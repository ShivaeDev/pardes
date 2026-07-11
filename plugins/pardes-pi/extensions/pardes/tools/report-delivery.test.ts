import {
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { type ManagerEvent, makeInboxWake, renderInboxWakeMessage } from '../manager/index.ts';
import { type CanonicalReport, REPORT_DETAILS_MAX_CHARS } from '../reporting/index.ts';
import { requiredValue } from '../test-support.ts';
import {
  REPORT_DELIVERY_COMPACTION_TIMEOUT_MS,
  REPORT_DELIVERY_OWNED_WAKE_TIMEOUT_MS,
  ReportDeliveryCoordinator,
  type ReportDeliveryScheduler,
  registerReportDelivery,
} from './report-delivery.ts';
import {
  REPORT_DELIVERY_COMPACTION_MAX_PLACEHOLDERS,
  REPORT_DELIVERY_COMPACTION_PLACEHOLDER_MAX_BYTES,
  sanitizeReportDeliveryCompactionPreparation,
} from './report-delivery-compaction.ts';
import {
  partitionCanonicalReport,
  REPORT_DELIVERY_DETAIL_TYPE,
  REPORT_DELIVERY_MESSAGE_TYPE,
  REPORT_DELIVERY_OUTCOME_MAX_BYTES,
  REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
  REPORT_DELIVERY_PART_MAX_BYTES,
  renderCanonicalReportPart,
} from './report-delivery-content.ts';

type CompactionPreparation = SessionBeforeCompactEvent['preparation'];

async function prepareWithPinnedPi(entries: SessionEntry[]): Promise<CompactionPreparation> {
  const packageEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const implementationUrl = new URL('./core/compaction/compaction.js', packageEntry).href;
  const implementation = (await import(/* @vite-ignore */ implementationUrl)) as {
    readonly prepareCompaction: (
      entries: SessionEntry[],
      settings: typeof DEFAULT_COMPACTION_SETTINGS,
    ) => CompactionPreparation | undefined;
  };
  return requiredValue(implementation.prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS));
}

function report(content: string, reportId = 'report-one'): CanonicalReport {
  return {
    agentId: 'agent-one',
    content,
    field: 'details',
    reportId,
    status: 'completed',
    totalChars: content.length,
  };
}

function startDelivery(
  delivery: ReportDeliveryCoordinator,
  canonicalReport: CanonicalReport,
  toolCallId: string,
) {
  return delivery.start(canonicalReport, toolCallId, requiredValue(delivery.acquirePermit()));
}

function schedulerHarness() {
  const tasks: Array<{ cancelled: boolean; readonly delayMs: number; readonly task: () => void }> =
    [];
  const scheduler: ReportDeliveryScheduler = {
    schedule(delayMs, task) {
      const scheduled = { cancelled: false, delayMs, task };
      tasks.push(scheduled);
      return () => {
        scheduled.cancelled = true;
      };
    },
  };
  const runNext = () => {
    const task = tasks.find((candidate) => !candidate.cancelled);
    requiredValue(task).cancelled = true;
    requiredValue(task).task();
    return task;
  };
  return { runNext, scheduler, tasks };
}

function harness() {
  const sent: Array<{ readonly message: unknown; readonly options: unknown }> = [];
  const scheduled = schedulerHarness();
  let idle = true;
  const pi = {
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  } as unknown as Pick<ExtensionAPI, 'sendMessage'>;
  const ctx = { isIdle: () => idle } as ExtensionContext;
  const delivery = new ReportDeliveryCoordinator(pi, scheduled.scheduler);
  const released: ExtensionContext[] = [];
  delivery.onOwnedWakeRelease((releaseContext) => released.push(releaseContext));
  return {
    ctx,
    delivery,
    released,
    runNext: scheduled.runNext,
    sent,
    setIdle(value: boolean) {
      idle = value;
    },
    tasks: scheduled.tasks,
  };
}

function deliveredMessage(sent: { readonly message: unknown }) {
  return { ...(sent.message as object), role: 'custom' as const } as {
    readonly role: 'custom';
    readonly details: Record<string, unknown>;
  };
}

