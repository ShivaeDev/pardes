import { Data } from 'effect';
import type { AgentAlreadyRunningError, AgentNotFoundError } from '../agent-errors.ts';

export { AgentAlreadyRunningError, AgentNotFoundError } from '../agent-errors.ts';

import type {
  DirtyWorktreeError,
  GitCommandError,
  InvalidManagedLeaseError,
  InvalidWorktreeInputError,
  RemoteBaselineError,
  RepositoryError,
  WorktreeError,
  WorktreeLockError,
} from '../git/index.ts';
import type {
  GitHubCommandError,
  GitHubPublicationInputError,
  GitHubResponseError,
  GitHubSyncInputError,
  GitHubWatcherInputError,
  GitHubWatcherTimeoutError,
} from '../github/index.ts';
import type {
  ReportArtifactError,
  ReportArtifactWriteError,
  ReportFieldUnavailableError,
  ReportInputValidationError,
  ReportWriteLimitExceededError,
} from '../reporting/index.ts';
import type { StoreError } from '../storage/index.ts';
import type { WorkerProcessError, WorkerRpcError } from '../worker-runtime/index.ts';
import type {
  PluginActivationAlignment,
  PluginActivationGuardOperation,
} from './activation-safety.ts';
import type { ManagerInputValidationError } from './inputs.ts';

export class InvalidManagedStateError extends Data.TaggedError('InvalidManagedStateError')<{
  readonly reason: string;
}> {}

export class ManagerInactiveError extends Data.TaggedError('ManagerInactiveError')<{
  readonly message: string;
}> {}

export class ManagerAlreadyActiveError extends Data.TaggedError('ManagerAlreadyActiveError')<{
  readonly managerId: string;
}> {}

export class PluginActivationBlockedError extends Data.TaggedError('PluginActivationBlockedError')<{
  readonly operation: PluginActivationGuardOperation;
  readonly status: PluginActivationAlignment;
  readonly reason:
    | 'not_materialized'
    | 'capture_unavailable'
    | 'materialization_unavailable'
    | 'snapshot_invalid';
}> {}

export class WorkstreamNotFoundError extends Data.TaggedError('WorkstreamNotFoundError')<{
  readonly workstreamId: string;
}> {}

export class InboxEventNotFoundError extends Data.TaggedError('InboxEventNotFoundError')<{
  readonly eventId: string;
}> {}

export class InboxHandoffUnavailableError extends Data.TaggedError('InboxHandoffUnavailableError')<{
  readonly reason: 'no_delivered_cursor' | 'stale_delivered_cursor';
}> {}

export class AgentCannotReviveError extends Data.TaggedError('AgentCannotReviveError')<{
  readonly agentId: string;
  readonly reason: string;
}> {}

export type AgentReportHandoffRejectedReason =
  | 'target_not_idle'
  | 'target_not_attached'
  | 'source_not_managed'
  | 'source_role_unsupported';

export class AgentReportHandoffRejectedError extends Data.TaggedError(
  'AgentReportHandoffRejectedError',
)<{
  readonly targetAgentId: string;
  readonly reason: AgentReportHandoffRejectedReason;
}> {}

export class AgentLeaseCleanupRejectedError extends Data.TaggedError(
  'AgentLeaseCleanupRejectedError',
)<{
  readonly agentId: string;
  readonly reason: string;
}> {}

export class AgentSpawnConfigurationError extends Data.TaggedError('AgentSpawnConfigurationError')<{
  readonly message: string;
}> {}

export class PullRequestPublicationValidationError extends Data.TaggedError(
  'PullRequestPublicationValidationError',
)<{
  readonly reason: string;
}> {}

export class VerificationRequestRejectedError extends Data.TaggedError(
  'VerificationRequestRejectedError',
)<{
  readonly sourceAgentId: string;
  readonly reason: string;
}> {}

export class VerificationNotFoundError extends Data.TaggedError('VerificationNotFoundError')<{
  readonly verificationId: string;
}> {}

export class VerificationRefreshRejectedError extends Data.TaggedError(
  'VerificationRefreshRejectedError',
)<{
  readonly verificationId: string;
  readonly reason: string;
}> {}

export type PardesError =
  | StoreError
  | GitCommandError
  | RepositoryError
  | WorktreeError
  | WorktreeLockError
  | InvalidWorktreeInputError
  | RemoteBaselineError
  | InvalidManagedLeaseError
  | InvalidManagedStateError
  | DirtyWorktreeError
  | ManagerInactiveError
  | ManagerAlreadyActiveError
  | PluginActivationBlockedError
  | ManagerInputValidationError
  | WorkstreamNotFoundError
  | InboxEventNotFoundError
  | InboxHandoffUnavailableError
  | AgentNotFoundError
  | AgentAlreadyRunningError
  | AgentCannotReviveError
  | AgentReportHandoffRejectedError
  | AgentLeaseCleanupRejectedError
  | AgentSpawnConfigurationError
  | WorkerProcessError
  | WorkerRpcError
  | GitHubCommandError
  | GitHubResponseError
  | GitHubPublicationInputError
  | GitHubSyncInputError
  | GitHubWatcherInputError
  | GitHubWatcherTimeoutError
  | PullRequestPublicationValidationError
  | VerificationRequestRejectedError
  | VerificationNotFoundError
  | VerificationRefreshRejectedError
  | ReportArtifactError
  | ReportArtifactWriteError
  | ReportWriteLimitExceededError
  | ReportFieldUnavailableError
  | ReportInputValidationError;

