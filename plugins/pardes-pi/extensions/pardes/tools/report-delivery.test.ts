import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { type CanonicalReport, REPORT_DETAILS_MAX_CHARS } from '../reporting/index.ts';
import { requiredValue } from '../test-support.ts';
import {
  partitionCanonicalReport,
  REPORT_DELIVERY_DETAIL_TYPE,
  REPORT_DELIVERY_MESSAGE_TYPE,
  REPORT_DELIVERY_PART_MAX_BYTES,
  ReportDeliveryCoordinator,
  renderCanonicalReportPart,
} from './report-delivery.ts';

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

function harness() {
  const sent: Array<{ readonly message: unknown; readonly options: unknown }> = [];
  const pi = {
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  } as unknown as Pick<ExtensionAPI, 'sendMessage'>;
  return { delivery: new ReportDeliveryCoordinator(pi), sent };
}

function deliveredMessage(sent: { readonly message: unknown }) {
  return { ...(sent.message as object), role: 'custom' as const };
}

describe('canonical report delivery', () => {
  test('partitions and reconstructs ordinary, hostile escaped, and surrogate-pair content losslessly', () => {
    for (const content of [
      `${'ordinary line\n'.repeat(8_000)}tail`,
      `${'\u0000'.repeat(30_000)}tail`,
      `${'😀'.repeat(30_000)}tail`,
      'z'.repeat(REPORT_DETAILS_MAX_CHARS),
      '',
    ]) {
      const canonical = report(content);
      const ranges = partitionCanonicalReport(content);
      const parts = ranges.map((_, index) => renderCanonicalReportPart(canonical, ranges, index));

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

  test('queues exactly one hidden follow-up at a time and advances only after a terminal response', () => {
    const { delivery, sent } = harness();
    const canonical = report('x'.repeat(120_000));
    const first = delivery.start(canonical);

    expect(first.metadata).toMatchObject({
      automaticContinuation: true,
      complete: false,
      part: 1,
      reportId: 'report-one',
    });
    expect(first.text).toContain('do not call report_get again');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ deliverAs: 'followUp' });
    expect(sent[0]?.message).toMatchObject({
      customType: REPORT_DELIVERY_MESSAGE_TYPE,
      details: {
        part: 2,
        reportId: 'report-one',
        type: REPORT_DELIVERY_DETAIL_TYPE,
      },
      display: false,
    });
    expect(() => delivery.start(report('other', 'report-two'))).toThrow(
      'report-one is still being delivered',
    );

    delivery.observeTurn({ stopReason: 'stop' });
    expect(sent).toHaveLength(1);
    delivery.observeMessage(deliveredMessage(requiredValue(sent[0])));
    delivery.observeTurn({ stopReason: 'toolUse' });
    expect(sent).toHaveLength(1);
    delivery.observeTurn({ stopReason: 'stop' });
    expect(sent).toHaveLength(2);

    while (delivery.activeReportId) {
      const latest = requiredValue(sent.at(-1));
      delivery.observeMessage(deliveredMessage(latest));
      if (delivery.activeReportId) delivery.observeTurn({ stopReason: 'stop' });
    }

    expect(sent).toHaveLength(first.metadata.parts - 1);
    expect(sent.at(-1)?.message).toMatchObject({
      details: { part: first.metadata.parts, parts: first.metadata.parts },
    });
    expect(delivery.start(report('next', 'report-two')).metadata.complete).toBe(true);
  });

  test('ignores unrelated or stale delivery markers and clears interrupted delivery state', () => {
    const { delivery, sent } = harness();
    delivery.start(report('x'.repeat(80_000)));

    delivery.observeMessage({
      customType: REPORT_DELIVERY_MESSAGE_TYPE,
      details: { part: 2, parts: 3, reportId: 'other', type: REPORT_DELIVERY_DETAIL_TYPE },
      role: 'custom',
    });
    delivery.observeTurn({ stopReason: 'stop' });
    expect(sent).toHaveLength(1);

    delivery.observeMessage(deliveredMessage(requiredValue(sent[0])));
    delivery.observeTurn({ stopReason: 'aborted' });
    expect(delivery.activeReportId).toBeUndefined();
  });
});
