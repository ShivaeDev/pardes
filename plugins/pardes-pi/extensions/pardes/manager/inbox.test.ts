import { describe, expect, test } from 'vitest';
import { requiredValue } from '../test-support.ts';
import { type InboxWake, initialManagerState, type ManagerEvent } from './domain.ts';
import {
  inboxWakeAgeMs,
  inboxWakeToken,
  MANAGER_INBOX_WAKE_MAX_CHARS,
  MANAGER_INBOX_WAKE_MAX_ROW_CHARS,
  MANAGER_INBOX_WAKE_MAX_ROWS,
  makeInboxWake,
  projectInboxAttention,
  renderInboxWakeMessage,
  retainCurrentInboxWake,
  withInbox,
} from './inbox.ts';

const createdAt = '2026-06-01T00:00:00.000Z';

function event(
  id: string,
  type = 'agent_question',
  summary = 'A durable event needs attention.',
): ManagerEvent {
  return { createdAt, id, summary, type };
}

function state(inbox: ReadonlyArray<ManagerEvent>) {
  return {
    ...initialManagerState('manager-notification', {
      currentCheckout: '/tmp/repo',
      gitCommonDir: '/tmp/repo/.git',
      key: 'repo-notification',
      primaryCheckout: '/tmp/repo',
    }),
    inbox: [...inbox],
  };
}

function render(inbox: ReadonlyArray<ManagerEvent>) {
  return renderInboxWakeMessage({
    inbox,
    wake: requiredValue(makeInboxWake('manager-notification', inbox, createdAt)),
  });
}

