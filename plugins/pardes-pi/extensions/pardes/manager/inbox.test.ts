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
      awaitingUser: false,
      coveredCount: 0,
      queuedSuffixCount: 0,
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
      awaitingUser: false,
      coveredCount: 2,
      deliveredCursor: 'event-2',
      deliveredCursorAgeMs: 2_000,
      queuedSuffixCount: 1,
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
      awaitingUser: false,
      coveredCount: 0,
      queuedSuffixCount: 0,
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
        '- agent_report_completed: [child summary] agent-1: Implemented the bounded manager inbox wake.',
        'Inspect `pardes_status(view="inbox")` for full bounded rows; use `inbox_get({ eventId })` to read one known row; call `inbox_acknowledge` after handling; trust current inbox if stale.',
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
      '- conflict: [GitHub metadata] #68 for agent-1 has merge conflicts.',
    );
    expect(message.content).toContain(
      '- agent_question: [child question] agent-2 asks: May I update the fixture?',
    );
    expect(message.content).toContain(
      '- agent_protocol_error: [Pardes] child RPC protocol error; diagnostics omitted',
    );
    expect(message.content).toContain(
      '- future_external_feedback: [summary omitted] inspect full inbox row',
    );
    expect(message.content).not.toContain('raw diagnostic');
    expect(message.content).not.toContain('raw GitHub comment body');
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
      '- agent_report_completed: [advisory verifier summary] verifier-1: Consolidated advisory report.',
    );
    expect(message.content).toContain(
      '- agent_question: [advisory verifier question] verifier-1 asks: Is the omitted fixture available?',
    );
    expect(message.content).not.toContain('[worker');
  });

  test('keeps external GitHub discussion feedback explicitly provenance-labelled and row-bounded', () => {
    const summary = `[external GitHub feedback] #42 observed issue comment by @alice: ${JSON.stringify('x'.repeat(400))}`;
    const message = render([event('event-discussion', 'discussion_feedback', summary)]);
    const row = requiredValue(message.content.split('\n')[1]);

    expect(row).toContain(
      'discussion_feedback: [external GitHub feedback] #42 observed issue comment by @alice:',
    );
    expect(row.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
    expect(row.endsWith('…')).toBe(true);
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

    expect(row).toContain(
      '- merged: [GitHub metadata] #42 merge observed; idle-owner:stopped; stream:complete; follow-up:0.',
    );
    expect(row.length).toBeLessThanOrEqual(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
  });

  test('normalizes and truncates each digest row predictably', () => {
    const message = render([
      event('event-1', 'agent_report_blocked', `agent-1:\n${'x'.repeat(400)}`),
    ]);
    const row = requiredValue(message.content.split('\n')[1]);

    expect(row.length).toBe(MANAGER_INBOX_WAKE_MAX_ROW_CHARS);
    expect(row).not.toContain('\n');
    expect(row.endsWith('…')).toBe(true);
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
  });
});
