import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import {
  effectiveAgentStatus,
  hasPersistedAgentWarning,
  hasPullRequestWarningMetadata,
} from './attention.ts';
import type { AgentRecord, ManagerEvent, ManagerState } from './domain.ts';
import { projectVerificationReviewLoopDisposition } from './verification/index.ts';

export const IDLE_WORKER_DISPOSITION_PRECEDENCE = [
  'needs_attention',
  'verification_retirement_pending',
  'review_gate_open',
  'merged_retirement_pending',
  'idle_unclassified',
] as const;

export type IdleWorkerDisposition = (typeof IDLE_WORKER_DISPOSITION_PRECEDENCE)[number];

const ROUTINE_IDLE_INBOX_EVENT_TYPES = new Set([
  'agent_idle',
  'agent_report_completed',
  'agent_detached',
  'merged',
]);

function eventAssociatedWithAgent(
  state: ManagerState,
  event: ManagerEvent,
  agent: AgentRecord,
): boolean {
  if (event.agentId !== undefined) return event.agentId === agent.id;
  if (event.pullRequestId !== undefined)
    return state.pullRequests[event.pullRequestId]?.agentId === agent.id;
  return event.workstreamId === agent.workstreamId;
}

/**
 * Derives a display-only canonical disposition for an effectively idle worker.
 * Runtime status wins when attached; otherwise the persisted idle projection is
 * used. The result is deliberately not persisted and does not infer intent from
 * task text, reports, diffs, roles, session artifacts, or activity previews.
 */
export function projectIdleWorkerDisposition(
  state: ManagerState,
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
): IdleWorkerDisposition | undefined {
  if (effectiveAgentStatus(agent, runtime) !== 'idle') return undefined;

  const pullRequests = Object.values(state.pullRequests).filter(
    (pullRequest) => pullRequest.agentId === agent.id,
  );
  const hasNonRoutineInboxEntry = state.inbox.some(
    (event) =>
      !ROUTINE_IDLE_INBOX_EVENT_TYPES.has(event.type) &&
      eventAssociatedWithAgent(state, event, agent),
  );

  if (
    hasPersistedAgentWarning(agent) ||
    pullRequests.some(hasPullRequestWarningMetadata) ||
    hasNonRoutineInboxEntry
  )
    return 'needs_attention';
  const verification =
    agent.role === 'verifier'
      ? Object.values(state.verifications).find(
          (candidate) => candidate.verifierAgentId === agent.id,
        )
      : undefined;
  if (
    verification &&
    projectVerificationReviewLoopDisposition(state, verification) === 'resolved_terminal'
  )
    return 'verification_retirement_pending';
  if (pullRequests.some((pullRequest) => pullRequest.status === 'open')) return 'review_gate_open';
  if (pullRequests.some((pullRequest) => pullRequest.status === 'merged'))
    return 'merged_retirement_pending';
  return 'idle_unclassified';
}