const GITHUB_COMMAND_OPERATION_FALLBACK = 'unrecognized operation';

export function renderModelFacingGitHubCommandOperation(command: unknown, args: unknown): string {
  if (!Array.isArray(args)) return GITHUB_COMMAND_OPERATION_FALLBACK;
  if (command === 'gh' && args[0] === 'pr') {
    if (args[1] === 'create') return 'gh pr create';
    if (args[1] === 'edit') return 'gh pr edit';
    if (args[1] === 'list') return 'gh pr list';
    if (args[1] === 'view') return 'gh pr view';
  }
  if (command === 'git' && args[0] === 'push') return 'git push';
  return GITHUB_COMMAND_OPERATION_FALLBACK;
}

export function formatPardesError(error: unknown): string {
  if (error && typeof error === 'object' && '_tag' in error) {
    const tagged = error as { readonly _tag: string; readonly message?: string };
    if (tagged._tag === 'ManagerInactiveError' && tagged.message) return tagged.message;
    if (tagged._tag === 'ManagerAlreadyActiveError' && 'managerId' in tagged) {
      return `Pardes manager is already active (${String(tagged.managerId)}).`;
    }
    if (
      tagged._tag === 'PluginActivationBlockedError' &&
      'operation' in tagged &&
      'status' in tagged
    ) {
      return `Cannot run ${String(tagged.operation)}: this manager's pinned child-runtime snapshot is unavailable. Coordinate a manual manager reload activation point; Pardes did not fetch, pull, or reload plugin sources automatically.`;
    }
    if (tagged._tag === 'ManagerInputValidationError' && 'boundary' in tagged) {
      return `Invalid ${String(tagged.boundary)} input.`;
    }
    if (tagged._tag === 'WorkstreamNotFoundError' && 'workstreamId' in tagged) {
      return `Unknown workstream: ${String(tagged.workstreamId)}`;
    }
    if (tagged._tag === 'InboxEventNotFoundError' && 'eventId' in tagged) {
      return `Unknown pending inbox event: ${String(tagged.eventId)}`;
    }
    if (tagged._tag === 'InboxHandoffUnavailableError') {
      return 'No current delivered Pardes attention cursor is available for user handoff.';
    }
    if (tagged._tag === 'AgentNotFoundError' && 'agentId' in tagged) {
      return `Unknown agent: ${String(tagged.agentId)}`;
    }
    if (tagged._tag === 'AgentAlreadyRunningError' && 'agentId' in tagged) {
      return `Agent is already running: ${String(tagged.agentId)}`;
    }
    if (tagged._tag === 'AgentCannotReviveError' && 'agentId' in tagged && 'reason' in tagged) {
      return `Cannot revive ${String(tagged.agentId)}: ${String(tagged.reason)}`;
    }
    if (
      tagged._tag === 'AgentReportHandoffRejectedError' &&
      'targetAgentId' in tagged &&
      'reason' in tagged
    ) {
      const target = String(tagged.targetAgentId);
      if (tagged.reason === 'target_not_idle')
        return `Cannot hand off durable report to ${target}: retained target is not idle.`;
      if (tagged.reason === 'target_not_attached')
        return `Cannot hand off durable report to ${target}: retained target runtime is not attached.`;
      if (tagged.reason === 'source_not_managed')
        return 'Cannot hand off durable report: artifact source is not a retained manager-owned agent.';
      return 'Cannot hand off durable report: artifact source is not a worker or advisory verifier.';
    }
    if (
      tagged._tag === 'AgentLeaseCleanupRejectedError' &&
      'agentId' in tagged &&
      'reason' in tagged
    ) {
      return `Cannot clean managed lease for ${String(tagged.agentId)}: ${String(tagged.reason)}`;
    }
    if (tagged._tag === 'AgentSpawnConfigurationError' && tagged.message) {
      return tagged.message;
    }
    if (
      (tagged._tag === 'WorkerProcessError' || tagged._tag === 'WorkerRpcError') &&
      'operation' in tagged
    ) {
      return `${tagged._tag}: ${String(tagged.operation)}`;
    }
    if (tagged._tag === 'WorkerRpcError' && 'command' in tagged) {
      return `WorkerRpcError: ${String(tagged.command)}`;
    }
    if (tagged._tag === 'PullRequestPublicationValidationError' && 'reason' in tagged) {
      return `Cannot publish pull request: ${String(tagged.reason)}`;
    }
    if (
      tagged._tag === 'VerificationRequestRejectedError' &&
      'sourceAgentId' in tagged &&
      'reason' in tagged
    ) {
      return `Cannot request verification for ${String(tagged.sourceAgentId)}: ${String(tagged.reason)}`;
    }
    if (tagged._tag === 'VerificationNotFoundError' && 'verificationId' in tagged) {
      return `Unknown verification: ${String(tagged.verificationId)}`;
    }
    if (
      tagged._tag === 'VerificationRefreshRejectedError' &&
      'verificationId' in tagged &&
      'reason' in tagged
    ) {
      return `Cannot refresh verification ${String(tagged.verificationId)}: ${String(tagged.reason)}`;
    }
    if (tagged._tag === 'ReportArtifactError' && 'reportId' in tagged && 'reason' in tagged) {
      return `Cannot read durable report ${String(tagged.reportId)}: ${String(tagged.reason)}.`;
    }
    if (tagged._tag === 'ReportArtifactWriteError')
      return 'Could not persist durable child report artifact.';
    if (tagged._tag === 'ReportWriteLimitExceededError') {
      if ('field' in tagged && (tagged.field === 'summary' || tagged.field === 'details')) {
        return `Durable child report ${tagged.field} field exceeds its configured write cap.`;
      }
      return 'Durable child report exceeds its configured write cap.';
    }
    if (
      tagged._tag === 'ReportFieldUnavailableError' &&
      'reportId' in tagged &&
      'field' in tagged
    ) {
      return `Durable report ${String(tagged.reportId)} has no ${String(tagged.field)} field.`;
    }
    if (tagged._tag === 'ReportInputValidationError') return 'Invalid report_get input.';
    if (tagged._tag === 'GitHubCommandError' && 'command' in tagged && 'args' in tagged) {
      return `GitHub publication command failed: ${renderModelFacingGitHubCommandOperation(tagged.command, tagged.args)}`;
    }
    if (tagged._tag === 'GitHubResponseError' && 'operation' in tagged) {
      return `Invalid GitHub CLI response: ${String(tagged.operation)}`;
    }
    if (tagged._tag === 'GitHubPublicationInputError') {
      return 'Invalid GitHub publication input.';
    }
    if (tagged._tag === 'GitHubSyncInputError') {
      return 'Invalid existing GitHub pull-request sync input.';
    }
    if (tagged._tag === 'GitHubWatcherInputError') {
      return 'Invalid persisted GitHub watcher association.';
    }
    if (tagged._tag === 'GitHubWatcherTimeoutError') {
      return 'GitHub watcher command timed out.';
    }
    if (tagged._tag === 'InvalidWorktreeInputError' && 'field' in tagged && tagged.message) {
      return `Invalid ${String(tagged.field)}: ${tagged.message}`;
    }
    if (tagged._tag === 'RemoteBaselineError' && 'reason' in tagged) {
      if (tagged.reason === 'missing_remote')
        return 'Cannot resolve worker baseline: configured remote origin is missing.';
      if (tagged.reason === 'missing_default_branch')
        return 'Cannot resolve worker baseline: origin default branch is missing.';
      if (tagged.reason === 'fetch_failed')
        return 'Cannot resolve worker baseline: could not fetch the selected origin baseline.';
      if (tagged.reason === 'invalid_override')
        return 'Cannot resolve worker baseline: invalid branch override.';
      return 'Cannot resolve worker baseline: selected origin ref did not resolve to one immutable commit.';
    }
    if (tagged._tag === 'InvalidManagedLeaseError' && 'reason' in tagged) {
      return `Invalid persisted managed worktree lease: ${String(tagged.reason)}`;
    }
    if (tagged._tag === 'InvalidManagedStateError' && 'reason' in tagged) {
      return `Invalid persisted managed state: ${String(tagged.reason)}`;
    }
    if (tagged._tag === 'DirtyWorktreeError' && 'path' in tagged) {
      return `Refusing to use dirty managed worktree: ${String(tagged.path)}`;
    }
    if (tagged._tag === 'WorktreeLockError' && 'lockPath' in tagged) {
      return `Could not acquire repository worktree lock: ${String(tagged.lockPath)}`;
    }
    if (tagged._tag === 'GitCommandError' && 'args' in tagged) {
      return `Git command failed: git ${(tagged.args as ReadonlyArray<string>).join(' ')}`;
    }
    if (
      (tagged._tag === 'StoreError' ||
        tagged._tag === 'RepositoryError' ||
        tagged._tag === 'WorktreeError') &&
      'operation' in tagged
    ) {
      return `${tagged._tag}: ${String(tagged.operation)}`;
    }
    return tagged._tag;
  }
  return error instanceof Error ? error.message : String(error);
}
