import { describe, expect, test } from 'vitest';
import { requiredValue } from '../../test-support.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../../worker-runtime/index.ts';
import {
  type AgentRecord,
  initialManagerState,
  type ManagerEvent,
  type ManagerState,
  type PullRequestRecord,
  type Workstream,
  type WorkstreamStatus,
} from '../domain.ts';
import {
  AUTONOMOUS_INBOX_PATH,
  boundManagerGuidance,
  MANAGER_GUIDANCE_BOUNDS,
  MANAGER_GUIDANCE_MAX_CHARS,
  MANAGER_GUIDANCE_MAX_LINE_CHARS,
  MANAGER_GUIDANCE_MAX_LINES,
  MANAGER_GUIDANCE_MESSAGE_TYPE,
  type ManagerGuidanceReason,
  managerGuidanceReasonForSessionStart,
  PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE,
  queueManagerGuidance,
  renderManagerGuidance,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
} from './index.ts';

const createdAt = '2026-06-01T00:00:00.000Z';
const reasons = ['activated', 'restored', 'reloaded', 'compacted'] as const;

function fixtureState(): ManagerState {
  return initialManagerState('manager-guidance', {
    currentCheckout: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    key: 'repo-guidance',
    primaryCheckout: '/tmp/repo',
  });
}

function workstream(id: string, status: WorkstreamStatus): Workstream {
  return {
    createdAt,
    id,
    objective: `Objective for ${id}`,
    status,
    title: `Title for ${id}`,
    updatedAt: createdAt,
  };
}

function agent(
  id: string,
  status: WorkerStatus,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    createdAt,
    id,
    model: 'fixture/model',
    role: 'worker',
    sessionDir: `/tmp/${id}`,
    status,
    task: `Task for ${id}`,
    thinkingLevel: 'high',
    updatedAt: createdAt,
    workstreamId: 'ws-active',
    ...overrides,
  };
}

function runtime(
  agentId: string,
  status: WorkerStatus,
  overrides: Partial<WorkerRuntimeSnapshot> = {},
): WorkerRuntimeSnapshot {
  return {
    agentId,
    completedCompactionCount: 0,
    model: 'fixture/model',
    pid: 123,
    sampledAt: 2,
    sessionFile: `/tmp/${agentId}.jsonl`,
    startedAt: 1,
    stats: undefined,
    status,
    stderr: '',
    task: `Task for ${agentId}`,
    thinkingLevel: 'high',
    ...overrides,
  };
}

function reviewGate(
  id: string,
  status: PullRequestRecord['status'],
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    agentId: 'agent-running',
    createdAt,
    draft: true,
    id,
    status,
    updatedAt: createdAt,
    url: `https://example.test/${id}`,
    workstreamId: 'ws-active',
    ...overrides,
  };
}

function inboxEvent(id: string): ManagerEvent {
  return { createdAt, id, summary: `Fixture ${id}`, type: 'fixture' };
}

function expectWithinTierBounds(guidance: string, reason: ManagerGuidanceReason): void {
  const bounds = MANAGER_GUIDANCE_BOUNDS[reason];
  expect(guidance.split('\n').length).toBeLessThanOrEqual(bounds.maxLines);
  expect(guidance.split('\n').every((line) => line.length <= bounds.maxLineChars)).toBe(true);
  expect(guidance.length).toBeLessThanOrEqual(bounds.maxChars);
}

function operationalFixture(): {
  readonly state: ManagerState;
  readonly runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>;
} {
  const state = {
    ...fixtureState(),
    agents: {
      'agent-crashed': agent('agent-crashed', 'stopped'),
      'agent-idle': agent('agent-idle', 'running'),
      'agent-running': agent('agent-running', 'running'),
      'agent-starting': agent('agent-starting', 'starting'),
      'agent-stopped': agent('agent-stopped', 'stopped'),
      'agent-warning': agent('agent-warning', 'stopped', {
        lastError: 'review required',
        sessionFile: '/tmp/agent-warning.jsonl',
      }),
    },
    inbox: [inboxEvent('event-1'), inboxEvent('event-2')],
    pullRequests: {
      'pr-merged': reviewGate('pr-merged', 'merged', {
        observation: {
          ci: 'unknown',
          mergeable: 'conflicting',
          number: 3,
          reviewDecision: 'unknown',
          status: 'merged',
        },
      }),
      'pr-open-draft': reviewGate('pr-open-draft', 'open', {
        observation: {
          ci: 'failing',
          mergeable: 'unknown',
          number: 1,
          reviewDecision: 'unknown',
          status: 'open',
        },
      }),
      'pr-open-ready': reviewGate('pr-open-ready', 'open', {
        draft: false,
        watcherFailedAt: createdAt,
      }),
    },
    workstreams: {
      'ws-active': workstream('ws-active', 'active'),
      'ws-cancelled': workstream('ws-cancelled', 'cancelled'),
      'ws-complete': workstream('ws-complete', 'complete'),
      'ws-planned': workstream('ws-planned', 'planned'),
    },
  };
  const runtimes = new Map([
    ['agent-running', runtime('agent-running', 'running', { pendingMessageCount: 2 })],
    ['agent-idle', runtime('agent-idle', 'idle', { isCompacting: true, pendingMessageCount: 3 })],
    ['agent-crashed', runtime('agent-crashed', 'crashed')],
  ]);
  return { runtimes, state };
}

