import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import { REPORT_EXCERPT_MAX_CHARS, REPORT_HANDOFF_NOTE_MAX_CHARS } from '../reporting/index.ts';
import {
  AgentIdInputSchema,
  decodeAgentIdInput,
  decodeAgentLeaseCleanupInput,
  decodeAgentReviveInput,
  decodeAgentSendInput,
  decodeAgentSendReportInput,
  decodeAgentSpawnInput,
  decodeInboxGetInput,
  decodeManagerInput,
  decodePullRequestCreateInput,
  decodeVerificationRefreshInput,
  decodeVerificationRequestInput,
  decodeWorkstreamCreateInput,
  decodeWorkstreamIdInput,
  INBOX_EVENT_EXCERPT_MAX_CHARS,
  INBOX_EVENT_EXCERPT_MAX_OFFSET,
  MANAGER_INPUT_ID_MAX_LENGTH,
  MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
  MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH,
  MANAGER_INPUT_VALIDATION_ERROR_MAX_LENGTH,
  ManagerInputValidationError,
} from './inputs.ts';

async function expectRejected(
  effect: Effect.Effect<unknown, ManagerInputValidationError>,
  boundary: string,
): Promise<ManagerInputValidationError> {
  const error = await Effect.runPromise(effect.pipe(Effect.flip));
  expect(error).toBeInstanceOf(ManagerInputValidationError);
  expect(error._tag).toBe('ManagerInputValidationError');
  expect(error.boundary).toBe(boundary);
  return error;
}

