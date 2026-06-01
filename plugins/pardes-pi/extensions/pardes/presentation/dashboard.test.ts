import type { ContextUsage, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { type AgentRecord, initialManagerState, type Workstream } from '../manager/index.ts';
import { requiredValue } from '../test-support.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import {
  bridgeMonitorLines,
  compactWidgetLines,
  dashboardLines,
  makeManagerPresentation,
} from './index.ts';

const { showDashboardOverlay, updateDashboard } = makeManagerPresentation();

const createdAt = '2026-06-01T00:00:00.000Z';
const agentId = 'agent-12345678';

function fixtureState(agentOverrides: Partial<AgentRecord> = {}) {
  const state = initialManagerState('manager-12345678', {
    currentCheckout: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    key: 'repo-1',
    primaryCheckout: '/tmp/repo',
  });
  const workstream: Workstream = {
    createdAt,
    id: 'ws-1',
    objective: 'Keep manager status legible.',
    status: 'active',
    title: 'Dashboard presentation',
    updatedAt: createdAt,
  };
  const agent: AgentRecord = {
    createdAt,
    id: agentId,
    model: 'openai-codex/gpt-5.4',
    role: 'worker',
    sessionDir: '/tmp/session',
    status: 'running',
    task: 'Inspect the RPC supervisor and report structural improvements.',
    thinkingLevel: 'high',
    updatedAt: createdAt,
    workstreamId: workstream.id,
    ...agentOverrides,
  };
  return { ...state, agents: { [agent.id]: agent }, workstreams: { [workstream.id]: workstream } };
}

function runtimeFixture(overrides: Partial<WorkerRuntimeSnapshot> = {}): WorkerRuntimeSnapshot {
  return {
    agentId,
    completedCompactionCount: 0,
    model: 'openai-codex/gpt-5.4',
    pid: 123,
    sampledAt: 2_000,
    sessionFile: '/tmp/session.jsonl',
    startedAt: 1_000,
    stats: {
      contextUsage: { contextWindow: 10_000, percent: 50, tokens: 5_000 },
      cost: 0.125,
      tokens: { cacheRead: 400, cacheWrite: 100, input: 1_200, output: 300, total: 2_000 },
      toolCalls: 3,
      totalMessages: 8,
    },
    status: 'running',
    stderr: '',
    task: 'Inspect the RPC supervisor and report structural improvements.',
    thinkingLevel: 'high',
    ...overrides,
  };
}

