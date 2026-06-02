import { describe, expect, test } from 'vitest';
import type { WorktreeLease } from '../git/index.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import {
  type AgentRecord,
  initialManagerState,
  type PullRequestRecord,
  type VerificationRecord,
  type Workstream,
} from './domain.ts';
import {
  projectResolvedWorkCleanup,
  RESOLVED_WORK_CLEANUP_PREVIEW_ITEMS,
} from './resolved-work-cleanup.ts';

const createdAt = '2026-06-01T00:00:00.000Z';
const reviewedHeadSha = 'a'.repeat(40);
const branchPointSha = 'b'.repeat(40);

function state() {
  return initialManagerState('manager-cleanup', {
    currentCheckout: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    key: 'repo-cleanup',
    primaryCheckout: '/tmp/repo',
  });
}

function workstream(id: string, status: Workstream['status']): Workstream {
  return { createdAt, id, objective: id, status, title: id, updatedAt: createdAt };
}

function lease(agentId: string): WorktreeLease {
  return {
    agentId,
    branch: `pardes/manager-cleanup/${agentId}`,
    branchPointSha,
    createdAt,
    managerId: 'manager-cleanup',
    path: `/tmp/private/${agentId}`,
  };
}

function agent(
  id: string,
  workstreamId: string,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    createdAt,
    id,
    model: 'fixture/model',
    role: 'worker',
    sessionDir: `/tmp/sessions/${id}`,
    status: 'stopped',
    task: id,
    thinkingLevel: 'high',
    updatedAt: createdAt,
    workstreamId,
    worktree: lease(id),
    ...overrides,
  };
}

function reviewGate(
  id: string,
  workstreamId: string,
  agentId: string,
  status: PullRequestRecord['status'],
): PullRequestRecord {
  return {
    agentId,
    createdAt,
    id,
    status,
    updatedAt: createdAt,
    url: `https://example.test/${id}`,
    workstreamId,
  };
}

function verification(
  id: string,
  sourceAgentId: string,
  workstreamId: string,
  overrides: Partial<VerificationRecord> = {},
): VerificationRecord {
  const verifierAgentId = `verifier-${id}`;
  return {
    attempts: [
      {
        attempt: 1,
        createdAt,
        evidenceStatus: 'current',
        reviewCheckout: {
          createdAt,
          managerId: 'manager-cleanup',
          path: `/tmp/private/reviews/${id}`,
          reviewedHeadSha,
          verificationId: id,
        },
        reviewedHeadSha,
        sourceBranchPointSha: branchPointSha,
        status: 'stopped',
        updatedAt: createdAt,
      },
    ],
    createdAt,
    id,
    model: 'fixture/model',
    sourceAgentId,
    task: id,
    thinkingLevel: 'high',
    updatedAt: createdAt,
    verifierAgentId,
    workstreamId,
    ...overrides,
  };
}

function runtime(agentId: string, status: WorkerRuntimeSnapshot['status']): WorkerRuntimeSnapshot {
  return {
    agentId,
    completedCompactionCount: 0,
    model: 'fixture/model',
    pid: 123,
    sampledAt: 2,
    sessionFile: `/tmp/sessions/${agentId}.jsonl`,
    startedAt: 1,
    stats: undefined,
    status,
    stderr: { omittedChars: 0, originalChars: 0, shownChars: 0, tail: '' },
    task: agentId,
    thinkingLevel: 'high',
  };
}

describe('resolved-work cleanup projection', () => {
  test('counts resolved residue and narrows actions to conservative explicit candidates', () => {
    const base = state();
    const complete = workstream('ws-complete', 'complete');
    const pending = workstream('ws-pending', 'active');
    const retained = agent('agent-retained', complete.id);
    const openOwner = agent('agent-open-owner', complete.id);
    const attached = agent('agent-attached', complete.id, { status: 'running' });
    const unresolved = agent('agent-unresolved', pending.id);
    const history = verification('verify-history', retained.id, complete.id);
    const retiring = verification('verify-retiring', retained.id, complete.id);
    const scratchRetry = verification(
      'verify-scratch-retry',
      'agent-unassociated',
      'ws-unassociated',
      { scratchCleanupPending: true },
    );
    const historyAgent = agent(history.verifierAgentId, complete.id, {
      role: 'verifier',
      worktree: undefined,
    });
    const retiringAgent = agent(retiring.verifierAgentId, complete.id, {
      role: 'verifier',
      status: 'idle',
      worktree: undefined,
    });
    const scratchAgent = agent(scratchRetry.verifierAgentId, 'ws-unassociated', {
      role: 'verifier',
      status: 'crashed',
      worktree: undefined,
    });
    const mergedComplete = reviewGate('pr-merged-complete', complete.id, retained.id, 'merged');
    const mergedPending = reviewGate('pr-merged-pending', pending.id, unresolved.id, 'merged');
    const open = reviewGate('pr-open', complete.id, openOwner.id, 'open');
    const projection = projectResolvedWorkCleanup(
      {
        ...base,
        agents: Object.fromEntries(
          [
            retained,
            openOwner,
            attached,
            unresolved,
            historyAgent,
            retiringAgent,
            scratchAgent,
          ].map((record) => [record.id, record]),
        ),
        pullRequests: {
          [mergedComplete.id]: mergedComplete,
          [mergedPending.id]: mergedPending,
          [open.id]: open,
        },
        verifications: {
          [history.id]: history,
          [retiring.id]: retiring,
          [scratchRetry.id]: scratchRetry,
        },
        workstreams: { [complete.id]: complete, [pending.id]: pending },
      },
      new Map([[retiringAgent.id, runtime(retiringAgent.id, 'idle')]]),
    );

    expect(projection).toEqual({
      detachedRetainedWorkers: {
        count: 3,
        openReviewOwnerCount: 1,
        resolvedLeaseInspectionCandidates: { count: 1, ids: [retained.id] },
      },
      disposableScratchMetadata: {
        cleanupRetryPending: { count: 1, ids: [scratchRetry.id] },
        terminalLeaseCount: 2,
      },
      historyOnlyVerifiers: { count: 1, retirementPendingCount: 1 },
      resolvedMergedLoops: {
        domainCompletionPending: { count: 1, ids: [pending.id] },
        reviewGateCount: 2,
        workstreamCount: 2,
      },
    });
  });

  test('bounds sorted identifier previews while retaining aggregate counts', () => {
    const base = state();
    const complete = workstream('ws-complete', 'complete');
    const agents = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => {
        const record = agent(`agent-${String(8 - index).padStart(2, '0')}`, complete.id);
        return [record.id, record];
      }),
    );

    const projection = projectResolvedWorkCleanup(
      { ...base, agents, workstreams: { [complete.id]: complete } },
      new Map(),
    );

    expect(projection.detachedRetainedWorkers.resolvedLeaseInspectionCandidates).toEqual({
      count: 9,
      ids: ['agent-00', 'agent-01', 'agent-02'],
    });
    expect(projection.detachedRetainedWorkers.resolvedLeaseInspectionCandidates.ids).toHaveLength(
      RESOLVED_WORK_CLEANUP_PREVIEW_ITEMS,
    );
  });
});
