import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import { type AgentRecord, currentVerificationAttempt, type ManagerState } from './domain.ts';
import { projectVerificationReviewLoopDisposition } from './verification-policy.ts';

export const RESOLVED_WORK_CLEANUP_PREVIEW_ITEMS = 3;

const ATTACHED_STATUSES = new Set<WorkerStatus>(['starting', 'running', 'idle']);
const RESOLVED_WORKSTREAM_STATUSES = new Set(['complete', 'cancelled']);

export interface ResolvedWorkCleanupIdPreview {
  readonly count: number;
  readonly ids: ReadonlyArray<string>;
}

export interface ResolvedWorkCleanupProjection {
  readonly resolvedMergedLoops: {
    readonly reviewGateCount: number;
    readonly workstreamCount: number;
    readonly domainCompletionPending: ResolvedWorkCleanupIdPreview;
  };
  readonly historyOnlyVerifiers: {
    readonly count: number;
    readonly retirementPendingCount: number;
  };
  readonly detachedRetainedWorkers: {
    readonly count: number;
    readonly openReviewOwnerCount: number;
    readonly resolvedLeaseInspectionCandidates: ResolvedWorkCleanupIdPreview;
  };
  readonly disposableScratchMetadata: {
    readonly terminalLeaseCount: number;
    readonly cleanupRetryPending: ResolvedWorkCleanupIdPreview;
  };
}

function idPreview(ids: ReadonlyArray<string>): ResolvedWorkCleanupIdPreview {
  const sorted = [...ids].sort();
  return { count: sorted.length, ids: sorted.slice(0, RESOLVED_WORK_CLEANUP_PREVIEW_ITEMS) };
}

function hasAttachedStatus(
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
): boolean {
  return (
    ATTACHED_STATUSES.has(agent.status) ||
    (runtime !== undefined && ATTACHED_STATUSES.has(runtime.status))
  );
}

/**
 * State-only cleanup orientation. This never inspects or mutates filesystem
 * artifacts: it narrows operators toward existing explicit per-record tools.
 */
export function projectResolvedWorkCleanup(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): ResolvedWorkCleanupProjection {
  const pullRequests = Object.values(state.pullRequests);
  const mergedReviewGates = pullRequests.filter((pullRequest) => pullRequest.status === 'merged');
  const mergedWorkstreamIds = [
    ...new Set(mergedReviewGates.map((pullRequest) => pullRequest.workstreamId)),
  ];
  const domainCompletionPending = idPreview(
    mergedWorkstreamIds.filter((workstreamId) => {
      const status = state.workstreams[workstreamId]?.status;
      return status !== undefined && !RESOLVED_WORKSTREAM_STATUSES.has(status);
    }),
  );

  const resolvedTerminalVerifications = Object.values(state.verifications).filter(
    (verification) =>
      projectVerificationReviewLoopDisposition(state, verification) === 'resolved_terminal',
  );
  const historyOnlyVerifiers = resolvedTerminalVerifications.filter((verification) => {
    const attempt = currentVerificationAttempt(verification);
    const agent = state.agents[verification.verifierAgentId];
    const status =
      runtimes.get(verification.verifierAgentId)?.status ?? agent?.status ?? attempt.status;
    return status === 'stopped' && attempt.status === 'stopped';
  });

  const detachedRetainedWorkers = Object.values(state.agents).filter(
    (agent) =>
      agent.role === 'worker' &&
      agent.worktree !== undefined &&
      !hasAttachedStatus(agent, runtimes.get(agent.id)),
  );
  const hasOpenReviewGate = (agentId: string) =>
    pullRequests.some(
      (pullRequest) => pullRequest.agentId === agentId && pullRequest.status === 'open',
    );
  const resolvedLeaseInspectionCandidates = idPreview(
    detachedRetainedWorkers
      .filter((agent) => {
        const status = state.workstreams[agent.workstreamId]?.status;
        return (
          status !== undefined &&
          RESOLVED_WORKSTREAM_STATUSES.has(status) &&
          !hasOpenReviewGate(agent.id)
        );
      })
      .map((agent) => agent.id),
  );

  return {
    detachedRetainedWorkers: {
      count: detachedRetainedWorkers.length,
      openReviewOwnerCount: detachedRetainedWorkers.filter((agent) => hasOpenReviewGate(agent.id))
        .length,
      resolvedLeaseInspectionCandidates,
    },
    disposableScratchMetadata: {
      cleanupRetryPending: idPreview(
        Object.values(state.verifications)
          .filter((verification) => verification.scratchCleanupPending === true)
          .map((verification) => verification.id),
      ),
      terminalLeaseCount: resolvedTerminalVerifications.length,
    },
    historyOnlyVerifiers: {
      count: historyOnlyVerifiers.length,
      retirementPendingCount: resolvedTerminalVerifications.length - historyOnlyVerifiers.length,
    },
    resolvedMergedLoops: {
      domainCompletionPending,
      reviewGateCount: mergedReviewGates.length,
      workstreamCount: mergedWorkstreamIds.length,
    },
  };
}
