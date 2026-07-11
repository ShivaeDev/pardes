import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type AgentReport,
  initialManagerState,
  MANAGER_EVENT_DETAILS_MAX_CHARS,
  type ManagerEvent,
} from '../manager/index.ts';
import { REPORT_DETAILS_MAX_CHARS, REPORT_SUMMARY_MAX_CHARS } from '../reporting/index.ts';
import {
  makeFileSystemStateStore,
  STORAGE_EVENT_SCAN_MAX_BYTES,
  STORAGE_EVENT_WRITE_MAX_BYTES,
  STORAGE_REPORT_ARTIFACT_MAX_BYTES,
  STORAGE_REPORT_SCAN_MAX_ENTRIES,
  STORAGE_REPORT_WRITE_MAX_BYTES,
  STORAGE_STATE_ARTIFACT_MAX_BYTES,
  STORAGE_STATE_WRITE_MAX_BYTES,
} from './index.ts';
import { readBoundedStateSource } from './state-limits.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pardes-store-'));
  temporaryDirectories.push(directory);
  return directory;
}

function initialState() {
  return initialManagerState('manager-1', {
    currentCheckout: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    key: 'repo-1',
    primaryCheckout: '/tmp/repo',
  });
}

async function siblingTemporaryArtifacts(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.endsWith('.tmp'));
}

