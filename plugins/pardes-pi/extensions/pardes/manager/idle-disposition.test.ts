import { describe, expect, test } from 'vitest';
import { requiredValue } from '../test-support.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import {
  type AgentRecord,
  initialManagerState,
  type ManagerEvent,
  type ManagerState,
  type PullRequestRecord,
  type VerificationRecord,
} from './domain.ts';
import {
  IDLE_WORKER_DISPOSITION_PRECEDENCE,
  projectIdleWorkerDisposition,
} from './idle-disposition.ts';

const createdAt = '2026-06-01T00:00:00.000Z';
const agentId = 'agent-12345678';

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    createdAt,
    id: agentId,
    model: 'fixture/model',
    role: 'worker',
    sessionDir: '/tmp/pardes/session',
    status: 'idle',
    task: 'Bounded fixture task.',
    thinkingLevel: 'high',
    updatedAt: createdAt,
    workstreamId: 'ws-1',
    ...overrides,
  };
}

function state(agentOverrides: Partial<AgentRecord> = {}): ManagerState {
  const base = initialManagerState('manager-12345678', {
    currentCheckout: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    key: 'repo-1',
    primaryCheckout: '/tmp/repo',
  });
  const worker = agent(agentOverrides);
  return { ...base, agents: { [worker.id]: worker } };
}

function pullRequest(
  id: string,
  status: PullRequestRecord['status'],
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    agentId,
    createdAt,
    id,
    status,
    updatedAt: createdAt,
    url: `https://github.test/acme/project/pull/${id}`,
    workstreamId: 'ws-1',
    ...overrides,
  };
}

function runtime(status: WorkerRuntimeSnapshot['status']): WorkerRuntimeSnapshot {
  return {
    agentId,
    completedCompactionCount: 0,
    model: 'fixture/model',
    pid: 123,
    recentActivityLines: ['Completed unpublished work is ready to publish as helper material.'],
    sampledAt: 2,
    sessionFile: '/tmp/pardes/session/fixture.jsonl',
    startedAt: 1,
    stats: undefined,
    status,
    stderr: { omittedChars: 0, originalChars: 0, shownChars: 0, tail: '' },
    task: 'completed_unpublished helper_material publication ready follow_up_parked',
    thinkingLevel: 'high',
  };
}

function disposition(current: ManagerState, attached?: WorkerRuntimeSnapshot) {
  return projectIdleWorkerDisposition(current, requiredValue(current.agents[agentId]), attached);
}

