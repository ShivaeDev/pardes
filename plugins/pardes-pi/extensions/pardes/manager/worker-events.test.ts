import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import type { WorktreeInspection } from '../git/index.ts';
import { requiredValue } from '../test-support.ts';
import {
  CHILD_QUESTION_CONTEXT_MAX_CHARS,
  CHILD_QUESTION_MAX_CHARS,
} from '../worker-runtime/child-profile.ts';
import type { WorkerSupervisorEvent } from '../worker-runtime/index.ts';
import {
  type AgentRecord,
  currentVerificationTerminalReportStatus,
  MANAGER_EVENT_DETAILS_MAX_CHARS,
  type ManagerEvent,
  ManagerEventSchema,
  type VerificationRecord,
} from './domain.ts';
import {
  acceptedDurableEventDetails,
  applyHandoffAudit,
  boundedEventSummary,
  boundedFailureSummary,
  failedHandoffAudit,
  type HandoffAuditOutcome,
  handoffAuditSuffix,
  hasPendingAgentAttention,
  hasPendingCanonicalAttention,
  isDuplicateWorkerAttention,
  type ReportArtifactPersistence,
  reportPersistenceSuffix,
  successfulHandoffAudit,
  truncateModelFacingText,
  type VerifierIdleDisposition,
  verifierIdleDisposition,
  type WorkerEventSummary,
  workerEventSummary,
} from './worker-events.ts';

const createdAt = '2026-06-01T00:00:00.000Z';
const laterAt = '2026-06-01T00:01:00.000Z';
const persistedReport = {
  reportId: 'report-one',
  status: 'persisted',
} as const satisfies ReportArtifactPersistence;
const failedReport = {
  failureSummary: 'report store unavailable',
  status: 'failed',
} as const satisfies ReportArtifactPersistence;

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    createdAt,
    id: 'agent-one',
    model: 'fixture/model',
    role: 'worker',
    sessionDir: '/tmp/pardes/session',
    status: 'idle',
    task: 'Exercise manager event policy.',
    thinkingLevel: 'high',
    updatedAt: createdAt,
    workstreamId: 'ws-one',
    ...overrides,
  };
}

function inspection(overrides: Partial<WorktreeInspection> = {}): WorktreeInspection {
  return {
    changedPaths: [],
    dirty: false,
    headSha: 'a'.repeat(40),
    path: '/tmp/pardes/worktree',
    ...overrides,
  };
}

