import { Schema } from 'effect';
import type {
  GitHubCommandError,
  GitHubResponseError,
  GitHubWatcherInputError,
  GitHubWatcherTimeoutError,
} from './errors.ts';

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

type KnownGitHubWatcherError =
  | GitHubWatcherInputError
  | GitHubResponseError
  | GitHubCommandError
  | GitHubWatcherTimeoutError;

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

/** Inspect only a bounded shallow diagnostic subset for symptom classification; never return it. */
function diagnosticScanText(cause: unknown): string {
  const values: string[] = [];
  appendScanText(values, cause);
  if (cause && typeof cause === 'object') {
    const record = cause as Readonly<Record<string, unknown>>;
    appendScanText(values, record.message);
    appendScanText(values, record.stderr);
    appendScanText(values, record.code);
    appendScanText(values, record.status);
    appendScanText(values, record.statusCode);
    appendScanText(values, record.cause);
  }
  return values.join(' ').slice(0, GITHUB_WATCHER_DIAGNOSTIC_SCAN_MAX_CHARS).toLowerCase();
}

export function githubCommandFailureDiagnosticHint(
  cause: unknown,
): GitHubCommandError['diagnosticHint'] {
  const text = diagnosticScanText(cause);
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

function commandFailureKind(error: GitHubCommandError): GitHubWatcherFailureKind {
  const hint = error.diagnosticHint;
  return hint === 'authentication_likely' || hint === 'rate_limit_likely'
    ? hint
    : (githubCommandFailureDiagnosticHint(error.cause) ?? 'command_failed');
}

/** Reduce watcher failures to bounded canonical diagnostics safe for durable and model-facing state. */
export function classifyGitHubWatcherFailure(error: unknown): GitHubWatcherFailureDiagnostic {
  if (!error || typeof error !== 'object' || !('_tag' in error))
    return diagnostic('unexpected_error');
  const tagged = error as KnownGitHubWatcherError | { readonly _tag: string };
  if (tagged._tag === 'GitHubWatcherTimeoutError') return diagnostic('command_timed_out');
  if (tagged._tag === 'GitHubWatcherInputError') return diagnostic('association_invalid');
  if (tagged._tag === 'GitHubResponseError') return diagnostic('metadata_invalid');
  if (tagged._tag === 'GitHubCommandError')
    return diagnostic(commandFailureKind(tagged as GitHubCommandError));
  return diagnostic('unexpected_typed_error');
}
