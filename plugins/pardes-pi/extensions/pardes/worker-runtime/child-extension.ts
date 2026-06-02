import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

export function boundedVerifierPathRows(output: string): {
  readonly omitted: number;
  readonly output: string;
  readonly shown: number;
  readonly total: number;
  readonly truncated: boolean;
} {
  const rows = output === '' ? [] : output.replace(/\n$/, '').split('\n');
  const shownRows: string[] = [];
  let shownChars = 0;
  for (const row of rows) {
    const nextChars = shownChars + (shownRows.length === 0 ? 0 : 1) + row.length;
    if (nextChars > VERIFIER_CHANGED_PATHS_MAX_CHARS) break;
    shownRows.push(row);
    shownChars = nextChars;
  }
  const shown = shownRows.length;
  const omitted = rows.length - shown;
  return {
    omitted,
    output: shownRows.join('\n'),
    shown,
    total: rows.length,
    truncated: omitted > 0,
  };
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
  const source = stderr.trim() ? 'stderr' : 'error';
  const diagnostic = source === 'stderr' ? stderr : fallback;
  const safe = diagnostic
    .replace(GIT_DIAGNOSTIC_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function git(root: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const diagnostic = boundedGitDiagnostic(String(stderr), error.message);
          reject(new Error(`Git inspection failed: ${JSON.stringify(diagnostic)}`));
        } else resolve(stdout);
      },
    );
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
      const headSha = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      const dirty =
        (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).trim().length > 0;
      const names = await git(root, ['diff', '--name-only', `${baselineSha}...${reviewedHeadSha}`]);
      const bounded = boundedVerifierPathRows(names);
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
