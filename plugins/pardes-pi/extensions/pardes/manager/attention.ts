import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import type { AgentRecord, PullRequestRecord } from './domain.ts';

export function effectiveAgentStatus(
  agent: AgentRecord,
  runtime?: WorkerRuntimeSnapshot,
): WorkerStatus {
  return runtime?.status ?? agent.status;
}

export function hasPersistedAgentWarning(agent: AgentRecord): boolean {
  return Boolean(
    agent.lastError ||
      agent.gitAudit?.status === 'failed' ||
      (agent.gitAudit?.status === 'succeeded' && agent.gitAudit.dirty),
  );
}

export function hasAgentWarning(agent: AgentRecord, effectiveStatus: WorkerStatus): boolean {
  return effectiveStatus === 'crashed' || hasPersistedAgentWarning(agent);
}

export function hasPullRequestWarningMetadata(pullRequest: PullRequestRecord): boolean {
  return Boolean(
    pullRequest.watcherFailedAt ||
      pullRequest.headDivergedAt ||
      pullRequest.discussionPaginationGaps?.length ||
      pullRequest.observation?.ci === 'failing' ||
      pullRequest.observation?.mergeable === 'conflicting' ||
      pullRequest.observation?.reviewDecision === 'changes_requested',
  );
}

export function pullRequestNeedsAttention(pullRequest: PullRequestRecord): boolean {
  return pullRequest.status === 'open' && hasPullRequestWarningMetadata(pullRequest);
}
