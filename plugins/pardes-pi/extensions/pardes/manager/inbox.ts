import { createHash } from 'node:crypto';
import type { InboxHandoff, InboxWake, ManagerEvent, ManagerState } from './domain.ts';
import {
  AUTONOMOUS_INBOX_PATH,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
} from './guidance/lifecycle.ts';

export const MANAGER_INBOX_WAKE_MESSAGE_TYPE = 'pardes-worker-event';
export const MANAGER_INBOX_WAKE_DETAIL_TYPE = 'manager_inbox_wake';
export const MANAGER_INBOX_WAKE_MAX_CHARS = 1_200;
export const MANAGER_INBOX_WAKE_MAX_ROWS = 4;
export const MANAGER_INBOX_WAKE_MAX_ROW_CHARS = 120;
const VISIBLE_CURSOR_MAX_CHARS = 80;
const VISIBLE_EVENT_TYPE_MAX_CHARS = 44;
const HEADER_MAX_CHARS = 160;
const FULL_INBOX_HINT_LINES = [
  'Inspect `pardes_status(view="inbox")` for bounded rows; use `inbox_get({ eventId })` only for a known row; trust current inbox if stale.',
  AUTONOMOUS_INBOX_PATH,
  USER_JUDGMENT_INBOX_PATH,
  USER_JUDGMENT_HANDOFF_PATH,
];

const CHILD_SUMMARY_EVENT_TYPES = new Set(['agent_report_blocked', 'agent_report_completed']);
const GITHUB_METADATA_EVENT_TYPES = new Set([
  'ci_failed',
  'review_feedback',
  'conflict',
  'merged',
  'closed_unmerged',
  'watcher_failed',
  'github_rate_metadata_unavailable',
  'pull_request_head_diverged',
  'discussion_pagination_gap',
]);
const GITHUB_EXTERNAL_FEEDBACK_EVENT_TYPES = new Set(['discussion_feedback']);
const PARDES_SUMMARY_EVENT_TYPES = new Set([
  'agent_crashed',
  'agent_detached',
  'agent_git_audit_dirty',
  'agent_idle',
  'verification_terminal_report_missing',
]);
const OMITTED_DIAGNOSTIC_EVENT_LABELS = new Map<string, string>([
  ['agent_auto_stop_failed', 'idle-worker auto-stop failed'],
  ['agent_git_audit_failed', 'managed-worktree Git audit failed'],
  ['agent_protocol_error', 'child RPC protocol error'],
  ['agent_report_persist_failed', 'report artifact persistence failed'],
  ['pull_request_auto_sync_attention', 'review-gate auto-sync needs attention'],
]);

export interface InboxWakeRelease {
  readonly wake: InboxWake;
  readonly inbox: ReadonlyArray<ManagerEvent>;
}

export interface InboxAttentionProjection {
  readonly deliveredCursor?: string;
  readonly wakeToken?: string;
  readonly deliveredCursorAgeMs?: number;
  readonly coveredCount: number;
  readonly queuedSuffixCount: number;
  readonly awaitingUser: boolean;
  /** Exact cursor that may be acknowledged proactively without crossing a fail-closed barrier. */
  readonly readyPrefixCursor?: string;
  readonly readyPrefixCount: number;
  readonly presentationBlockedEventId?: string;
  readonly presentationBlockedReason?: string;
}

function compactText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

/** Upstream row selection and field previews bound dynamic data; keep authored wake guidance intact. */
function projectedWakeContent(lines: ReadonlyArray<string>): string {
  const content = lines.join('\n');
  if (content.length > MANAGER_INBOX_WAKE_MAX_CHARS)
    throw new Error('Manager inbox wake exceeded its structural character bound.');
  return content;
}

/** Stable and bounded even if a forward-compatible persisted event id is unexpectedly large. */
export function inboxWakeToken(managerId: string, cursor: string): string {
  const digest = createHash('sha256').update(`${managerId}\0${cursor}`).digest('hex').slice(0, 16);
  return `wake-${digest}`;
}

/** Mint one cursor only across the ready prefix the compact wake can present individually. */
export function makeInboxWake(
  managerId: string,
  inbox: ReadonlyArray<ManagerEvent>,
  createdAt: string,
): InboxWake | undefined {
  const firstBlockedIndex = inbox.findIndex((event) => event.presentationBlocked === true);
  const readyPrefixLength = firstBlockedIndex === -1 ? inbox.length : firstBlockedIndex;
  const pendingCount = Math.min(readyPrefixLength, MANAGER_INBOX_WAKE_MAX_ROWS);
  const cursor = inbox[pendingCount - 1]?.id;
  return cursor === undefined
    ? undefined
    : { createdAt, cursor, pendingCount, token: inboxWakeToken(managerId, cursor) };
}

