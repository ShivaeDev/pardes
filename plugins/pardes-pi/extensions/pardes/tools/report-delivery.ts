import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type ManagerInboxWakeMessage, managerInboxWakeMessageIdentity } from '../manager/index.ts';
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
  type ReportDeliveryCancellationReason,
  renderCanonicalReportPart,
  renderReportDeliveryCancellation,
  reportDeliveryMessageDetails,
} from './report-delivery-content.ts';

export const REPORT_DELIVERY_COMPACTION_TIMEOUT_MS = 5 * 60 * 1_000;
export const REPORT_DELIVERY_OWNED_WAKE_TIMEOUT_MS = 5 * 60 * 1_000;
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

interface OwnedWakeInterlude {
  ended: boolean;
  readonly identity: string;
  started: boolean;
}

export interface ReportDeliveryScheduler {
  readonly schedule: (delayMs: number, task: () => void) => () => void;
}

export interface ReportDeliveryPermit {
  readonly epoch: number;
}

export type ReportDeliveryHoldRelease = (ctx: ExtensionContext) => void;

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
  private cancelOwnedWakeTimeout: (() => void) | undefined;
  private compactionInProgress = false;
  private acceptingDeliveries = true;
  private deliveryEpoch = 0;
  private acquisitionPermit: ReportDeliveryPermit | undefined;
  private ownedWakeInterlude: OwnedWakeInterlude | undefined;
  private releaseOwnedWake: ReportDeliveryHoldRelease | undefined;

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

  /** Structural hold consumed by the manager wake scheduler; no inbox truth lives here. */
  get isHoldingOwnedWakes(): boolean {
    return (
      this.active !== undefined ||
      this.acquisitionPermit !== undefined ||
      this.ownedWakeInterlude !== undefined
    );
  }

  onOwnedWakeRelease(release: ReportDeliveryHoldRelease): void {
    this.releaseOwnedWake = release;
  }

  registerOwnedWake(message: ManagerInboxWakeMessage, ctx: ExtensionContext): boolean {
    const identity = managerInboxWakeMessageIdentity(message);
    if (!identity || !this.acceptingDeliveries || this.acquisitionPermit || this.ownedWakeInterlude)
      return false;
    this.ownedWakeInterlude = { ended: false, identity, started: false };
    if (this.active?.phase === 'waiting_for_settlement') this.cancelScheduledDispatch();
    this.cancelOwnedWakeTimeout?.();
    this.cancelOwnedWakeTimeout = this.scheduler.schedule(
      REPORT_DELIVERY_OWNED_WAKE_TIMEOUT_MS,
      () => {
        if (this.ownedWakeInterlude?.identity !== identity) return;
        if (this.active) this.cancelActive('owned_wake_timeout', ctx);
        else if (this.acquisitionPermit && this.ownedWakeInterlude.started)
          this.cancelStartedWakeAcquisition(ctx);
        else this.clearOwnedWakeInterlude(ctx);
      },
    );
    return true;
  }

  acquirePermit(): ReportDeliveryPermit | undefined {
    if (
      !this.acceptingDeliveries ||
      this.active ||
      this.acquisitionPermit ||
      (this.ownedWakeInterlude && !this.ownedWakeInterlude.started)
    )
      return undefined;
    const permit = { epoch: this.deliveryEpoch };
    this.acquisitionPermit = permit;
    return permit;
  }

  releasePermit(permit: ReportDeliveryPermit, ctx?: ExtensionContext): boolean {
    if (this.acquisitionPermit !== permit) return false;
    this.acquisitionPermit = undefined;
    if (ctx) this.releaseOwnedWake?.(ctx);
    return true;
  }

  activate(): void {
    this.resetActive();
    this.acceptingDeliveries = true;
  }

  deactivate(reason: ReportDeliveryCancellationReason = 'manager_lifecycle_change'): void {
    this.acceptingDeliveries = false;
    this.cancelActive(reason);
  }

  start(
    report: CanonicalReport,
    toolCallId: string,
    permit: ReportDeliveryPermit,
  ): ReportDeliveryStart {
    if (
      !this.acceptingDeliveries ||
      permit.epoch !== this.deliveryEpoch ||
      this.acquisitionPermit !== permit
    )
      throw new Error('Canonical report delivery was canceled by a manager lifecycle change.');
    if (this.active)
      throw new Error(
        `Canonical report ${this.active.report.reportId} is still being delivered; wait for its final automatic part before retrieving another report.`,
      );
    const ranges = partitionCanonicalReport(report.content);
    const id = deliveryId(report.reportId, toolCallId);
    this.acquisitionPermit = undefined;
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

  observeMessageStart(message: unknown, ctx?: ExtensionContext): void {
    const active = this.active;
    const wakeIdentity = managerInboxWakeMessageIdentity(message);
    const interlude = this.ownedWakeInterlude;
    if (
      (message as { readonly role?: unknown })?.role === 'custom' &&
      wakeIdentity !== undefined &&
      interlude !== undefined &&
      !interlude.started &&
      wakeIdentity === interlude.identity
    ) {
      this.cancelScheduledDispatch();
      interlude.started = true;
      return;
    }
    if (active && isReportDeliveryMessage(message)) {
      if (!this.matchesExpectedPart(active, message.details)) {
        this.cancelActive('delivery_marker_mismatch', ctx);
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
    ) {
      if (active) this.cancelActive('unrelated_input', ctx);
      else if (interlude?.started) this.cancelStartedWakeAcquisition(ctx);
    }
  }

  observeMessageEnd(message: unknown): void {
    const active = this.active;
    const interlude = this.ownedWakeInterlude;
    if (
      interlude?.started &&
      !interlude.ended &&
      managerInboxWakeMessageIdentity(message) === interlude.identity
    ) {
      interlude.ended = true;
      return;
    }
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
    const interlude = this.ownedWakeInterlude;
    if (!active && !interlude?.started) return;
    const stopReason = terminalStopReason(messages);
    if (stopReason === 'error' || stopReason === 'aborted') {
      if (active)
        this.cancelActive(stopReason === 'aborted' ? 'agent_aborted' : 'agent_error', ctx);
      else this.clearOwnedWakeInterlude(ctx);
      return;
    }
    if (stopReason !== 'stop' && stopReason !== 'length') return;
    if (interlude?.started) {
      if (!interlude.ended) {
        if (active) this.cancelActive('settlement_mismatch', ctx);
        else this.clearOwnedWakeInterlude(ctx);
        return;
      }
      this.clearOwnedWakeInterlude();
      if (active) this.settleOwnedWakeInterlude(active, ctx);
      return;
    }
    if (!active) return;
    if (active.phase === 'initial_run') {
      active.phase = 'waiting_for_settlement';
      this.scheduleDispatch(ctx, 0);
      return;
    }
    this.settleReportPart(active, ctx);
  }

  observeCompactionStart(ctx?: ExtensionContext): void {
    const active = this.active;
    if (!active) return;
    const deliveryIdentity = active.deliveryId;
    this.compactionInProgress = true;
    this.cancelScheduledDispatch();
    this.cancelCompactionTimeout?.();
    this.cancelCompactionTimeout = this.scheduler.schedule(
      REPORT_DELIVERY_COMPACTION_TIMEOUT_MS,
      () => {
        if (this.active?.deliveryId === deliveryIdentity && this.compactionInProgress)
          this.cancelActive('compaction_timeout', ctx);
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
    this.cancelActive('manager_lifecycle_change');
  }

  private resetActive(): ActiveReportDelivery | undefined {
    const active = this.active;
    this.deliveryEpoch += 1;
    this.cancelScheduledDispatch();
    this.cancelCompactionTimeout?.();
    this.cancelCompactionTimeout = undefined;
    this.cancelOwnedWakeTimeout?.();
    this.cancelOwnedWakeTimeout = undefined;
    this.compactionInProgress = false;
    this.acquisitionPermit = undefined;
    this.ownedWakeInterlude = undefined;
    this.active = undefined;
    return active;
  }

  private cancelActive(reason: ReportDeliveryCancellationReason, ctx?: ExtensionContext): void {
    const active = this.resetActive();
    if (!active) return;
    const outcome = renderReportDeliveryCancellation({
      deliveryId: active.deliveryId,
      nextPart: active.nextPart + 1,
      parts: active.ranges.length,
      reason,
      reportId: active.report.reportId,
    });
    this.pi.sendMessage(
      outcome,
      // While streaming this is a bounded steering record; while idle Pi
      // appends it without starting an unsolicited model run.
      { deliverAs: 'steer' },
    );
    if (ctx) this.releaseOwnedWake?.(ctx);
  }

  private completeActive(ctx: ExtensionContext): void {
    if (!this.resetActive()) return;
    this.releaseOwnedWake?.(ctx);
  }

  private cancelStartedWakeAcquisition(ctx?: ExtensionContext): void {
    this.deliveryEpoch += 1;
    this.acquisitionPermit = undefined;
    this.clearOwnedWakeInterlude(ctx);
  }

  private clearOwnedWakeInterlude(ctx?: ExtensionContext): void {
    this.cancelOwnedWakeTimeout?.();
    this.cancelOwnedWakeTimeout = undefined;
    this.ownedWakeInterlude = undefined;
    if (ctx) this.releaseOwnedWake?.(ctx);
  }

  private settleOwnedWakeInterlude(active: ActiveReportDelivery, ctx: ExtensionContext): void {
    if (active.phase === 'initial_run') {
      active.phase = 'waiting_for_settlement';
      this.scheduleDispatch(ctx, 0);
      return;
    }
    if (active.phase === 'waiting_for_settlement') {
      this.scheduleDispatch(ctx, 0);
      return;
    }
    if (active.phase === 'dispatching') return;
    this.settleReportPart(active, ctx);
  }

  private settleReportPart(active: ActiveReportDelivery, ctx: ExtensionContext): void {
    if (active.phase !== 'part_run' || active.acknowledgedPart !== active.nextPart) {
      this.cancelActive('settlement_mismatch', ctx);
      return;
    }
    if (active.nextPart + 1 === active.ranges.length) {
      this.completeActive(ctx);
      return;
    }
    active.nextPart += 1;
    active.acknowledgedPart = undefined;
    active.phase = 'waiting_for_settlement';
    this.scheduleDispatch(ctx, 0);
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
    if (
      !active ||
      active.phase !== 'waiting_for_settlement' ||
      this.compactionInProgress ||
      this.ownedWakeInterlude
    )
      return;
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
        this.compactionInProgress ||
        this.ownedWakeInterlude
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
  pi.on('message_start', (event, ctx) => {
    delivery.observeMessageStart(event.message, ctx);
  });
  pi.on('message_end', (event) => {
    delivery.observeMessageEnd(event.message);
  });
  pi.on('agent_end', (event, ctx) => {
    delivery.observeAgentEnd(event.messages, ctx);
  });
  pi.on('session_before_compact', (event, ctx) => {
    sanitizeReportDeliveryCompactionPreparation(event.preparation);
    delivery.observeCompactionStart(ctx);
  });
  pi.on('session_compact', (_event, ctx) => {
    delivery.observeCompactionComplete(ctx);
  });
  pi.on('session_shutdown', (event) => {
    delivery.deactivate(event.reason === 'reload' ? 'session_reload' : 'session_shutdown');
  });
  return delivery;
}
