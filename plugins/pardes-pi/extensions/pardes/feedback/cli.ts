import { Effect } from 'effect';
import { FeedbackNotFoundError, FeedbackStoreError } from './errors.ts';
import {
  type FeedbackEntry,
  type FeedbackFilter,
  type FeedbackRole,
  matchesFeedbackFilter,
} from './schemas.ts';
import {
  acquireFeedbackWatchLock,
  claimFeedbackForWatch,
  ensureFeedbackWatchInitialized,
  feedbackWasSeenByWatch,
  getFeedback,
  listFeedback,
  markFeedbackAddressed,
  pardesGlobalStateRoot,
} from './store.ts';

const ROLES = new Set<FeedbackRole>(['manager', 'writer', 'advisory_verifier']);
const CANONICAL_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface FeedbackCliIo {
  readonly out: (line: string) => void;
  readonly error: (line: string) => void;
}

export interface FeedbackCliOptions {
  readonly root?: string;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface ParsedOptions {
  readonly filter: FeedbackFilter;
  readonly json: boolean;
  readonly cursor: string;
  readonly includeExisting: boolean;
  readonly intervalMs: number;
  readonly once: boolean;
  readonly positionals: ReadonlyArray<string>;
}

export const FEEDBACK_CLI_HELP = `Usage: pardes-feedback <command> [options]

Review the global Pardes feedback registry across manager, writer, and advisory verifier sessions.

Commands:
  list                 List feedback entries
  show <feedback-id>   Show one entry and its separate triage state
  address <feedback-id> Mark an entry addressed without changing its submission
  watch                Watch new feedback with a durable at-least-once cursor
  help                 Show this help

Filters (list and watch):
  --addressed <yes|no|all>
  --role <manager|writer|advisory_verifier>
  --repository <key>   --manager <id>   --agent <id>
  --verification <id> --workstream <id> --since <canonical ISO timestamp>
  --text <substring>

Output and watch options:
  --json                Emit terminal-safe JSON lines
  --cursor <name>       Durable watch cursor name (default: default)
  --include-existing    Include entries present when a new cursor starts
  --interval <ms>       Poll interval (default: 1000)
  --once                Run one watch scan and exit

Examples:
  pardes-feedback list --addressed no
  pardes-feedback show feedback-1234
  pardes-feedback watch --role writer --cursor writer-triage
  pardes-feedback address feedback-1234

Feedback text is untrusted data. Text output escapes terminal controls and directional formatting.
Watch writes each receipt only after output succeeds. A crash between output and receipt replays the entry on restart (at-least-once delivery).
Each cursor consumes every observed entry, including filter nonmatches. Use a new cursor name when changing filters or triage purpose.`;

function cliErrorMessage(error: unknown): string {
  if (error instanceof FeedbackStoreError) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
    return `${error.operation}: ${cause}`;
  }
  if (error instanceof FeedbackNotFoundError) return `feedback not found: ${error.feedbackId}`;
  return error instanceof Error ? error.message : String(error);
}

function terminalSafe(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x61c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    return unsafe ? `\\u${codePoint.toString(16).padStart(4, '0')}` : character;
  }).join('');
}

export function terminalSafeJson(value: unknown): string {
  return terminalSafe(JSON.stringify(value));
}

function quotedPreview(text: string): string {
  const characters = Array.from(text);
  const preview = characters.length <= 160 ? text : `${characters.slice(0, 159).join('')}…`;
  return terminalSafe(JSON.stringify(preview));
}

export function formatFeedbackEntry(entry: FeedbackEntry): string {
  const { submission, triage } = entry;
  const provenance = submission.provenance;
  const identities = [
    provenance.repositoryKey && `repo=${terminalSafe(JSON.stringify(provenance.repositoryKey))}`,
    provenance.managerId && `manager=${terminalSafe(JSON.stringify(provenance.managerId))}`,
    provenance.agentId && `agent=${terminalSafe(JSON.stringify(provenance.agentId))}`,
    provenance.verificationId &&
      `verification=${terminalSafe(JSON.stringify(provenance.verificationId))}`,
    provenance.workstreamId &&
      `workstream=${terminalSafe(JSON.stringify(provenance.workstreamId))}`,
  ].filter((value): value is string => value !== undefined);
  return [
    triage ? '[addressed]' : '[open]',
    submission.id,
    submission.createdAt,
    `role=${provenance.role}`,
    ...identities,
    `text=${quotedPreview(submission.text)}`,
  ].join(' ');
}