describe('manager input schemas', () => {
  test('decodes current manager command inputs with exact optional overrides', async () => {
    expect(
      await Effect.runPromise(
        decodeWorkstreamCreateInput({
          objective: 'Decode before lifecycle side effects.',
          title: 'Schema substrate',
        }),
      ),
    ).toEqual({
      objective: 'Decode before lifecycle side effects.',
      title: 'Schema substrate',
    });
    expect(
      await Effect.runPromise(
        decodePullRequestCreateInput({
          agentId: 'agent-12345678',
          baseBranch: 'release/v1.2_3',
          body: 'Summary and validation.',
          openInBrowser: true,
          title: 'Publish schema substrate',
          workstreamId: 'ws-12345678',
        }),
      ),
    ).toEqual({
      agentId: 'agent-12345678',
      baseBranch: 'release/v1.2_3',
      body: 'Summary and validation.',
      openInBrowser: true,
      title: 'Publish schema substrate',
      workstreamId: 'ws-12345678',
    });
    expect(
      await Effect.runPromise(
        decodePullRequestCreateInput({
          agentId: 'agent-12345678',
          baseBranch: 'release/v1.2_3',
          body: 'Summary and validation.',
          browserMode: 'background',
          title: 'Publish schema substrate in background',
          workstreamId: 'ws-12345678',
        }),
      ),
    ).toEqual({
      agentId: 'agent-12345678',
      baseBranch: 'release/v1.2_3',
      body: 'Summary and validation.',
      browserMode: 'background',
      title: 'Publish schema substrate in background',
      workstreamId: 'ws-12345678',
    });
    expect(
      await Effect.runPromise(
        decodeAgentSpawnInput({
          baselineBranch: 'release/v1.2_3',
          model: 'openai-codex/gpt-5.4',
          task: 'Implement a bounded schema boundary.',
          thinkingLevel: 'high',
          title: 'Schema ergonomics',
          workstreamId: 'ws-12345678',
        }),
      ),
    ).toEqual({
      baselineBranch: 'release/v1.2_3',
      model: 'openai-codex/gpt-5.4',
      task: 'Implement a bounded schema boundary.',
      thinkingLevel: 'high',
      title: 'Schema ergonomics',
      workstreamId: 'ws-12345678',
    });
    expect(
      await Effect.runPromise(
        decodeAgentSendInput({
          agentId: 'agent-12345678',
          behavior: 'auto',
          message: 'Please verify the focused tests.',
        }),
      ),
    ).toEqual({
      agentId: 'agent-12345678',
      behavior: 'auto',
      message: 'Please verify the focused tests.',
    });
    expect(
      await Effect.runPromise(
        decodeAgentSendInput({
          agentId: 'agent-12345678',
          behavior: 'steer',
          message: 'Interrupt for the urgent failure.',
        }),
      ),
    ).toEqual({
      agentId: 'agent-12345678',
      behavior: 'steer',
      message: 'Interrupt for the urgent failure.',
    });
    expect(
      await Effect.runPromise(
        decodeAgentSendReportInput({
          agentId: 'agent-12345678',
          field: 'details',
          maxChars: 400,
          message: 'Review the advisory finding critically.',
          offset: 12,
          reportId: 'report-123',
        }),
      ),
    ).toEqual({
      agentId: 'agent-12345678',
      field: 'details',
      maxChars: 400,
      message: 'Review the advisory finding critically.',
      offset: 12,
      reportId: 'report-123',
    });
    expect(
      await Effect.runPromise(
        decodeAgentReviveInput({
          agentId: 'agent-12345678',
          message: 'Resume the retained session.',
        }),
      ),
    ).toEqual({
      agentId: 'agent-12345678',
      message: 'Resume the retained session.',
    });
    expect(
      await Effect.runPromise(
        decodeAgentLeaseCleanupInput({
          action: 'cleanup',
          agentId: 'agent-12345678',
          forceDeleteUnmergedBranch: true,
          forceDiscardDirty: true,
        }),
      ),
    ).toEqual({
      action: 'cleanup',
      agentId: 'agent-12345678',
      forceDeleteUnmergedBranch: true,
      forceDiscardDirty: true,
    });
    expect(
      await Effect.runPromise(
        decodeInboxGetInput({ eventId: 'event-1234_ab.cd', maxChars: 123, offset: 456 }),
      ),
    ).toEqual({
      eventId: 'event-1234_ab.cd',
      maxChars: 123,
      offset: 456,
    });
    expect(
      await Effect.runPromise(
        decodeInboxGetInput({ eventId: 'event-legacy-summary', offset: 2 * 1_024 * 1_024 }),
      ),
    ).toEqual({ eventId: 'event-legacy-summary', offset: 2 * 1_024 * 1_024 });
    expect(
      await Effect.runPromise(
        decodeVerificationRequestInput({
          sourceAgentId: 'agent-12345678',
          task: 'Review this head.',
          thinkingLevel: 'high',
        }),
      ),
    ).toEqual({
      sourceAgentId: 'agent-12345678',
      task: 'Review this head.',
      thinkingLevel: 'high',
    });
    expect(
      await Effect.runPromise(
        decodeVerificationRefreshInput({ verificationId: 'verify-12345678' }),
      ),
    ).toEqual({ verificationId: 'verify-12345678' });
  });

  test('keeps safe defaults optional and rejects excess manager input properties', async () => {
    expect(
      await Effect.runPromise(
        decodeAgentSpawnInput({
          task: 'Implement only the reviewed vertical slice.',
          workstreamId: 'ws-12345678',
        }),
      ),
    ).toEqual({
      task: 'Implement only the reviewed vertical slice.',
      workstreamId: 'ws-12345678',
    });
    expect(
      await Effect.runPromise(
        decodeAgentSendInput({ agentId: 'agent-12345678', message: 'Continue.' }),
      ),
    ).toEqual({
      agentId: 'agent-12345678',
      message: 'Continue.',
    });
    await expectRejected(
      decodeAgentSpawnInput({
        ownedPaths: ['extensions/pardes'],
        task: 'Do not accept stale ownership declarations.',
        workstreamId: 'ws-12345678',
      }),
      'agent_spawn',
    );
  });

  test('accepts only bounded lexical workstream and agent ids', async () => {
    expect(
      await Effect.runPromise(decodeWorkstreamIdInput({ workstreamId: 'ws-1234_ab.cd' })),
    ).toEqual({ workstreamId: 'ws-1234_ab.cd' });
    expect(await Effect.runPromise(decodeAgentIdInput({ agentId: 'agent-12345678' }))).toEqual({
      agentId: 'agent-12345678',
    });

    await expectRejected(
      decodeWorkstreamIdInput({ workstreamId: 'w'.repeat(MANAGER_INPUT_ID_MAX_LENGTH + 1) }),
      'workstream_id',
    );
    await expectRejected(decodeWorkstreamIdInput({ workstreamId: 'ws/unsafe' }), 'workstream_id');
    await expectRejected(decodeAgentIdInput({ agentId: '' }), 'agent_id');
    await expectRejected(decodeAgentIdInput({ agentId: 'agent unsafe' }), 'agent_id');
    await expectRejected(decodeInboxGetInput({ eventId: 'event/unsafe' }), 'inbox_get');
    await expectRejected(
      decodeInboxGetInput({ eventId: 'e'.repeat(MANAGER_INPUT_ID_MAX_LENGTH + 1) }),
      'inbox_get',
    );
    await expectRejected(
      decodeInboxGetInput({ eventId: 'event-safe', maxChars: INBOX_EVENT_EXCERPT_MAX_CHARS + 1 }),
      'inbox_get',
    );
    await expectRejected(
      decodeInboxGetInput({ eventId: 'event-safe', offset: INBOX_EVENT_EXCERPT_MAX_OFFSET + 1 }),
      'inbox_get',
    );
    await expectRejected(
      decodeVerificationRequestInput({ sourceAgentId: 'agent/unsafe' }),
      'verification_request',
    );
    await expectRejected(
      decodeVerificationRefreshInput({ verificationId: 'verify/unsafe' }),
      'verification_refresh',
    );
  });

  test('reuses one decoder-ready agent-id schema for lifecycle and queued runtime controls', async () => {
    for (const boundary of [
      'agent_status',
      'agent_stop',
      'agent_compact',
      'agent_reload',
    ] as const) {
      expect(
        await Effect.runPromise(
          decodeManagerInput(boundary, AgentIdInputSchema, { agentId: 'agent-12345678' }),
        ),
      ).toEqual({ agentId: 'agent-12345678' });
      await expectRejected(
        decodeManagerInput(boundary, AgentIdInputSchema, { agentId: 'agent/unsafe' }),
        boundary,
      );
    }
  });

  test('rejects unsafe baseline-branch overrides and exact enum mismatches', async () => {
    await expectRejected(
      decodeAgentSpawnInput({
        baselineBranch: '--upload-pack=attacker',
        task: 'Task',
        workstreamId: 'ws-1',
      }),
      'agent_spawn',
    );
    await expectRejected(
      decodeAgentSpawnInput({ baselineBranch: '/unsafe', task: 'Task', workstreamId: 'ws-1' }),
      'agent_spawn',
    );
    await expectRejected(
      decodeAgentSpawnInput({
        baselineBranch: 'a'.repeat(256),
        task: 'Task',
        workstreamId: 'ws-1',
      }),
      'agent_spawn',
    );
    await expectRejected(
      decodeAgentSpawnInput({ task: 'Task', thinkingLevel: 'extreme', workstreamId: 'ws-1' }),
      'agent_spawn',
    );
    await expectRejected(
      decodeAgentSendInput({ agentId: 'agent-1', behavior: 'later', message: 'Continue.' }),
      'agent_send',
    );
    await expectRejected(
      decodeAgentSendReportInput({
        agentId: 'agent-1',
        field: 'instructions',
        reportId: 'report-1',
      }),
      'agent_send_report',
    );
    await expectRejected(
      decodeAgentSendReportInput({ agentId: 'agent-1', reportId: '../outside' }),
      'agent_send_report',
    );
    await expectRejected(
      decodeAgentLeaseCleanupInput({
        action: 'cleanup',
        agentId: 'agent/unsafe',
        forceDiscardDirty: true,
      }),
      'agent_lease_cleanup',
    );
    await expectRejected(
      decodeAgentLeaseCleanupInput({ action: 'sweep', agentId: 'agent-1' }),
      'agent_lease_cleanup',
    );
  });

  test('rejects oversized bounded text, unsafe PR branches, and invalid browser handoff', async () => {
    await expectRejected(
      decodeWorkstreamCreateInput({
        objective: 'Objective',
        title: 'x'.repeat(MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH + 1),
      }),
      'workstream_create',
    );
    await expectRejected(
      decodeWorkstreamCreateInput({
        objective: 'x'.repeat(MANAGER_INPUT_LONG_TEXT_MAX_LENGTH + 1),
        title: 'Title',
      }),
      'workstream_create',
    );
    await expectRejected(
      decodeAgentSpawnInput({ task: 'Task', title: 'x'.repeat(81), workstreamId: 'ws-1' }),
      'agent_spawn',
    );
    await expectRejected(
      decodeAgentSpawnInput({
        task: 'x'.repeat(MANAGER_INPUT_LONG_TEXT_MAX_LENGTH + 1),
        workstreamId: 'ws-1',
      }),
      'agent_spawn',
    );
    await expectRejected(
      decodeAgentSpawnInput({
        model: 'x'.repeat(MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH + 1),
        task: 'Task',
        workstreamId: 'ws-1',
      }),
      'agent_spawn',
    );
    await expectRejected(
      decodeAgentSendInput({
        agentId: 'agent-1',
        message: 'x'.repeat(MANAGER_INPUT_LONG_TEXT_MAX_LENGTH + 1),
      }),
      'agent_send',
    );
    await expectRejected(
      decodeAgentSendReportInput({
        agentId: 'agent-1',
        maxChars: REPORT_EXCERPT_MAX_CHARS + 1,
        reportId: 'report-1',
      }),
      'agent_send_report',
    );
    await expectRejected(
      decodeAgentSendReportInput({
        agentId: 'agent-1',
        message: 'x'.repeat(REPORT_HANDOFF_NOTE_MAX_CHARS + 1),
        reportId: 'report-1',
      }),
      'agent_send_report',
    );
    await expectRejected(
      decodeAgentReviveInput({ agentId: 'agent-1', message: '' }),
      'agent_revive',
    );
    await expectRejected(
      decodePullRequestCreateInput({
        agentId: 'agent-1',
        baseBranch: 'feature branch',
        body: 'Summary.',
        title: 'Publish',
        workstreamId: 'ws-1',
      }),
      'pull_request_create',
    );
    await expectRejected(
      decodePullRequestCreateInput({
        agentId: 'agent-1',
        baseBranch: 'x'.repeat(256),
        body: 'Summary.',
        title: 'Publish',
        workstreamId: 'ws-1',
      }),
      'pull_request_create',
    );
    await expectRejected(
      decodePullRequestCreateInput({
        agentId: 'agent-1',
        baseBranch: 'main',
        body: 'Summary.',
        title: 'x'.repeat(MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH + 1),
        workstreamId: 'ws-1',
      }),
      'pull_request_create',
    );
    await expectRejected(
      decodePullRequestCreateInput({
        agentId: 'agent-1',
        baseBranch: 'main',
        body: 'x'.repeat(MANAGER_INPUT_LONG_TEXT_MAX_LENGTH + 1),
        title: 'Publish',
        workstreamId: 'ws-1',
      }),
      'pull_request_create',
    );
    await expectRejected(
      decodePullRequestCreateInput({
        agentId: 'agent-1',
        baseBranch: 'main',
        body: 'Summary.',
        browserMode: 'sideways',
        title: 'Publish',
        workstreamId: 'ws-1',
      }),
      'pull_request_create',
    );
    await expectRejected(
      decodePullRequestCreateInput({
        agentId: 'agent-1',
        baseBranch: 'main',
        body: 'Summary.',
        openInBrowser: 'yes',
        title: 'Publish',
        workstreamId: 'ws-1',
      }),
      'pull_request_create',
    );
    await expectRejected(
      decodePullRequestCreateInput({
        agentId: 'agent-1',
        baseBranch: 'main',
        body: 'Summary.',
        browserMode: 'background',
        openInBrowser: true,
        title: 'Publish',
        workstreamId: 'ws-1',
      }),
      'pull_request_create',
    );
  });

  test('bounds validation error representations for hostile oversized input', async () => {
    const error = await expectRejected(
      decodeAgentSendInput({
        agentId: 'agent-1',
        message: 'x'.repeat(MANAGER_INPUT_LONG_TEXT_MAX_LENGTH + 1),
        unexpected: 'y'.repeat(MANAGER_INPUT_LONG_TEXT_MAX_LENGTH + 1),
      }),
      'agent_send',
    );

    expect(error.cause.length).toBe(MANAGER_INPUT_VALIDATION_ERROR_MAX_LENGTH);
    expect(error.cause.endsWith('…')).toBe(true);
    expect(JSON.stringify(error).length).toBeLessThanOrEqual(
      MANAGER_INPUT_VALIDATION_ERROR_MAX_LENGTH + 128,
    );
  });
});