describe('manager inbox notification projection', () => {
  test('creates a stable wake token through at most one inspectable durable inbox batch', () => {
    const inbox = Array.from({ length: MANAGER_INBOX_WAKE_MAX_ROWS + 2 }, (_, index) =>
      event(`event-${index + 1}`),
    );
    const cursor = `event-${MANAGER_INBOX_WAKE_MAX_ROWS}`;
    const wake = requiredValue(makeInboxWake('manager-notification', inbox, createdAt));

    expect(wake).toEqual({
      createdAt,
      cursor,
      pendingCount: MANAGER_INBOX_WAKE_MAX_ROWS,
      token: inboxWakeToken('manager-notification', cursor),
    });
    expect(makeInboxWake('manager-notification', [], createdAt)).toBeUndefined();
  });

  test('projects a conservative delivered-cursor age', () => {
    const wake = requiredValue(
      makeInboxWake('manager-notification', [event('event-1')], createdAt),
    );

    expect(inboxWakeAgeMs(wake, Date.parse(createdAt) + 12_345)).toBe(12_345);
    expect(inboxWakeAgeMs(wake, Date.parse(createdAt) - 1)).toBe(0);
    expect(
      inboxWakeAgeMs({ ...wake, createdAt: 'not-a-time' }, Date.parse(createdAt)),
    ).toBeUndefined();
  });

  test('rejects an oversized legacy delivered cursor and mechanically drops its ambiguous handoff without consuming rows', () => {
    const inbox = Array.from({ length: MANAGER_INBOX_WAKE_MAX_ROWS + 2 }, (_, index) =>
      event(`event-${index + 1}`),
    );
    const legacyWake = {
      createdAt,
      cursor: requiredValue(inbox.at(-1)).id,
      pendingCount: inbox.length,
      token: 'wake-legacy-oversized',
    };
    const projected = {
      ...state(inbox),
      inboxHandoff: {
        cursor: legacyWake.cursor,
        surfacedAt: createdAt,
        token: 'handoff-legacy-oversized',
      },
      inboxWake: legacyWake,
    };

    expect(retainCurrentInboxWake(inbox, legacyWake)).toBeUndefined();
    expect(projectInboxAttention(inbox, legacyWake)).toEqual({
      acknowledgeableCount: 6,
      acknowledgeableCursor: 'event-6',
      awaitingUser: false,
      coveredCount: 0,
      queuedSuffixCount: 0,
      readyFrontierCount: 6,
      readyFrontierCursor: 'event-6',
    });
    expect(withInbox(projected, inbox)).toEqual({ ...state(inbox), inbox: [...inbox] });
  });

  test('mechanically drops stale wake and handoff cursors after proactive handling', () => {
    const inbox = [event('event-1'), event('event-2')];
    const wake = requiredValue(makeInboxWake('manager-notification', inbox, createdAt));
    const projected = {
      ...state(inbox),
      inboxHandoff: { cursor: wake.cursor, surfacedAt: createdAt },
      inboxWake: wake,
    };

    expect(retainCurrentInboxWake(inbox, wake)).toEqual(wake);
    expect(withInbox(projected, [requiredValue(inbox[0])])).not.toHaveProperty('inboxWake');
    expect(withInbox(projected, [requiredValue(inbox[0])])).not.toHaveProperty('inboxHandoff');
    expect(withInbox(projected, [])).not.toHaveProperty('inboxWake');
  });

  test('projects one delivered cursor, durable awaiting-user state, and only the queued suffix', () => {
    const initialInbox = [event('event-1'), event('event-2')];
    const wake = requiredValue(makeInboxWake('manager-notification', initialInbox, createdAt));
    const inbox = [...initialInbox, event('event-late')];

    expect(projectInboxAttention(inbox, wake, undefined, Date.parse(createdAt) + 2_000)).toEqual({
      acknowledgeableCount: 2,
      acknowledgeableCursor: 'event-2',
      awaitingUser: false,
      coveredCount: 2,
      deliveredCursor: 'event-2',
      deliveredCursorAgeMs: 2_000,
      queuedSuffixCount: 1,
      readyFrontierCount: 3,
      readyFrontierCursor: 'event-late',
      wakeToken: wake.token,
    });
    expect(
      projectInboxAttention(inbox, wake, { cursor: wake.cursor, surfacedAt: createdAt }),
    ).toMatchObject({
      awaitingUser: true,
      deliveredCursor: 'event-2',
      queuedSuffixCount: 1,
    });
    expect(projectInboxAttention(inbox, undefined)).toEqual({
      acknowledgeableCount: 3,
      acknowledgeableCursor: 'event-late',
      awaitingUser: false,
      coveredCount: 0,
      queuedSuffixCount: 0,
      readyFrontierCount: 3,
      readyFrontierCursor: 'event-late',
    });
  });

  test('renders one actionable event as a signal-first child-labeled digest', () => {
    const inbox = [
      event(
        'event-1',
        'agent_report_completed',
        'agent-1: Implemented the bounded manager inbox wake.',
      ),
    ];
    const message = render(inbox);

    expect(message.content).toBe(
      [
        `[Pardes wake ${message.details.wakeToken}] 1 pending through cursor event-1`,
        '- agent_report_completed: [child summary] inspect inbox_get({ eventId:event-1 })',
        'Inspect `pardes_status(view="inbox")` for bounded rows; use `inbox_get({ eventId })` only for a known row; trust current inbox if stale.',
        'Autonomous rows may be acknowledged once handled.',
        'When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first; surface it.',
        'Use `question` with choices or `options: []` for free-form feedback; it binds the current delivered cursor and consumes only it after a non-blank answer.',
      ].join('\n'),
    );
    expect(message.details).toEqual({
      cursor: 'event-1',
      digestCount: 1,
      omittedCount: 0,
      pendingCount: 1,
      queuedSuffixCount: 0,
      staleCursor: false,
      type: 'manager_inbox_wake',
      wakeToken: message.details.wakeToken,
    });
  });

  test('renders mixed event provenance without injecting unsafe diagnostics or unknown summaries', () => {
    const message = render([
      event('event-1', 'conflict', '#68 for agent-1 has merge conflicts.'),
      event('event-2', 'agent_question', 'agent-2 asks: May I update the fixture?'),
      event('event-3', 'agent_protocol_error', 'raw diagnostic must stay out of wake'),
      event('event-4', 'future_external_feedback', 'raw GitHub comment body must stay out of wake'),
    ]);

    expect(message.content).toContain(
      '- conflict: [GitHub metadata] inspect inbox_get({ eventId:event-1 })',
    );
    expect(message.content).toContain(
      '- agent_question: [child question] inspect inbox_get({ eventId:event-2 })',
    );
    expect(message.content).toContain(
      '- agent_protocol_error: [Pardes] child RPC protocol error; inspect inbox_get({ eventId:event-3 })',
    );
    expect(message.content).toContain(
      '- future_external_feedback: [summary omitted] inspect inbox_get({ eventId:event-4 })',
    );
    expect(message.content).not.toContain('raw diagnostic');
    expect(message.content).not.toContain('raw GitHub comment body');
  });

  test('renders retained verifier missing-report attention as one actionable Pardes warning', () => {
    const message = render([
      {
        ...event(
          'event-verifier-idle',
          'verification_terminal_report_missing',
          'verifier-1: terminal report missing; follow up; do not poll. Retained advisory verifier remains attached idle.',
        ),
        verificationId: 'verify-1',
      },
    ]);

    expect(message.content).toContain(
      '- verification_terminal_report_missing: [Pardes] inspect inbox_get({ eventId:event-verifier-idle })',
    );
  });

  test('labels verifier-associated reports and questions explicitly without writing-worker attribution', () => {
    const message = render([
      {
        ...event(
          'event-report',
          'agent_report_completed',
          'verifier-1: Consolidated advisory report.',
        ),
        verificationId: 'verify-1',
      },
      {
        ...event(
          'event-question',
          'agent_question',
          'verifier-1 asks: Is the omitted fixture available?',
        ),
        verificationId: 'verify-1',
      },
    ]);

    expect(message.content).toContain(
      '- agent_report_completed: [advisory verifier summary] inspect inbox_get({ eventId:event-report })',
    );
    expect(message.content).toContain(
      '- agent_question: [advisory verifier question] inspect inbox_get({ eventId:event-question })',
    );
    expect(message.content).not.toContain('[worker');
  });

  test('keeps external GitHub discussion feedback explicitly provenance-labelled and row-bounded', () => {
    const summary = `[external GitHub feedback] #42 observed issue comment by @alice: ${JSON.stringify('x'.repeat(400))}`;
    const message = render([event('event-discussion', 'discussion_feedback', summary)]);
    const row = requiredValue(message.content.split('\n')[1]);

    expect(row).toContain(
      'discussion_feedback: [external GitHub feedback] inspect inbox_get({ eventId:event-discussion })',
    );
    expect(row.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
    expect(row).not.toContain('@alice');
  });

  test('keeps a routine merge retirement outcome self-contained in one bounded external-metadata row', () => {
    const message = render([
      event(
        'event-merge',
        'merged',
        '#42 merge observed; idle-owner:stopped; stream:complete; follow-up:0. External GitHub merge metadata was observed only; Pardes did not merge.',
      ),
    ]);
    const row = requiredValue(message.content.split('\n')[1]);

    expect(row).toContain('- merged: [GitHub metadata] inspect inbox_get({ eventId:event-merge })');
    expect(row.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
  });

  test('normalizes and truncates each digest row predictably', () => {
    const message = render([
      event('event-1', 'agent_report_blocked', `agent-1:\n${'x'.repeat(400)}`),
    ]);
    const row = requiredValue(message.content.split('\n')[1]);

    expect(row.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
    expect(row).not.toContain('\n');
    expect(row).not.toContain('x'.repeat(20));
    expect(row).toContain('inspect inbox_get({ eventId:event-1 })');
  });

  test('mints a cursor only through the ready prefix before a presentation-blocked merge row', () => {
    const inbox = [
      event('event-ready', 'agent_question', 'A ready prefix row.'),
      {
        ...event('event-merge', 'merged', 'Merge refinement is pending.'),
        presentationBlocked: true,
        presentationBlockedReason: 'merge_retirement_refinement',
      },
      event('event-suffix', 'agent_question', 'A suffix row held behind merge refinement.'),
    ];
    const wake = requiredValue(makeInboxWake('manager-notification', inbox, createdAt));
    const message = renderInboxWakeMessage({ inbox, wake });

    expect(wake).toMatchObject({ cursor: 'event-ready', pendingCount: 1 });
    expect(message.content).toContain(
      '- agent_question: [child question] inspect inbox_get({ eventId:event-ready })',
    );
    expect(message.content).toContain(
      '- queued suffix: +2 durable events await the next cursor release.',
    );
    expect(message.content).not.toContain('Merge refinement is pending.');
    expect(message.content).not.toContain('A suffix row held behind merge refinement.');
    expect(message.details).toMatchObject({ digestCount: 1, queuedSuffixCount: 2 });
    expect(makeInboxWake('manager-notification', inbox.slice(1), createdAt)).toBeUndefined();
    expect(projectInboxAttention(inbox, undefined)).toMatchObject({
      acknowledgeableCount: 1,
      acknowledgeableCursor: 'event-ready',
      presentationBlockedEventId: 'event-merge',
      presentationBlockedReason: 'merge_retirement_refinement',
      readyFrontierCount: 1,
      readyFrontierCursor: 'event-ready',
    });
  });

  test('leaves overflow as an explicit queued suffix instead of minting a cursor across hidden rows', () => {
    const inbox = Array.from({ length: MANAGER_INBOX_WAKE_MAX_ROWS + 3 }, (_, index) =>
      event(`event-${index}`, 'agent_idle', `agent-${index} is idle and ready for follow-up.`),
    );
    const wake = requiredValue(makeInboxWake('manager-notification', inbox, createdAt));
    const message = renderInboxWakeMessage({ inbox, wake });

    expect(wake.cursor).toBe(`event-${MANAGER_INBOX_WAKE_MAX_ROWS - 1}`);
    expect(wake.pendingCount).toBe(MANAGER_INBOX_WAKE_MAX_ROWS);
    expect(message.content).toContain(
      '- queued suffix: +3 durable events await the next cursor release.',
    );
    expect(message.content).not.toContain('more pending events omitted');
    expect(message.details).toMatchObject({
      digestCount: MANAGER_INBOX_WAKE_MAX_ROWS,
      omittedCount: 0,
      queuedSuffixCount: 3,
      staleCursor: false,
    });
    expect(
      message.content.split('\n').filter((line) => line.startsWith('- agent_idle')),
    ).toHaveLength(MANAGER_INBOX_WAKE_MAX_ROWS);
  });

  test('treats an absent through-cursor as stale without digesting unrelated current attention', () => {
    const wake: InboxWake = {
      createdAt,
      cursor: 'event-handled',
      pendingCount: 2,
      token: 'wake-stale',
    };
    const message = renderInboxWakeMessage({
      inbox: [event('event-later', 'agent_question', 'do not present unrelated current event')],
      wake,
    });

    expect(message.content).toContain(
      '[Pardes wake wake-stale] 2 pending through cursor event-handled',
    );
    expect(message.content).toContain('- stale cursor: released batch is no longer pending.');
    expect(message.content).toContain('trust current inbox if stale');
    expect(message.content).not.toContain('do not present unrelated current event');
    expect(message.details).toMatchObject({
      digestCount: 0,
      omittedCount: 0,
      queuedSuffixCount: 0,
      staleCursor: true,
    });
  });

  test('hard-bounds total model-visible wake text for oversized persisted content', () => {
    const inbox = Array.from({ length: MANAGER_INBOX_WAKE_MAX_ROWS + 5 }, (_, index) =>
      event(
        `event-${index}-${'c'.repeat(500)}`,
        'agent_report_completed',
        `worker-authored ${'s'.repeat(2_000)}`,
      ),
    );
    const message = render(inbox);
    const digestRows = message.content
      .split('\n')
      .filter((line) => line.startsWith('- agent_report_completed'));

    expect(message.content.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_CHARS);
    expect(digestRows).toHaveLength(MANAGER_INBOX_WAKE_MAX_ROWS);
    for (const row of digestRows)
      expect(row.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
    expect(message.content).not.toContain('s'.repeat(MANAGER_INBOX_WAKE_MAX_ROW_CHARS));
    expect(message.content).toContain('Autonomous rows may be acknowledged once handled.');
    expect(message.content).toContain(
      'When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first; surface it.',
    );
    expect(message.content.endsWith('consumes only it after a non-blank answer.')).toBe(true);
  });

  test('reserves intact authored hints and omission metadata before selecting complete legacy wake rows', () => {
    const coveredCount = MANAGER_INBOX_WAKE_MAX_ROWS + 100;
    const inbox = Array.from({ length: coveredCount + 100 }, (_, index) =>
      event(
        `event-${index}-${'c'.repeat(500)}`,
        'agent_report_completed',
        `worker-authored ${'s'.repeat(2_000)}`,
      ),
    );
    const cursor = requiredValue(inbox[coveredCount - 1]).id;
    const message = renderInboxWakeMessage({
      inbox,
      wake: {
        createdAt,
        cursor,
        pendingCount: coveredCount,
        token: `wake-${'t'.repeat(500)}`,
      },
    });
    const digestRows = message.content
      .split('\n')
      .filter((line) => line.startsWith('- agent_report_completed'));

    expect(message.content.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_CHARS);
    expect(digestRows).toHaveLength(MANAGER_INBOX_WAKE_MAX_ROWS - 1);
    for (const row of digestRows) expect(row.length).toBe(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
    expect(message.details).toMatchObject({
      digestCount: MANAGER_INBOX_WAKE_MAX_ROWS - 1,
      omittedCount: coveredCount - MANAGER_INBOX_WAKE_MAX_ROWS + 1,
      queuedSuffixCount: 100,
      staleCursor: false,
    });
    expect(message.content).toContain(
      `- … +${coveredCount - MANAGER_INBOX_WAKE_MAX_ROWS + 1} more pending events omitted.`,
    );
    expect(message.content).toContain(
      '- queued suffix: +100 durable events await the next cursor release.',
    );
    expect(message.content).toContain('Autonomous rows may be acknowledged once handled.');
    expect(message.content.endsWith('consumes only it after a non-blank answer.')).toBe(true);
  });
});
