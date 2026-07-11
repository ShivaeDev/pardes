import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { type CanonicalReport, REPORT_DETAILS_MAX_CHARS } from '../reporting/index.ts';
import { requiredValue } from '../test-support.ts';
import {
  REPORT_DELIVERY_COMPACTION_TIMEOUT_MS,
  ReportDeliveryCoordinator,
  type ReportDeliveryScheduler,
} from './report-delivery.ts';
import {
  partitionCanonicalReport,
  REPORT_DELIVERY_DETAIL_TYPE,
  REPORT_DELIVERY_PART_MAX_BYTES,
  renderCanonicalReportPart,
} from './report-delivery-content.ts';

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

  test('fails closed on unrelated interleaving and on unsettled compaction', () => {
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