describe('idle worker disposition projector', () => {
  test('publishes the explicit canonical precedence', () => {
    expect(IDLE_WORKER_DISPOSITION_PRECEDENCE).toEqual([
      'needs_attention',
      'verification_retirement_pending',
      'review_gate_open',
      'merged_retirement_pending',
      'idle_unclassified',
    ]);

    const base = state();
    const merged = pullRequest('pr-merged', 'merged');
    const open = pullRequest('pr-open', 'open');
    const warning = pullRequest('pr-warning', 'open', { watcherFailedAt: createdAt });

    expect(
      disposition({
        ...base,
        pullRequests: { [merged.id]: merged, [open.id]: open, [warning.id]: warning },
      }),
    ).toBe('needs_attention');
    expect(disposition({ ...base, pullRequests: { [merged.id]: merged, [open.id]: open } })).toBe(
      'review_gate_open',
    );
    expect(disposition({ ...base, pullRequests: { [merged.id]: merged } })).toBe(
      'merged_retirement_pending',
    );
    expect(disposition(base)).toBe('idle_unclassified');
  });

  test('derives needs_attention from current associated evidence', () => {
    const auditFailed = state({
      gitAudit: {
        checkedAt: createdAt,
        failureSummary: 'inspection unavailable',
        status: 'failed',
        trigger: 'completion',
      },
    });
    const auditDirty = state({
      gitAudit: { checkedAt: createdAt, dirty: true, status: 'succeeded', trigger: 'completion' },
    });
    const prMetadata = pullRequest('pr-warning', 'open', {
      observation: {
        ci: 'failing',
        mergeable: 'conflicting',
        number: 42,
        reviewDecision: 'changes_requested',
        status: 'open',
      },
    });
    const watcherFailed = pullRequest('pr-watcher', 'open', { watcherFailedAt: createdAt });
    const directInbox: ManagerEvent = {
      agentId,
      createdAt,
      id: 'event-direct',
      summary: 'A decision is required.',
      type: 'agent_question',
    };
    const pullRequestInbox: ManagerEvent = {
      createdAt,
      id: 'event-pr',
      pullRequestId: 'pr-owned',
      summary: 'Review requires attention.',
      type: 'review_feedback',
    };
    const workstreamInbox: ManagerEvent = {
      createdAt,
      id: 'event-stream',
      summary: 'Stream requires attention.',
      type: 'scope_independent_error',
      workstreamId: 'ws-1',
    };
    const owned = pullRequest('pr-owned', 'open');
    const base = state();

    expect(disposition(state({ lastError: 'worker warning' }))).toBe('needs_attention');
    expect(disposition(auditFailed)).toBe('needs_attention');
    expect(disposition(auditDirty)).toBe('needs_attention');
    expect(disposition({ ...base, pullRequests: { [prMetadata.id]: prMetadata } })).toBe(
      'needs_attention',
    );
    expect(disposition({ ...base, pullRequests: { [watcherFailed.id]: watcherFailed } })).toBe(
      'needs_attention',
    );
    expect(disposition({ ...base, inbox: [directInbox] })).toBe('needs_attention');
    expect(
      disposition({ ...base, inbox: [pullRequestInbox], pullRequests: { [owned.id]: owned } }),
    ).toBe('needs_attention');
    expect(disposition({ ...base, inbox: [workstreamInbox] })).toBe('needs_attention');
  });

  test('treats warning metadata on terminal associated pull requests as needs_attention evidence', () => {
    const base = state();
    const mergedWarning = pullRequest('pr-merged-warning', 'merged', {
      observation: {
        ci: 'passing',
        mergeable: 'conflicting',
        number: 42,
        reviewDecision: 'approved',
        status: 'merged',
      },
    });
    const closedWatcherFailure = pullRequest('pr-closed-watcher', 'closed', {
      watcherFailedAt: createdAt,
    });

    expect(disposition({ ...base, pullRequests: { [mergedWarning.id]: mergedWarning } })).toBe(
      'needs_attention',
    );
    expect(
      disposition({ ...base, pullRequests: { [closedWatcherFailure.id]: closedWatcherFailure } }),
    ).toBe('needs_attention');
  });

  test('does not infer intent from routine prose, diffs, sessions, roles, or activity previews', () => {
    const worker = agent({
      changedPaths: [],
      role: 'explorer',
      sessionFile: '/tmp/pardes/session/fixture.jsonl',
      task: 'completed_unpublished follow_up_parked helper_material publication ready',
    });
    const routineReport: ManagerEvent = {
      agentId,
      createdAt,
      id: 'event-completed',
      summary: 'Empty diff. Park this helper material; publication ready.',
      type: 'agent_report_completed',
    };
    const base = state();
    const projected = { ...base, agents: { [worker.id]: worker }, inbox: [routineReport] };

    expect(disposition(projected, runtime('idle'))).toBe('idle_unclassified');
    expect(
      disposition(
        {
          ...projected,
          agents: { [worker.id]: { ...worker, changedPaths: ['helper-material.md'] } },
        },
        runtime('idle'),
      ),
    ).toBe('idle_unclassified');
    expect(
      disposition({ ...projected, agents: { [worker.id]: { ...worker, status: 'stopped' } } }),
    ).toBeUndefined();
  });

  test('uses attached runtime status over the persisted projection without treating stopped state as evidence', () => {
    expect(disposition(state({ status: 'stopped' }), runtime('idle'))).toBe('idle_unclassified');
    expect(disposition(state(), runtime('stopped'))).toBeUndefined();

    const merged = pullRequest('pr-merged', 'merged');
    const stopped = state({ status: 'stopped' });
    const stoppedWithMergedGate = { ...stopped, pullRequests: { [merged.id]: merged } };
    expect(disposition(stoppedWithMergedGate, runtime('idle'))).toBe('merged_retirement_pending');
    expect(disposition(stoppedWithMergedGate)).toBeUndefined();
  });

  test('classifies an idle verifier with a resolved terminal writer gate as retirement pending', () => {
    const base = state();
    const source = agent({ id: 'agent-writer', status: 'running' });
    const verifier = agent({ id: 'verifier-12345678', role: 'verifier' });
    const terminalGate = pullRequest('pr-terminal', 'merged', { agentId: source.id });
    const verification: VerificationRecord = {
      attempts: [
        {
          attempt: 1,
          createdAt,
          evidenceStatus: 'current',
          reviewCheckout: {
            createdAt,
            managerId: base.managerId,
            path: '/tmp/repo/.worktrees/pardes/manager-12345678/verify-12345678',
            reviewedHeadSha: 'a'.repeat(40),
            verificationId: 'verify-12345678',
          },
          reviewedHeadSha: 'a'.repeat(40),
          sourceBranchPointSha: 'b'.repeat(40),
          status: 'idle',
          updatedAt: createdAt,
        },
      ],
      createdAt,
      id: 'verify-12345678',
      model: 'fixture/model',
      sourceAgentId: source.id,
      task: 'Review terminal fixture.',
      thinkingLevel: 'high',
      updatedAt: createdAt,
      verifierAgentId: verifier.id,
      workstreamId: verifier.workstreamId,
    };
    const projected = {
      ...base,
      agents: { [source.id]: source, [verifier.id]: verifier },
      pullRequests: { [terminalGate.id]: terminalGate },
      verifications: { [verification.id]: verification },
    };

    expect(projectIdleWorkerDisposition(projected, verifier, undefined)).toBe(
      'verification_retirement_pending',
    );
  });

  test('ignores routine or more specifically unrelated inbox entries', () => {
    const base = state();
    const routine: ManagerEvent[] = [
      'agent_idle',
      'agent_report_completed',
      'agent_detached',
      'merged',
    ].map((type, index) => ({
      agentId,
      createdAt,
      id: `routine-${index}`,
      summary: 'Routine lifecycle evidence only.',
      type,
    }));
    const unrelated: ManagerEvent = {
      agentId: 'agent-other',
      createdAt,
      id: 'event-unrelated',
      summary: 'Another worker needs guidance.',
      type: 'agent_question',
      workstreamId: 'ws-1',
    };

    expect(disposition({ ...base, inbox: [...routine, unrelated] })).toBe('idle_unclassified');
  });
});