function ownedWakeMessage(id: string, suffixCount = 0) {
  const createdAt = new Date(0).toISOString();
  const inbox: ManagerEvent[] = Array.from({ length: suffixCount + 1 }, (_, index) => ({
    createdAt,
    id: index === 0 ? id : `${id}-suffix-${index}`,
    summary: `Durable attention ${index + 1}`,
    type: 'agent_question',
  }));
  const wake = requiredValue(makeInboxWake('manager-owned-wake', inbox, createdAt));
  return {
    ...renderInboxWakeMessage({ inbox, wake }),
    role: 'custom' as const,
    timestamp: 0,
  };
}

const stoppedRun = [{ role: 'assistant', stopReason: 'stop' }];
const abortedRun = [{ role: 'assistant', stopReason: 'aborted' }];

describe('canonical report delivery', () => {
  test('partitions and reconstructs current maximum, hostile escaped, and surrogate content losslessly', () => {
    for (const content of [
      `${'ordinary line\n'.repeat(8_000)}tail`,
      `${'\u0000'.repeat(30_000)}tail`,
      `${'😀'.repeat(30_000)}tail`,
      'z'.repeat(REPORT_DETAILS_MAX_CHARS),
      '',
    ]) {
      const canonical = report(content);
      const ranges = partitionCanonicalReport(content);
      const active = { deliveryId: 'delivery-fixture', ranges, report: canonical };
      const parts = ranges.map((_, index) => renderCanonicalReportPart(active, index));

      expect(parts.map((part) => part.content).join('')).toBe(content);
      expect(parts.at(-1)?.metadata.complete).toBe(true);
      expect(parts.at(-1)?.metadata.automaticContinuation).toBe(false);
      for (const [index, part] of parts.entries()) {
        expect(part.metadata.part).toBe(index + 1);
        expect(part.metadata.parts).toBe(parts.length);
        expect(Buffer.byteLength(part.text, 'utf8')).toBeLessThanOrEqual(
          REPORT_DELIVERY_PART_MAX_BYTES,
        );
      }
    }
  });

  test('delivers every part in its own acknowledged triggerTurn run and never uses the shared queue', () => {
    const { ctx, delivery, runNext, sent, setIdle, tasks } = harness();
    const started = startDelivery(delivery, report('x'.repeat(120_000)), 'tool-call-one');

    expect(started.metadata.parts).toBeGreaterThan(1);
    expect(started.text).toContain('after this agent run settles');
    expect(sent).toEqual([]);
    delivery.observeAgentEnd(stoppedRun, ctx);
    expect(tasks).toHaveLength(1);

    setIdle(false);
    runNext();
    expect(sent).toEqual([]);
    expect(tasks).toHaveLength(2);
    setIdle(true);
    runNext();
    expect(sent).toHaveLength(1);

    for (let part = 1; part <= started.metadata.parts; part += 1) {
      const dispatched = requiredValue(sent[part - 1]);
      expect(dispatched.options).toEqual({ triggerTurn: true });
      expect(dispatched.message).toMatchObject({
        details: {
          deliveryId: started.metadata.deliveryId,
          part,
          parts: started.metadata.parts,
          reportId: 'report-one',
          type: REPORT_DELIVERY_DETAIL_TYPE,
        },
        display: false,
      });
      const message = deliveredMessage(dispatched);
      delivery.observeMessageStart(message);
      delivery.observeMessageEnd(message);
      delivery.observeAgentEnd(stoppedRun, ctx);
      if (part < started.metadata.parts) {
        runNext();
        expect(sent).toHaveLength(part + 1);
      }
    }

    expect(delivery.activeReportId).toBeUndefined();
    expect(sent).toHaveLength(started.metadata.parts);
  });

  test('holds owned wake release and tolerates one real cursor wake between report parts through compaction', () => {
    const { ctx, delivery, released, runNext, sent } = harness();
    const started = startDelivery(delivery, report('x'.repeat(120_000)), 'tool-call-owned-wake');
    expect(delivery.isHoldingOwnedWakes).toBe(true);
    delivery.observeAgentEnd(stoppedRun, ctx);
    runNext();

    const firstPart = deliveredMessage(requiredValue(sent[0]));
    delivery.observeMessageStart(firstPart, ctx);
    delivery.observeMessageEnd(firstPart);
    delivery.observeAgentEnd(stoppedRun, ctx);

    const createdAt = new Date(0).toISOString();
    const inbox: ManagerEvent[] = Array.from({ length: 5 }, (_, index) => ({
      createdAt,
      id: `event-${index + 1}`,
      summary: `Durable attention ${index + 1}`,
      type: 'agent_question',
    }));
    const wake = requiredValue(makeInboxWake('manager-owned-wake', inbox, createdAt));
    const wakeMessage = {
      ...renderInboxWakeMessage({ inbox, wake }),
      role: 'custom' as const,
      timestamp: 0,
    };
    expect(wakeMessage.details).toMatchObject({
      cursor: 'event-4',
      pendingCount: 4,
      queuedSuffixCount: 1,
      type: 'manager_inbox_wake',
    });

    expect(delivery.registerOwnedWake(wakeMessage, ctx)).toBe(true);
    delivery.observeCompactionStart(ctx);
    delivery.observeMessageStart(wakeMessage, ctx);
    delivery.observeMessageEnd(wakeMessage);
    delivery.observeAgentEnd(stoppedRun, ctx);
    expect(delivery.activeReportId).toBe('report-one');
    expect(released).toEqual([]);
    delivery.observeCompactionFailure(ctx);

    for (let part = 2; part <= started.metadata.parts; part += 1) {
      runNext();
      const dispatched = deliveredMessage(requiredValue(sent[part - 1]));
      delivery.observeMessageStart(dispatched, ctx);
      delivery.observeMessageEnd(dispatched);
      delivery.observeAgentEnd(stoppedRun, ctx);
    }

    expect(delivery.isHoldingOwnedWakes).toBe(false);
    expect(released).toEqual([ctx]);
    expect(sent).toHaveLength(started.metadata.parts);
    expect(
      sent.filter(
        ({ message }) =>
          (message as { customType?: unknown }).customType === REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
      ),
    ).toEqual([]);

    const compacted = harness();
    startDelivery(compacted.delivery, report('x'.repeat(80_000)), 'tool-wake-compact-success');
    compacted.delivery.observeAgentEnd(stoppedRun, compacted.ctx);
    const compactedWake = ownedWakeMessage('event-compact-success');
    expect(compacted.delivery.registerOwnedWake(compactedWake, compacted.ctx)).toBe(true);
    compacted.delivery.observeCompactionStart(compacted.ctx);
    compacted.delivery.observeMessageStart(compactedWake, compacted.ctx);
    compacted.delivery.observeMessageEnd(compactedWake);
    compacted.delivery.observeCompactionComplete(compacted.ctx);
    expect(compacted.tasks.filter((task) => !task.cancelled).map(({ delayMs }) => delayMs)).toEqual(
      [REPORT_DELIVERY_OWNED_WAKE_TIMEOUT_MS],
    );
    compacted.delivery.observeAgentEnd(stoppedRun, compacted.ctx);
    compacted.runNext();
    expect(compacted.sent[0]?.message).toMatchObject({ details: { part: 1 } });
  });

  test('settles one exact owned wake run without truncation in every report phase', () => {
    const cancellationCount = (sent: ReadonlyArray<{ readonly message: unknown }>) =>
      sent.filter(
        ({ message }) =>
          (message as { customType?: unknown }).customType === REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
      ).length;

    const initial = harness();
    startDelivery(initial.delivery, report('x'.repeat(80_000)), 'tool-initial-interlude');
    const initialWake = ownedWakeMessage('event-initial');
    expect(initial.delivery.registerOwnedWake(initialWake, initial.ctx)).toBe(true);
    initial.delivery.observeMessageStart(initialWake, initial.ctx);
    initial.delivery.observeMessageEnd(initialWake);
    initial.delivery.observeAgentEnd(stoppedRun, initial.ctx);
    initial.runNext();
    expect(initial.sent[0]?.message).toMatchObject({ details: { part: 1 } });
    expect(cancellationCount(initial.sent)).toBe(0);

    const waiting = harness();
    startDelivery(waiting.delivery, report('x'.repeat(80_000)), 'tool-waiting-interlude');
    waiting.delivery.observeAgentEnd(stoppedRun, waiting.ctx);
    const waitingWake = ownedWakeMessage('event-waiting');
    expect(waiting.delivery.registerOwnedWake(waitingWake, waiting.ctx)).toBe(true);
    waiting.delivery.observeMessageStart(waitingWake, waiting.ctx);
    waiting.delivery.observeMessageEnd(waitingWake);
    waiting.delivery.observeAgentEnd(stoppedRun, waiting.ctx);
    waiting.runNext();
    expect(waiting.sent[0]?.message).toMatchObject({ details: { part: 1 } });
    expect(cancellationCount(waiting.sent)).toBe(0);

    const dispatching = harness();
    startDelivery(dispatching.delivery, report('x'.repeat(80_000)), 'tool-dispatching-interlude');
    dispatching.delivery.observeAgentEnd(stoppedRun, dispatching.ctx);
    dispatching.runNext();
    const dispatchingWake = ownedWakeMessage('event-dispatching');
    expect(dispatching.delivery.registerOwnedWake(dispatchingWake, dispatching.ctx)).toBe(true);
    dispatching.delivery.observeMessageStart(dispatchingWake, dispatching.ctx);
    dispatching.delivery.observeMessageEnd(dispatchingWake);
    dispatching.delivery.observeAgentEnd(stoppedRun, dispatching.ctx);
    const dispatchedPart = deliveredMessage(requiredValue(dispatching.sent[0]));
    dispatching.delivery.observeMessageStart(dispatchedPart, dispatching.ctx);
    dispatching.delivery.observeMessageEnd(dispatchedPart);
    dispatching.delivery.observeAgentEnd(stoppedRun, dispatching.ctx);
    dispatching.runNext();
    expect(dispatching.sent[1]?.message).toMatchObject({ details: { part: 2 } });
    expect(cancellationCount(dispatching.sent)).toBe(0);

    const partRun = harness();
    startDelivery(partRun.delivery, report('x'.repeat(80_000)), 'tool-part-interlude');
    partRun.delivery.observeAgentEnd(stoppedRun, partRun.ctx);
    partRun.runNext();
    const acknowledgedPart = deliveredMessage(requiredValue(partRun.sent[0]));
    partRun.delivery.observeMessageStart(acknowledgedPart, partRun.ctx);
    partRun.delivery.observeMessageEnd(acknowledgedPart);
    const partWake = ownedWakeMessage('event-part');
    expect(partRun.delivery.registerOwnedWake(partWake, partRun.ctx)).toBe(true);
    partRun.delivery.observeMessageStart(partWake, partRun.ctx);
    partRun.delivery.observeMessageEnd(partWake);
    partRun.delivery.observeAgentEnd(stoppedRun, partRun.ctx);
    partRun.runNext();
    expect(partRun.sent[1]?.message).toMatchObject({ details: { part: 2 } });
    expect(cancellationCount(partRun.sent)).toBe(0);
  });

  test('keeps aggregate report contribution bounded while spanning a maximum-size report across runs', () => {
    const { ctx, delivery, runNext, sent } = harness();
    const content = '\u0000'.repeat(REPORT_DETAILS_MAX_CHARS);
    const started = startDelivery(delivery, report(content), 'tool-call-aggregate');
    const transcript: unknown[] = [];
    delivery.observeAgentEnd(stoppedRun, ctx);

    for (let part = 1; part <= started.metadata.parts; part += 1) {
      runNext();
      const dispatched = requiredValue(sent[part - 1]);
      const message = deliveredMessage(dispatched);
      transcript.push(message);
      delivery.observeMessageStart(message);
      delivery.observeMessageEnd(message);
      const context = delivery.contextMessages(transcript);
      expect(context).toHaveLength(1);
      const visible = requiredValue(context[0]) as { readonly content: string };
      expect(Buffer.byteLength(visible.content, 'utf8')).toBeLessThanOrEqual(
        REPORT_DELIVERY_PART_MAX_BYTES,
      );
      delivery.observeAgentEnd(stoppedRun, ctx);
    }

    expect(sent).toHaveLength(started.metadata.parts);
    expect(started.metadata.parts).toBeGreaterThan(500);
    expect(delivery.contextMessages(transcript)).toEqual([]);
  });

  test('sanitizes raw persisted report parts in Pi compaction preparation without rewriting durable entries', async () => {
    const entries: SessionEntry[] = [];
    let parentId: string | null = null;
    const rawBody = `RAW_REPORT_BODY_${'x'.repeat(45_000)}`;
    for (let index = 0; index < 100; index += 1) {
      const customId = `custom-${index}`;
      entries.push({
        content: rawBody,
        customType: REPORT_DELIVERY_MESSAGE_TYPE,
        details: {
          deliveryId: 'delivery-persisted',
          part: index + 1,
          parts: 100,
          reportId: 'report-persisted',
          type: REPORT_DELIVERY_DETAIL_TYPE,
        },
        display: false,
        id: customId,
        parentId,
        timestamp: new Date(index * 2).toISOString(),
        type: 'custom_message',
      });
      const assistantId = `assistant-${index}`;
      entries.push({
        id: assistantId,
        message: {
          api: 'fixture',
          content: [{ text: 'manager response '.repeat(80), type: 'text' }],
          model: 'fixture',
          provider: 'fixture',
          role: 'assistant',
          stopReason: 'stop',
          timestamp: index * 2 + 1,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 300,
            output: 20,
            totalTokens: 320,
          },
        },
        parentId: customId,
        timestamp: new Date(index * 2 + 1).toISOString(),
        type: 'message',
      } as SessionEntry);
      parentId = assistantId;
    }

    const preparation = await prepareWithPinnedPi(entries);
    const rawPrepared = preparation.messagesToSummarize.filter(
      (message) => message.role === 'custom' && message.customType === REPORT_DELIVERY_MESSAGE_TYPE,
    );
    expect(rawPrepared.length).toBeGreaterThan(10);
    expect(Buffer.byteLength(JSON.stringify(rawPrepared), 'utf8')).toBeGreaterThan(500_000);
    preparation.turnPrefixMessages.push({
      ...requiredValue(rawPrepared[0]),
      details: {
        part: 1,
        parts: 100,
        reportId: 'legacy-report',
        type: REPORT_DELIVERY_DETAIL_TYPE,
      },
    } as CompactionPreparation['turnPrefixMessages'][number]);

    sanitizeReportDeliveryCompactionPreparation(preparation);

    const sanitized = [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ].filter(
      (message) => message.role === 'custom' && message.customType === REPORT_DELIVERY_MESSAGE_TYPE,
    );
    expect(sanitized).toHaveLength(2);
    expect(sanitized.length).toBeLessThanOrEqual(REPORT_DELIVERY_COMPACTION_MAX_PLACEHOLDERS);
    for (const message of sanitized) {
      const messageContent = (message as { readonly content: unknown }).content;
      expect(typeof messageContent).toBe('string');
      expect(messageContent).not.toContain('RAW_REPORT_BODY_');
      expect(Buffer.byteLength(messageContent as string, 'utf8')).toBeLessThanOrEqual(
        REPORT_DELIVERY_COMPACTION_PLACEHOLDER_MAX_BYTES,
      );
    }
    expect(Buffer.byteLength(JSON.stringify(sanitized), 'utf8')).toBeLessThanOrEqual(
      REPORT_DELIVERY_COMPACTION_MAX_PLACEHOLDERS *
        REPORT_DELIVERY_COMPACTION_PLACEHOLDER_MAX_BYTES,
    );
    const manyDeliveries: CompactionPreparation = {
      ...preparation,
      messagesToSummarize: rawPrepared.map((message, index) => ({
        ...message,
        details: {
          deliveryId: `delivery-${index}`,
          part: 1,
          parts: 1,
          reportId: `report-${index}`,
          type: REPORT_DELIVERY_DETAIL_TYPE,
        },
      })) as CompactionPreparation['messagesToSummarize'],
      turnPrefixMessages: [],
    };
    sanitizeReportDeliveryCompactionPreparation(manyDeliveries);
    const cappedPlaceholders = manyDeliveries.messagesToSummarize.filter(
      (message) => message.role === 'custom' && message.customType === REPORT_DELIVERY_MESSAGE_TYPE,
    );
    expect(cappedPlaceholders).toHaveLength(REPORT_DELIVERY_COMPACTION_MAX_PLACEHOLDERS);
    expect(Buffer.byteLength(JSON.stringify(cappedPlaceholders), 'utf8')).toBeLessThanOrEqual(
      REPORT_DELIVERY_COMPACTION_MAX_PLACEHOLDERS *
        REPORT_DELIVERY_COMPACTION_PLACEHOLDER_MAX_BYTES,
    );

    const durableParts = entries.filter((entry) => entry.type === 'custom_message');
    expect(durableParts).toHaveLength(100);
    expect(durableParts.every((entry) => entry.content === rawBody)).toBe(true);
  });

  test('cancels exact pending identities across abort, clear, and reload without stale dispatch', () => {
    const first = harness();
    startDelivery(first.delivery, report('x'.repeat(80_000)), 'tool-call-old');
    first.delivery.observeAgentEnd(stoppedRun, first.ctx);
    const staleDispatch = requiredValue(first.tasks[0]);
    first.delivery.clear();
    staleDispatch.task();
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]).toMatchObject({
      message: {
        customType: REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
        details: { reason: 'manager_lifecycle_change', resumable: true },
      },
      options: { deliverAs: 'steer' },
    });

    const reloaded = harness();
    const next = startDelivery(reloaded.delivery, report('x'.repeat(80_000)), 'tool-call-new');
    reloaded.delivery.observeAgentEnd(stoppedRun, reloaded.ctx);
    reloaded.runNext();
    expect(reloaded.sent).toHaveLength(1);
    expect(reloaded.sent[0]?.message).toMatchObject({
      details: { deliveryId: next.metadata.deliveryId },
    });

    const inFlight = deliveredMessage(requiredValue(reloaded.sent[0]));
    reloaded.delivery.observeMessageStart(inFlight);
    reloaded.delivery.observeMessageEnd(inFlight);
    reloaded.delivery.observeAgentEnd(abortedRun, reloaded.ctx);
    expect(reloaded.delivery.activeReportId).toBeUndefined();
    expect(reloaded.tasks.filter((task) => !task.cancelled)).toEqual([]);
  });

  test('cancels unregistered, mismatched, duplicate, and replayed owned-wake lookalikes', () => {
    const unregistered = harness();
    startDelivery(unregistered.delivery, report('x'.repeat(80_000)), 'tool-unregistered');
    unregistered.delivery.observeMessageStart(
      ownedWakeMessage('event-unregistered'),
      unregistered.ctx,
    );
    expect(unregistered.delivery.activeReportId).toBeUndefined();
    expect(unregistered.sent[0]?.message).toMatchObject({
      details: { reason: 'unrelated_input' },
    });
    const mismatched = harness();
    startDelivery(mismatched.delivery, report('x'.repeat(80_000)), 'tool-mismatched');
    const expected = ownedWakeMessage('event-expected');
    expect(mismatched.delivery.registerOwnedWake(expected, mismatched.ctx)).toBe(true);
    const wrongToken = {
      ...expected,
      details: { ...expected.details, wakeToken: 'wake-0000000000000000' },
    };
    mismatched.delivery.observeMessageStart(wrongToken, mismatched.ctx);
    expect(mismatched.delivery.activeReportId).toBeUndefined();
    expect(mismatched.sent[0]?.message).toMatchObject({
      details: { reason: 'unrelated_input' },
    });

    const duplicate = harness();
    startDelivery(duplicate.delivery, report('x'.repeat(80_000)), 'tool-duplicate');
    const duplicateWake = ownedWakeMessage('event-duplicate');
    expect(duplicate.delivery.registerOwnedWake(duplicateWake, duplicate.ctx)).toBe(true);
    expect(duplicate.delivery.registerOwnedWake(duplicateWake, duplicate.ctx)).toBe(false);
    duplicate.delivery.observeMessageStart(duplicateWake, duplicate.ctx);
    duplicate.delivery.observeMessageEnd(duplicateWake);
    duplicate.delivery.observeMessageStart(duplicateWake, duplicate.ctx);
    expect(duplicate.delivery.activeReportId).toBeUndefined();

    const incomplete = harness();
    startDelivery(incomplete.delivery, report('x'.repeat(80_000)), 'tool-incomplete');
    const incompleteWake = ownedWakeMessage('event-incomplete');
    expect(incomplete.delivery.registerOwnedWake(incompleteWake, incomplete.ctx)).toBe(true);
    incomplete.delivery.observeMessageStart(incompleteWake, incomplete.ctx);
    incomplete.delivery.observeAgentEnd(stoppedRun, incomplete.ctx);
    expect(incomplete.delivery.activeReportId).toBeUndefined();
    expect(incomplete.sent[0]?.message).toMatchObject({
      details: { reason: 'settlement_mismatch' },
    });

    const timedOut = harness();
    startDelivery(timedOut.delivery, report('x'.repeat(80_000)), 'tool-wake-timeout');
    timedOut.delivery.observeAgentEnd(stoppedRun, timedOut.ctx);
    const timedOutWake = ownedWakeMessage('event-timeout');
    expect(timedOut.delivery.registerOwnedWake(timedOutWake, timedOut.ctx)).toBe(true);
    expect(timedOut.tasks.findLast((task) => !task.cancelled)?.delayMs).toBe(
      REPORT_DELIVERY_OWNED_WAKE_TIMEOUT_MS,
    );
    timedOut.runNext();
    expect(timedOut.delivery.activeReportId).toBeUndefined();
    expect(timedOut.sent[0]?.message).toMatchObject({
      details: { reason: 'owned_wake_timeout' },
    });
    expect(timedOut.released).toEqual([timedOut.ctx]);

    const replay = harness();
    startDelivery(replay.delivery, report('x'.repeat(80_000)), 'tool-replay');
    replay.delivery.observeAgentEnd(stoppedRun, replay.ctx);
    const replayWake = ownedWakeMessage('event-replay');
    expect(replay.delivery.registerOwnedWake(replayWake, replay.ctx)).toBe(true);
    replay.delivery.observeMessageStart(replayWake, replay.ctx);
    replay.delivery.observeMessageEnd(replayWake);
    replay.delivery.observeAgentEnd(stoppedRun, replay.ctx);
    expect(replay.delivery.activeReportId).toBe('report-one');
    replay.delivery.observeMessageStart(replayWake, replay.ctx);
    expect(replay.delivery.activeReportId).toBeUndefined();
    expect(replay.sent[0]?.message).toMatchObject({
      details: { reason: 'unrelated_input' },
    });
  });

  test('fails closed on unrelated interleaving and resumes known failed compaction', () => {
    const interleaved = harness();
    startDelivery(interleaved.delivery, report('x'.repeat(80_000)), 'tool-call-interleaved');
    interleaved.delivery.observeAgentEnd(stoppedRun, interleaved.ctx);
    const stale = requiredValue(interleaved.tasks[0]);
    interleaved.delivery.observeMessageStart(
      {
        customType: 'pardes-worker-event',
        details: { type: 'not_a_manager_inbox_wake' },
        role: 'custom',
      },
      interleaved.ctx,
    );
    stale.task();
    expect(interleaved.sent).toHaveLength(1);
    expect(interleaved.sent[0]).toMatchObject({
      message: {
        customType: REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
        details: { reason: 'unrelated_input', resumable: true },
      },
      options: { deliverAs: 'steer' },
    });
    expect(
      Buffer.byteLength((interleaved.sent[0]?.message as { content: string }).content, 'utf8'),
    ).toBeLessThanOrEqual(REPORT_DELIVERY_OUTCOME_MAX_BYTES);
    expect(interleaved.delivery.activeReportId).toBeUndefined();
    expect(interleaved.released).toEqual([interleaved.ctx]);

    const compacting = harness();
    startDelivery(compacting.delivery, report('x'.repeat(80_000)), 'tool-call-compacting');
    compacting.delivery.observeAgentEnd(stoppedRun, compacting.ctx);
    const preCompactionDispatch = requiredValue(compacting.tasks[0]);
    compacting.delivery.observeCompactionStart();
    expect(compacting.tasks.at(-1)?.delayMs).toBe(REPORT_DELIVERY_COMPACTION_TIMEOUT_MS);
    preCompactionDispatch.task();
    expect(compacting.sent).toEqual([]);
    compacting.delivery.observeCompactionComplete(compacting.ctx);
    compacting.runNext();
    expect(compacting.sent).toHaveLength(1);

    const failed = harness();
    const failedStart = startDelivery(
      failed.delivery,
      report('x'.repeat(80_000)),
      'tool-call-failed',
    );
    failed.delivery.observeAgentEnd(stoppedRun, failed.ctx);
    failed.delivery.observeCompactionStart();
    failed.delivery.observeCompactionFailure(failed.ctx);
    failed.runNext();
    expect(failed.delivery.activeReportId).toBe('report-one');
    expect(failed.sent).toHaveLength(1);
    for (let part = 1; part <= failedStart.metadata.parts; part += 1) {
      const message = deliveredMessage(requiredValue(failed.sent[part - 1]));
      failed.delivery.observeMessageStart(message, failed.ctx);
      failed.delivery.observeMessageEnd(message);
      failed.delivery.observeAgentEnd(stoppedRun, failed.ctx);
      if (part < failedStart.metadata.parts) failed.runNext();
    }
    expect(failed.released).toEqual([failed.ctx]);
    expect(failed.delivery.isHoldingOwnedWakes).toBe(false);

    const stalled = harness();
    startDelivery(stalled.delivery, report('x'.repeat(80_000)), 'tool-call-stalled');
    stalled.delivery.observeAgentEnd(stoppedRun, stalled.ctx);
    stalled.delivery.observeCompactionStart(stalled.ctx);
    stalled.runNext();
    expect(stalled.delivery.activeReportId).toBeUndefined();
    expect(stalled.sent).toHaveLength(1);
    expect(stalled.sent[0]?.message).toMatchObject({
      customType: REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
      details: { reason: 'compaction_timeout', resumable: true },
    });
    expect(stalled.released).toEqual([stalled.ctx]);
  });

  test('leases report acquisition and serializes a committed wake before report start', () => {
    const leased = harness();
    const permit = requiredValue(leased.delivery.acquirePermit());
    const deferredWake = ownedWakeMessage('event-during-read');

    expect(leased.delivery.isHoldingOwnedWakes).toBe(true);
    expect(leased.delivery.registerOwnedWake(deferredWake, leased.ctx)).toBe(false);
    expect(leased.delivery.releasePermit(permit, leased.ctx)).toBe(true);
    expect(leased.released).toEqual([leased.ctx]);
    expect(leased.delivery.isHoldingOwnedWakes).toBe(false);

    const committedWake = ownedWakeMessage('event-before-read');
    expect(leased.delivery.registerOwnedWake(committedWake, leased.ctx)).toBe(true);
    expect(leased.delivery.acquirePermit()).toBeUndefined();
    leased.delivery.observeMessageStart(committedWake, leased.ctx);
    leased.delivery.observeMessageEnd(committedWake);
    leased.delivery.observeAgentEnd(stoppedRun, leased.ctx);

    const afterWake = requiredValue(leased.delivery.acquirePermit());
    expect(leased.delivery.releasePermit(afterWake)).toBe(true);

    const timedOut = harness();
    expect(
      timedOut.delivery.registerOwnedWake(ownedWakeMessage('event-never-started'), timedOut.ctx),
    ).toBe(true);
    timedOut.runNext();
    expect(timedOut.delivery.isHoldingOwnedWakes).toBe(false);
    expect(timedOut.delivery.acquirePermit()).toBeDefined();
    expect(timedOut.sent).toEqual([]);
  });

  test('releases the process-lifecycle hold on reload and starts a fresh permit epoch', () => {
    const handlers = new Map<string, (event: { reason?: string }, ctx: ExtensionContext) => void>();
    const sent: Array<{ readonly message: unknown; readonly options: unknown }> = [];
    const pi = {
      on(event: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => void) {
        handlers.set(event, handler);
      },
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options });
      },
    } as unknown as ExtensionAPI;
    const delivery = registerReportDelivery(pi);
    startDelivery(delivery, report('reload body'), 'tool-call-reload');
    expect(delivery.isHoldingOwnedWakes).toBe(true);

    requiredValue(handlers.get('session_shutdown'))({ reason: 'reload' }, {} as ExtensionContext);

    expect(delivery.isHoldingOwnedWakes).toBe(false);
    expect(delivery.acquirePermit()).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toMatchObject({
      customType: REPORT_DELIVERY_OUTCOME_MESSAGE_TYPE,
      details: { reason: 'session_reload', resumable: true },
    });
    delivery.activate();
    const permit = requiredValue(delivery.acquirePermit());
    expect(permit).toEqual({ epoch: expect.any(Number) });
    expect(delivery.isHoldingOwnedWakes).toBe(true);
    expect(delivery.releasePermit(permit)).toBe(true);
    expect(delivery.isHoldingOwnedWakes).toBe(false);
  });

  test('rejects overlapping retrievals and mismatched delivery markers', () => {
    const { ctx, delivery, runNext, sent } = harness();
    startDelivery(delivery, report('x'.repeat(80_000)), 'tool-call-one');
    expect(delivery.acquirePermit()).toBeUndefined();
    delivery.observeAgentEnd(stoppedRun, ctx);
    runNext();
    const expected = deliveredMessage(requiredValue(sent[0]));
    delivery.observeMessageStart({
      ...expected,
      details: { ...(expected.details as object), deliveryId: 'wrong-delivery' },
    });
    expect(delivery.activeReportId).toBeUndefined();
  });
});
