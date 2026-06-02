import { Schema } from 'effect';
import type { GitHubCommandError } from './errors.ts';

export const GITHUB_WATCHER_DIAGNOSTIC_SCAN_MAX_CHARS = 4_096;

export const GITHUB_WATCHER_FAILURE_SUMMARIES = {
  association_invalid: 'Persisted watcher association is invalid; inspect review-gate state.',
  authentication_likely: 'GitHub CLI authentication likely failed; run gh auth status.',
  command_failed: 'GitHub CLI command failed; check gh connectivity.',
  command_timed_out: 'GitHub CLI command timed out; check connectivity.',
  metadata_invalid: 'GitHub returned malformed or inconsistent watcher metadata.',
  rate_limit_likely: 'GitHub API rate limit likely affected watcher inspection; retry later.',
  unexpected_error: 'GitHub watcher failed unexpectedly; inspect local diagnostics.',
  unexpected_typed_error: 'Typed GitHub watcher failure occurred; inspect local diagnostics.',
} as const;

export type GitHubWatcherFailureKind = keyof typeof GITHUB_WATCHER_FAILURE_SUMMARIES;

/** Bounded monotonic escalation policy for one unresolved watcher outage. */
export const GITHUB_WATCHER_FAILURE_RANKS = {
  association_invalid: 2,
  authentication_likely: 3,
  command_failed: 1,
  command_timed_out: 2,
  metadata_invalid: 2,
  rate_limit_likely: 4,
  unexpected_error: 0,
  unexpected_typed_error: 0,
} as const satisfies Readonly<Record<GitHubWatcherFailureKind, number>>;

/** Canonical durable watcher diagnosis. Raw CLI diagnostics never cross this boundary. */
export const GitHubWatcherFailureDiagnosticSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('association_invalid'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.association_invalid),
  }),
  Schema.Struct({
    kind: Schema.Literal('authentication_likely'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.authentication_likely),
  }),
  Schema.Struct({
    kind: Schema.Literal('command_failed'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.command_failed),
  }),
  Schema.Struct({
    kind: Schema.Literal('command_timed_out'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.command_timed_out),
  }),
  Schema.Struct({
    kind: Schema.Literal('metadata_invalid'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.metadata_invalid),
  }),
  Schema.Struct({
    kind: Schema.Literal('rate_limit_likely'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.rate_limit_likely),
  }),
  Schema.Struct({
    kind: Schema.Literal('unexpected_error'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.unexpected_error),
  }),
  Schema.Struct({
    kind: Schema.Literal('unexpected_typed_error'),
    summary: Schema.Literal(GITHUB_WATCHER_FAILURE_SUMMARIES.unexpected_typed_error),
  }),
]);
export type GitHubWatcherFailureDiagnostic = typeof GitHubWatcherFailureDiagnosticSchema.Type;

function safeUnknownProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function diagnostic(kind: GitHubWatcherFailureKind): GitHubWatcherFailureDiagnostic {
  return {
    kind,
    summary: GITHUB_WATCHER_FAILURE_SUMMARIES[kind],
  } as GitHubWatcherFailureDiagnostic;
}

function appendScanText(values: string[], value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const consumed = values.reduce((total, part) => total + part.length + 1, 0);
  const remaining = GITHUB_WATCHER_DIAGNOSTIC_SCAN_MAX_CHARS - consumed;
  if (remaining > 0) values.push(String(value).slice(0, remaining));
}

function appendLabeledScanText(values: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  appendScanText(values, `${label}:${value}`);
}

/** Inspect only a bounded shallow diagnostic subset for symptom classification; never return it. */
function diagnosticScanText(cause: unknown): string {
  const values: string[] = [];
  appendScanText(values, cause);
  appendScanText(values, safeUnknownProperty(cause, 'message'));
  appendScanText(values, safeUnknownProperty(cause, 'stderr'));
  appendScanText(values, safeUnknownProperty(cause, 'code'));
  appendLabeledScanText(values, 'status', safeUnknownProperty(cause, 'status'));
  appendLabeledScanText(values, 'statusCode', safeUnknownProperty(cause, 'statusCode'));
  appendScanText(values, safeUnknownProperty(cause, 'cause'));
  return values.join(' ').slice(0, GITHUB_WATCHER_DIAGNOSTIC_SCAN_MAX_CHARS).toLowerCase();
}

export function githubCommandFailureDiagnosticHint(
  cause: unknown,
): GitHubCommandError['diagnosticHint'] {
  let text = '';
  try {
    text = diagnosticScanText(cause);
  } catch {
    return undefined;
  }
  if (
    /rate[ -]?limit|secondary rate|abuse detection|too many requests|http\s*429|status(?:code)?\s*[:=]?\s*429/.test(
      text,
    )
  )
    return 'rate_limit_likely';
  if (
    /bad credentials|authentication|not logged (?:in|into)|auth login|unauthorized|http\s*401|status(?:code)?\s*[:=]?\s*401/.test(
      text,
    )
  )
    return 'authentication_likely';
  return undefined;
}

export function isGitHubWatcherFailureEscalation(
  previous: GitHubWatcherFailureDiagnostic | undefined,
  next: GitHubWatcherFailureDiagnostic,
): boolean {
  return (
    previous === undefined ||
    GITHUB_WATCHER_FAILURE_RANKS[next.kind] > GITHUB_WATCHER_FAILURE_RANKS[previous.kind]
  );
}

function commandFailureKind(error: GitHubCommandError): GitHubWatcherFailureKind {
  const hint = safeUnknownProperty(error, 'diagnosticHint');
  return hint === 'authentication_likely' || hint === 'rate_limit_likely'
    ? hint
    : (githubCommandFailureDiagnosticHint(safeUnknownProperty(error, 'cause')) ?? 'command_failed');
}

/** Reduce watcher failures to bounded canonical diagnostics safe for durable and model-facing state. */
export function classifyGitHubWatcherFailure(error: unknown): GitHubWatcherFailureDiagnostic {
  const tag = safeUnknownProperty(error, '_tag');
  if (typeof tag !== 'string') return diagnostic('unexpected_error');
  if (tag === 'GitHubWatcherTimeoutError') return diagnostic('command_timed_out');
  if (tag === 'GitHubWatcherInputError') return diagnostic('association_invalid');
  if (tag === 'GitHubResponseError') return diagnostic('metadata_invalid');
  if (tag === 'GitHubCommandError')
    return diagnostic(commandFailureKind(error as GitHubCommandError));
  return diagnostic('unexpected_typed_error');
}
