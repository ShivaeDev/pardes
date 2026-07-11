import { Effect } from 'effect';
import type {
  ManagedLeaseCleanupInspection,
  ManagedLeaseCleanupIntent,
  ManagedLeaseCleanupOutcome,
  ManagedWorktreeShape,
} from '../git/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import type { AgentRecord, ManagerEvent, ManagerState } from './domain.ts';
import { AgentLeaseCleanupRejectedError, AgentNotFoundError } from './errors.ts';
import { type ManagerNamespaceContext, managedLeaseOwner } from './namespace.ts';

const ATTACHED_STATUSES = new Set<WorkerStatus>(['starting', 'running', 'idle']);
const CLEANUP_RESOLVED_INBOX_EVENT_TYPES = new Set([
  'agent_auto_stop_failed',
  'agent_crashed',
  'agent_detached',
  'agent_git_audit_dirty',
  'agent_git_audit_failed',
  'pull_request_auto_sync_attention',
  'worktree_bootstrap_interrupted',
]);

export interface AgentLeaseCleanupProjection {
  readonly agentId: string;
  readonly action: 'inspect' | 'cleanup';
  readonly worktree: ManagedLeaseCleanupInspection['worktree'];
  readonly branch: ManagedLeaseCleanupInspection['branch'];
  readonly changedPathCount: number;
  readonly worktreeOutcome?: ManagedLeaseCleanupOutcome['worktreeOutcome'];
  readonly branchOutcome?: ManagedLeaseCleanupOutcome['branchOutcome'];
  readonly session: 'retained_metadata' | 'preserved_history_only';
  readonly revival:
    | 'subject_to_retained_session_validation'
    | 'unavailable_missing_worktree'
    | 'disabled_no_worktree';
}

interface AgentLeaseCleanupContext {
  readonly namespace: ManagerNamespaceContext;
  readonly state: ManagerState;
  readonly runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>;
  readonly worktrees: ManagedWorktreeShape;
}

function rejected(agentId: string, reason: string): AgentLeaseCleanupRejectedError {
  return new AgentLeaseCleanupRejectedError({ agentId, reason });
}

const cleanupCandidate = Effect.fnUntraced(function* (
  context: AgentLeaseCleanupContext,
  agentId: string,
) {
  const agent = context.state.agents[agentId];
  if (!agent) return yield* new AgentNotFoundError({ agentId });
  const runtime = context.runtimes.get(agentId);
  if (
    ATTACHED_STATUSES.has(agent.status) ||
    (runtime !== undefined && ATTACHED_STATUSES.has(runtime.status))
  ) {
    return yield* rejected(agentId, 'attached or active workers must be stopped before cleanup');
  }
  if (
    Object.values(context.state.pullRequests).some(
      (pullRequest) => pullRequest.agentId === agentId && pullRequest.status === 'open',
    )
  ) {
    return yield* rejected(
      agentId,
      'an unresolved open review gate still requires retained ownership',
    );
  }
  if (!agent.worktree)
    return yield* rejected(agentId, 'agent has no retained managed worktree lease');
  return { agent, lease: agent.worktree, owner: managedLeaseOwner(context.namespace, agentId) };
});

function inspectProjection(
  agentId: string,
  inspection: ManagedLeaseCleanupInspection,
): AgentLeaseCleanupProjection {
  return {
    action: 'inspect',
    agentId,
    branch: inspection.branch,
    changedPathCount: inspection.changedPaths.length,
    revival:
      inspection.worktree === 'already_missing'
        ? 'unavailable_missing_worktree'
        : 'subject_to_retained_session_validation',
    session: 'retained_metadata',
    worktree: inspection.worktree,
  };
}

function cleanupProjection(
  agentId: string,
  outcome: ManagedLeaseCleanupOutcome,
): AgentLeaseCleanupProjection {
  return {
    action: 'cleanup',
    agentId,
    branch: outcome.branch,
    branchOutcome: outcome.branchOutcome,
    changedPathCount: outcome.changedPaths.length,
    revival: 'disabled_no_worktree',
    session: 'preserved_history_only',
    worktree: outcome.worktree,
    worktreeOutcome: outcome.worktreeOutcome,
  };
}

export const inspectAgentLeaseCleanup = Effect.fnUntraced(function* (
  context: AgentLeaseCleanupContext,
  agentId: string,
) {
  const candidate = yield* cleanupCandidate(context, agentId);
  const inspection = yield* context.worktrees.inspectForCleanup(candidate.owner, candidate.lease);
  return inspectProjection(agentId, inspection);
});

export const cleanupAgentLease = Effect.fnUntraced(function* (
  context: AgentLeaseCleanupContext,
  agentId: string,
  intent: ManagedLeaseCleanupIntent,
) {
  const candidate = yield* cleanupCandidate(context, agentId);
  const outcome = yield* context.worktrees.cleanup(candidate.owner, candidate.lease, intent);
  return { outcome, projection: cleanupProjection(agentId, outcome) };
});

export function reconcileAgentLeaseCleanup(
  agent: AgentRecord,
  outcome: ManagedLeaseCleanupOutcome,
  cleanedAt: string,
): AgentRecord {
  const {
    changedPaths: _changedPaths,
    gitAudit: _gitAudit,
    lastError: _lastError,
    worktree: _worktree,
    ...retained
  } = agent;
  return {
    ...retained,
    leaseCleanup: {
      branchOutcome: outcome.branchOutcome,
      cleanedAt,
      revival: 'disabled_no_worktree',
      session: 'preserved_history_only',
      worktreeOutcome: outcome.worktreeOutcome,
    },
    status: 'stopped',
    updatedAt: cleanedAt,
  };
}

export function isResolvedByAgentLeaseCleanup(event: ManagerEvent, agentId: string): boolean {
  return event.agentId === agentId && CLEANUP_RESOLVED_INBOX_EVENT_TYPES.has(event.type);
}

export function agentLeaseCleanupEventSummary(projection: AgentLeaseCleanupProjection): string {
  return `Cleaned retained managed lease for ${projection.agentId}: worktree ${projection.worktreeOutcome}; branch ${projection.branchOutcome}; retained Pi session metadata as history-only; revival disabled because no worktree remains.`;
}
