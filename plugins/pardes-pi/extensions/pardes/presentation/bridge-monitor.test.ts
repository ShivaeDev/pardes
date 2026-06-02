import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, test } from 'vitest';
import { type AgentRecord, initialManagerState } from '../manager/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import { type BridgeMonitorWorker, bridgeMonitorLines, makeManagerPresentation } from './index.ts';

const createdAt = '2026-06-01T00:00:00.000Z';

function worker(agentId: string, activity: ReadonlyArray<string> = []): BridgeMonitorWorker {
  return {
    agentId,
    label: agentId,
    recentActivityLines: activity,
    status: 'running',
    task: `Implement ${agentId} while keeping a deliberately long task description visible in the monitor.`,
  };
}

function fixtureState(status: WorkerStatus = 'running', managerId = 'manager-monitor') {
  const state = initialManagerState(managerId, {
    currentCheckout: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    key: 'repo-1',
    primaryCheckout: '/tmp/repo',
  });
  const agent: AgentRecord = {
    createdAt,
    id: 'agent-monitor',
    model: 'fixture/model',
    role: 'worker',
    sessionDir: '/tmp/session',
    status,
    task: 'Render recent child activity without stealing editor focus.',
    thinkingLevel: 'low',
    updatedAt: createdAt,
    workstreamId: 'ws-monitor',
  };
  return { ...state, agents: { [agent.id]: agent } };
}

function runtime(status: WorkerStatus = 'running'): WorkerRuntimeSnapshot {
  return {
    agentId: 'agent-monitor',
    completedCompactionCount: 0,
    model: 'fixture/model',
    pid: 123,
    recentActivityLines: ['Inspecting widget APIs', '› read: extensions/pardes/ui.ts'],
    sampledAt: undefined,
    sessionFile: '/tmp/session.jsonl',
    startedAt: 1_000,
    stats: undefined,
    status,
    stderr: { omittedChars: 0, originalChars: 0, shownChars: 0, tail: '' },
    task: 'Render recent child activity without stealing editor focus.',
    thinkingLevel: 'low',
  };
}

function plainTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
}

interface WidgetCall {
  readonly key: string;
  readonly value: unknown;
  readonly options: unknown;
}

interface Harness {
  readonly ctx: ExtensionContext;
  readonly widgetCalls: WidgetCall[];
  readonly customCalls: unknown[];
}

let cleanupContext: ExtensionContext | undefined;
let presentation = makeManagerPresentation();

function harness(): Harness {
  const widgetCalls: WidgetCall[] = [];
  const customCalls: unknown[] = [];
  const theme = plainTheme();
  const ctx = {
    hasUI: true,
    ui: {
      custom: (...args: unknown[]) => {
        customCalls.push(args);
        return Promise.resolve();
      },
      setStatus: () => {},
      setTitle: () => {},
      setWidget: (key: string, value: unknown, options?: unknown) => {
        widgetCalls.push({ key, options, value });
      },
      theme,
    },
  } as unknown as ExtensionContext;
  cleanupContext = ctx;
  return { ctx, customCalls, widgetCalls };
}

function lastWidgetCall(ui: Harness, key: string): WidgetCall {
  const call = ui.widgetCalls.filter((candidate) => candidate.key === key).at(-1);
  if (!call) throw new Error(`Missing widget call for ${key}`);
  return call;
}

function renderWidget(value: unknown, width = 100, terminalRows = 80): string[] {
  if (typeof value !== 'function') throw new Error('Expected widget component factory');
  const tui = { terminal: { rows: terminalRows } } as TUI;
  return (value as (_tui: TUI, theme: Theme) => Component)(tui, plainTheme()).render(width);
}

afterEach(() => {
  if (cleanupContext) presentation.clearDashboard(cleanupContext);
  cleanupContext = undefined;
  presentation = makeManagerPresentation();
});

