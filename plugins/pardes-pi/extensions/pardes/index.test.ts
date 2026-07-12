import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import pardesManager, { createPardesCommandHandler, isNormalUserInputSource } from './index.ts';
import type { ManagerController, ManagerState } from './manager/index.ts';
import type { ManagerPresentation } from './presentation/index.ts';
import type { CanonicalReport } from './reporting/index.ts';
import { requiredValue } from './test-support.ts';
import {
  ReportDeliveryCoordinator,
  type ReportDeliveryScheduler,
} from './tools/report-delivery.ts';
import { REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE } from './tools/report-delivery-content.ts';

const temporaryDirectories: string[] = [];
const originalStateDir = process.env.PARDES_PI_STATE_DIR;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
  if (originalStateDir === undefined) delete process.env.PARDES_PI_STATE_DIR;
  else process.env.PARDES_PI_STATE_DIR = originalStateDir;
});

function registeredEvents(factory: (pi: ExtensionAPI) => void): ReadonlyArray<string> {
  const events: string[] = [];
  factory({
    on(event: string) {
      events.push(event);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    registerTool() {},
  } as unknown as ExtensionAPI);
  return events;
}

const stoppedRun = [{ role: 'assistant', stopReason: 'stop' }] as const;

function commandDeliveryHarness() {
  const tasks: Array<{ cancelled: boolean; readonly task: () => void }> = [];
  const sent: Array<{ readonly message: unknown; readonly options: unknown }> = [];
  const notifications: unknown[] = [];
  const scheduler: ReportDeliveryScheduler = {
    schedule(_delayMs, task) {
      const scheduled = { cancelled: false, task };
      tasks.push(scheduled);
      return () => {
        scheduled.cancelled = true;
      };
    },
  };
  const pi = {
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const delivery = new ReportDeliveryCoordinator(pi, scheduler);
  const state = {
    agents: {},
    inbox: [],
    managerId: 'manager-fixture',
    pullRequests: {},
    repo: {
      currentCheckout: '/fixture/repository',
      gitCommonDir: '/fixture/repository/.git',
      key: 'fixture/repository',
      primaryCheckout: '/fixture/repository',
    },
    revision: 0,
    schemaVersion: 1,
    verifications: {},
    workstreamCompletionIntents: {},
    workstreams: {},
  } as ManagerState;
  let active = true;
  let deactivatedAfterClear = false;
  const manager = {
    activate: () =>
      Effect.sync(() => {
        active = true;
        return state;
      }),
    deactivate: () =>
      Effect.sync(() => {
        deactivatedAfterClear = !delivery.isActive && delivery.acquirePermit() === undefined;
        active = false;
      }),
    runtimeSnapshots: () => new Map(),
    snapshot: () => (active ? state : undefined),
  } as unknown as ManagerController;
  const ctx = {
    isIdle: () => true,
    ui: { notify: (...args: unknown[]) => notifications.push(args) },
  } as unknown as ExtensionCommandContext;
  const handler = createPardesCommandHandler(pi, manager, {} as ManagerPresentation, delivery);
  const report = (reportId: string): CanonicalReport => ({
    agentId: 'agent-fixture',
    content: 'x'.repeat(80_000),
    field: 'details',
    reportId,
    status: 'completed',
    totalChars: 80_000,
  });
  const startReport = (reportId: string, toolCallId: string) =>
    delivery.start(report(reportId), toolCallId, requiredValue(delivery.acquirePermit()));
  return {
    ctx,
    delivery,
    handler,
    notifications,
    report,
    sent,
    startReport,
    tasks,
    wasDeactivatedAfterClear: () => deactivatedAfterClear,
  };
}

describe('Pardes package extension registration', () => {
  test('installs coordinating-manager compaction plus report-delivery settlement observation', () => {
    const events = registeredEvents(pardesManager);

    expect(events.filter((event) => event === 'session_before_compact')).toHaveLength(2);
    expect(events.filter((event) => event === 'session_compact')).toHaveLength(2);
    expect(events).toContain('input');
  });

  test('stops a scheduled report delivery synchronously before manager deactivation', async () => {
    const fixture = commandDeliveryHarness();
    fixture.startReport('report-scheduled', 'tool-scheduled');
    fixture.delivery.observeAgentEnd(stoppedRun, fixture.ctx);
    const staleDispatch = requiredValue(fixture.tasks[0]);

    await fixture.handler('stop', fixture.ctx);
    staleDispatch.task();

    expect(fixture.wasDeactivatedAfterClear()).toBe(true);
    expect(fixture.delivery.isActive).toBe(false);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({
      message: {
        customType: REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
        details: { reason: 'manager_stopped', resumable: true },
      },
      options: { deliverAs: 'steer' },
    });
    expect(fixture.notifications).toContainEqual([
      'Pardes manager stopped: manager-fixture',
      'info',
    ]);
  });

  test('stops an acknowledged in-flight report without scheduling another part', async () => {
    const fixture = commandDeliveryHarness();
    fixture.startReport('report-in-flight', 'tool-in-flight');
    fixture.delivery.observeAgentEnd(stoppedRun, fixture.ctx);
    requiredValue(fixture.tasks[0]).task();
    const dispatched = requiredValue(fixture.sent[0]);
    const delivered = { ...(dispatched.message as object), role: 'custom' as const };
    fixture.delivery.observeMessageStart(delivered);
    fixture.delivery.observeMessageEnd(delivered);

    await fixture.handler('stop', fixture.ctx);
    fixture.delivery.observeAgentEnd(stoppedRun, fixture.ctx);

    expect(fixture.wasDeactivatedAfterClear()).toBe(true);
    expect(fixture.delivery.isActive).toBe(false);
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      message: {
        customType: REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
        details: { nextPart: 1, reason: 'manager_stopped', resumable: true },
      },
    });
    expect(fixture.tasks).toHaveLength(1);
  });

  test('stops a compaction-held delivery and restarts without stale identity or timers', async () => {
    const fixture = commandDeliveryHarness();
    const old = fixture.startReport('report-old', 'tool-old');
    fixture.delivery.observeAgentEnd(stoppedRun, fixture.ctx);
    fixture.delivery.observeCompactionStart();
    const staleTasks = [...fixture.tasks];

    await fixture.handler('stop', fixture.ctx);
    await fixture.handler('start', fixture.ctx);
    const restarted = fixture.startReport('report-new', 'tool-new');
    for (const stale of staleTasks) stale.task();

    expect(fixture.delivery.activeReportId).toBe('report-new');
    expect(restarted.metadata.deliveryId).not.toBe(old.metadata.deliveryId);
    expect(
      fixture.sent.filter(
        ({ message }) =>
          (message as { customType?: unknown }).customType === 'pardes-canonical-report-delivery',
      ),
    ).toEqual([]);

    fixture.delivery.observeAgentEnd(stoppedRun, fixture.ctx);
    const currentDispatch = requiredValue(fixture.tasks.findLast((task) => !task.cancelled));
    currentDispatch.task();
    expect(fixture.sent.at(-1)?.message).toMatchObject({
      details: { deliveryId: restarted.metadata.deliveryId, reportId: 'report-new' },
    });
  });

  test('uses the supported input source field only for normal user messages', () => {
    expect(isNormalUserInputSource('interactive')).toBe(true);
    expect(isNormalUserInputSource('rpc')).toBe(true);
    expect(isNormalUserInputSource('extension')).toBe(false);
  });

  test('routes /pardes config to the persisted presentation owner without manager activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-config-command-'));
    temporaryDirectories.push(root);
    process.env.PARDES_PI_STATE_DIR = root;
    let pardesCommand: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    pardesManager({
      on() {},
      registerCommand(
        name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) {
        if (name === 'pardes') pardesCommand = options.handler;
      },
      registerMessageRenderer() {},
      registerShortcut() {},
      registerTool() {},
    } as unknown as ExtensionAPI);
    const notifications: unknown[] = [];
    const ctx = {
      hasUI: false,
      ui: { notify: (...args: unknown[]) => notifications.push(args) },
    } as unknown as ExtensionCommandContext;

    await requiredValue(pardesCommand)('config', ctx);

    expect(notifications).toEqual([['Pardes verbose tool results: off.', 'info']]);
  });
});
