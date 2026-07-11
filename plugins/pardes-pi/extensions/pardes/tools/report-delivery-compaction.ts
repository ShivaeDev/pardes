import type { SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import {
  type DeliveryMessageDetails,
  isReportDeliveryCustomMessage,
  REPORT_DELIVERY_DETAIL_TYPE,
  type ReportDeliveryCustomMessage,
} from './report-delivery-content.ts';

export const REPORT_DELIVERY_COMPACTION_PLACEHOLDER_MAX_BYTES = 768;
export const REPORT_DELIVERY_COMPACTION_MAX_PLACEHOLDERS = 32;

type CompactionPreparation = SessionBeforeCompactEvent['preparation'];
type CompactionMessage = CompactionPreparation['messagesToSummarize'][number];

function boundedIdentity(value: unknown, fallback: string): string {
  return typeof value === 'string'
    ? value.slice(0, 120).replace(/[^a-zA-Z0-9._-]/g, '_')
    : fallback;
}

function boundedPart(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function originalDeliveryDetails(
  message: ReportDeliveryCustomMessage,
): Partial<DeliveryMessageDetails> | undefined {
  return message.details && typeof message.details === 'object'
    ? (message.details as Partial<DeliveryMessageDetails>)
    : undefined;
}

function compactionIdentity(message: ReportDeliveryCustomMessage): string {
  const details = originalDeliveryDetails(message);
  return `${boundedIdentity(details?.deliveryId, 'legacy')}\0${boundedIdentity(
    details?.reportId,
    'unknown',
  )}`;
}

function compactionPlaceholder(message: ReportDeliveryCustomMessage): CompactionMessage {
  const originalDetails = originalDeliveryDetails(message);
  const details: DeliveryMessageDetails = {
    deliveryId: boundedIdentity(originalDetails?.deliveryId, 'legacy'),
    part: boundedPart(originalDetails?.part),
    parts: boundedPart(originalDetails?.parts),
    reportId: boundedIdentity(originalDetails?.reportId, 'unknown'),
    type: REPORT_DELIVERY_DETAIL_TYPE,
  };
  const renderedChars = typeof message.content === 'string' ? message.content.length : 0;
  const content = [
    '[Prior Pardes canonical report part omitted from compaction input; durable source remains in session history]',
    `deliveryId: ${details.deliveryId} · reportId: ${details.reportId} · part: ${details.part}/${details.parts} · renderedChars: ${renderedChars}`,
  ].join('\n');
  return { ...message, content, details } as CompactionMessage;
}

interface CompactionPlaceholderState {
  readonly retainedDeliveries: Set<string>;
  retainedCount: number;
}

function sanitizeCompactionMessages(
  messages: CompactionMessage[],
  state: CompactionPlaceholderState,
): CompactionMessage[] {
  const sanitized: CompactionMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (!isReportDeliveryCustomMessage(message)) {
      sanitized.push(message);
      continue;
    }
    const identity = compactionIdentity(message);
    if (
      state.retainedDeliveries.has(identity) ||
      state.retainedCount >= REPORT_DELIVERY_COMPACTION_MAX_PLACEHOLDERS
    )
      continue;
    state.retainedDeliveries.add(identity);
    state.retainedCount += 1;
    sanitized.push(compactionPlaceholder(message));
  }
  sanitized.reverse();
  return sanitized;
}

/**
 * Pi 0.75.5 prepares compaction directly from persisted session entries and does
 * not run the ordinary context hook. Mutate the one preparation object shared by
 * extension and built-in compactors while leaving durable branch entries intact.
 */
export function sanitizeReportDeliveryCompactionPreparation(
  preparation: CompactionPreparation,
): void {
  const state: CompactionPlaceholderState = {
    retainedCount: 0,
    retainedDeliveries: new Set(),
  };
  // Retain bounded metadata for the newest delivery identities first.
  preparation.turnPrefixMessages = sanitizeCompactionMessages(
    preparation.turnPrefixMessages,
    state,
  );
  preparation.messagesToSummarize = sanitizeCompactionMessages(
    preparation.messagesToSummarize,
    state,
  );
}