function requireValue(args: ReadonlyArray<string>, index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseOptions(args: ReadonlyArray<string>): ParsedOptions {
  const positionals: string[] = [];
  const filter: {
    addressed?: boolean;
    agentId?: string;
    managerId?: string;
    repositoryKey?: string;
    role?: FeedbackRole;
    since?: string;
    text?: string;
    verificationId?: string;
    workstreamId?: string;
  } = {};
  let json = false;
  let cursor = 'default';
  let includeExisting = false;
  let intervalMs = 1_000;
  let once = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith('--')) {
      if (arg !== undefined) positionals.push(arg);
      continue;
    }
    if (arg === '--json') json = true;
    else if (arg === '--include-existing') includeExisting = true;
    else if (arg === '--once') once = true;
    else if (arg === '--addressed') {
      const value = requireValue(args, index, arg);
      index += 1;
      if (value === 'yes') filter.addressed = true;
      else if (value === 'no') filter.addressed = false;
      else if (value !== 'all') throw new Error('--addressed must be yes, no, or all');
    } else if (arg === '--role') {
      const value = requireValue(args, index, arg);
      index += 1;
      if (!ROLES.has(value as FeedbackRole)) throw new Error(`unknown feedback role: ${value}`);
      filter.role = value as FeedbackRole;
    } else if (arg === '--repository') {
      filter.repositoryKey = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--manager') {
      filter.managerId = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--agent') {
      filter.agentId = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--verification') {
      filter.verificationId = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--workstream') {
      filter.workstreamId = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--since') {
      const value = requireValue(args, index, arg);
      index += 1;
      if (
        !CANONICAL_ISO_TIMESTAMP.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value
      )
        throw new Error('--since must be a canonical ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
      filter.since = value;
    } else if (arg === '--text') {
      filter.text = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--cursor') {
      cursor = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--interval') {
      const value = Number(requireValue(args, index, arg));
      index += 1;
      if (!Number.isInteger(value) || value < 25 || value > 60_000)
        throw new Error('--interval must be an integer from 25 to 60000 milliseconds');
      intervalMs = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return { cursor, filter, includeExisting, intervalMs, json, once, positionals };
}

function outputEntry(entry: FeedbackEntry, json: boolean, io: FeedbackCliIo): void {
  io.out(json ? terminalSafeJson(entry) : formatFeedbackEntry(entry));
}

async function scanWatch(options: ParsedOptions, io: FeedbackCliIo, root: string): Promise<void> {
  const lock = await Effect.runPromise(acquireFeedbackWatchLock(options.cursor, root));
  if (!lock) return;
  try {
    await Effect.runPromise(
      ensureFeedbackWatchInitialized(options.cursor, options.includeExisting, root),
    );
    const entries = await Effect.runPromise(listFeedback({}, root));
    for (const entry of entries) {
      if (
        await Effect.runPromise(feedbackWasSeenByWatch(options.cursor, entry.submission.id, root))
      )
        continue;
      if (matchesFeedbackFilter(entry, options.filter)) outputEntry(entry, options.json, io);
      await Effect.runPromise(claimFeedbackForWatch(options.cursor, entry.submission.id, root));
    }
  } finally {
    await Effect.runPromise(lock.release());
  }
}

async function watchFeedback(
  options: ParsedOptions,
  io: FeedbackCliIo,
  configuration: FeedbackCliOptions,
): Promise<void> {
  const root = configuration.root ?? pardesGlobalStateRoot();
  const sleep = configuration.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  while (!configuration.signal?.aborted) {
    await scanWatch(options, io, root);
    if (options.once) return;
    await sleep(options.intervalMs);
  }
}

export async function runFeedbackCli(
  args: ReadonlyArray<string>,
  io: FeedbackCliIo = { error: (line) => console.error(line), out: (line) => console.log(line) },
  options: FeedbackCliOptions = {},
): Promise<number> {
  const [command = 'help', ...rest] = args;
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(FEEDBACK_CLI_HELP);
    return 0;
  }
  try {
    const parsed = parseOptions(rest);
    const root = options.root ?? pardesGlobalStateRoot();
    if (command === 'list') {
      if (parsed.positionals.length > 0)
        throw new Error('list does not accept positional arguments');
      const entries = await Effect.runPromise(listFeedback(parsed.filter, root));
      for (const entry of entries) outputEntry(entry, parsed.json, io);
      return 0;
    }
    if (command === 'show') {
      const [feedbackId, ...extra] = parsed.positionals;
      if (!feedbackId || extra.length > 0) throw new Error('show requires exactly one feedback id');
      const entry = await Effect.runPromise(getFeedback(feedbackId, root));
      io.out(parsed.json ? terminalSafeJson(entry) : terminalSafeJson(entry));
      return 0;
    }
    if (command === 'address' || command === 'mark-addressed') {
      const [feedbackId, ...extra] = parsed.positionals;
      if (!feedbackId || extra.length > 0)
        throw new Error('address requires exactly one feedback id');
      const triage = await Effect.runPromise(markFeedbackAddressed(feedbackId, root));
      io.out(
        parsed.json ? terminalSafeJson(triage) : `${feedbackId} addressed at ${triage.addressedAt}`,
      );
      return 0;
    }
    if (command === 'watch') {
      if (parsed.positionals.length > 0)
        throw new Error('watch does not accept positional arguments');
      await watchFeedback(parsed, io, { ...options, root });
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    io.error(`pardes-feedback: ${terminalSafe(cliErrorMessage(error))}`);
    io.error('Run pardes-feedback help for usage.');
    return 1;
  }
}