function inboxEvent(type: string, agentId?: string): ManagerEvent {
  return {
    createdAt,
    id: `event-${type}-${agentId ?? 'unassociated'}`,
    summary: 'Pending attention.',
    type,
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function verification(
  latestReportStatus?: 'progress' | 'completed' | 'blocked',
): VerificationRecord {
  return {
    attempts: [
      {
        attempt: 1,
        createdAt,
        evidenceStatus: 'current',
        ...(latestReportStatus === undefined
          ? {}
          : {
              latestReport: {
                createdAt,
                reportId: `report-${latestReportStatus}`,
                status: latestReportStatus,
                summaryTruncated: false,
              },
            }),
        reviewCheckout: {
          createdAt,
          managerId: 'manager-one',
          path: '/tmp/pardes/reviews/verify-one',
          reviewedHeadSha: 'b'.repeat(40),
          verificationId: 'verify-one',
        },
        reviewedHeadSha: 'b'.repeat(40),
        sourceBranchPointSha: 'a'.repeat(40),
        status:
          latestReportStatus === 'completed' || latestReportStatus === 'blocked'
            ? latestReportStatus
            : 'running',
        updatedAt: createdAt,
      },
    ],
    createdAt,
    id: 'verify-one',
    model: 'fixture/model',
    sourceAgentId: 'agent-source',
    task: 'Review.',
    thinkingLevel: 'high',
    updatedAt: createdAt,
    verifierAgentId: 'agent-one',
    workstreamId: 'ws-one',
  };
}

describe('manager event schema compatibility', () => {
  test('decodes historical schema-v1 events without report pointers and additive structured report associations', () => {
    const historical: ManagerEvent = {
      createdAt,
      id: 'event-old',
      summary: 'Historical bounded preview.',
      type: 'agent_report_completed',
    };
    const associated: ManagerEvent = {
      ...historical,
      id: 'event-new',
      reportId: 'report-123',
      reportPreviewTruncated: true,
    };

    expect(Schema.decodeUnknownSync(ManagerEventSchema)(historical)).toEqual(historical);
    expect(Schema.decodeUnknownSync(ManagerEventSchema)(associated)).toEqual(associated);
  });

  test('rejects incoherent restored report-preview omission metadata', () => {
    const incoherent = {
      createdAt,
      id: 'event-incoherent',
      reportId: 'report-123',
      reportPreviewChars: { omittedChars: 0, originalChars: 1, shownChars: 999 },
      reportPreviewOmissionReason: 'report_summary_preview_limit',
      reportPreviewTruncated: false,
      summary: 'Impossible counts.',
      type: 'agent_report_completed',
    };

    expect(() => Schema.decodeUnknownSync(ManagerEventSchema)(incoherent)).toThrow();
  });
});

describe('manager event text policy', () => {
  test('normalizes whitespace and accounts for omissions inside the 240-character model-facing bound', () => {
    expect(truncateModelFacingText('  hello\n\tworld  ')).toBe('hello world');
    expect(truncateModelFacingText('x'.repeat(240))).toBe('x'.repeat(240));
    const omitted = truncateModelFacingText('x'.repeat(241));
    expect(omitted).toHaveLength(240);
    expect(omitted).toContain(
      '[omitted reason=manager_event_text_limit originalChars=241 shownChars=149 omittedChars=92]',
    );
  });

  test('normalizes joined parts and accounts for omissions inside the 900-character summary bound', () => {
    expect(boundedEventSummary(['  hello', '', '\n world  '])).toBe('hello world');
    expect(boundedEventSummary(['x'.repeat(900)])).toBe('x'.repeat(900));
    const omitted = boundedEventSummary(['x'.repeat(901)]);
    expect(omitted).toHaveLength(900);
    expect(omitted).toContain(
      '[omitted reason=manager_event_summary_limit originalChars=901 shownChars=806 omittedChars=95]',
    );
  });

  test('formats, normalizes, and bounds failure summaries', () => {
    const summary = boundedFailureSummary(new Error(`  inspection\n failed ${'x'.repeat(300)}  `));

    expect(summary.startsWith('inspection failed ')).toBe(true);
    expect(summary).toHaveLength(240);
    expect(summary).toContain('[omitted reason=manager_event_text_limit');
    expect(summary).not.toContain('\n');
  });
});

describe('manager handoff-audit policy', () => {
  test('constructs success and bounded failure outcomes', () => {
    const succeeded = successfulHandoffAudit(
      'completion',
      laterAt,
      inspection({ changedPaths: ['src/a.ts'], dirty: true }),
    );
    const failed = failedHandoffAudit(
      'stop',
      laterAt,
      new Error(`inspection failed ${'x'.repeat(300)}`),
    );

    expect(succeeded).toEqual({
      changedPaths: ['src/a.ts'],
      gitAudit: { checkedAt: laterAt, dirty: true, status: 'succeeded', trigger: 'completion' },
      status: 'succeeded',
    });
    expect(failed).toMatchObject({
      gitAudit: { checkedAt: laterAt, status: 'failed', trigger: 'stop' },
      status: 'failed',
    });
    if (failed.status !== 'failed') throw new Error('Expected a failed handoff audit fixture.');
    expect(failed.gitAudit.failureSummary).toHaveLength(240);
    expect(failed.gitAudit.failureSummary).toContain('[omitted reason=manager_event_text_limit');
  });

  test('applies fresh success paths and clears stale paths after failure', () => {
    const original = agent({
      changedPaths: ['stale.ts'],
      gitAudit: { checkedAt: createdAt, dirty: true, status: 'succeeded', trigger: 'completion' },
    });
    const succeeded = successfulHandoffAudit(
      'publication',
      laterAt,
      inspection({ changedPaths: ['fresh.ts'] }),
    );
    const failed = failedHandoffAudit('stop', laterAt, new Error('inspection unavailable'));

    expect(applyHandoffAudit(original, undefined)).toBe(original);
    expect(applyHandoffAudit(original, succeeded)).toMatchObject({
      changedPaths: ['fresh.ts'],
      gitAudit: succeeded.gitAudit,
      updatedAt: laterAt,
    });
    const failedAgent = applyHandoffAudit(original, failed);
    expect(failedAgent).toMatchObject({ gitAudit: failed.gitAudit, updatedAt: laterAt });
    expect(failedAgent).not.toHaveProperty('changedPaths');
  });

  test('renders absent, plural, dirty, and failure audit suffixes', () => {
    const cases: ReadonlyArray<{
      readonly audit: HandoffAuditOutcome | undefined;
      readonly expected: string;
    }> = [
      { audit: undefined, expected: '' },
      {
        audit: successfulHandoffAudit('completion', laterAt, inspection()),
        expected: 'Git audit: 0 changed paths.',
      },
      {
        audit: successfulHandoffAudit(
          'completion',
          laterAt,
          inspection({ changedPaths: ['one.ts'] }),
        ),
        expected: 'Git audit: 1 changed path.',
      },
      {
        audit: successfulHandoffAudit(
          'completion',
          laterAt,
          inspection({ changedPaths: ['one.ts', 'two.ts'], dirty: true }),
        ),
        expected: 'Git audit: 2 changed paths. Worktree is dirty.',
      },
      {
        audit: failedHandoffAudit('completion', laterAt, new Error('inspection unavailable')),
        expected: 'Git audit failed: inspection unavailable.',
      },
    ];

    for (const { audit, expected } of cases) expect(handoffAuditSuffix(audit)).toBe(expected);
  });

  test('renders only failed report-persistence suffixes', () => {
    expect(reportPersistenceSuffix(undefined)).toBe('');
    expect(reportPersistenceSuffix(persistedReport)).toBe('');
    expect(reportPersistenceSuffix(failedReport)).toBe(
      'Report artifact persistence failed: report store unavailable.',
    );
  });
});

describe('verifier idle classification policy', () => {
  const idle: WorkerSupervisorEvent = { agentId: 'agent-one', status: 'idle', type: 'status' };
  const verifier = agent({ role: 'verifier', status: 'running' });

  test('distinguishes report completion, transient handoff settlement, stopped or crashed state, and attached idle without a terminal report', () => {
    const cases: ReadonlyArray<{
      readonly event?: WorkerSupervisorEvent;
      readonly agent?: AgentRecord;
      readonly verification?: VerificationRecord;
      readonly handoffSettling?: boolean;
      readonly expected: VerifierIdleDisposition | undefined;
    }> = [
      { expected: 'report_complete', verification: verification('completed') },
      {
        expected: 'report_complete',
        verification: verification('blocked'),
      },
      {
        expected: 'handoff_settling',
        handoffSettling: true,
        verification: verification(),
      },
      {
        agent: agent({ role: 'verifier', status: 'crashed' }),
        expected: 'stopped_or_crashed',
        verification: verification(),
      },
      {
        event: {
          agentId: 'agent-one',
          exitCode: 1,
          signal: null,
          stderr: { omittedChars: 0, originalChars: 15, shownChars: 15, tail: 'fixture failure' },
          type: 'unexpected_exit',
        },
        expected: 'stopped_or_crashed',
        verification: verification(),
      },
      {
        expected: 'attached_idle_without_terminal_report',
        verification: verification(),
      },
      {
        expected: 'attached_idle_without_terminal_report',
        verification: verification('progress'),
      },
      { agent: agent({ role: 'worker', status: 'running' }), expected: undefined },
      {
        event: { agentId: 'agent-one', status: 'running', type: 'status' },
        expected: undefined,
        verification: verification(),
      },
    ];

    for (const entry of cases)
      expect(
        verifierIdleDisposition(
          entry.event ?? idle,
          entry.agent ?? verifier,
          entry.verification,
          entry.handoffSettling,
        ),
      ).toBe(entry.expected);
  });

  test('reads only current-attempt completed or blocked durable report references as terminal', () => {
    expect(currentVerificationTerminalReportStatus(undefined)).toBeUndefined();
    expect(currentVerificationTerminalReportStatus(verification())).toBeUndefined();
    expect(currentVerificationTerminalReportStatus(verification('progress'))).toBeUndefined();
    expect(currentVerificationTerminalReportStatus(verification('completed'))).toBe('completed');
    expect(currentVerificationTerminalReportStatus(verification('blocked'))).toBe('blocked');
  });
});

describe('worker-event summary policy', () => {
  test('projects the existing actionable and suppressed event table', () => {
    const succeededAudit = successfulHandoffAudit(
      'completion',
      laterAt,
      inspection({ changedPaths: ['one.ts', 'two.ts'], dirty: true }),
    );
    const cases: ReadonlyArray<{
      readonly event: WorkerSupervisorEvent;
      readonly persistence?: ReportArtifactPersistence;
      readonly audit?: HandoffAuditOutcome;
      readonly options?: {
        readonly suppressIdleWakeup?: boolean;
        readonly verifierIdleDisposition?: VerifierIdleDisposition;
      };
      readonly expected: WorkerEventSummary | undefined;
    }> = [
      {
        event: {
          agentId: 'agent-one',
          status: 'progress',
          summary: '  Routine\nprogress. ',
          type: 'report',
        },
        expected: {
          actionable: false,
          reportPreviewChars: { omittedChars: 0, originalChars: 17, shownChars: 17 },
          reportPreviewTruncated: false,
          summary: 'agent-one: Routine progress.',
          type: 'agent_report_progress',
        },
        persistence: persistedReport,
      },
      {
        audit: succeededAudit,
        event: { agentId: 'agent-one', status: 'completed', summary: 'Done.', type: 'report' },
        expected: {
          actionable: true,
          reportPreviewChars: { omittedChars: 0, originalChars: 5, shownChars: 5 },
          reportPreviewTruncated: false,
          summary: 'agent-one: Done. Git audit: 2 changed paths. Worktree is dirty.',
          type: 'agent_report_completed',
        },
        persistence: persistedReport,
      },
      {
        event: {
          agentId: 'agent-one',
          status: 'blocked',
          summary: 'Needs decision.',
          type: 'report',
        },
        expected: {
          actionable: true,
          summary: 'agent-one: Needs decision.',
          type: 'agent_report_blocked',
        },
      },
      {
        event: { agentId: 'agent-one', question: '  Choose\npath? ', type: 'question' },
        expected: {
          actionable: true,
          details: '{"question":"  Choose\\npath? "}',
          summary: 'agent-one asks a blocking question; inspect the durable inbox detail.',
          type: 'agent_question',
        },
      },
      {
        event: {
          agentId: 'agent-one',
          exitCode: 1,
          signal: null,
          stderr: { omittedChars: 0, originalChars: 15, shownChars: 15, tail: 'fixture failure' },
          type: 'unexpected_exit',
        },
        expected: {
          actionable: true,
          summary: 'agent-one exited unexpectedly.',
          type: 'agent_crashed',
        },
      },
      {
        event: { agentId: 'agent-one', message: ' invalid\njson ', type: 'protocol_error' },
        expected: {
          actionable: true,
          details:
            '[legacy_adapter_text_omitted] Legacy protocol-error adapter text was omitted. chars(original=14, shown=0, omitted=14).',
          summary: 'agent-one emitted invalid RPC JSON; inspect the durable inbox diagnostic.',
          type: 'agent_protocol_error',
        },
      },
      {
        event: { agentId: 'agent-one', status: 'idle', type: 'status' },
        expected: {
          actionable: true,
          summary: 'agent-one is idle and ready for follow-up.',
          type: 'agent_idle',
        },
      },
      {
        event: { agentId: 'agent-one', status: 'idle', type: 'status' },
        expected: undefined,
        options: { suppressIdleWakeup: true },
      },
      {
        event: { agentId: 'agent-one', status: 'idle', type: 'status' },
        expected: {
          actionable: true,
          summary:
            'agent-one: terminal report missing; follow up; do not poll. Retained advisory verifier remains attached idle.',
          type: 'verification_terminal_report_missing',
        },
        options: { verifierIdleDisposition: 'attached_idle_without_terminal_report' },
      },
      {
        event: { agentId: 'agent-one', status: 'idle', type: 'status' },
        expected: undefined,
        options: { verifierIdleDisposition: 'report_complete' },
      },
      {
        event: { agentId: 'agent-one', status: 'running', type: 'status' },
        expected: undefined,
      },
    ];

    for (const { event, persistence, audit, options, expected } of cases) {
      expect(workerEventSummary(event, persistence, audit, options)).toEqual(expected);
    }
  });

  test('exposes structural preview truncation metadata for persisted report events instead of embedding ids in prose', () => {
    const projected = workerEventSummary(
      { agentId: 'agent-one', status: 'completed', summary: 'x'.repeat(241), type: 'report' },
      persistedReport,
    );

    expect(projected).toMatchObject({
      reportPreviewChars: { omittedChars: 1, originalChars: 241, shownChars: 240 },
      reportPreviewOmissionReason: 'report_summary_preview_limit',
      reportPreviewTruncated: true,
      type: 'agent_report_completed',
    });
    expect(projected?.summary).not.toContain('report-one');
    expect(projected?.summary).toContain(
      '[omitted reason=report_summary_preview_limit originalChars=241 shownChars=240 omittedChars=1; canonical full report available via one report_get({ reportId }) call]',
    );
  });

  test('replaces legacy protocol-error adapter text with fixed count-only diagnostics', () => {
    const projected = workerEventSummary({
      agentId: 'agent-one',
      message: 'token=private-protocol-secret',
      type: 'protocol_error',
    });

    expect(projected?.details).toContain('[legacy_adapter_text_omitted]');
    expect(projected?.details).toContain('chars(original=29, shown=0, omitted=29)');
    expect(projected?.details).not.toContain('private-protocol-secret');
    expect(projected?.details).not.toContain('token=');
    expect(projected?.summary).toBe(
      'agent-one emitted invalid RPC JSON; inspect the durable inbox diagnostic.',
    );
  });

  test('canonicalizes forged typed protocol diagnostics before durable manager summaries', () => {
    for (const diagnostic of [
      {
        countAccuracy: 'exact',
        message: 'token=private-forged-protocol-message',
        omittedChars: 31,
        originalChars: 31,
        reason: 'invalid_json',
        shownChars: 0,
      },
      {
        countAccuracy: 'exact',
        message: 'token=private-forged-protocol-message',
        omittedChars: 31,
        originalChars: 31,
        reason: 'token=private-forged-protocol-reason',
        shownChars: 0,
      },
    ]) {
      const projected = workerEventSummary({
        agentId: 'agent-one',
        diagnostic,
        type: 'protocol_error',
      } as unknown as WorkerSupervisorEvent);

      expect(projected?.details).not.toContain('private-forged');
      expect(projected?.details).not.toContain('token=');
      expect(projected?.details).toContain('chars(original=31, shown=0, omitted=31)');
    }
  });

  test('keeps accepted worst-case child question fields lossless beneath the durable inbox cap', () => {
    const question = '\u0000'.repeat(CHILD_QUESTION_MAX_CHARS);
    const context = '\u0000'.repeat(CHILD_QUESTION_CONTEXT_MAX_CHARS);
    const projected = workerEventSummary({
      agentId: 'agent-one',
      context,
      question,
      type: 'question',
    });

    expect(projected?.details?.length).toBeLessThanOrEqual(MANAGER_EVENT_DETAILS_MAX_CHARS);
    expect(JSON.parse(requiredValue(projected?.details))).toEqual({ context, question });
    expect(
      acceptedDurableEventDetails('x'.repeat(MANAGER_EVENT_DETAILS_MAX_CHARS + 1), 'fixture'),
    ).toContain('fixture rejected before durable persistence');
  });

  test('makes progress persistence failures actionable and lets Git audit failure type win', () => {
    const progress = workerEventSummary(
      { agentId: 'agent-one', status: 'progress', summary: 'Routine progress.', type: 'report' },
      failedReport,
    );
    expect(progress).toEqual({
      actionable: true,
      details:
        'report summary(JSON string): "Routine progress."\nreport artifact persistence diagnostic(JSON string): "report store unavailable"',
      summary:
        'agent-one: Routine progress. Report artifact persistence failed: report store unavailable.',
      type: 'agent_report_persist_failed',
    });

    const failedAudit = failedHandoffAudit(
      'completion',
      laterAt,
      new Error('inspection unavailable'),
    );
    const completed = workerEventSummary(
      { agentId: 'agent-one', status: 'completed', summary: 'Done.', type: 'report' },
      failedReport,
      failedAudit,
    );
    expect(completed).toEqual({
      actionable: true,
      details:
        'report summary(JSON string): "Done."\nreport artifact persistence diagnostic(JSON string): "report store unavailable"\nmanaged-worktree Git audit diagnostic(JSON string): "inspection unavailable"',
      summary:
        'agent-one: Done. Report artifact persistence failed: report store unavailable. Git audit failed: inspection unavailable.',
      type: 'agent_git_audit_failed',
    });
  });
});

describe('manager event dedupe policy', () => {
  test('matches pending generic attention by exact type and agent association', () => {
    const inbox = [inboxEvent('agent_git_audit_failed', 'agent-one'), inboxEvent('manager_notice')];

    expect(
      hasPendingAgentAttention(inbox, { agentId: 'agent-one', type: 'agent_git_audit_failed' }),
    ).toBe(true);
    expect(
      hasPendingAgentAttention(inbox, { agentId: 'agent-one', type: 'agent_git_audit_dirty' }),
    ).toBe(false);
    expect(
      hasPendingAgentAttention(inbox, { agentId: 'agent-two', type: 'agent_git_audit_failed' }),
    ).toBe(false);
    expect(hasPendingAgentAttention(inbox, { type: 'manager_notice' })).toBe(true);
  });

  test('matches only equivalent canonical pending attention so changed outcomes rearm without duplicate noise', () => {
    const candidate: ManagerEvent = {
      agentId: 'agent-one',
      createdAt,
      details: 'full durable diagnosis',
      id: 'event-candidate',
      pullRequestId: 'pr-one',
      summary: 'Bounded diagnosis.',
      type: 'pull_request_auto_sync_attention',
      workstreamId: 'ws-one',
    };
    const prior = { ...candidate, id: 'event-prior' };

    expect(hasPendingCanonicalAttention([prior], candidate)).toBe(true);
    expect(
      hasPendingCanonicalAttention([{ ...prior, details: 'changed diagnosis' }], candidate),
    ).toBe(false);
    expect(hasPendingCanonicalAttention([{ ...prior, pullRequestId: 'pr-two' }], candidate)).toBe(
      false,
    );
    expect(hasPendingCanonicalAttention([], candidate)).toBe(false);
    const legacyAutoSync = { ...prior, details: undefined };
    expect(
      hasPendingCanonicalAttention([legacyAutoSync], { ...candidate, details: candidate.summary }),
    ).toBe(true);
  });

  test('deduplicates repeatable pending diagnostics by type plus agent without collapsing terminal reports', () => {
    const progress: WorkerSupervisorEvent = {
      agentId: 'agent-one',
      status: 'progress',
      summary: 'Routine progress.',
      type: 'report',
    };
    const blocked: WorkerSupervisorEvent = {
      agentId: 'agent-one',
      status: 'blocked',
      summary: 'Needs decision.',
      type: 'report',
    };
    const completed: WorkerSupervisorEvent = {
      agentId: 'agent-one',
      status: 'completed',
      summary: 'Done.',
      type: 'report',
    };
    const progressFailure = {
      actionable: true,
      summary: 'Persistence failed.',
      type: 'agent_report_persist_failed',
    } satisfies WorkerEventSummary;
    const blockedFailure = {
      actionable: true,
      summary: 'Persistence failed.',
      type: 'agent_report_persist_failed',
    } satisfies WorkerEventSummary;
    const completion = {
      actionable: true,
      summary: 'Done.',
      type: 'agent_report_completed',
    } satisfies WorkerEventSummary;
    const gitAuditFailure = {
      actionable: true,
      summary: 'Audit failed.',
      type: 'agent_git_audit_failed',
    } satisfies WorkerEventSummary;
    const verifierMissingReport = {
      actionable: true,
      summary: 'Verifier settled without a terminal report.',
      type: 'verification_terminal_report_missing',
    } satisfies WorkerEventSummary;
    const cases: ReadonlyArray<{
      readonly inbox: ReadonlyArray<ManagerEvent>;
      readonly workerEvent: WorkerSupervisorEvent;
      readonly event: WorkerEventSummary | undefined;
      readonly persistence: ReportArtifactPersistence | undefined;
      readonly expected: boolean;
    }> = [
      {
        event: progressFailure,
        expected: true,
        inbox: [inboxEvent('agent_report_persist_failed', 'agent-one')],
        persistence: failedReport,
        workerEvent: progress,
      },
      {
        event: progressFailure,
        expected: false,
        inbox: [inboxEvent('agent_report_persist_failed', 'agent-two')],
        persistence: failedReport,
        workerEvent: progress,
      },
      {
        event: progressFailure,
        expected: false,
        inbox: [inboxEvent('agent_report_persist_failed', 'agent-one')],
        persistence: persistedReport,
        workerEvent: progress,
      },
      {
        event: blockedFailure,
        expected: false,
        inbox: [inboxEvent('agent_report_persist_failed', 'agent-one')],
        persistence: failedReport,
        workerEvent: blocked,
      },
      {
        event: completion,
        expected: false,
        inbox: [inboxEvent('agent_report_completed', 'agent-one')],
        persistence: persistedReport,
        workerEvent: completed,
      },
      {
        event: gitAuditFailure,
        expected: true,
        inbox: [inboxEvent('agent_git_audit_failed', 'agent-one')],
        persistence: failedReport,
        workerEvent: completed,
      },
      {
        event: gitAuditFailure,
        expected: false,
        inbox: [inboxEvent('agent_git_audit_failed', 'agent-two')],
        persistence: failedReport,
        workerEvent: completed,
      },
      {
        event: completion,
        expected: false,
        inbox: [inboxEvent('agent_git_audit_failed', 'agent-one')],
        persistence: persistedReport,
        workerEvent: completed,
      },
      {
        event: verifierMissingReport,
        expected: true,
        inbox: [inboxEvent('verification_terminal_report_missing', 'agent-one')],
        persistence: undefined,
        workerEvent: { agentId: 'agent-one', status: 'idle', type: 'status' },
      },
      {
        event: verifierMissingReport,
        expected: false,
        inbox: [inboxEvent('verification_terminal_report_missing', 'agent-two')],
        persistence: undefined,
        workerEvent: { agentId: 'agent-one', status: 'idle', type: 'status' },
      },
    ];

    for (const { inbox, workerEvent, event, persistence, expected } of cases) {
      expect(isDuplicateWorkerAttention(inbox, workerEvent, event, persistence)).toBe(expected);
    }
  });
});