describe('Pardes manager lifecycle guidance', () => {
  test('suppresses every lifecycle tier while manager mode is inactive', () => {
    const messages: unknown[] = [];
    const pi = { sendMessage: (...args: unknown[]) => messages.push(args) };

    for (const reason of reasons) {
      expect(renderManagerGuidance(undefined, reason)).toBeUndefined();
      expect(queueManagerGuidance(pi, undefined, new Map(), reason)).toBe(false);
    }
    expect(messages).toEqual([]);
  });

  test('fully teaches the operating model on initial activation without assuming prior knowledge', () => {
    const guidance = requiredValue(renderManagerGuidance(fixtureState(), 'activated'));

    expect(guidance).toContain('Pardes manager activated. This is a coordination control plane');
    expect(guidance).toContain(
      'software owns deterministic mechanics and you own engineering judgment',
    );
    expect(guidance).toContain('do not implement, shell-operate, test, or manually verify');
    expect(guidance).toContain('delegate one coherent end-to-end outcome per worker');
    expect(guidance).toContain('request advisory `verification_request({ sourceAgentId })`');
    expect(guidance).toContain('wait for durable inbox delivery without polling');
    expect(guidance).toContain('use `pull_request_create` for exact committed worker state');
    expect(guidance).toContain('user controls merges');
    expect(guidance).toContain('inspect `pardes_status(view="inbox")`');
    expect(guidance).toContain('State:');
    expect(guidance.split('\n')).toHaveLength(12);
    expectWithinTierBounds(guidance, 'activated');
  });

  test('explains restoration before selective resume guidance', () => {
    const guidance = requiredValue(renderManagerGuidance(fixtureState(), 'restored'));

    expect(guidance).toContain('Pardes manager restored. Persisted state is authoritative');
    expect(guidance).toContain(
      'process-scoped child runtimes do not survive a prior manager process',
    );
    expect(guidance).toContain('attachment is not assumed');
    expect(guidance).toContain('account for open review gates');
    expect(guidance).toContain('revive only detached retained conversations that should continue');
    expect(guidance).toContain(
      'Use `pardes_status(view="cleanup")` only for explicit resolved-artifact guidance',
    );
    expect(guidance.split('\n')).toHaveLength(11);
    expectWithinTierBounds(guidance, 'restored');
  });

  test('explains intentional plugin reload, pinned-snapshot refresh, preservation, and next actions', () => {
    const guidance = requiredValue(renderManagerGuidance(fixtureState(), 'reloaded'));

    expect(managerGuidanceReasonForSessionStart('reload')).toBe('reloaded');
    for (const reason of ['startup', 'new', 'resume', 'fork'] as const) {
      expect(managerGuidanceReasonForSessionStart(reason)).toBe('restored');
    }
    expect(guidance).toContain('Pardes plugin reloaded.');
    expect(guidance).toContain('intentionally rebound to loaded plugin code');
    expect(guidance).toContain('refreshed its pinned child-runtime snapshot');
    expect(guidance).toContain('former child RPC attachments disconnected');
    expect(guidance).toContain('managed worktrees and retained conversations were preserved');
    expect(guidance).toContain('revive selectively');
    expect(guidance).toContain('State:');
    expect(guidance.split('\n')).toHaveLength(10);
    expectWithinTierBounds(guidance, 'reloaded');
  });

  test('deliberately reteaches the operating model after compaction with an operational snapshot', () => {
    const { state, runtimes } = operationalFixture();
    const guidance = requiredValue(renderManagerGuidance(state, 'compacted', runtimes));

    expect(guidance).toContain('Pardes manager compacted.');
    expect(guidance).toContain('Persisted state and the coordinating suffix are authoritative');
    expect(guidance).toContain('deliberately re-establish the operating model');
    expect(guidance).toContain('do not implement, shell-operate, test, or manually verify');
    expect(guidance).toContain('delegate one coherent end-to-end outcome per worker');
    expect(guidance).toContain('request advisory verification');
    expect(guidance).toContain(
      'publish exact committed worker state only through `pull_request_create`',
    );
    expect(guidance).toContain('State: streams');
    expect(guidance).toContain('Workers:');
    expect(guidance).toContain('Attention:');
    expect(guidance.split('\n')).toHaveLength(13);
    expectWithinTierBounds(guidance, 'compacted');
  });

  test('states the same explicit two-path judgment rule across every lifecycle variant', () => {
    for (const reason of reasons) {
      const guidance = requiredValue(renderManagerGuidance(fixtureState(), reason));
      expect(guidance).toContain(AUTONOMOUS_INBOX_PATH);
      expect(guidance).toContain(USER_JUDGMENT_INBOX_PATH);
      expect(guidance).toContain(USER_JUDGMENT_HANDOFF_PATH);
      expect(guidance).toContain(PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE);
      expect(guidance).not.toContain('\n\n');
      expect(guidance).not.toContain('#');
      expect(guidance).not.toContain('```');
      expectWithinTierBounds(guidance, reason);
    }
  });

  test('keeps runtime reminders portable and free of repository-specific diagnostic chores', () => {
    const forbiddenRuntimeText = [
      'bun',
      'review:summary',
      'github actions',
      'fast-forward sync',
      'local diagnostics',
      'clean audited shas',
      'configured hosted checks',
      'agent_reload',
    ];

    for (const reason of reasons) {
      const guidance = renderManagerGuidance(fixtureState(), reason)?.toLowerCase();
      for (const forbidden of forbiddenRuntimeText) expect(guidance).not.toContain(forbidden);
    }
  });

  test('queues visible lifecycle messages only for the next user turn', () => {
    const messages: unknown[] = [];
    const pi = { sendMessage: (...args: unknown[]) => messages.push(args) };
    const state = fixtureState();

    for (const reason of reasons) {
      expect(queueManagerGuidance(pi, state, new Map(), reason)).toBe(true);
    }

    expect(messages).toHaveLength(reasons.length);
    for (const [index, reason] of reasons.entries()) {
      expect(messages[index]).toEqual([
        {
          content: renderManagerGuidance(state, reason),
          customType: MANAGER_GUIDANCE_MESSAGE_TYPE,
          details: { reason },
          display: true,
        },
        { deliverAs: 'nextTurn' },
      ]);
    }
  });

  test('recomputes dynamic counts from durable state and attached runtime projections', () => {
    const { state, runtimes } = operationalFixture();
    const restored = requiredValue(renderManagerGuidance(state, 'restored', runtimes));
    const compacted = requiredValue(renderManagerGuidance(state, 'compacted', runtimes));

    expect(restored).toContain(
      'streams 4 total (1 active/1 planned/1 complete); workers 6 total (3 attached/3 detached, 1 revivable).',
    );
    expect(restored).toContain(
      'Attention: 1 running/1 idle; 4 warnings; inbox 2; 2 open review gates (1 draft).',
    );
    expect(compacted).toContain('4 total; 1 active/1 planned/1 complete/1 cancelled.');
    expect(compacted).toContain(
      '6 total; 3 attached/3 detached/1 revivable; states 1 starting/1 running/1 idle/2 stopped/1 crashed; compacting 1; queued 5.',
    );
    expect(compacted).toContain(
      'Attention: 2 worker warnings; 2 review warnings; inbox 2; 2 open review gates (1 draft).',
    );
  });

  test('counts failed and dirty latest Git audits as lifecycle-guidance warnings', () => {
    const state = {
      ...fixtureState(),
      agents: {
        'agent-dirty-audit': agent('agent-dirty-audit', 'stopped', {
          gitAudit: {
            checkedAt: createdAt,
            dirty: true,
            status: 'succeeded',
            trigger: 'completion',
          },
        }),
        'agent-failed-audit': agent('agent-failed-audit', 'stopped', {
          gitAudit: {
            checkedAt: createdAt,
            failureSummary: 'inspection unavailable',
            status: 'failed',
            trigger: 'stop',
          },
        }),
      },
    };

    expect(renderManagerGuidance(state, 'restored')).toContain('2 warnings; inbox 0');
  });

  test('hard-bounds every tier without enumerating large manager lists', () => {
    for (const reason of reasons) {
      const bounded = boundManagerGuidance(
        Array.from({ length: 100 }, () => 'x'.repeat(1_000)),
        MANAGER_GUIDANCE_BOUNDS[reason],
      );
      expectWithinTierBounds(bounded, reason);
      expect(bounded.endsWith('…')).toBe(true);
    }

    const state = {
      ...fixtureState(),
      agents: Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => {
          const id = `agent-large-${index}`;
          return [id, agent(id, 'stopped', { sessionFile: `/tmp/${id}.jsonl` })];
        }),
      ),
      workstreams: Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => {
          const id = `ws-large-${index}`;
          return [id, { ...workstream(id, 'planned'), title: 'large-title-'.repeat(100) }];
        }),
      ),
    };

    for (const reason of reasons) {
      const guidance = requiredValue(renderManagerGuidance(state, reason));
      expect(guidance).not.toContain('ws-large-');
      expect(guidance).not.toContain('agent-large-');
      expectWithinTierBounds(guidance, reason);
    }
    expect(renderManagerGuidance(state, 'activated')).toContain(
      'streams 500 total (0 active/500 planned/0 complete); workers 500 total (0 attached/500 detached, 500 revivable).',
    );
    expect(MANAGER_GUIDANCE_MAX_LINES).toBe(13);
    expect(MANAGER_GUIDANCE_MAX_LINE_CHARS).toBe(320);
    expect(MANAGER_GUIDANCE_MAX_CHARS).toBe(3_800);
  });
});
