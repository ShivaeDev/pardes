import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  CHILD_REPORT_DETAILS_MAX_CHARS,
  CHILD_REPORT_SUMMARY_MAX_CHARS,
  childProfileFromEnvironment,
  type VerifierChildProfile,
} from './child-profile.ts';
import { renderChildToolCall, renderChildToolResult } from './child-tool-call-preview.ts';

const PATH_PARAMETERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  edit: ['path'],
  find: ['path'],
  grep: ['path'],
  ls: ['path'],
  read: ['path'],
  write: ['path'],
};
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Git diagnostics are rendered inert before model-visible display.
const GIT_DIAGNOSTIC_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const GIT_DIAGNOSTIC_MAX_CHARS = 1_000;
const GIT_HEAD_MAX_CHARS = 1_000;
const GIT_INSPECTION_STDERR_MAX_BYTES = 64 * 1_024;
export const GIT_INSPECTION_STDOUT_MAX_BYTES = 16 * 1_024 * 1_024;
export const VERIFIER_CHANGED_PATHS_MAX_CHARS = 12_000;

function nearestExistingAncestor(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

export function normalizeWorkerToolPath(requestedPath: string): string {
  let normalized = requestedPath.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized === '~') return homedir();
  if (
    normalized.startsWith('~/') ||
    (process.platform === 'win32' && normalized.startsWith('~\\'))
  ) {
    return join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

export function isPathInsideWorktree(worktreeRoot: string, requestedPath: string): boolean {
  const root = realpathSync(worktreeRoot);
  let normalized: string;
  try {
    normalized = normalizeWorkerToolPath(requestedPath);
  } catch {
    return false;
  }
  const lexical = resolve(root, normalized);
  const ancestor = nearestExistingAncestor(lexical);
  const candidate = join(realpathSync(ancestor), relative(ancestor, lexical));
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

export function getWorkerToolPathDenialReason(
  worktreeRoot: string,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const parameters = PATH_PARAMETERS[toolName];
  if (!parameters) return;
  for (const parameter of parameters) {
    if (!Object.hasOwn(input, parameter)) continue;
    const path = input[parameter];
    if (typeof path !== 'string' || !isPathInsideWorktree(worktreeRoot, path)) {
      return `Pardes worker path is outside the managed worktree: ${String(path)}`;
    }
  }
}

function text(text: string, details: unknown) {
  return { content: [{ text, type: 'text' as const }], details };
}

interface GitRowEvidence {
  readonly omitted: number;
  readonly output: string;
  readonly shown: number;
  readonly total: number;
  readonly truncated: boolean;
}

function gitRowCollector(maxChars: number): {
  readonly append: (chunk: string) => void;
  readonly finish: () => GitRowEvidence;
} {
  let pending = '';
  let retaining = true;
  let shownChars = 0;
  let total = 0;
  const shownRows: string[] = [];
  const accept = (row: string) => {
    total += 1;
    if (!retaining) return;
    const nextChars = shownChars + (shownRows.length === 0 ? 0 : 1) + row.length;
    if (nextChars > maxChars) {
      retaining = false;
      return;
    }
    shownRows.push(row);
    shownChars = nextChars;
  };
  return {
    append(chunk) {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        accept(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    },
    finish() {
      if (pending) {
        accept(pending);
        pending = '';
      }
      const shown = shownRows.length;
      return {
        omitted: total - shown,
        output: shownRows.join('\n'),
        shown,
        total,
        truncated: shown < total,
      };
    },
  };
}

export function boundedVerifierPathRows(output: string): GitRowEvidence {
  const collector = gitRowCollector(VERIFIER_CHANGED_PATHS_MAX_CHARS);
  collector.append(output);
  return collector.finish();
}

function inertGitDiagnostic(diagnostic: string): string {
  return diagnostic.replace(GIT_DIAGNOSTIC_CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

export function boundedGitDiagnostic(
  stderr: string,
  fallback: string,
): {
  readonly normalizedAwayChars: number;
  readonly omittedChars: number;
  readonly originalChars: number;
  readonly preview: string;
  readonly safeChars: number;
  readonly shownChars: number;
  readonly source: 'error' | 'stderr';
  readonly truncated: boolean;
} {
  const safeStderr = inertGitDiagnostic(stderr);
  const source = safeStderr ? 'stderr' : 'error';
  const diagnostic = source === 'stderr' ? stderr : fallback;
  const safe = source === 'stderr' ? safeStderr : inertGitDiagnostic(fallback);
  const preview = safe.slice(0, GIT_DIAGNOSTIC_MAX_CHARS);
  return {
    normalizedAwayChars: diagnostic.length - safe.length,
    omittedChars: safe.length - preview.length,
    originalChars: diagnostic.length,
    preview,
    safeChars: safe.length,
    shownChars: preview.length,
    source,
    truncated: preview.length < safe.length,
  };
}

function gitInspectionTransportBreaker(
  stream: 'stderr' | 'stdout',
  observedBytes: number,
  limitBytes: number,
): Error {
  return new Error(
    `Git inspection transport breaker: ${JSON.stringify({ limitBytes, observedBytes, stream })}`,
  );
}

function gitRows(
  root: string,
  args: ReadonlyArray<string>,
  maxChars: number,
): Promise<GitRowEvidence> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const collector = gitRowCollector(maxChars);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let stderrBytes = 0;
    let stdoutBytes = 0;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
      child.kill();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > GIT_INSPECTION_STDOUT_MAX_BYTES) {
        rejectOnce(
          gitInspectionTransportBreaker('stdout', stdoutBytes, GIT_INSPECTION_STDOUT_MAX_BYTES),
        );
        return;
      }
      collector.append(stdoutDecoder.write(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > GIT_INSPECTION_STDERR_MAX_BYTES) {
        rejectOnce(
          gitInspectionTransportBreaker('stderr', stderrBytes, GIT_INSPECTION_STDERR_MAX_BYTES),
        );
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      rejectOnce(
        new Error(
          `Git inspection failed: ${JSON.stringify(boundedGitDiagnostic('', error.message))}`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      collector.append(stdoutDecoder.end());
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const fallback = `git exited with code ${String(code)} and signal ${String(signal)}`;
        rejectOnce(
          new Error(
            `Git inspection failed: ${JSON.stringify(boundedGitDiagnostic(stderr, fallback))}`,
          ),
        );
        return;
      }
      settled = true;
      resolve(collector.finish());
    });
  });
}

function registerVerifierTools(
  pi: ExtensionAPI,
  root: string,
  profile: VerifierChildProfile,
): void {
  const { reviewBaselineSha: baselineSha, reviewedHeadSha } = profile;

  pi.registerTool({
    description:
      'Read bounded immutable-head and clean-checkout evidence for this detached advisory review checkout. Executes fixed Git inspection argv only.',
    async execute() {
      const head = await gitRows(
        root,
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        GIT_HEAD_MAX_CHARS,
      );
      if (head.truncated) throw new Error('Git inspection returned oversized HEAD evidence.');
      const headSha = head.output.trim();
      const status = await gitRows(root, ['status', '--porcelain=v1', '--untracked-files=all'], 0);
      const dirty = status.total > 0;
      const bounded = await gitRows(
        root,
        ['diff', '--name-only', `${baselineSha}...${reviewedHeadSha}`],
        VERIFIER_CHANGED_PATHS_MAX_CHARS,
      );
      return text(
        [
          `reviewedHeadSha: ${reviewedHeadSha}`,
          `checkoutHeadSha: ${headSha}`,
          `baselineSha: ${baselineSha}`,
          `checkoutClean: ${String(!dirty)}`,
          `changed path evidence: total=${bounded.total}; shown=${bounded.shown}; omitted=${bounded.omitted}`,
          'changed paths:',
          bounded.output || (bounded.total === 0 ? '(none)' : '(none shown within bound)'),
          ...(bounded.truncated ? ['changed path evidence truncated: true'] : []),
        ].join('\n'),
        {
          pardesVerifier: {
            changedPaths: {
              omitted: bounded.omitted,
              shown: bounded.shown,
              total: bounded.total,
            },
            checkoutClean: !dirty,
            checkoutHeadSha: headSha,
            reviewedHeadSha,
            truncated: bounded.truncated,
            type: 'evidence',
          },
        },
      );
    },
    label: 'Inspect Verification Evidence',
    name: 'verification_evidence',
    parameters: Type.Object({}, { additionalProperties: false }),
    renderCall(_args, theme, context) {
      return renderChildToolCall(theme, 'verification_evidence', [], !context.isPartial);
    },
    renderResult(result, options, theme, context) {
      return renderChildToolResult(theme, 'verification_evidence', [], result, options, context);
    },
    renderShell: 'self',
  });
}

export default function pardesWorker(pi: ExtensionAPI): void {
  const root = process.env.PARDES_WORKTREE_ROOT;
  if (!root) throw new Error('PARDES_WORKTREE_ROOT is required for the Pardes worker extension.');
  const profile = childProfileFromEnvironment(process.env);

  pi.on('tool_call', (event) => {
    const reason = getWorkerToolPathDenialReason(root, event.toolName, event.input);
    if (reason) return { block: true, reason };
  });

  if (profile.type === 'verifier') registerVerifierTools(pi, root, profile);

  const verifier = profile.type === 'verifier';
  const reportStatus = Type.Union(
    [Type.Literal('progress'), Type.Literal('completed'), Type.Literal('blocked')],
    {
      description: verifier
        ? 'Use completed after the whole requested review pass, blocked only when review cannot continue, and progress only for a genuine interim checkpoint; never drip-feed individually discoverable findings.'
        : 'Report progress, completion, or a genuine blocker.',
    },
  );
  const reportSummary = Type.String({
    description: verifier
      ? 'Concise advisory disposition and consolidated finding-count summary.'
      : 'Concise report summary.',
    maxLength: CHILD_REPORT_SUMMARY_MAX_CHARS,
    minLength: 1,
  });
  const reportDetails = Type.String({
    ...(verifier ? { minLength: 1 } : {}),
    description: verifier
      ? 'Required bounded consolidated advisory body: whole risk surface inspected; every currently known blocker, concern, and non-blocking note; bounded reproduction reasoning per concern; validation run or not run; and separate confidence and completeness limitations. Summarize instead of dumping bulk logs.'
      : 'Optional bounded durable report details.',
    maxLength: CHILD_REPORT_DETAILS_MAX_CHARS,
  });

  pi.registerTool({
    description: verifier
      ? 'Send one bounded structured advisory report to the owning Pardes manager. Inspect the whole requested risk surface before a terminal report; consolidate every currently known blocker, concern, and non-blocking note; include bounded reproduction reasoning; distinguish confidence from completeness limitations; and avoid serial finding drip-feed when one pass can discover the findings. This remains advisory evidence: the manager judges action.'
      : 'Send a concise structured progress, completion, or blocker report to the owning Pardes manager.',
    async execute(_toolCallId, params) {
      return text(
        verifier
          ? 'Consolidated advisory report delivered to the owning Pardes manager.'
          : 'Structured report delivered to the owning Pardes manager.',
        { pardesWorker: { type: 'report', ...params } },
      );
    },
    label: 'Report to Manager',
    name: 'report_to_manager',
    parameters: Type.Object(
      {
        details: verifier ? reportDetails : Type.Optional(reportDetails),
        status: reportStatus,
        summary: reportSummary,
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme, context) {
      return renderChildToolCall(
        theme,
        'report_to_manager',
        [
          { name: 'status', value: args.status },
          { mode: 'length', name: 'summary', value: args.summary },
          { mode: 'length', name: 'details', value: args.details },
        ],
        !context.isPartial,
      );
    },
    renderResult(result, options, theme, context) {
      return renderChildToolResult(
        theme,
        'report_to_manager',
        [
          { name: 'status', value: context.args.status },
          { mode: 'length', name: 'summary', value: context.args.summary },
          { mode: 'length', name: 'details', value: context.args.details },
        ],
        result,
        options,
        context,
      );
    },
    renderShell: 'self',
  });

  pi.registerTool({
    description: verifier
      ? 'Ask the owning Pardes manager a concise question only when it truly blocks continued review after inspecting what remains possible. Do not drip-feed discoverable concerns as separate questions.'
      : 'Ask the owning Pardes manager a concise blocking question, then wait for a follow-up response.',
    async execute(_toolCallId, params) {
      return text(
        'Question delivered to the owning Pardes manager. Stop and wait for follow-up guidance.',
        {
          pardesWorker: { type: 'question', ...params },
        },
      );
    },
    label: 'Ask Manager',
    name: 'ask_manager',
    parameters: Type.Object(
      {
        context: Type.Optional(Type.String()),
        question: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme, context) {
      return renderChildToolCall(
        theme,
        'ask_manager',
        [
          { mode: 'length', name: 'question', value: args.question },
          { mode: 'length', name: 'context', value: args.context },
        ],
        !context.isPartial,
      );
    },
    renderResult(result, options, theme, context) {
      return renderChildToolResult(
        theme,
        'ask_manager',
        [
          { mode: 'length', name: 'question', value: context.args.question },
          { mode: 'length', name: 'context', value: context.args.context },
        ],
        result,
        options,
        context,
      );
    },
    renderShell: 'self',
  });
}
