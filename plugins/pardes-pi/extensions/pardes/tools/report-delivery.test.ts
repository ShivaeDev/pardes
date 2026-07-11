import {
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { type CanonicalReport, REPORT_DETAILS_MAX_CHARS } from '../reporting/index.ts';
import { requiredValue } from '../test-support.ts';
import {
  REPORT_DELIVERY_COMPACTION_TIMEOUT_MS,
  ReportDeliveryCoordinator,
  type ReportDeliveryScheduler,
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
  return {
    ctx,
    delivery: new ReportDeliveryCoordinator(pi, scheduled.scheduler),
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
    const started = delivery.start(report('x'.repeat(120_000)), 'tool-call-one');

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

  test('keeps aggregate report contribution bounded while spanning a maximum-size report across runs', () => {
    const { ctx, delivery, runNext, sent } = harness();
    const content = '\u0000'.repeat(REPORT_DETAILS_MAX_CHARS);
    const started = delivery.start(report(content), 'tool-call-aggregate');
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
    first.delivery.start(report('x'.repeat(80_000)), 'tool-call-old');
    first.delivery.observeAgentEnd(stoppedRun, first.ctx);
    const staleDispatch = requiredValue(first.tasks[0]);
    first.delivery.clear();
    staleDispatch.task();
    expect(first.sent).toEqual([]);

    const reloaded = harness();
    const next = reloaded.delivery.start(report('x'.repeat(80_000)), 'tool-call-new');
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

  test('fails closed on unrelated interleaving and resumes known failed compaction', () => {
    const interleaved = harness();
    interleaved.delivery.start(report('x'.repeat(80_000)), 'tool-call-interleaved');
    interleaved.delivery.observeAgentEnd(stoppedRun, interleaved.ctx);
    const stale = requiredValue(interleaved.tasks[0]);
    interleaved.delivery.observeMessageStart({ customType: 'unrelated', role: 'custom' });
    stale.task();
    expect(interleaved.sent).toEqual([]);
    expect(interleaved.delivery.activeReportId).toBeUndefined();

    const compacting = harness();
    compacting.delivery.start(report('x'.repeat(80_000)), 'tool-call-compacting');
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
    failed.delivery.start(report('x'.repeat(80_000)), 'tool-call-failed');
    failed.delivery.observeAgentEnd(stoppedRun, failed.ctx);
    failed.delivery.observeCompactionStart();
    failed.delivery.observeCompactionFailure(failed.ctx);
    failed.runNext();
    expect(failed.delivery.activeReportId).toBe('report-one');
    expect(failed.sent).toHaveLength(1);

    const stalled = harness();
    stalled.delivery.start(report('x'.repeat(80_000)), 'tool-call-stalled');
    stalled.delivery.observeAgentEnd(stoppedRun, stalled.ctx);
    stalled.delivery.observeCompactionStart();
    stalled.runNext();
    expect(stalled.delivery.activeReportId).toBeUndefined();
    expect(stalled.sent).toEqual([]);
  });

  test('rejects overlapping retrievals and mismatched delivery markers', () => {
    const { ctx, delivery, runNext, sent } = harness();
    delivery.start(report('x'.repeat(80_000)), 'tool-call-one');
    expect(() => delivery.start(report('other', 'report-two'), 'tool-call-two')).toThrow(
      'report-one is still being delivered',
    );
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