describe('filesystem state store', () => {
  test('round-trips typed state and appends events', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));

    const event: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-1',
      summary: 'test event',
      type: 'test_event',
    };
    await Effect.runPromise(store.appendEventOnce(event));
    await Effect.runPromise(store.appendEventOnce(event));
    const report: AgentReport = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      details: 'longer durable details',
      id: 'report-1',
      status: 'completed',
      summary: 'fixture report',
    };
    const reportPath = await Effect.runPromise(store.writeReport(report));

    expect(await Effect.runPromise(store.load())).toEqual(initialState());
    expect(await readFile(store.eventPath, 'utf8')).toBe(`${JSON.stringify(event)}\n`);
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report);
  });

  test('restores lossless inbox prose and bounded presentation-barrier reasons through schema-v1 storage', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const details = `question context ${'x'.repeat(5_000)} tail`;
    const event: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      details,
      id: 'event-lossless-inbox',
      presentationBlocked: true,
      presentationBlockedReason: 'merge_retirement_refinement',
      summary: 'Structural bounded summary.',
      type: 'agent_question',
    };
    const state = { ...initialState(), inbox: [event] };

    await Effect.runPromise(store.initialize(state));

    expect(await Effect.runPromise(store.load())).toEqual(state);
  });

  test('restores a legacy summary-only inbox row beyond the new detail cap without clipping', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const summary = `legacy summary ${'x'.repeat(MANAGER_EVENT_DETAILS_MAX_CHARS + 123)} tail`;
    const event: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-legacy-large-summary',
      summary,
      type: 'legacy_attention',
    };
    await Effect.runPromise(store.initialize(initialState()));
    await writeFile(
      store.statePath,
      `${JSON.stringify({ ...initialState(), inbox: [event] }, null, 2)}\n`,
      'utf8',
    );

    const restored = (await Effect.runPromise(store.load())).inbox[0];
    expect(restored).toEqual(event);
    expect(restored?.summary.length).toBeGreaterThan(MANAGER_EVENT_DETAILS_MAX_CHARS);
    expect(restored).not.toHaveProperty('details');
  });

  test('rejects oversized inbox detail and serialized state or event growth before durable allocation', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));
    const overCapDetail: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      details: 'x'.repeat(MANAGER_EVENT_DETAILS_MAX_CHARS + 1),
      id: 'event-over-detail-cap',
      summary: 'Reject oversized detail.',
      type: 'agent_question',
    };

    expect(
      await Effect.runPromise(
        store
          .mutate((state) =>
            Effect.succeed([
              undefined,
              { ...state, inbox: [...state.inbox, overCapDetail] },
            ] as const),
          )
          .pipe(Effect.flip),
      ),
    ).toMatchObject({ _tag: 'StoreError', operation: 'encode state schema' });
    expect(
      await Effect.runPromise(store.appendEvent(overCapDetail).pipe(Effect.flip)),
    ).toMatchObject({ _tag: 'StoreError', operation: 'encode event schema' });

    const expansiveEvent: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-expansive-json',
      summary: '\u0000'.repeat(STORAGE_EVENT_WRITE_MAX_BYTES),
      type: 'fixture_event',
    };
    expect(
      await Effect.runPromise(store.appendEvent(expansiveEvent).pipe(Effect.flip)),
    ).toMatchObject({ _tag: 'StoreError', operation: 'validate serialized event size' });

    const aggregateDirectory = await temporaryDirectory();
    const aggregateStore = await Effect.runPromise(makeFileSystemStateStore(aggregateDirectory));
    const expansiveState = { ...initialState(), inbox: [expansiveEvent] };
    expect(
      await Effect.runPromise(aggregateStore.initialize(expansiveState).pipe(Effect.flip)),
    ).toMatchObject({ _tag: 'StoreError', operation: 'validate serialized state size' });
    expect(existsSync(aggregateStore.statePath)).toBe(false);
  });

  test('admits a bounded oversized legacy artifact read but rejects read-mostly current state explicitly', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));
    const summary = `legacy oversized projection ${'x'.repeat(STORAGE_STATE_WRITE_MAX_BYTES + 1_024)} tail`;
    const event: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-legacy-oversized-state',
      summary,
      type: 'legacy_attention',
    };
    const legacy = { ...initialState(), inbox: [event] };
    const before = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(store.statePath, before, 'utf8');
    expect(Buffer.byteLength(before)).toBeGreaterThan(STORAGE_STATE_WRITE_MAX_BYTES);
    expect(Buffer.byteLength(before)).toBeLessThan(STORAGE_STATE_ARTIFACT_MAX_BYTES);

    expect(await Effect.runPromise(readBoundedStateSource(store.statePath))).toBe(before);
    expect(await Effect.runPromise(store.load().pipe(Effect.flip))).toMatchObject({
      _tag: 'StoreError',
      operation: 'reject oversized current state: operator storage recovery required',
      path: store.statePath,
    });
    expect(await readFile(store.statePath, 'utf8')).toBe(before);
  });

  test('cleans stale cursors through ordinary safe mutation below the current-state cap without prose loss', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const summary = `legacy cursor prose ${'x'.repeat(5_000)} tail`;
    const event: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-legacy-stale-cursor',
      summary,
      type: 'legacy_attention',
    };
    const inboxWake = {
      createdAt: event.createdAt,
      cursor: 'event-stale-cursor',
      pendingCount: 1,
      token: 'wake-stale-cursor',
    };
    const inboxHandoff = { cursor: inboxWake.cursor, surfacedAt: event.createdAt };
    await Effect.runPromise(
      store.initialize({ ...initialState(), inbox: [event], inboxHandoff, inboxWake }),
    );

    await Effect.runPromise(
      store.mutate((current) => {
        const {
          inboxHandoff: _inboxHandoff,
          inboxWake: _inboxWake,
          ...withoutInboxCursors
        } = current;
        return Effect.succeed([undefined, withoutInboxCursors] as const);
      }),
    );

    const restored = await Effect.runPromise(store.load());
    expect(restored.inbox).toEqual([event]);
    expect(restored.inbox[0]?.summary).toBe(summary);
    expect(restored).not.toHaveProperty('inboxWake');
    expect(restored).not.toHaveProperty('inboxHandoff');
  });

  test('refuses an oversized restored state artifact before reading its contents', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));
    await truncate(store.statePath, STORAGE_STATE_ARTIFACT_MAX_BYTES + 1);

    expect(await Effect.runPromise(store.load().pipe(Effect.flip))).toMatchObject({
      _tag: 'StoreError',
      operation: 'validate state artifact size',
      path: store.statePath,
    });
    expect(STORAGE_STATE_WRITE_MAX_BYTES).toBeLessThan(STORAGE_STATE_ARTIFACT_MAX_BYTES);
  });

  test('preserves a legitimate multi-megabyte worker-authored report artifact', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const details = `worker-authored details ${'d'.repeat(3 * 1_024 * 1_024)} tail`;
    const report: AgentReport = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      details,
      id: 'report-multi-meg',
      status: 'completed',
      summary: 'Retain the complete local artifact.',
    };

    const reportPath = await Effect.runPromise(store.writeReport(report));
    const persisted = JSON.parse(await readFile(reportPath, 'utf8')) as AgentReport;

    expect(persisted).toEqual(report);
    expect(persisted.details).toHaveLength(details.length);
    expect((await Effect.runPromise(store.inspectStorage())).reports).toMatchObject({
      metricsAccuracy: 'exact',
      reports: 1,
    });
  });

  test('rejects over-cap fields and expansive serialized JSON before writing artifact content', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const base = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'report-write-cap',
      status: 'completed' as const,
      summary: 'bounded summary',
    };

    for (const report of [
      { ...base, id: 'report-summary-cap', summary: 's'.repeat(REPORT_SUMMARY_MAX_CHARS + 1) },
      { ...base, details: 'd'.repeat(REPORT_DETAILS_MAX_CHARS + 1), id: 'report-details-cap' },
    ]) {
      expect(await Effect.runPromise(store.writeReport(report).pipe(Effect.flip))).toMatchObject({
        _tag: 'StoreError',
        operation: 'encode report schema',
      });
    }

    const expansiveDetails = '\u0000'.repeat(Math.ceil(STORAGE_REPORT_WRITE_MAX_BYTES / 6));
    const expansive = { ...base, details: expansiveDetails, id: 'report-serialized-cap' };
    expect(expansive.details.length).toBeLessThanOrEqual(REPORT_DETAILS_MAX_CHARS);
    expect(Buffer.byteLength(`${JSON.stringify(expansive, null, 2)}\n`, 'utf8')).toBeGreaterThan(
      STORAGE_REPORT_WRITE_MAX_BYTES,
    );
    expect(await Effect.runPromise(store.writeReport(expansive).pipe(Effect.flip))).toMatchObject({
      _tag: 'StoreError',
      operation: 'validate serialized report size',
    });
    expect(existsSync(store.reportsPath)).toBe(false);
  });

  test('keeps retained pre-policy artifacts readable behind the separate retrieval breaker', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const report: AgentReport = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      details: 'd'.repeat(REPORT_DETAILS_MAX_CHARS + 1),
      id: 'report-retained-legacy',
      status: 'completed',
      summary: 'Retained historical report.',
    };
    await mkdir(store.reportsPath, { recursive: true });
    await writeFile(
      join(store.reportsPath, `${report.id}.json`),
      `${JSON.stringify(report)}\n`,
      'utf8',
    );

    expect((await Effect.runPromise(store.readReport(report.id))).details).toHaveLength(
      REPORT_DETAILS_MAX_CHARS + 1,
    );
  });

  test('reads exactly one direct report artifact and decodes JSON plus Schema at the adapter boundary', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const report: AgentReport = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      details: 'lossless details',
      id: 'report-direct',
      status: 'completed',
      summary: 'fixture report',
    };
    await Effect.runPromise(store.writeReport(report));

    expect(await Effect.runPromise(store.readReport(report.id))).toEqual(report);

    await writeFile(join(store.reportsPath, 'report-invalid-json.json'), '{\n', 'utf8');
    expect(
      await Effect.runPromise(store.readReport('report-invalid-json').pipe(Effect.flip)),
    ).toMatchObject({
      _tag: 'ReportArtifactError',
      reason: 'invalid_json',
      reportId: 'report-invalid-json',
    });
    await writeFile(
      join(store.reportsPath, 'report-invalid-schema.json'),
      JSON.stringify({ ...report, id: 'report-invalid-schema', status: 'unknown' }),
      'utf8',
    );
    expect(
      await Effect.runPromise(store.readReport('report-invalid-schema').pipe(Effect.flip)),
    ).toMatchObject({
      _tag: 'ReportArtifactError',
      reason: 'invalid_schema',
      reportId: 'report-invalid-schema',
    });
    await writeFile(
      join(store.reportsPath, 'report-mismatched.json'),
      JSON.stringify(report),
      'utf8',
    );
    expect(
      await Effect.runPromise(store.readReport('report-mismatched').pipe(Effect.flip)),
    ).toMatchObject({
      _tag: 'ReportArtifactError',
      reason: 'invalid_schema',
      reportId: 'report-mismatched',
    });
  });

  test('rejects arbitrary ids, redirected leaves, and absurd direct report allocations without scanning', async () => {
    const root = await temporaryDirectory();
    const directory = join(root, 'manager');
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await mkdir(store.reportsPath, { recursive: true });
    const outside = join(root, 'outside.json');
    await writeFile(outside, JSON.stringify({ private: 'redirect target' }), 'utf8');
    await symlink(outside, join(store.reportsPath, 'report-redirected.json'));
    await writeFile(join(store.reportsPath, 'report-absurd.json'), '{}', 'utf8');
    await truncate(
      join(store.reportsPath, 'report-absurd.json'),
      STORAGE_REPORT_ARTIFACT_MAX_BYTES + 1,
    );

    expect(await Effect.runPromise(store.readReport('../outside').pipe(Effect.flip))).toMatchObject(
      { _tag: 'ReportArtifactError', reason: 'invalid_id' },
    );
    expect(
      await Effect.runPromise(store.readReport('report-missing').pipe(Effect.flip)),
    ).toMatchObject({ _tag: 'ReportArtifactError', reason: 'not_found' });
    expect(
      await Effect.runPromise(store.readReport('report-redirected').pipe(Effect.flip)),
    ).toMatchObject({ _tag: 'ReportArtifactError', reason: 'redirected' });
    expect(
      await Effect.runPromise(store.readReport('report-absurd').pipe(Effect.flip)),
    ).toMatchObject({ _tag: 'ReportArtifactError', reason: 'too_large' });

    await rm(store.reportsPath, { force: true, recursive: true });
    const redirectedReports = join(root, 'redirected-reports');
    await mkdir(redirectedReports);
    await symlink(redirectedReports, store.reportsPath);
    expect(await Effect.runPromise(store.readReport('report-any').pipe(Effect.flip))).toMatchObject(
      { _tag: 'ReportArtifactError', reason: 'redirected' },
    );
    const writeFailure = await Effect.runPromise(
      store
        .writeReport({
          agentId: 'agent-1',
          createdAt: '2026-06-01T00:00:00.000Z',
          id: 'report-refused',
          status: 'completed',
          summary: 'Do not follow reports root.',
        })
        .pipe(Effect.flip),
    );
    expect(writeFailure).toMatchObject({
      _tag: 'StoreError',
      operation: 'validate direct reports directory',
    });
    expect(await readdir(redirectedReports)).toEqual([]);
  });

  test('loads schema-v1 pull-request snapshots without and with additive discussion cursor safety metadata', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const state = initialState();
    const legacyPullRequest = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'pr-42',
      status: 'open' as const,
      updatedAt: '2026-06-01T00:00:00.000Z',
      url: 'https://github.test/acme/project/pull/42',
      workstreamId: 'ws-1',
    };
    await Effect.runPromise(
      store.initialize({ ...state, pullRequests: { [legacyPullRequest.id]: legacyPullRequest } }),
    );
    expect((await Effect.runPromise(store.load())).pullRequests[legacyPullRequest.id]).toEqual(
      legacyPullRequest,
    );

    const {
      verifications: _newerVerifications,
      workstreamCompletionIntents: _newerCompletionIntents,
      ...legacyState
    } = state;
    await writeFile(
      store.statePath,
      `${JSON.stringify({ ...legacyState, pullRequests: { [legacyPullRequest.id]: legacyPullRequest } }, null, 2)}\n`,
      'utf8',
    );
    const restoredLegacyState = await Effect.runPromise(store.load());
    expect(restoredLegacyState.verifications).toEqual({});
    expect(restoredLegacyState.workstreamCompletionIntents).toEqual({});

    const additive = {
      ...legacyPullRequest,
      discussionCursor: { inlineReviewCommentId: 30, issueCommentId: 10, reviewId: 20 },
    };
    await writeFile(
      store.statePath,
      `${JSON.stringify({ ...state, pullRequests: { [additive.id]: additive } }, null, 2)}\n`,
      'utf8',
    );
    expect((await Effect.runPromise(store.load())).pullRequests[additive.id]).toEqual(additive);

    const withPaginationGap = { ...additive, discussionPaginationGaps: ['issue_comment' as const] };
    await writeFile(
      store.statePath,
      `${JSON.stringify({ ...state, pullRequests: { [withPaginationGap.id]: withPaginationGap } }, null, 2)}\n`,
      'utf8',
    );
    expect((await Effect.runPromise(store.load())).pullRequests[withPaginationGap.id]).toEqual(
      withPaginationGap,
    );
  });

  test('normalizes schema-v1 verifier snapshots to one canonical latest-attempt projection', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const state = initialState();
    const createdAt = '2026-06-01T00:00:00.000Z';
    const updatedAt = '2026-06-01T00:01:00.000Z';
    const staleAt = '2026-06-01T00:02:00.000Z';
    const originalHead = 'a'.repeat(40);
    const driftedHead = 'b'.repeat(40);
    const baseline = 'c'.repeat(40);
    const checkout = (verificationId: string, reviewedHeadSha: string) => ({
      createdAt,
      managerId: state.managerId,
      path: `/tmp/repo/.worktrees/pardes/${state.managerId}/${verificationId}`,
      reviewedHeadSha,
      verificationId,
    });
    const legacy = {
      createdAt,
      evidenceStatus: 'stale' as const,
      id: 'verify-legacy',
      model: 'fixture/model',
      reviewCheckout: checkout('verify-legacy', originalHead),
      reviewedHeadSha: originalHead,
      sourceAgentId: 'agent-source',
      sourceBranchPointSha: baseline,
      staleAt,
      staleReason: 'source advanced after the captured review',
      status: 'completed' as const,
      task: 'Restore the pre-lineage verifier snapshot.',
      thinkingLevel: 'high' as const,
      updatedAt,
      verifierAgentId: 'verifier-legacy',
      workstreamId: 'ws-1',
    };
    const transitional = {
      ...legacy,
      attempts: [
        {
          attempt: 2,
          createdAt,
          evidenceStatus: 'current' as const,
          reviewCheckout: checkout('verify-transitional', originalHead),
          reviewedHeadSha: originalHead,
          sourceBranchPointSha: baseline,
          status: 'running' as const,
          updatedAt,
        },
      ],
      evidenceStatus: 'stale' as const,
      id: 'verify-transitional',
      reviewCheckout: checkout('verify-transitional', driftedHead),
      reviewedHeadSha: driftedHead,
      staleAt,
      staleReason: 'obsolete duplicated record-level evidence',
      status: 'crashed' as const,
      verifierAgentId: 'verifier-transitional',
    };
    await writeFile(
      store.statePath,
      `${JSON.stringify(
        {
          ...state,
          verifications: { [legacy.id]: legacy, [transitional.id]: transitional },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const restored = await Effect.runPromise(store.load());
    expect(restored.verifications[legacy.id]).toMatchObject({
      attempts: [
        {
          attempt: 1,
          evidenceStatus: 'stale',
          reviewedHeadSha: originalHead,
          staleReason: legacy.staleReason,
          status: 'completed',
        },
      ],
      id: legacy.id,
    });
    expect(restored.verifications[transitional.id]).toMatchObject({
      attempts: [
        { attempt: 2, evidenceStatus: 'current', reviewedHeadSha: originalHead, status: 'running' },
      ],
      id: transitional.id,
    });
    expect(restored.verifications[transitional.id]).not.toHaveProperty('reviewedHeadSha');
    expect(restored.verifications[transitional.id]).not.toHaveProperty('status');
    expect(restored.verifications[transitional.id]).not.toHaveProperty('staleReason');

    await Effect.runPromise(
      store.mutate((current) => Effect.succeed([undefined, { ...current }] as const)),
    );
    const persisted = JSON.parse(await readFile(store.statePath, 'utf8')) as {
      verifications: Record<string, Record<string, unknown>>;
    };
    for (const verification of Object.values(persisted.verifications)) {
      expect(verification).not.toHaveProperty('reviewedHeadSha');
      expect(verification).not.toHaveProperty('reviewCheckout');
      expect(verification).not.toHaveProperty('status');
      expect(verification).not.toHaveProperty('evidenceStatus');
      expect(verification).not.toHaveProperty('staleReason');
      expect(verification).toHaveProperty('attempts');
    }

    const otherwiseLegacy = {
      ...legacy,
      id: 'verify-invalid',
      verifierAgentId: 'verifier-invalid',
    };
    const validAttempt = {
      attempt: 1,
      createdAt,
      evidenceStatus: 'current' as const,
      reviewCheckout: checkout(otherwiseLegacy.id, originalHead),
      reviewedHeadSha: originalHead,
      sourceBranchPointSha: baseline,
      status: 'running' as const,
      updatedAt,
    };
    for (const attempts of [[], [{ ...validAttempt, attempt: 0 }]]) {
      await writeFile(
        store.statePath,
        `${JSON.stringify(
          {
            ...state,
            verifications: { [otherwiseLegacy.id]: { ...otherwiseLegacy, attempts } },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      expect(await Effect.runPromise(store.load().pipe(Effect.flip))).toMatchObject({
        _tag: 'StoreError',
        operation: 'decode state schema',
        path: store.statePath,
      });
    }
  });

  test('restores durable inbox handoffs written before and after exact marker identities', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const state = initialState();
    const createdAt = '2026-06-01T00:00:00.000Z';
    const inbox = [
      {
        createdAt,
        id: 'event-attention',
        summary: 'Choose the safe path.',
        type: 'agent_question',
      },
    ];
    const inboxWake = { createdAt, cursor: inbox[0]?.id, pendingCount: 1, token: 'wake-attention' };
    const legacyHandoff = { cursor: inboxWake.cursor, surfacedAt: createdAt };
    await Effect.runPromise(
      store.initialize({ ...state, inbox, inboxHandoff: legacyHandoff, inboxWake }),
    );
    expect((await Effect.runPromise(store.load())).inboxHandoff).toEqual(legacyHandoff);

    const identifiedHandoff = { ...legacyHandoff, token: 'handoff-attention' };
    await writeFile(
      store.statePath,
      `${JSON.stringify({ ...state, inbox, inboxHandoff: identifiedHandoff, inboxWake }, null, 2)}\n`,
      'utf8',
    );
    expect((await Effect.runPromise(store.load())).inboxHandoff).toEqual(identifiedHandoff);
  });

  test('rejects malformed snapshots at the Schema decode boundary', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));
    await writeFile(store.statePath, '{"schemaVersion":1}\n', 'utf8');

    const failure = await Effect.runPromise(store.load().pipe(Effect.flip));

    expect(failure._tag).toBe('StoreError');
    expect(failure.operation).toBe('decode state schema');
    expect(failure.path).toBe(store.statePath);
  });

  test('rejects restored snapshots with incoherent inbox omission metadata', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const state = initialState();
    await Effect.runPromise(store.initialize(state));
    await writeFile(
      store.statePath,
      `${JSON.stringify({
        ...state,
        inbox: [
          {
            createdAt: '2026-06-01T00:00:00.000Z',
            id: 'event-incoherent',
            reportId: 'report-123',
            reportPreviewChars: { omittedChars: 0, originalChars: 1, shownChars: 999 },
            reportPreviewOmissionReason: 'report_summary_preview_limit',
            reportPreviewTruncated: false,
            summary: 'Impossible restored preview counts.',
            type: 'agent_report_completed',
          },
        ],
      })}\n`,
      'utf8',
    );

    expect(await Effect.runPromise(store.load().pipe(Effect.flip))).toMatchObject({
      _tag: 'StoreError',
      operation: 'decode state schema',
      path: store.statePath,
    });
  });

  test('rejects schema-invalid mutations without replacing the authoritative snapshot', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const state = initialState();
    await Effect.runPromise(store.initialize(state));

    const failure = await Effect.runPromise(
      store
        .mutate((current) => Effect.succeed([undefined, { ...current, managerId: '' }] as const))
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('StoreError');
    expect(failure.operation).toBe('encode state schema');
    expect(await Effect.runPromise(store.load())).toEqual(state);
    expect(await siblingTemporaryArtifacts(directory)).toEqual([]);
  });

  test('rejects schema-invalid event and report artifacts before writing content', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const invalidEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-invalid',
      summary: '',
      type: 'test_event',
    } as ManagerEvent;
    const invalidReport = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'report-invalid',
      status: 'unknown',
      summary: 'fixture report',
    } as unknown as AgentReport;

    const eventFailure = await Effect.runPromise(store.appendEvent(invalidEvent).pipe(Effect.flip));
    const reportFailure = await Effect.runPromise(
      store.writeReport(invalidReport).pipe(Effect.flip),
    );

    expect(eventFailure.operation).toBe('encode event schema');
    expect(reportFailure.operation).toBe('encode report schema');
    expect(await readdir(directory)).toEqual([]);
  });

  test('observes missing and empty leaves without creating storage artifacts', async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, 'manager-missing');
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));

    expect(await Effect.runPromise(store.inspectStorage())).toEqual({
      bounds: {
        eventScanMaxBytes: STORAGE_EVENT_SCAN_MAX_BYTES,
        reportScanMaxEntries: STORAGE_REPORT_SCAN_MAX_ENTRIES,
      },
      events: {
        eventLines: 0,
        eventLinesAccuracy: 'exact',
        kind: 'missing',
        omittedBytes: 0,
        scannedBytes: 0,
      },
      reports: {
        kind: 'missing',
        metricsAccuracy: 'exact',
        omittedEntriesLowerBound: 0,
        otherEntries: 0,
        reportBytes: 0,
        reports: 0,
        scannedEntries: 0,
      },
      root: { kind: 'missing' },
      state: { kind: 'missing' },
    });
    expect(await readdir(parent)).toEqual([]);

    await mkdir(directory);
    expect(await Effect.runPromise(store.inspectStorage())).toMatchObject({
      events: { eventLines: 0, eventLinesAccuracy: 'exact', kind: 'missing', scannedBytes: 0 },
      reports: {
        kind: 'missing',
        metricsAccuracy: 'exact',
        otherEntries: 0,
        reportBytes: 0,
        reports: 0,
        scannedEntries: 0,
      },
      root: { kind: 'directory' },
      state: { kind: 'missing' },
    });
    expect(await readdir(directory)).toEqual([]);
  });

  test('observes representative state, append-only events, and durable report metrics without returning artifact content', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));
    const firstEvent: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-1',
      summary: 'private event marker',
      type: 'test_event',
    };
    const secondEvent: ManagerEvent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-2',
      summary: 'second private event marker',
      type: 'test_event',
    };
    await Effect.runPromise(store.appendEvent(firstEvent));
    await Effect.runPromise(store.appendEvent(secondEvent));
    const reports: AgentReport[] = [
      {
        agentId: 'agent-1',
        createdAt: '2026-06-01T00:00:00.000Z',
        id: 'report-a',
        status: 'progress',
        summary: 'private report marker',
      },
      {
        agentId: 'agent-1',
        createdAt: '2026-06-01T00:00:00.000Z',
        details: 'durable private details',
        id: 'report-b',
        status: 'completed',
        summary: 'second private report marker',
      },
    ];
    const reportPaths = [];
    for (const report of reports)
      reportPaths.push(await Effect.runPromise(store.writeReport(report)));

    const observed = await Effect.runPromise(store.inspectStorage());
    const expectedReportBytes = (
      await Promise.all(reportPaths.map((path) => readFile(path)))
    ).reduce((total, source) => total + source.byteLength, 0);
    expect(observed).toMatchObject({
      events: {
        bytes: (await readFile(store.eventPath)).byteLength,
        eventLines: 2,
        eventLinesAccuracy: 'exact',
        kind: 'regular_file',
      },
      reports: {
        kind: 'directory',
        metricsAccuracy: 'exact',
        otherEntries: 0,
        reportBytes: expectedReportBytes,
        reports: 2,
        scannedEntries: 2,
      },
      root: { kind: 'directory' },
      state: { bytes: (await readFile(store.statePath)).byteLength, kind: 'regular_file' },
    });
    expect(JSON.stringify(observed)).not.toContain('private');
    expect(JSON.stringify(observed)).not.toContain('report-a');
  });

  test('caps event reads and direct report scans while exposing lower-bound metrics', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const eventSource = '{}\n'.repeat(Math.ceil(STORAGE_EVENT_SCAN_MAX_BYTES / 3) + 5);
    await writeFile(store.eventPath, eventSource, 'utf8');
    await mkdir(store.reportsPath);
    await Promise.all(
      Array.from({ length: STORAGE_REPORT_SCAN_MAX_ENTRIES + 1 }, (_, index) =>
        writeFile(join(store.reportsPath, `report-${index}.json`), '{}\n', 'utf8'),
      ),
    );

    const observed = await Effect.runPromise(store.inspectStorage());

    expect(observed.events).toMatchObject({
      bytes: Buffer.byteLength(eventSource),
      eventLinesAccuracy: 'lower_bound',
      kind: 'regular_file',
      omissionReason: 'event_scan_byte_limit',
      omittedBytes: Buffer.byteLength(eventSource) - STORAGE_EVENT_SCAN_MAX_BYTES,
      scannedBytes: STORAGE_EVENT_SCAN_MAX_BYTES,
    });
    expect(observed.events.eventLines).toBeLessThan(
      Math.ceil(STORAGE_EVENT_SCAN_MAX_BYTES / 3) + 5,
    );
    expect(observed.reports).toEqual({
      kind: 'directory',
      metricsAccuracy: 'lower_bound',
      omissionReason: 'direct_entry_scan_limit',
      omittedEntriesLowerBound: 1,
      otherEntries: 0,
      reportBytes: STORAGE_REPORT_SCAN_MAX_ENTRIES * 3,
      reports: STORAGE_REPORT_SCAN_MAX_ENTRIES,
      scannedEntries: STORAGE_REPORT_SCAN_MAX_ENTRIES,
    });
  });

  test('counts redirected report artifacts as other entries without following their targets', async () => {
    const root = await temporaryDirectory();
    const directory = join(root, 'manager');
    const outsideReport = join(root, 'private-report.json');
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await mkdir(store.reportsPath, { recursive: true });
    await writeFile(join(store.reportsPath, 'report-safe.json'), '{}\n', 'utf8');
    await writeFile(outsideReport, 'private redirected report marker\n', 'utf8');
    await symlink(outsideReport, join(store.reportsPath, 'report-redirected.json'));

    expect((await Effect.runPromise(store.inspectStorage())).reports).toEqual({
      kind: 'directory',
      metricsAccuracy: 'exact',
      omittedEntriesLowerBound: 0,
      otherEntries: 1,
      reportBytes: 3,
      reports: 1,
      scannedEntries: 2,
    });
  });

  test('reports redirected and unusual leaves without following them or mutating storage', async () => {
    const root = await temporaryDirectory();
    const directory = join(root, 'manager');
    const outside = join(root, 'outside');
    await mkdir(directory);
    await mkdir(join(outside, 'reports'), { recursive: true });
    await writeFile(join(outside, 'state.json'), 'private redirected state\n', 'utf8');
    await writeFile(join(outside, 'events.jsonl'), 'private redirected event\n', 'utf8');
    await writeFile(
      join(outside, 'reports', 'private.json'),
      'private redirected report\n',
      'utf8',
    );
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await symlink(join(outside, 'state.json'), store.statePath);
    await symlink(join(outside, 'events.jsonl'), store.eventPath);
    await symlink(join(outside, 'reports'), store.reportsPath);

    expect(await Effect.runPromise(store.inspectStorage())).toMatchObject({
      events: { eventLinesAccuracy: 'unavailable', kind: 'redirected', scannedBytes: 0 },
      reports: { kind: 'redirected', metricsAccuracy: 'unavailable', scannedEntries: 0 },
      root: { kind: 'directory' },
      state: { kind: 'redirected' },
    });
    expect(await readFile(join(outside, 'reports', 'private.json'), 'utf8')).toBe(
      'private redirected report\n',
    );

    await rm(directory, { force: true, recursive: true });
    await symlink(outside, directory);
    expect(await Effect.runPromise(store.inspectStorage())).toMatchObject({
      events: {
        blockedReason: 'root_redirected',
        eventLinesAccuracy: 'unavailable',
        kind: 'blocked',
      },
      reports: {
        blockedReason: 'root_redirected',
        kind: 'blocked',
        metricsAccuracy: 'unavailable',
      },
      root: { kind: 'redirected' },
      state: { blockedReason: 'root_redirected', kind: 'blocked' },
    });

    await rm(directory, { force: true });
    await mkdir(directory);
    await mkdir(store.statePath);
    await mkdir(store.eventPath);
    await writeFile(store.reportsPath, 'broken reports leaf\n', 'utf8');
    expect(await Effect.runPromise(store.inspectStorage())).toMatchObject({
      events: { eventLinesAccuracy: 'unavailable', kind: 'directory' },
      reports: { kind: 'regular_file', metricsAccuracy: 'unavailable' },
      root: { kind: 'directory' },
      state: { kind: 'directory' },
    });
  });

  test('cleans temporary state artifacts when replacement fails', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await mkdir(store.statePath);

    const failure = await Effect.runPromise(store.initialize(initialState()).pipe(Effect.flip));

    expect(failure._tag).toBe('StoreError');
    expect(failure.operation).toBe('replace state');
    expect(await siblingTemporaryArtifacts(directory)).toEqual([]);
  });

  test('cleans temporary report artifacts when replacement fails', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    const report: AgentReport = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'report-directory',
      status: 'completed',
      summary: 'fixture report',
    };
    await mkdir(join(store.reportsPath, `${report.id}.json`), { recursive: true });

    const failure = await Effect.runPromise(store.writeReport(report).pipe(Effect.flip));

    expect(failure._tag).toBe('StoreError');
    expect(failure.operation).toBe('replace report');
    expect(await siblingTemporaryArtifacts(store.reportsPath)).toEqual([]);
  });

  test('keeps authoritative state and inbox writes available when the reports leaf is broken', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));
    await writeFile(store.reportsPath, 'broken reports leaf\n', 'utf8');
    const report: AgentReport = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'report-broken',
      status: 'progress',
      summary: 'persist through the authoritative fallback',
    };
    const reportFailure = await Effect.runPromise(store.writeReport(report).pipe(Effect.flip));
    expect(reportFailure._tag).toBe('StoreError');

    const event: ManagerEvent = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'event-report-failed',
      summary: 'Report artifact persistence failed.',
      type: 'agent_report_persist_failed',
    };
    await Effect.runPromise(
      store.mutate((state) =>
        Effect.succeed([undefined, { ...state, inbox: [...state.inbox, event] }] as const),
      ),
    );
    await Effect.runPromise(store.appendEvent(event));

    expect((await Effect.runPromise(store.load())).inbox).toEqual([event]);
    expect(await readFile(store.eventPath, 'utf8')).toBe(`${JSON.stringify(event)}\n`);
  });

  test('skips exact-reference no-op mutations without rewriting or incrementing revision', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));
    const before = await readFile(store.statePath, 'utf8');

    expect(
      await Effect.runPromise(
        store.mutate((state) => Effect.succeed(['unchanged', state] as const)),
      ),
    ).toBe('unchanged');

    expect(await readFile(store.statePath, 'utf8')).toBe(before);
    expect((await Effect.runPromise(store.load())).revision).toBe(0);
  });

  test('serializes concurrent mutations and increments revisions', async () => {
    const directory = await temporaryDirectory();
    const store = await Effect.runPromise(makeFileSystemStateStore(directory));
    await Effect.runPromise(store.initialize(initialState()));

    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 20 }, (_, index) =>
          store.mutate((state) =>
            Effect.succeed([
              undefined,
              {
                ...state,
                workstreams: {
                  ...state.workstreams,
                  [`ws-${index}`]: {
                    createdAt: '2026-06-01T00:00:00.000Z',
                    id: `ws-${index}`,
                    objective: 'Exercise serialized updates',
                    status: 'planned' as const,
                    title: `Workstream ${index}`,
                    updatedAt: '2026-06-01T00:00:00.000Z',
                  },
                },
              },
            ] as const),
          ),
        ),
        { concurrency: 'unbounded' },
      ),
    );

    const state = await Effect.runPromise(store.load());
    expect(state.revision).toBe(20);
    expect(Object.keys(state.workstreams)).toHaveLength(20);
  });
});
