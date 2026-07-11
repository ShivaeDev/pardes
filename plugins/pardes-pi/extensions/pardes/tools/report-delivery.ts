import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CanonicalReport, CanonicalReportMetadata } from '../reporting/index.ts';
import { sanitizeReportDeliveryCompactionPreparation } from './report-delivery-compaction.ts';
import {
  type CanonicalReportDelivery,
  type DeliveryMessageDetails,
  isReportDeliveryCustomMessage,
  isReportDeliveryMessage,
  partitionCanonicalReport,
  REPORT_DELIVERY_DETAIL_TYPE,
  REPORT_DELIVERY_MESSAGE_TYPE,
  renderCanonicalReportPart,
  reportDeliveryMessageDetails,
} from './report-delivery-content.ts';

export const REPORT_DELIVERY_COMPACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const REPORT_DELIVERY_SETTLEMENT_RETRY_MS = 10;

export interface ReportDeliveryStartMetadata extends CanonicalReportMetadata {
  readonly automaticContinuation: true;
  readonly deliveryId: string;
  readonly parts: number;
}

export interface ReportDeliveryStart {
  readonly metadata: ReportDeliveryStartMetadata;
  readonly text: string;
}

type DeliveryPhase = 'initial_run' | 'waiting_for_settlement' | 'dispatching' | 'part_run';

interface ActiveReportDelivery extends CanonicalReportDelivery {
  acknowledgedPart?: number;
  nextPart: number;
  phase: DeliveryPhase;
}

export interface ReportDeliveryScheduler {
  readonly schedule: (delayMs: number, task: () => void) => () => void;
}

export interface ReportDeliveryPermit {
  readonly epoch: number;
}

const liveScheduler: ReportDeliveryScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
};

function deliveryId(reportId: string, toolCallId: string): string {
  const digest = createHash('sha256')
    .update(`${reportId}\0${toolCallId}`)
    .digest('hex')
    .slice(0, 24);
  return `report-delivery-${digest}`;
}

function terminalStopReason(messages: ReadonlyArray<unknown>): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === 'object' &&
      (message as { role?: unknown }).role === 'assistant'
    )
      return (message as { stopReason?: unknown }).stopReason;
  }
  return undefined;
}

/**
 * Deliver each part as its own triggerTurn run. No report continuation is ever
 * placed in Pi 0.75.5's shared follow-up queue, so clear/reload can cancel every
 * not-yet-dispatched part exactly. Matching message events are the only dispatch
 * acknowledgement because this Pi API keeps sendMessage fire-and-forget.
 */
export class ReportDeliveryCoordinator {
  private active: ActiveReportDelivery | undefined;
  private cancelDispatch: (() => void) | undefined;
  private cancelCompactionTimeout: (() => void) | undefined;
  private compactionInProgress = false;
  private acceptingDeliveries = true;
  private deliveryEpoch = 0;

  constructor(
    private readonly pi: Pick<ExtensionAPI, 'sendMessage'>,
    private readonly scheduler: ReportDeliveryScheduler = liveScheduler,
  ) {}

  get activeReportId(): string | undefined {
    return this.active?.report.reportId;
  }

  get isActive(): boolean {
    return this.active !== undefined;
  }

  capturePermit(): ReportDeliveryPermit | undefined {
    return this.acceptingDeliveries ? { epoch: this.deliveryEpoch } : undefined;
  }

  activate(): void {
    this.clear();
    this.acceptingDeliveries = true;
  }

  deactivate(): void {
    this.acceptingDeliveries = false;
    this.clear();
  }

  start(
    report: CanonicalReport,
    toolCallId: string,
    permit: ReportDeliveryPermit,
  ): ReportDeliveryStart {
    if (!this.acceptingDeliveries || permit.epoch !== this.deliveryEpoch)
      throw new Error('Canonical report delivery was canceled by a manager lifecycle change.');
    if (this.active)
      throw new Error(
        `Canonical report ${this.active.report.reportId} is still being delivered; wait for its final automatic part before retrieving another report.`,
      );
    const ranges = partitionCanonicalReport(report.content);
    const id = deliveryId(report.reportId, toolCallId);
    this.active = {
      deliveryId: id,
      nextPart: 0,
      phase: 'initial_run',
      ranges,
      report,
    };
    const { content: _content, ...metadata } = report;
    return {
      metadata: {
        ...metadata,
        automaticContinuation: true,
        deliveryId: id,
        parts: ranges.length,
      },
      text: [
        '[Pardes canonical report delivery scheduled]',
        `deliveryId: ${id} · reportId: ${report.reportId} · field: ${report.field} · totalChars: ${report.totalChars} · parts: ${ranges.length}`,
        'The complete trust-labelled report will begin automatically after this agent run settles. Each bounded part uses a separate run so Pi can compact between parts. Do not call report_get again or construct pagination arguments.',
      ].join('\n'),
    };
  }

  observeMessageStart(message: unknown): void {
    const active = this.active;
    if (!active) return;
    if (isReportDeliveryMessage(message)) {
      if (!this.matchesExpectedPart(active, message.details)) {
        this.clear();
        return;
      }
      this.cancelScheduledDispatch();
      active.phase = 'part_run';
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      ((message as { role?: unknown }).role === 'user' ||
        (message as { role?: unknown }).role === 'custom')
    )
      this.clear();
  }

  observeMessageEnd(message: unknown): void {
    const active = this.active;
    if (
      !active ||
      !isReportDeliveryMessage(message) ||
      !this.matchesExpectedPart(active, message.details)
    )
      return;
    active.acknowledgedPart = active.nextPart;
  }