describe('normal-layout bridge monitor rendering', () => {
  test('renders three panes per row on wide terminals and stacks additional rows', () => {
    const lines = bridgeMonitorLines(
      [worker('agent-one'), worker('agent-two'), worker('agent-three'), worker('agent-four')],
      100,
    );
    const firstRow = lines.find((line) => line.includes('agent-one'));
    const fourthRow = lines.findIndex((line) => line.includes('agent-four'));

    expect(firstRow).toContain('agent-two');
    expect(firstRow).toContain('agent-three');
    expect(fourthRow).toBeGreaterThan(lines.findIndex((line) => line.includes('agent-one')));
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
  });

  test('falls back to two medium columns and one narrow column with ANSI-aware truncation', () => {
    const workers = [
      worker('agent-one', [`\u001b[31m${'activity '.repeat(20)}\u001b[0m`]),
      worker('agent-two'),
      worker('agent-three'),
    ];
    const medium = bridgeMonitorLines(workers, 80);
    const narrow = bridgeMonitorLines(workers, 40);

    expect(medium.find((line) => line.includes('agent-one'))).toContain('agent-two');
    expect(medium.some((line) => line.includes('agent-one') && line.includes('agent-three'))).toBe(
      false,
    );
    expect(narrow.some((line) => line.includes('agent-one') && line.includes('agent-two'))).toBe(
      false,
    );
    expect(narrow.findIndex((line) => line.includes('agent-two'))).toBeGreaterThan(
      narrow.findIndex((line) => line.includes('agent-one')),
    );
    expect(medium.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(narrow.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  test('shows only the last five visible activity entries in a pane', () => {
    const text = bridgeMonitorLines(
      [
        worker(
          'agent-one',
          Array.from({ length: 6 }, (_, index) => `activity-${index + 1}`),
        ),
      ],
      100,
    ).join('\n');

    expect(text).not.toContain('activity-1');
    for (let index = 2; index <= 6; index++) expect(text).toContain(`activity-${index}`);
  });

  test('reduces activity rows as terminal height tightens and suppresses the monitor below its compact budget', () => {
    const active = worker(
      'agent-one',
      Array.from({ length: 6 }, (_, index) => `activity-${index + 1}`),
    );
    const tall = bridgeMonitorLines([active], 100, 33).join('\n');
    const constrained = bridgeMonitorLines([active], 100, 30).join('\n');

    expect(tall).toContain('activity-2');
    expect(tall).not.toContain('activity-1');
    expect(constrained).toContain('activity-5');
    expect(constrained).toContain('activity-6');
    expect(constrained).not.toContain('activity-4');
    expect(bridgeMonitorLines([active], 100, 28)).toEqual([]);
  });

  test('removes decorative pane padding and blank separators between stacked monitor rows', () => {
    const lines = bridgeMonitorLines(
      [
        worker('agent-one', ['activity-one']),
        worker('agent-two'),
        worker('agent-three'),
        worker('agent-four'),
      ],
      100,
    );

    expect(lines).not.toContain('');
    expect(lines.some((line) => line.startsWith('╭agent-one · running'))).toBe(true);
    expect(lines.some((line) => line.startsWith('│activity-one'))).toBe(true);
    expect(lines.join('\n')).not.toContain('│  activity-one');
    expect(lines).toHaveLength(7);
  });
});

describe('normal-layout bridge monitor lifecycle', () => {
  test('keeps the compact dashboard below the editor and the attached-worker monitor above it without opening custom UI', () => {
    const ui = harness();
    const running = runtime();

    presentation.updateDashboard(ui.ctx, fixtureState(), new Map([[running.agentId, running]]));
    expect(lastWidgetCall(ui, 'pardes-manager').options).toEqual({ placement: 'belowEditor' });
    const monitor = lastWidgetCall(ui, 'pardes-bridge-monitor');
    expect(monitor.options).toEqual({ placement: 'aboveEditor' });
    expect(renderWidget(monitor.value).join('\n')).toContain('agent-monitor');
    expect(renderWidget(monitor.value, 100, 29).join('\n')).toContain(
      '› read: extensions/pardes/ui.ts',
    );
    expect(renderWidget(monitor.value, 100, 29).join('\n')).not.toContain('Inspecting widget APIs');
    expect(renderWidget(monitor.value, 100, 28)).toEqual([]);
    expect(ui.customCalls).toHaveLength(0);

    const stopped = runtime('stopped');
    presentation.updateDashboard(
      ui.ctx,
      fixtureState('stopped'),
      new Map([[stopped.agentId, stopped]]),
    );
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBeUndefined();

    presentation.updateDashboard(ui.ctx, fixtureState(), new Map([[running.agentId, running]]));
    expect(renderWidget(lastWidgetCall(ui, 'pardes-bridge-monitor').value).join('\n')).toContain(
      'agent-monitor',
    );

    presentation.clearDashboard(ui.ctx);
    expect(lastWidgetCall(ui, 'pardes-manager').value).toBeUndefined();
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBeUndefined();
  });

  test('manual toggle stays hidden across current-manager renders, reshows, and does not create an empty widget', () => {
    const ui = harness();
    const state = fixtureState();
    const activeRuntime = runtime();
    const runtimes = new Map([[activeRuntime.agentId, activeRuntime]]);

    presentation.updateDashboard(ui.ctx, state, runtimes);
    expect(presentation.toggleBridgeMonitor(ui.ctx, state, runtimes)).toBe('hidden');
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBeUndefined();
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').options).toEqual({
      placement: 'aboveEditor',
    });

    presentation.updateDashboard(ui.ctx, state, runtimes);
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBeUndefined();

    expect(presentation.toggleBridgeMonitor(ui.ctx, state, runtimes)).toBe('shown');
    expect(typeof lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBe('function');
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').options).toEqual({
      placement: 'aboveEditor',
    });

    const stopped = runtime('stopped');
    expect(
      presentation.toggleBridgeMonitor(
        ui.ctx,
        fixtureState('stopped'),
        new Map([[stopped.agentId, stopped]]),
      ),
    ).toBe('unavailable');
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBeUndefined();
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').options).toEqual({
      placement: 'aboveEditor',
    });
  });

  test('manual visibility belongs only to one loaded presentation adapter', () => {
    const ui = harness();
    const activeRuntime = runtime();
    const runtimes = new Map([[activeRuntime.agentId, activeRuntime]]);
    const first = makeManagerPresentation();
    const second = makeManagerPresentation();
    const state = fixtureState();

    first.updateDashboard(ui.ctx, state, runtimes);
    expect(first.toggleBridgeMonitor(ui.ctx, state, runtimes)).toBe('hidden');
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBeUndefined();

    second.updateDashboard(ui.ctx, state, runtimes);
    expect(typeof lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBe('function');
  });

  test('manual visibility belongs only to the current manager session', () => {
    const ui = harness();
    const activeRuntime = runtime();
    const runtimes = new Map([[activeRuntime.agentId, activeRuntime]]);

    const first = fixtureState('running', 'manager-first');
    presentation.updateDashboard(ui.ctx, first, runtimes);
    expect(presentation.toggleBridgeMonitor(ui.ctx, first, runtimes)).toBe('hidden');
    expect(lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBeUndefined();

    presentation.updateDashboard(ui.ctx, fixtureState('running', 'manager-second'), runtimes);
    expect(typeof lastWidgetCall(ui, 'pardes-bridge-monitor').value).toBe('function');
  });
});
