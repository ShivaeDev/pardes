import { describe, expect, test } from 'vitest';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import {
  effectiveAgentStatus,
  hasAgentWarning,
  hasPersistedAgentWarning,
  hasPullRequestWarningMetadata,
  pullRequestNeedsAttention,
} from './attention.ts';
import type { AgentRecord, PullRequestObservation, PullRequestRecord } from './domain.ts';
import { conflictAttentionTransition } from './review-gate-lifecycle.ts';

const createdAt = '2026-06-01T00:00:00.000Z';

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    createdAt,
    id: 'agent-attention',
    model: 'fixture/model',
    role: 'worker',
    sessionDir: '/tmp/pardes/session',
    status: 'idle',
    task: 'Exercise pure attention predicates.',
    thinkingLevel: 'high',
    updatedAt: createdAt,
    workstreamId: 'ws-attention',
    ...overrides,
  };
}

function runtime(status: WorkerRuntimeSnapshot['status']): WorkerRuntimeSnapshot {
  return {
    agentId: 'agent-attention',
    completedCompactionCount: 0,
    model: 'fixture/model',
    pid: 123,
    sampledAt: 2,
    sessionFile: '/tmp/pardes/session/fixture.jsonl',
    startedAt: 1,
    stats: undefined,
    status,
    stderr: { omittedChars: 0, originalChars: 0, shownChars: 0, tail: '' },
    task: 'Exercise pure attention predicates.',
    thinkingLevel: 'high',
  };
}

function observation(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    ci: 'passing',
    mergeable: 'mergeable',
    number: 42,
    reviewDecision: 'approved',
    status: 'open',
    ...overrides,
  };
}

function pullRequest(
  status: PullRequestRecord['status'],
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    agentId: 'agent-attention',
    createdAt,
    id: `pr-${status}`,
    status,
    updatedAt: createdAt,
    url: `https://github.test/acme/project/pull/${status}`,
    workstreamId: 'ws-attention',
    ...overrides,
  };
}

describe('manager attention predicates', () => {
  test('uses attached runtime status over the persisted agent projection', () => {
    expect(effectiveAgentStatus(agent({ status: 'stopped' }))).toBe('stopped');
    expect(effectiveAgentStatus(agent({ status: 'stopped' }), runtime('idle'))).toBe('idle');
    expect(effectiveAgentStatus(agent({ status: 'idle' }), runtime('running'))).toBe('running');
  });

  test('recognizes persisted lastError and failed or dirty Git audits', () => {
    expect(hasPersistedAgentWarning(agent())).toBe(false);
    expect(hasPersistedAgentWarning(agent({ lastError: 'worker failed' }))).toBe(true);
    expect(
      hasPersistedAgentWarning(
        agent({
          gitAudit: {
            checkedAt: createdAt,
            failureSummary: 'inspection unavailable',
            status: 'failed',
            trigger: 'completion',
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasPersistedAgentWarning(
        agent({
          gitAudit: {
            checkedAt: createdAt,
            dirty: true,
            status: 'succeeded',
            trigger: 'completion',
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasPersistedAgentWarning(
        agent({
          gitAudit: {
            checkedAt: createdAt,
            dirty: false,
            status: 'succeeded',
            trigger: 'completion',
          },
        }),
      ),
    ).toBe(false);
  });

  test('adds an effective crash to persisted agent-warning evidence', () => {
    const worker = agent({ status: 'stopped' });

    expect(hasAgentWarning(worker, effectiveAgentStatus(worker))).toBe(false);
    expect(hasAgentWarning(worker, effectiveAgentStatus(worker, runtime('crashed')))).toBe(true);
    expect(hasAgentWarning(agent({ lastError: 'durable warning' }), 'idle')).toBe(true);
  });

  test('recognizes each pull-request warning metadata source', () => {
    const warnings = [
      pullRequest('open', { watcherFailedAt: createdAt }),
      pullRequest('open', {
        watcherFailure: {
          kind: 'command_failed',
          summary: 'GitHub CLI command failed; check gh connectivity.',
        },
      }),
      pullRequest('open', { headDivergedAt: createdAt }),
      pullRequest('open', { discussionPaginationGaps: ['issue_comment'] }),
      pullRequest('open', { observation: observation({ ci: 'failing' }) }),
      pullRequest('open', { observation: observation({ mergeable: 'conflicting' }) }),
      pullRequest('open', { observation: observation({ reviewDecision: 'changes_requested' }) }),
    ];

    for (const warning of warnings) {
      expect(hasPullRequestWarningMetadata(warning)).toBe(true);
      expect(pullRequestNeedsAttention(warning)).toBe(true);
    }
    const healthy = pullRequest('open', { observation: observation() });
    expect(hasPullRequestWarningMetadata(healthy)).toBe(false);
    expect(pullRequestNeedsAttention(healthy)).toBe(false);
  });

  test('supersedes an older conflict key after complete mergeability and rearms on later conflict', () => {
    const headA = 'a'.repeat(40);
    const headB = 'b'.repeat(40);
    for (const current of [
      { headSha: headB, lifecycleGeneration: 1 },
      { headSha: headA, lifecycleGeneration: 2 },
    ]) {
      const owner = agent({ lifecycleGeneration: current.lifecycleGeneration });
      const gate = pullRequest('open', {
        conflictAttention: {
          attentionObservedForKey: true,
          auditedHeadSha: headA,
          generation: 1,
          ownerLifecycleGeneration: 1,
          phase: 'conflicting',
        },
        lastPushedHeadSha: current.headSha,
      });

      const first = conflictAttentionTransition(gate, owner, observation(), true);
      expect(first).toMatchObject({
        attention: false,
        next: {
          attentionObservedForKey: false,
          auditedHeadSha: current.headSha,
          generation: 1,
          ownerLifecycleGeneration: current.lifecycleGeneration,
          phase: 'resolution_candidate',
        },
      });
      const second = conflictAttentionTransition(
        { ...gate, conflictAttention: first.next },
        owner,
        observation(),
        true,
      );
      expect(second).toMatchObject({ attention: false, next: { phase: 'resolved' } });
      const reappeared = conflictAttentionTransition(
        { ...gate, conflictAttention: second.next },
        owner,
        observation({ mergeable: 'conflicting' }),
        true,
      );
      expect(reappeared).toMatchObject({
        attention: true,
        next: { attentionObservedForKey: true, generation: 2, phase: 'conflicting' },
      });
    }
  });

  test('does not count terminal pull-request metadata warnings as open-review attention', () => {
    for (const status of ['merged', 'closed'] as const) {
      const terminal = pullRequest(status, { observation: observation({ ci: 'failing', status }) });
      expect(hasPullRequestWarningMetadata(terminal)).toBe(true);
      expect(pullRequestNeedsAttention(terminal)).toBe(false);
    }
  });
});