function markupTheme(): Theme {
  return {
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as unknown as Theme;
}

describe('pardes dashboard', () => {
  test('renders a separator and groups a running worker beneath its owning workstream', () => {
    const runtime = runtimeFixture();
    const lines = dashboardLines(fixtureState(), new Map([[runtime.agentId, runtime]]), 71_000);

    expect(lines).toEqual([
      'pardes manager- · 1 workstream · 1 agent (1 running · 0 idle) · 0 PRs · inbox 0',
      '────────────────────────────────────────────────────────────────',
      '  ws-1 [active] Dashboard presentation',
      '    ● running agent-12345678 · 1m10s · gpt-5.4 · [█████░░░░░] ctx 50% 5K/10K · tok 2K · $0.125',
      '      task: Inspect the RPC supervisor and report structural improvements.',
    ]);
    expect(lines.join('\n')).not.toContain('live workers:');
  });

  test('uses future title and active timing fields when present while making idle warnings explicit', () => {
    const state = fixtureState();
    const futureAgent = {
      ...requiredValue(state.agents[agentId]),
      lastError: 'fixture warning',
      status: 'idle' as const,
      title: 'Dashboard artisan',
    };
    const futureRuntime = { ...runtimeFixture({ status: 'idle' }), totalActiveMs: 42_000 };
    const lines = dashboardLines(
      { ...state, agents: { [agentId]: futureAgent } },
      new Map([[agentId, futureRuntime]]),
      1,
    );

    expect(lines[0]).toContain('1 agent (0 running · 1 idle · 1 warning)');
    expect(lines.join('\n')).toContain(
      '○ idle Dashboard artisan · active 42s · gpt-5.4 · [█████░░░░░] ctx 50% 5K/10K · tok 2K · $0.125 · ⚠ error',
    );
    const runningLines = dashboardLines(
      state,
      new Map([
        [agentId, { ...runtimeFixture(), currentAskElapsedMs: 3_000, totalActiveMs: 42_000 }],
      ]),
      1,
    );
    expect(runningLines.join('\n')).toContain('ask 3s · active 42s');
  });

  test('adds short derived suffixes to visible idle rows without flooding terminal history', () => {
    const idle = fixtureState({ status: 'idle' });
    const reviewGate = {
      agentId,
      createdAt,
      id: 'pr-42',
      number: 42,
      status: 'open' as const,
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/42',
      workstreamId: 'ws-1',
    };
    const reviewState = { ...idle, pullRequests: { [reviewGate.id]: reviewGate } };
    const reviewCompact = compactWidgetLines(reviewState).join('\n');
    const reviewDetailed = dashboardLines(reviewState).join('\n');

    expect(reviewCompact).toContain('○ idle [░░░░░░░░░░] ctx … tok … $…');
    expect(reviewCompact).toContain('review gate agent-12345678');
    expect(reviewCompact).not.toContain(' · review gate');
    expect(reviewDetailed).toContain(' · review gate');
    expect(compactWidgetLines(idle).join('\n')).toContain(' unclassified agent-12345678');

    const mergedGate = { ...reviewGate, status: 'merged' as const };
    expect(
      compactWidgetLines({ ...idle, pullRequests: { [mergedGate.id]: mergedGate } }).join('\n'),
    ).toContain(' retire pending agent-12345678');

    const attention = fixtureState({ lastError: 'worker warning', status: 'idle' });
    expect(compactWidgetLines(attention).join('\n')).toContain(
      '⚠ error needs attention agent-12345678',
    );

    const terminal = fixtureState({
      gitAudit: { checkedAt: createdAt, dirty: true, status: 'succeeded', trigger: 'completion' },
      status: 'stopped',
    });
    const terminalText = compactWidgetLines({
      ...terminal,
      pullRequests: { [mergedGate.id]: mergedGate },
    }).join('\n');
    expect(terminalText).toContain('■ stopped [░░░░░░░░░░] ctx … tok … $…');
    expect(terminalText).toContain('⚠ dirty worktree agent-12345678');
    expect(terminalText).not.toContain('retire pending');
    expect(terminalText).not.toContain('unclassified');
  });

  test('surfaces unresolved delivered-cursor age and queued inbox suffix compactly', () => {
    const state = fixtureState();
    const inbox = [
      { createdAt, id: 'event-delivered', summary: 'First question.', type: 'agent_question' },
      { createdAt, id: 'event-suffix', summary: 'Later question.', type: 'agent_question' },
    ];
    const delivered = {
      ...state,
      inbox,
      inboxWake: { createdAt, cursor: inbox[0]?.id, pendingCount: 1, token: 'wake-delivered' },
    };

    expect(compactWidgetLines(delivered, new Map(), Date.parse(createdAt) + 65_000)[0]).toContain(
      '· inbox 2 · delivered age:1m05s · suffix:1',
    );
    expect(dashboardLines(delivered, new Map(), Date.parse(createdAt) + 65_000)[0]).toContain(
      '· inbox 2 · delivered age:1m05s · suffix:1',
    );
  });

  test('projects queued delivery and active compaction concisely across dashboard surfaces', () => {
    const runtime = runtimeFixture({
      autoCompactionEnabled: true,
      compactionReason: 'threshold',
      isCompacting: true,
      pendingMessageCount: 3,
    });
    const runtimes = new Map([[runtime.agentId, runtime]]);
    const compact = compactWidgetLines(fixtureState(), runtimes, 71_000).join('\n');
    const detailed = dashboardLines(fixtureState(), runtimes, 71_000).join('\n');

    expect(compact).toContain(
      'ctx 50% 5K/10K tok 2K $0.125 queued:3 compacting:threshold 1m10s agent-12345678',
    );
    expect(detailed).toContain(
      'ctx 50% 5K/10K · tok 2K · $0.125 · queued:3 · compacting:threshold',
    );
    expect(compact.match(/queued:3/g)).toHaveLength(1);
    expect(compact.match(/compacting:threshold/g)).toHaveLength(1);
  });

  test('packs compact metrics left, shows useful compaction counts, and keeps the human title rightmost', () => {
    const state = fixtureState({
      lastError: 'fixture warning',
      status: 'idle',
      title: 'Dashboard artisan',
    });
    const runtime = runtimeFixture({
      autoCompactionEnabled: false,
      completedCompactionCount: 2,
      status: 'idle',
    });
    const line = requiredValue(
      compactWidgetLines(state, new Map([[runtime.agentId, runtime]]), 71_000).find((candidate) =>
        candidate.includes('○ idle'),
      ),
    );

    expect(line).toContain(
      '○ idle [█████░░░░░] ctx 50% 5K/10K tok 2K $0.125 cmp:2 1m10s ⚠ error,auto-compact off needs attention Dashboard artisan',
    );
    expect(line).not.toContain(' · ');
    expect(line.endsWith('Dashboard artisan')).toBe(true);

    const fallback = requiredValue(
      compactWidgetLines(fixtureState(), new Map([[agentId, runtimeFixture()]]), 71_000).find(
        (candidate) => candidate.includes('● running'),
      ),
    );
    expect(fallback).not.toContain('cmp:0');
    expect(fallback.endsWith('agent-12345678')).toBe(true);
  });

  test('labels unknown post-compaction context usage as recalibrating without flooding completion history', () => {
    const stats = requiredValue(runtimeFixture().stats);
    const runtime = runtimeFixture({
      lastCompaction: {
        aborted: false,
        completedAt: 2_000,
        reason: 'overflow',
        succeeded: true,
        tokensBefore: 9_876,
        willRetry: false,
      },
      stats: { ...stats, contextUsage: { contextWindow: 10_000, percent: null, tokens: null } },
    });
    const runtimes = new Map([[runtime.agentId, runtime]]);
    const compact = compactWidgetLines(fixtureState(), runtimes, 71_000).join('\n');
    const detailed = dashboardLines(fixtureState(), runtimes, 71_000).join('\n');

    expect(compact).toContain('[░░░░░░░░░░] ctx recalibrating tok 2K $0.125');
    expect(detailed).toContain('[░░░░░░░░░░] ctx recalibrating · tok 2K · $0.125');
    expect(compact.match(/recalibrating/g)).toHaveLength(1);
    expect(compact).not.toContain('overflow');
    expect(compact).not.toContain('9.9K');
  });

  test('warns once per attached worker when auto-compaction is disabled without retaining terminal noise', () => {
    const runtime = runtimeFixture({ autoCompactionEnabled: false });
    const compact = compactWidgetLines(
      fixtureState(),
      new Map([[runtime.agentId, runtime]]),
      71_000,
    ).join('\n');
    const detailed = dashboardLines(
      fixtureState(),
      new Map([[runtime.agentId, runtime]]),
      71_000,
    ).join('\n');

    expect(compact).toContain('· 1 warning · inbox 0');
    expect(compact.match(/⚠ auto-compact off/g)).toHaveLength(1);
    expect(detailed.match(/⚠ auto-compact off/g)).toHaveLength(1);

    const stopped = { ...runtime, status: 'stopped' as const };
    const stoppedState = fixtureState({ status: 'stopped' });
    const completed = {
      ...requiredValue(stoppedState.workstreams['ws-1']),
      status: 'complete' as const,
    };
    const terminal = compactWidgetLines(
      { ...stoppedState, workstreams: { [completed.id]: completed } },
      new Map([[stopped.agentId, stopped]]),
      71_000,
    ).join('\n');
    expect(terminal).not.toContain('auto-compact off');
    expect(terminal).not.toContain('ws-1 [complete]');
  });

  test('surfaces failed and dirty latest Git audits as compact worker warnings', () => {
    const failed = fixtureState({
      gitAudit: {
        checkedAt: createdAt,
        failureSummary: 'inspection unavailable',
        status: 'failed',
        trigger: 'stop',
      },
      status: 'stopped',
    });
    const dirty = fixtureState({
      gitAudit: { checkedAt: createdAt, dirty: true, status: 'succeeded', trigger: 'completion' },
      status: 'stopped',
    });

    const failedText = compactWidgetLines(failed, new Map(), 71_000).join('\n');
    const dirtyText = compactWidgetLines(dirty, new Map(), 71_000).join('\n');

    expect(failedText).toContain('· 1 warning · inbox 0');
    expect(failedText).toContain('⚠ git audit failed');
    expect(dirtyText).toContain('· 1 warning · inbox 0');
    expect(dirtyText).toContain('⚠ dirty worktree');
  });

  test('keeps the headless compact header inline with an unknown manager context summary', () => {
    const lines = compactWidgetLines(
      fixtureState(),
      new Map([[agentId, runtimeFixture()]]),
      71_000,
    );

    expect(lines[0]).toBe('pardes manager- · [░░░░░░░░░░] ctx … · 1 running · 0 idle · inbox 0');
    expect(lines[1]).toBe('────────────────────────────────────────────────────────────────');
  });

  test('renders known manager Pi context usage inline and resamples recalibration on widget rerender', () => {
    const runtime = runtimeFixture();
    const state = fixtureState();
    const theme = markupTheme();
    const widgets = new Map<string, unknown>();
    let usage: ContextUsage = { contextWindow: 10_000, percent: 50, tokens: 5_000 };
    let samples = 0;
    const ctx = {
      getContextUsage: () => {
        samples += 1;
        return usage;
      },
      hasUI: true,
      ui: {
        setStatus: () => {},
        setTitle: () => {},
        setWidget: (key: string, value: unknown) => {
          widgets.set(key, value);
        },
        theme,
      },
    } as unknown as ExtensionContext;

    updateDashboard(ctx, state, new Map([[runtime.agentId, runtime]]));

    const component = (
      widgets.get('pardes-manager') as (
        _tui: unknown,
        theme: Theme,
      ) => { render: (width: number) => string[] }
    )({}, theme);
    const knownLines = component.render(500);
    expect(knownLines[0]).toContain(
      '<dim> · [█████░░░░░] ctx 50% 5K/10K · 1 running · 0 idle · inbox 0</dim>',
    );
    expect(knownLines[1]).toContain(
      '────────────────────────────────────────────────────────────────',
    );

    usage = { contextWindow: 10_000, percent: null, tokens: null };
    const recalibratingLines = component.render(500);
    expect(recalibratingLines[0]).toContain(
      '<dim> · [░░░░░░░░░░] ctx … …/10K · 1 running · 0 idle · inbox 0</dim>',
    );
    expect(samples).toBe(2);
  });

  test('places the compact themed component below the editor while the separate bridge monitor stays above it', () => {
    const runtime = runtimeFixture();
    const state = fixtureState();
    const theme = markupTheme();
    const widgets = new Map<string, { readonly value: unknown; readonly options: unknown }>();
    const ctx = {
      getContextUsage: () => undefined,
      hasUI: true,
      ui: {
        setStatus: () => {},
        setTitle: () => {},
        setWidget: (key: string, value: unknown, options?: unknown) => {
          widgets.set(key, { options, value });
        },
        theme,
      },
    } as unknown as ExtensionContext;

    updateDashboard(ctx, state, new Map([[runtime.agentId, runtime]]));

    const dashboard = widgets.get('pardes-manager');
    expect(dashboard?.options).toEqual({ placement: 'belowEditor' });
    expect(typeof dashboard?.value).toBe('function');
    expect(Array.isArray(dashboard?.value)).toBe(false);
    expect(widgets.get('pardes-bridge-monitor')?.options).toEqual({ placement: 'aboveEditor' });
    const lines = (
      dashboard?.value as (_tui: unknown, theme: Theme) => { render: (width: number) => string[] }
    )({}, theme).render(500);
    expect(lines.join('\n')).toContain(
      '<borderMuted>────────────────────────────────────────────────────────────────</borderMuted>',
    );
    expect(lines.join('\n')).toContain(
      '<success>● running</success> <dim>[█████░░░░░] ctx 50% 5K/10K tok 2K $0.125',
    );
    expect(lines.join('\n')).toContain('</dim> <accent>agent-12345678</accent>');
    expect(
      compactWidgetLines(state, new Map([[runtime.agentId, runtime]]), 71_000).join('\n'),
    ).not.toContain('<accent>');
  });

  test('omits idle planned backlog while retaining active, attached, and warning rows', () => {
    const state = fixtureState();
    const plannedBacklog: Workstream = {
      ...requiredValue(state.workstreams['ws-1']),
      id: 'ws-planned-backlog',
      status: 'planned',
      title: 'Idle planned backlog',
    };
    const warningWorkstream: Workstream = {
      ...plannedBacklog,
      id: 'ws-warning',
      title: 'Warning owner',
    };
    const warningAgent: AgentRecord = {
      ...requiredValue(state.agents[agentId]),
      id: 'agent-warning1',
      lastError: 'worker stopped unexpectedly',
      status: 'stopped',
      workstreamId: warningWorkstream.id,
    };
    const expandedState = {
      ...state,
      agents: { ...state.agents, [warningAgent.id]: warningAgent },
      workstreams: {
        ...state.workstreams,
        [plannedBacklog.id]: plannedBacklog,
        [warningWorkstream.id]: warningWorkstream,
      },
    };
    const text = compactWidgetLines(
      expandedState,
      new Map([[agentId, runtimeFixture()]]),
      71_000,
    ).join('\n');

    expect(text).toContain('ws-1 [active]');
    expect(text).toContain(
      '● running [█████░░░░░] ctx 50% 5K/10K tok 2K $0.125 1m10s agent-12345678',
    );
    expect(text).toContain('ws-warning [planned]');
    expect(text).toContain('■ stopped [░░░░░░░░░░] ctx … tok … $… 0s ⚠ error agent-warning1');
    expect(text).not.toContain('ws-planned-backlog');
    expect(text).not.toContain('hidden');
    expect(dashboardLines(expandedState).join('\n')).toContain(
      'ws-planned-backlog [planned] Idle planned backlog',
    );
  });

  test('keeps all live workers while prioritizing active streams and summarizing live compact overflow', () => {
    const state = fixtureState();
    const makeWorkstream = (id: string, status: Workstream['status']): Workstream => ({
      createdAt,
      id,
      objective: `Objective ${id}`,
      status,
      title: `Title ${id}`,
      updatedAt: createdAt,
    });
    const idleAgent: AgentRecord = {
      ...requiredValue(state.agents[agentId]),
      id: 'agent-deadbeef',
      status: 'idle',
      workstreamId: 'ws-inactive-live',
    };
    const expandedState = {
      ...state,
      agents: { ...state.agents, [idleAgent.id]: idleAgent },
      workstreams: {
        ...state.workstreams,
        'ws-active-2': makeWorkstream('ws-active-2', 'active'),
        'ws-active-3': makeWorkstream('ws-active-3', 'active'),
        'ws-active-4': makeWorkstream('ws-active-4', 'active'),
        'ws-inactive-hidden': makeWorkstream('ws-inactive-hidden', 'complete'),
        'ws-inactive-live': makeWorkstream('ws-inactive-live', 'planned'),
        'ws-planned-backlog': makeWorkstream('ws-planned-backlog', 'planned'),
      },
    };

    const lines = compactWidgetLines(expandedState, new Map([[agentId, runtimeFixture()]]), 71_000);
    const text = lines.join('\n');

    expect(text).toContain(
      '● running [█████░░░░░] ctx 50% 5K/10K tok 2K $0.125 1m10s agent-12345678',
    );
    expect(text).toContain('○ idle [░░░░░░░░░░] ctx … tok … $… 0s unclassified agent-deadbeef');
    expect(text).toContain('ws-active-2 [active]');
    expect(text).toContain('ws-inactive-live [planned]');
    expect(text).not.toContain('ws-planned-backlog [planned]');
    expect(text).not.toContain('ws-inactive-hidden [complete]');
    expect(text).toContain('… 2 active workstreams hidden');
    expect(text).not.toContain(' inactive workstream');
    expect(text).not.toContain('task:');
  });

  test('fully hides completed history without a visible worker while retaining a live row', () => {
    const state = fixtureState({ status: 'stopped' });
    const workstream = { ...requiredValue(state.workstreams['ws-1']), status: 'complete' as const };
    const completedState = { ...state, workstreams: { [workstream.id]: workstream } };
    const text = compactWidgetLines(completedState, new Map(), 71_000).join('\n');

    expect(text).not.toContain('ws-1 [complete]');
    expect(text).not.toContain('hidden');

    const liveText = compactWidgetLines(
      completedState,
      new Map([[agentId, runtimeFixture()]]),
      71_000,
    ).join('\n');
    expect(liveText).toContain('ws-1 [complete]');
    expect(liveText).toContain('● running [█████░░░░░] ctx 50% 5K/10K tok 2K $0.125');
  });

  test('hides idle planned and cancelled streams unless they own a warning row', () => {
    const state = fixtureState({ status: 'stopped' });
    const planned = { ...requiredValue(state.workstreams['ws-1']), status: 'planned' as const };
    const plannedState = { ...state, workstreams: { [planned.id]: planned } };
    const plannedText = compactWidgetLines(plannedState, new Map(), 71_000).join('\n');
    expect(plannedText).not.toContain('ws-1 [planned]');
    expect(plannedText).not.toContain('hidden');
    expect(dashboardLines(plannedState).join('\n')).toContain('ws-1 [planned]');

    const cancelled = { ...planned, status: 'cancelled' as const };
    const cancelledState = { ...state, workstreams: { [cancelled.id]: cancelled } };
    const hiddenText = compactWidgetLines(cancelledState, new Map(), 71_000).join('\n');
    expect(hiddenText).not.toContain('ws-1 [cancelled]');
    expect(hiddenText).not.toContain('hidden');

    const warningAgent = {
      ...requiredValue(state.agents[agentId]),
      lastError: 'worker stopped unexpectedly',
    };
    const warningText = compactWidgetLines(
      { ...cancelledState, agents: { [agentId]: warningAgent } },
      new Map(),
      71_000,
    ).join('\n');
    expect(warningText).toContain('ws-1 [cancelled]');
    expect(warningText).toContain(
      '■ stopped [░░░░░░░░░░] ctx … tok … $… 0s ⚠ error agent-12345678',
    );
    expect(warningText).toContain('⚠ error');
  });

  test('shows associated draft pull requests in compact and expanded dashboards, even without other live rows', () => {
    const state = fixtureState();
    const withPullRequest = {
      ...state,
      pullRequests: {
        'pr-42': {
          agentId,
          baseBranch: 'main',
          createdAt,
          draft: true,
          headBranch: 'pardes/manager-1/agent-12345678',
          id: 'pr-42',
          number: 42,
          status: 'open' as const,
          title: 'Dashboard review gate',
          updatedAt: createdAt,
          url: 'https://github.test/acme/project/pull/42',
          workstreamId: 'ws-1',
        },
      },
    };

    expect(compactWidgetLines(withPullRequest).join('\n')).toContain(
      '↗ PR #42 [draft] Dashboard review gate · https://github.test/acme/project/pull/42',
    );
    const planned = {
      ...requiredValue(withPullRequest.workstreams['ws-1']),
      status: 'planned' as const,
    };
    const pullRequestOnlyState = {
      ...withPullRequest,
      agents: {
        [agentId]: {
          ...requiredValue(withPullRequest.agents[agentId]),
          status: 'stopped' as const,
        },
      },
      workstreams: { [planned.id]: planned },
    };
    expect(compactWidgetLines(pullRequestOnlyState).join('\n')).toContain(
      '↗ PR #42 [draft] Dashboard review gate · https://github.test/acme/project/pull/42',
    );
    expect(dashboardLines(withPullRequest)[0]).toContain('· 1 PR · inbox 0');
    expect(dashboardLines(withPullRequest).join('\n')).toContain(
      '↗ PR #42 [draft] Dashboard review gate',
    );
  });

  test('omits terminal pull request history compactly while retaining it in the detailed dashboard', () => {
    const state = fixtureState({ status: 'stopped' });
    const completed = { ...requiredValue(state.workstreams['ws-1']), status: 'complete' as const };
    const withTerminalHistory = {
      ...state,
      pullRequests: {
        'pr-42': {
          agentId,
          createdAt,
          id: 'pr-42',
          number: 42,
          status: 'merged' as const,
          updatedAt: createdAt,
          url: 'https://github.test/acme/project/pull/42',
          workstreamId: completed.id,
        },
        'pr-43': {
          agentId,
          createdAt,
          id: 'pr-43',
          number: 43,
          status: 'closed' as const,
          updatedAt: createdAt,
          url: 'https://github.test/acme/project/pull/43',
          workstreamId: completed.id,
        },
      },
      workstreams: { [completed.id]: completed },
    };
    const compact = compactWidgetLines(withTerminalHistory).join('\n');
    const detailed = dashboardLines(withTerminalHistory).join('\n');
    const active = { ...completed, status: 'active' as const };
    const selectedCompact = compactWidgetLines({
      ...withTerminalHistory,
      workstreams: { [active.id]: active },
    }).join('\n');

    expect(compact).not.toContain('ws-1 [complete]');
    expect(compact).not.toContain('↗ PR #42');
    expect(compact).not.toContain('↗ PR #43');
    expect(selectedCompact).toContain('ws-1 [active]');
    expect(selectedCompact).not.toContain('↗ PR #42');
    expect(selectedCompact).not.toContain('↗ PR #43');
    expect(detailed).toContain('ws-1 [complete]');
    expect(detailed).toContain('↗ PR #42 [merged]');
    expect(detailed).toContain('↗ PR #43 [closed]');
  });

  test('uses bridge monitor pane rows for activity while retaining the waiting placeholder', () => {
    const worker = {
      agentId,
      label: 'Dashboard artisan',
      recentActivityLines: ['Inspecting overlay APIs', '› read'],
      status: 'running' as const,
      task: 'This task description should not consume a bridge pane row.',
    };
    const text = bridgeMonitorLines([worker], 100).join('\n');

    expect(text).toContain('Dashboard artisan · running');
    expect(text).toContain('Inspecting overlay APIs');
    expect(text).toContain('› read');
    expect(text).not.toContain('task:');
    expect(text).not.toContain('recent activity:');
    expect(bridgeMonitorLines([{ ...worker, recentActivityLines: [] }], 100).join('\n')).toContain(
      '(waiting for visible activity)',
    );
  });

  test('renders inactive overlays with the activation hint and recreates disposed overlay components', async () => {
    const theme = markupTheme();
    const components: unknown[] = [];
    const options: unknown[] = [];
    const presentation = makeManagerPresentation();
    const ctx = {
      hasUI: true,
      ui: {
        custom: async (
          factory: (
            _tui: unknown,
            theme: Theme,
            _keybindings: unknown,
            done: () => void,
          ) => { render: (width: number) => string[] },
          receivedOptions: unknown,
        ) => {
          options.push(receivedOptions);
          components.push(factory({}, theme, {}, () => {}));
        },
      },
    } as unknown as ExtensionContext;

    await presentation.showDashboardOverlay(ctx, undefined);
    await presentation.showDashboardOverlay(ctx, undefined);

    expect(components).toHaveLength(2);
    expect(components[0]).not.toBe(components[1]);
    expect(
      (components[0] as { render: (width: number) => string[] }).render(500).join('\n'),
    ).toContain('Pardes manager is inactive');
    expect(
      (components[0] as { render: (width: number) => string[] }).render(500).join('\n'),
    ).toContain('Run /pardes start to activate a manager for this Pi session.');
    expect(options).toEqual([
      {
        overlay: true,
        overlayOptions: { anchor: 'center', margin: 1, maxHeight: '80%', width: '80%' },
      },
      {
        overlay: true,
        overlayOptions: { anchor: 'center', margin: 1, maxHeight: '80%', width: '80%' },
      },
    ]);
  });

  test('retains the inactive-manager fallback outside interactive TUI mode', async () => {
    const notifications: unknown[] = [];
    const ctx = {
      hasUI: false,
      ui: {
        notify: (...args: unknown[]) => notifications.push(args),
      },
    } as unknown as ExtensionContext;

    await makeManagerPresentation().showDashboardOverlay(ctx, undefined);

    expect(notifications).toEqual([['Pardes manager is inactive.', 'info']]);
  });

  test('renders the grouped dashboard and themed sections inside the overlay', async () => {
    const state = fixtureState();
    const historicalWorkstream = {
      ...requiredValue(state.workstreams['ws-1']),
      id: 'ws-history',
      status: 'complete' as const,
      title: 'Completed history',
    };
    const plannedWorkstream = {
      ...requiredValue(state.workstreams['ws-1']),
      id: 'ws-planned',
      status: 'planned' as const,
      title: 'Durable planned backlog',
    };
    const mergedPullRequest = {
      agentId,
      createdAt,
      id: 'pr-history',
      number: 42,
      status: 'merged' as const,
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/42',
      workstreamId: historicalWorkstream.id,
    };
    const overlayState = {
      ...state,
      pullRequests: { [mergedPullRequest.id]: mergedPullRequest },
      workstreams: {
        ...state.workstreams,
        [historicalWorkstream.id]: historicalWorkstream,
        [plannedWorkstream.id]: plannedWorkstream,
      },
    };
    const theme = markupTheme();
    let rendered = '';
    let options: unknown;
    const ctx = {
      hasUI: true,
      ui: {
        custom: async (
          factory: (
            _tui: unknown,
            theme: Theme,
            _keybindings: unknown,
            done: () => void,
          ) => { render: (width: number) => string[] },
          receivedOptions: unknown,
        ) => {
          options = receivedOptions;
          rendered = factory({}, theme, {}, () => {})
            .render(500)
            .join('\n');
        },
      },
    } as unknown as ExtensionContext;

    await showDashboardOverlay(ctx, overlayState);

    expect(options).toMatchObject({ overlay: true, overlayOptions: { anchor: 'center' } });
    expect(rendered).toContain('<accent><bold>Pardes control plane</bold></accent>');
    expect(rendered).toContain('<accent>Commands:</accent>');
    expect(rendered.indexOf('<accent>ws-1</accent>')).toBeLessThan(
      rendered.indexOf('<accent>agent-12345678</accent>'),
    );
    expect(rendered).toContain(
      '<accent>ws-history</accent> <muted>[complete]</muted> Completed history',
    );
    expect(rendered).toContain('<accent>↗ PR #42</accent> <muted>[merged]</muted>');
    expect(rendered).toContain(
      '<accent>ws-planned</accent> <dim>[planned]</dim> Durable planned backlog',
    );
  });
});