/** Parse one durable presentation timestamp conservatively for compact age projections. */
export function inboxWakeAgeMs(wake: InboxWake, nowMs = Date.now()): number | undefined {
  const createdAtMs = Date.parse(wake.createdAt);
  return Number.isFinite(createdAtMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor(nowMs - createdAtMs))
    : undefined;
}

/** Keep a released wake only while its through-cursor remains actionable and inspectably bounded. */
export function retainCurrentInboxWake(
  inbox: ReadonlyArray<ManagerEvent>,
  wake: InboxWake | undefined,
): InboxWake | undefined {
  if (wake === undefined) return undefined;
  const cursorIndex = inbox.findIndex((event) => event.id === wake.cursor);
  return cursorIndex >= 0 && cursorIndex < MANAGER_INBOX_WAKE_MAX_ROWS ? wake : undefined;
}

/** A handoff remains meaningful only for the one currently delivered durable cursor. */
export function retainCurrentInboxHandoff(
  inbox: ReadonlyArray<ManagerEvent>,
  wake: InboxWake | undefined,
  handoff: InboxHandoff | undefined,
): InboxHandoff | undefined {
  const retainedWake = retainCurrentInboxWake(inbox, wake);
  return handoff !== undefined && retainedWake?.cursor === handoff.cursor ? handoff : undefined;
}

export function projectInboxAttention(
  inbox: ReadonlyArray<ManagerEvent>,
  wake: InboxWake | undefined,
  handoff?: InboxHandoff,
  nowMs = Date.now(),
): InboxAttentionProjection {
  const firstBlockedIndex = inbox.findIndex((event) => event.presentationBlocked === true);
  const readyPrefixCount = firstBlockedIndex === -1 ? inbox.length : firstBlockedIndex;
  const readyPrefixCursor = inbox[readyPrefixCount - 1]?.id;
  const presentationBlocked = firstBlockedIndex === -1 ? undefined : inbox[firstBlockedIndex];
  const readiness = {
    readyPrefixCount,
    ...(readyPrefixCursor === undefined ? {} : { readyPrefixCursor }),
    ...(presentationBlocked === undefined
      ? {}
      : {
          presentationBlockedEventId: presentationBlocked.id,
          presentationBlockedReason:
            presentationBlocked.presentationBlockedReason ?? 'software_refinement_pending',
        }),
  };
  const retainedWake = retainCurrentInboxWake(inbox, wake);
  if (!retainedWake)
    return { awaitingUser: false, coveredCount: 0, queuedSuffixCount: 0, ...readiness };
  const cursorIndex = inbox.findIndex((event) => event.id === retainedWake.cursor);
  const deliveredCursorAgeMs = inboxWakeAgeMs(retainedWake, nowMs);
  return {
    deliveredCursor: retainedWake.cursor,
    wakeToken: retainedWake.token,
    ...(deliveredCursorAgeMs === undefined ? {} : { deliveredCursorAgeMs }),
    awaitingUser: retainCurrentInboxHandoff(inbox, retainedWake, handoff) !== undefined,
    coveredCount: cursorIndex + 1,
    queuedSuffixCount: Math.max(0, inbox.length - cursorIndex - 1),
    ...readiness,
  };
}

/** Replace inbox state while mechanically dropping stale presentation and handoff cursors. */
export function withInbox(state: ManagerState, inbox: ReadonlyArray<ManagerEvent>): ManagerState {
  const inboxWake = retainCurrentInboxWake(inbox, state.inboxWake);
  const inboxHandoff = retainCurrentInboxHandoff(inbox, inboxWake, state.inboxHandoff);
  const { inboxWake: _inboxWake, inboxHandoff: _inboxHandoff, ...withoutCursors } = state;
  return {
    ...withoutCursors,
    inbox: [...inbox],
    ...(inboxWake === undefined ? {} : { inboxWake }),
    ...(inboxHandoff === undefined ? {} : { inboxHandoff }),
  };
}

function childDigestLabel(event: ManagerEvent, kind: 'summary' | 'question'): string {
  return event.verificationId === undefined ? `child ${kind}` : `advisory verifier ${kind}`;
}

function drillDownPointer(event: ManagerEvent): string {
  return `inspect inbox_get({ eventId:${event.id} })`;
}