  observeAgentEnd(messages: ReadonlyArray<unknown>, ctx: ExtensionContext): void {
    const active = this.active;
    if (!active) return;
    const stopReason = terminalStopReason(messages);
    if (stopReason === 'error' || stopReason === 'aborted') {
      this.clear();
      return;
    }
    if (stopReason !== 'stop' && stopReason !== 'length') return;
    if (active.phase === 'initial_run') {
      active.phase = 'waiting_for_settlement';
      this.scheduleDispatch(ctx, 0);
      return;
    }
    if (active.phase !== 'part_run' || active.acknowledgedPart !== active.nextPart) {
      this.clear();
      return;
    }
    if (active.nextPart + 1 === active.ranges.length) {
      this.clear();
      return;
    }
    active.nextPart += 1;
    active.acknowledgedPart = undefined;
    active.phase = 'waiting_for_settlement';
    this.scheduleDispatch(ctx, 0);
  }

  observeCompactionStart(): void {
    const active = this.active;
    if (!active) return;
    const deliveryIdentity = active.deliveryId;
    this.compactionInProgress = true;
    this.cancelScheduledDispatch();
    this.cancelCompactionTimeout?.();
    this.cancelCompactionTimeout = this.scheduler.schedule(
      REPORT_DELIVERY_COMPACTION_TIMEOUT_MS,
      () => {
        if (this.active?.deliveryId === deliveryIdentity && this.compactionInProgress) this.clear();
      },
    );
  }

  observeCompactionComplete(ctx: ExtensionContext): void {
    this.settleCompaction(ctx);
  }

  /** Manager-owned compaction was canceled after its custom override failed. */
  observeCompactionFailure(ctx: ExtensionContext): void {
    this.settleCompaction(ctx);
  }

  contextMessages<A>(messages: ReadonlyArray<A>): A[] {
    const active = this.active;
    return messages.filter((message) => {
      if (!isReportDeliveryCustomMessage(message)) return true;
      const details = reportDeliveryMessageDetails(message);
      if (!details) return false;
      return (
        active !== undefined &&
        details.deliveryId === active.deliveryId &&
        details.reportId === active.report.reportId &&
        details.part === active.nextPart + 1 &&
        active.phase === 'part_run'
      );
    });
  }

  clear(): void {
    this.deliveryEpoch += 1;
    this.cancelScheduledDispatch();
    this.cancelCompactionTimeout?.();
    this.cancelCompactionTimeout = undefined;
    this.compactionInProgress = false;
    this.active = undefined;
  }

  private matchesExpectedPart(
    active: ActiveReportDelivery,
    details: DeliveryMessageDetails,
  ): boolean {
    return (
      details.deliveryId === active.deliveryId &&
      details.reportId === active.report.reportId &&
      details.parts === active.ranges.length &&
      details.part === active.nextPart + 1
    );
  }

  private scheduleDispatch(ctx: ExtensionContext, delayMs: number): void {
    const active = this.active;
    if (!active || active.phase !== 'waiting_for_settlement' || this.compactionInProgress) return;
    this.cancelScheduledDispatch();
    const deliveryIdentity = active.deliveryId;
    const expectedPart = active.nextPart;
    this.cancelDispatch = this.scheduler.schedule(delayMs, () => {
      this.cancelDispatch = undefined;
      const current = this.active;
      if (
        !current ||
        current.deliveryId !== deliveryIdentity ||
        current.nextPart !== expectedPart ||
        current.phase !== 'waiting_for_settlement' ||
        this.compactionInProgress
      )
        return;
      if (!ctx.isIdle()) {
        this.scheduleDispatch(ctx, REPORT_DELIVERY_SETTLEMENT_RETRY_MS);
        return;
      }
      const part = renderCanonicalReportPart(current, current.nextPart);
      current.phase = 'dispatching';
      this.pi.sendMessage(
        {
          content: part.text,
          customType: REPORT_DELIVERY_MESSAGE_TYPE,
          details: {
            deliveryId: part.metadata.deliveryId,
            part: part.metadata.part,
            parts: part.metadata.parts,
            reportId: part.metadata.reportId,
            type: REPORT_DELIVERY_DETAIL_TYPE,
          } satisfies DeliveryMessageDetails,
          display: false,
        },
        { triggerTurn: true },
      );
    });
  }

  private cancelScheduledDispatch(): void {
    this.cancelDispatch?.();
    this.cancelDispatch = undefined;
  }

  private settleCompaction(ctx: ExtensionContext): void {
    this.compactionInProgress = false;
    this.cancelCompactionTimeout?.();
    this.cancelCompactionTimeout = undefined;
    if (this.active?.phase === 'waiting_for_settlement') this.scheduleDispatch(ctx, 0);
  }
}

export function registerReportDelivery(pi: ExtensionAPI): ReportDeliveryCoordinator {
  const delivery = new ReportDeliveryCoordinator(pi);
  pi.on('context', (event) => ({ messages: delivery.contextMessages(event.messages) }));
  pi.on('message_start', (event) => {
    delivery.observeMessageStart(event.message);
  });
  pi.on('message_end', (event) => {
    delivery.observeMessageEnd(event.message);
  });
  pi.on('agent_end', (event, ctx) => {
    delivery.observeAgentEnd(event.messages, ctx);
  });
  pi.on('session_before_compact', (event) => {
    sanitizeReportDeliveryCompactionPreparation(event.preparation);
    delivery.observeCompactionStart();
  });
  pi.on('session_compact', (_event, ctx) => {
    delivery.observeCompactionComplete(ctx);
  });
  pi.on('session_shutdown', () => {
    delivery.deactivate();
  });
  return delivery;
}
