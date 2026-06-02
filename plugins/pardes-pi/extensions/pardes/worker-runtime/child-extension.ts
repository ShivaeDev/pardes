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
const VERIFIER_OUTPUT_MAX_CHARS = 12_000;
const VERIFIER_GIT_TIMEOUT_MS = 10_000;
const GIT_EXPLICIT_CWD_UNSAFE_ENVIRONMENT_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ATTR_SOURCE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
] as const;

/** Keep the pinned child extension self-contained while mirroring the Git boundary policy. */
function gitEnvironmentForExplicitCwd(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of GIT_EXPLICIT_CWD_UNSAFE_ENVIRONMENT_VARIABLES) delete environment[name];
  return environment;
}

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

function boundedVerifierOutput(output: string): {
  readonly output: string;
  readonly truncated: boolean;
} {
  return output.length <= VERIFIER_OUTPUT_MAX_CHARS
    ? { output, truncated: false }
    : { output: `${output.slice(0, VERIFIER_OUTPUT_MAX_CHARS - 1)}…`, truncated: true };
}

function git(root: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: gitEnvironmentForExplicitCwd(),
        maxBuffer: 1024 * 1024,
        timeout: VERIFIER_GIT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason = (String(stderr).replace(/\s+/g, ' ').trim() || error.message).slice(
            0,
            1_000,
          );
          reject(new Error(`Git inspection failed: ${reason}`));
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
      const bounded = boundedVerifierOutput(names);
      return text(
        [
          `reviewedHeadSha: ${reviewedHeadSha}`,
          `checkoutHeadSha: ${headSha}`,
          `baselineSha: ${baselineSha}`,
          `checkoutClean: ${String(!dirty)}`,
          'changed paths:',
          bounded.output || '(none)',
          ...(bounded.truncated ? ['changed path evidence truncated: true'] : []),
        ].join('\n'),
        {
          pardesVerifier: {
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