function digestSummary(event: ManagerEvent): string {
  if (CHILD_SUMMARY_EVENT_TYPES.has(event.type))
    return `[${childDigestLabel(event, 'summary')}] ${drillDownPointer(event)}`;
  if (event.type === 'agent_question')
    return `[${childDigestLabel(event, 'question')}] ${drillDownPointer(event)}`;
  if (GITHUB_METADATA_EVENT_TYPES.has(event.type))
    return `[GitHub metadata] ${drillDownPointer(event)}`;
  if (GITHUB_EXTERNAL_FEEDBACK_EVENT_TYPES.has(event.type))
    return `[external GitHub feedback] ${drillDownPointer(event)}`;
  if (PARDES_SUMMARY_EVENT_TYPES.has(event.type)) return `[Pardes] ${drillDownPointer(event)}`;
  const diagnosticLabel = OMITTED_DIAGNOSTIC_EVENT_LABELS.get(event.type);
  return diagnosticLabel === undefined
    ? `[summary omitted] ${drillDownPointer(event)}`
    : `[Pardes] ${diagnosticLabel}; ${drillDownPointer(event)}`;
}

function digestRow(event: ManagerEvent): string {
  const type = compactText(event.type, VISIBLE_EVENT_TYPE_MAX_CHARS) || 'event';
  return compactText(`- ${type}: ${digestSummary(event)}`, MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
}

export function inboxThroughCursor(
  inbox: ReadonlyArray<ManagerEvent>,
  cursor: string,
): ReadonlyArray<ManagerEvent> | undefined {
  const cursorIndex = inbox.findIndex((event) => event.id === cursor);
  return cursorIndex === -1 ? undefined : inbox.slice(0, cursorIndex + 1);
}

/**
 * Render one bounded signal-first wake for the actionable durable events covered by a
 * released cursor. Durable inbox state remains authoritative if presentation is late.
 */
export function renderInboxWakeMessage(release: InboxWakeRelease) {
  const { wake } = release;
  const cursor = compactText(wake.cursor, VISIBLE_CURSOR_MAX_CHARS);
  const coveredInbox = inboxThroughCursor(release.inbox, release.wake.cursor);
  const candidateDigestRows =
    coveredInbox?.slice(0, MANAGER_INBOX_WAKE_MAX_ROWS).map(digestRow) ?? [];
  const queuedSuffixCount =
    coveredInbox === undefined ? 0 : Math.max(0, release.inbox.length - coveredInbox.length);
  const header = compactText(
    `[Pardes wake ${wake.token}] ${wake.pendingCount} pending through cursor ${cursor}`,
    HEADER_MAX_CHARS,
  );
  const wakeContentLines = (digestCount: number): ReadonlyArray<string> => {
    const omittedCount = Math.max(0, (coveredInbox?.length ?? 0) - digestCount);
    const digestLines =
      coveredInbox === undefined
        ? ['- stale cursor: released batch is no longer pending.']
        : [
            ...candidateDigestRows.slice(0, digestCount),
            ...(omittedCount > 0
              ? [`- … +${omittedCount} more pending event${omittedCount === 1 ? '' : 's'} omitted.`]
              : []),
            ...(queuedSuffixCount > 0
              ? [
                  `- queued suffix: +${queuedSuffixCount} durable event${queuedSuffixCount === 1 ? '' : 's'} await the next cursor release.`,
                ]
              : []),
          ];
    return [header, ...digestLines, ...FULL_INBOX_HINT_LINES];
  };
  let digestCount = 0;
  for (
    let nextDigestCount = 1;
    nextDigestCount <= candidateDigestRows.length;
    nextDigestCount += 1
  ) {
    if (wakeContentLines(nextDigestCount).join('\n').length <= MANAGER_INBOX_WAKE_MAX_CHARS)
      digestCount = nextDigestCount;
  }
  const omittedCount = Math.max(0, (coveredInbox?.length ?? 0) - digestCount);
  return {
    content: projectedWakeContent(wakeContentLines(digestCount)),
    customType: MANAGER_INBOX_WAKE_MESSAGE_TYPE,
    details: {
      cursor: wake.cursor,
      digestCount,
      omittedCount,
      pendingCount: wake.pendingCount,
      queuedSuffixCount,
      staleCursor: coveredInbox === undefined,
      type: MANAGER_INBOX_WAKE_DETAIL_TYPE,
      wakeToken: wake.token,
    },
    display: true,
  } as const;
}
