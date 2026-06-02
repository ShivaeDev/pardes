import { setTimeout as sleep } from 'node:timers/promises';
import { Deferred, Effect, Fiber, Semaphore } from 'effect';
import { describe, expect, test } from 'vitest';
import { makeReporting, REPORT_DETAILS_MAX_CHARS } from '../reporting/index.ts';
import type { StateStoreShape } from '../storage/index.ts';
import { requiredValue } from '../test-support.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import type { ManagerState } from './domain.ts';
import { makeReviewGateLifecycleCoordinator } from './review-gate-lifecycle.ts';
import { makeWorkerSupervisorEventCoordinator } from './worker-event-coordinator.ts';

describe('incoming worker-event coordinator', () => {
  test('serializes completion handoff before the following idle transition', async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const trace: string[] = [];
    const initial: ManagerState = {
      agents: {
        'agent-one': {
          createdAt: '2026-01-01T00:00:00.000Z',
          id: 'agent-one',
          model: 'fixture/model',
          role: 'worker',
          sessionDir: '/sessions/agent-one',
          status: 'running',
          task: 'Exercise ordered handoff.',
          thinkingLevel: 'low',
          updatedAt: '2026-01-01T00:00:00.000Z',
          workstreamId: 'ws-one',
        },
      },
      inbox: [],
      managerId: 'manager-one',
      pullRequests: {},
      repo: {
        currentCheckout: '/repo',
        gitCommonDir: '/repo/.git',
        key: 'repo',
        primaryCheckout: '/repo',
      },
      revision: 0,
      schemaVersion: 1,
      verifications: {},
      workstreams: {},
    };
    const state = { current: initial };
    const namespace = {
      get state() {
        return state.current;
      },
      set state(next: ManagerState) {
        state.current = next;
      },
      store: undefined as unknown as StateStoreShape,
    };
    namespace.store = {
      mutate: <A, E>(
        mutation: (current: ManagerState) => Effect.Effect<readonly [A, ManagerState], E>,
      ) =>
        mutation(state.current).pipe(
          Effect.map(([result, proposed]) => {
            state.current = { ...proposed, revision: state.current.revision + 1 };
            return result;
          }),
        ),
    } as unknown as StateStoreShape;
    const coordinator = await Effect.runPromise(
      makeWorkerSupervisorEventCoordinator({
        attachments: { auditHandoffBestEffort: () => Effect.succeed(undefined) },
        callbacks: {
          appendEventSafely: (event) =>
            Effect.sync(() => {
              trace.push(`append:${event.type}`);
            }),
          isSuppressed: () => false,
          reconcileVerificationsForSource: () => Effect.void,
          refresh: () =>
            Effect.sync(() => {
              trace.push('refresh');
            }),
          releaseInboxWake: () =>
            Effect.sync(() => {
              trace.push('wake');
              return true;
            }),
          render: () => {},
          retryResolvedVerificationRetirementForIdleVerifier: () => Effect.succeed(false),
          serializeVerificationMutation: (effect) => effect,
        },
        liveRuntimes: new Map(),
        namespace,
        pullRequests: {
          syncCompletedReport: () =>
            Effect.sync(() => {
              trace.push('sync');
            }),
        },
        reporting: {
          persist: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                reference: {
                  createdAt: '2026-01-01T00:00:00.000Z',
                  reportId: 'report-one',
                  status: 'completed',
                  summaryTruncated: false,
                },
                reportId: 'report-one',
              }),
            ),
        },
        reviewGates: {
          retryMergedRetirementForIdleAgent: () =>
            Effect.sync(() => {
              trace.push('retry');
            }),
          retryMergedRetirementForWorkstream: () =>
            Effect.sync(() => {
              trace.push('retry-stream');
            }),
        },
      }),
    );

    const completion = Effect.runFork(
      coordinator.handle({
        agentId: 'agent-one',
        status: 'completed',
        summary: 'Completed before idle.',
        type: 'report',
      }),
    );
    await Effect.runPromise(Deferred.await(entered));
    const idle = Effect.runFork(
      coordinator.handle({ agentId: 'agent-one', status: 'idle', type: 'status' }),
    );
    await sleep(10);

    expect(namespace.state.agents['agent-one']?.status).toBe('running');
    expect(trace).toEqual([]);

    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(completion));
    await Effect.runPromise(Fiber.join(idle));

    expect(namespace.state.agents['agent-one']?.status).toBe('idle');
    expect(namespace.state.inbox.map(({ type }) => type)).toEqual(['agent_report_completed']);
    expect(trace).toEqual([
      'append:agent_report_completed',
      'refresh',
      'wake',
      'sync',
      'refresh',
      'retry',
    ]);
  });

  test('projects over-cap report persistence into bounded actionable attention without invoking artifact storage', async () => {
    const initial: ManagerState = {
      agents: {
        'agent-one': {
          createdAt: '2026-01-01T00:00:00.000Z',
          id: 'agent-one',
          model: 'fixture/model',
          role: 'worker',
          sessionDir: '/sessions/agent-one',
          status: 'running',
          task: 'Reject bulk durable report writes.',
          thinkingLevel: 'low',
          updatedAt: '2026-01-01T00:00:00.000Z',
          workstreamId: 'ws-one',
        },
      },
      inbox: [],
      managerId: 'manager-one',
      pullRequests: {},
      repo: {
        currentCheckout: '/repo',
        gitCommonDir: '/repo/.git',
        key: 'repo',
        primaryCheckout: '/repo',
      },
      revision: 0,
      schemaVersion: 1,
      verifications: {},
      workstreams: {},
    };
    const state = { current: initial };
    const namespace = {
      get state() {
        return state.current;
      },
      set state(next: ManagerState) {
        state.current = next;
      },
      store: undefined as unknown as StateStoreShape,
    };
    namespace.store = {
      mutate: <A, E>(
        mutation: (current: ManagerState) => Effect.Effect<readonly [A, ManagerState], E>,
      ) =>
        mutation(state.current).pipe(
          Effect.map(([result, proposed]) => {
            state.current = { ...proposed, revision: state.current.revision + 1 };
            return result;
          }),
        ),
    } as unknown as StateStoreShape;
    const writes: unknown[] = [];
    const appended: string[] = [];
    const reporting = makeReporting({
      readReport: () => Effect.die('unused fixture read'),
      writeReport: (report) =>
        Effect.sync(() => {
          writes.push(report);
        }),
    });
    const coordinator = await Effect.runPromise(
      makeWorkerSupervisorEventCoordinator({
        attachments: { auditHandoffBestEffort: () => Effect.succeed(undefined) },
        callbacks: {
          appendEventSafely: (event) =>
            Effect.sync(() => {
              appended.push(event.type);
            }),
          isSuppressed: () => false,
          reconcileVerificationsForSource: () => Effect.void,
          refresh: () => Effect.void,
          releaseInboxWake: () => Effect.succeed(true),
          render: () => {},
          retryResolvedVerificationRetirementForIdleVerifier: () => Effect.succeed(false),
          serializeVerificationMutation: (effect) => effect,
        },
        liveRuntimes: new Map(),
        namespace,
        pullRequests: { syncCompletedReport: () => Effect.void },
        reporting,
        reviewGates: {
          retryMergedRetirementForIdleAgent: () => Effect.void,
          retryMergedRetirementForWorkstream: () => Effect.void,
        },
      }),
    );

    await Effect.runPromise(
      coordinator.handle({
        agentId: 'agent-one',
        details: 'D'.repeat(REPORT_DETAILS_MAX_CHARS + 1),
        status: 'progress',
        summary: 'Reject this oversized artifact safely.',
        type: 'report',
      }),
    );

    expect(writes).toEqual([]);
    expect(appended).toEqual(['agent_report_persist_failed']);
    expect(namespace.state.inbox).toHaveLength(1);
    expect(namespace.state.inbox[0]).toMatchObject({
      agentId: 'agent-one',
      type: 'agent_report_persist_failed',
    });
    expect(namespace.state.inbox[0]?.summary).toContain(
      'Durable child report details field exceeds its configured write cap.',
    );
    expect(namespace.state.inbox[0]?.summary.length).toBeLessThanOrEqual(900);
    expect(namespace.state.inbox[0]).not.toHaveProperty('reportId');
  });

  test('releases verifier and review-gate permits before adjacent merged-retirement follow-ups', async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const expectedHeadSha = 'c'.repeat(40);
    const reviewCheckout = {
      createdAt: timestamp,
      managerId: 'manager-one',
      path: '/repo/.worktrees/pardes/manager-one/reviews/verify-one',
      reviewedHeadSha: 'b'.repeat(40),
      verificationId: 'verify-one',
    };
    const verificationOwnerEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseVerificationOwner = await Effect.runPromise(Deferred.make<void>());
    const reviewGateFollowUpEntered = await Effect.runPromise(Deferred.make<void>());
    const verificationPermit = await Effect.runPromise(Semaphore.make(1));
    const initial: ManagerState = {
      agents: {
        'agent-source': {
          createdAt: timestamp,
          id: 'agent-source',
          model: 'fixture/model',
          role: 'worker',
          sessionDir: '/sessions/agent-source',
          status: 'stopped',
          task: 'Write.',
          thinkingLevel: 'low',
          updatedAt: timestamp,
          workstreamId: 'ws-one',
        },
        'verifier-one': {
          createdAt: timestamp,
          id: 'verifier-one',
          model: 'fixture/model',
          role: 'verifier',
          sessionDir: '/sessions/verifier-one',
          status: 'idle',
          task: 'Review.',
          thinkingLevel: 'low',
          updatedAt: timestamp,
          workstreamId: 'ws-one',
        },
      },
      inbox: [],
      managerId: 'manager-one',
      pullRequests: {
        'pr-one': {
          agentId: 'agent-source',
          createdAt: timestamp,
          id: 'pr-one',
          lastPushedHeadSha: expectedHeadSha,
          number: 1,
          observation: {
            ci: 'passing',
            mergeable: 'mergeable',
            number: 1,
            reviewDecision: 'approved',
            status: 'open',
          },
          status: 'open',
          updatedAt: timestamp,
          url: 'https://example.test/pr/1',
          workstreamId: 'ws-one',
        },
      },
      repo: {
        currentCheckout: '/repo',
        gitCommonDir: '/repo/.git',
        key: 'repo',
        primaryCheckout: '/repo',
      },
      revision: 0,
      schemaVersion: 1,
      verifications: {
        'verify-one': {
          attempts: [
            {
              attempt: 1,
              createdAt: timestamp,
              evidenceStatus: 'current',
              reviewCheckout,
              reviewedHeadSha: 'b'.repeat(40),
              sourceBranchPointSha: 'a'.repeat(40),
              status: 'idle',
              updatedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          id: 'verify-one',
          model: 'fixture/model',
          sourceAgentId: 'agent-source',
          task: 'Review.',
          thinkingLevel: 'low',
          updatedAt: timestamp,
          verifierAgentId: 'verifier-one',
          workstreamId: 'ws-one',
        },
      },
      workstreams: {
        'ws-one': {
          createdAt: timestamp,
          id: 'ws-one',
          objective: 'Retire safely.',
          status: 'active',
          title: 'Merge',
          updatedAt: timestamp,
        },
      },
    };
    const state = { current: initial };
    const store = {
      mutate: <A, E>(
        mutation: (current: ManagerState) => Effect.Effect<readonly [A, ManagerState], E>,
      ) =>
        mutation(state.current).pipe(
          Effect.map(([result, proposed]) => {
            state.current = { ...proposed, revision: state.current.revision + 1 };
            return result;
          }),
        ),
    } as unknown as StateStoreShape;
    const namespace = {
      managerId: initial.managerId,
      repo: initial.repo,
      get state() {
        return state.current;
      },
      set state(next: ManagerState) {
        state.current = next;
      },
      store,
    };
    const reviewGates = await Effect.runPromise(
      makeReviewGateLifecycleCoordinator({
        callbacks: {
          appendEventSafely: () => Effect.void,
          auditAutoStop: () => Effect.succeed(undefined),
          liveRuntimes: () => new Map(),
          recordStoppedRuntime: () => {},
          refresh: () => Effect.void,
          releaseInboxWake: () => Effect.succeed(true),
          retireResolvedVerificationsForSource: () =>
            Deferred.succeed(reviewGateFollowUpEntered, undefined).pipe(
              Effect.andThen(verificationPermit.withPermit(Effect.void)),
            ),
          stopIdleWorker: () => Effect.succeed(undefined),
          trySerializeWorkstreamCompletion: (_retryKey, effect) => effect.pipe(Effect.as(true)),
        },
        namespace,
      }),
    );
    const workerEvents = await Effect.runPromise(
      makeWorkerSupervisorEventCoordinator({
        attachments: { auditHandoffBestEffort: () => Effect.succeed(undefined) },
        callbacks: {
          appendEventSafely: () => Effect.void,
          isSuppressed: () => false,
          reconcileVerificationsForSource: () => Effect.void,
          refresh: () => Effect.void,
          releaseInboxWake: () => Effect.succeed(true),
          render: () => {},
          retryResolvedVerificationRetirementForIdleVerifier: () => Effect.succeed(true),
          serializeVerificationMutation: (effect) =>
            verificationPermit.withPermit(
              Deferred.succeed(verificationOwnerEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseVerificationOwner)),
                Effect.andThen(effect),
              ),
            ),
        },
        liveRuntimes: new Map(),
        namespace,
        pullRequests: { syncCompletedReport: () => Effect.void },
        reporting: { persist: () => Effect.die('unused fixture report') },
        reviewGates,
      }),
    );
    const telemetry: WorkerRuntimeSnapshot = {
      agentId: 'verifier-one',
      completedCompactionCount: 0,
      isCompacting: false,
      isStreaming: false,
      model: 'fixture/model',
      pendingMessageCount: 0,
      pid: 123,
      sampledAt: undefined,
      sessionFile: undefined,
      startedAt: 1,
      stats: undefined,
      status: 'idle',
      stderr: '',
      task: 'Review.',
      thinkingLevel: 'low',
    };

    const verifierIdle = Effect.runFork(
      workerEvents.handle({
        agentId: 'verifier-one',
        lifecycleGeneration: 1,
        runtime: telemetry,
        type: 'telemetry',
      }),
    );
    await Effect.runPromise(Deferred.await(verificationOwnerEntered));
    const terminalObservation = Effect.runFork(
      reviewGates.watcherCallbacks.onObservation({
        complete: true,
        expectedHeadSha,
        observation: {
          ci: 'passing',
          mergeable: 'unknown',
          number: 1,
          reviewDecision: 'approved',
          status: 'merged',
        },
        pullRequestId: 'pr-one',
      }),
    );
    await Effect.runPromise(Deferred.await(reviewGateFollowUpEntered));
    await Effect.runPromise(Deferred.succeed(releaseVerificationOwner, undefined));

    await expect(
      Promise.race([
        Effect.runPromise(
          Effect.all([Fiber.join(verifierIdle), Fiber.join(terminalObservation)], {
            concurrency: 'unbounded',
          }),
        ),
        sleep(250).then(() => {
          throw new Error('adjacent lifecycle follow-ups deadlocked');
        }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(namespace.state.pullRequests['pr-one']?.status).toBe('merged');
  });

  test('rejects stale or unknown verifier telemetry and delayed prior-attempt reports before mutation', async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const reviewCheckout = {
      createdAt: timestamp,
      managerId: 'manager-one',
      path: '/repo/.worktrees/pardes/manager-one/reviews/verify-one',
      reviewedHeadSha: 'b'.repeat(40),
      verificationId: 'verify-one',
    };
    const initial: ManagerState = {
      agents: {
        'verifier-one': {
          createdAt: timestamp,
          id: 'verifier-one',
          model: 'fixture/model',
          role: 'verifier',
          sessionDir: '/sessions/verifier-one',
          status: 'running',
          task: 'Review.',
          thinkingLevel: 'low',
          updatedAt: timestamp,
          workstreamId: 'ws-one',
        },
      },
      inbox: [],
      managerId: 'manager-one',
      pullRequests: {},
      repo: {
        currentCheckout: '/repo',
        gitCommonDir: '/repo/.git',
        key: 'repo',
        primaryCheckout: '/repo',
      },
      revision: 0,
      schemaVersion: 1,
      verifications: {
        'verify-one': {
          attempts: [
            {
              attempt: 1,
              createdAt: timestamp,
              evidenceStatus: 'stale',
              reviewCheckout: { ...reviewCheckout, reviewedHeadSha: 'a'.repeat(40) },
              reviewedHeadSha: 'a'.repeat(40),
              sourceBranchPointSha: 'a'.repeat(40),
              staleAt: timestamp,
              staleReason: 'superseded',
              status: 'completed',
              updatedAt: timestamp,
            },
            {
              attempt: 2,
              createdAt: timestamp,
              evidenceStatus: 'current',
              reviewCheckout,
              reviewedHeadSha: 'b'.repeat(40),
              sourceBranchPointSha: 'a'.repeat(40),
              status: 'running',
              updatedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          id: 'verify-one',
          model: 'fixture/model',
          sourceAgentId: 'agent-source',
          task: 'Review.',
          thinkingLevel: 'low',
          updatedAt: timestamp,
          verifierAgentId: 'verifier-one',
          workstreamId: 'ws-one',
        },
      },
      workstreams: {},
    };
    const state = { current: initial };
    let persistedReports = 0;
    let serializedMutations = 0;
    const liveRuntimes = new Map<string, WorkerRuntimeSnapshot>();
    const namespace = {
      get state() {
        return state.current;
      },
      set state(next: ManagerState) {
        state.current = next;
      },
      store: {
        mutate: <A, E>(
          mutation: (current: ManagerState) => Effect.Effect<readonly [A, ManagerState], E>,
        ) =>
          mutation(state.current).pipe(
            Effect.map(([result, proposed]) => {
              state.current = { ...proposed, revision: state.current.revision + 1 };
              return result;
            }),
          ),
      } as unknown as StateStoreShape,
    };
    const coordinator = await Effect.runPromise(
      makeWorkerSupervisorEventCoordinator({
        attachments: { auditHandoffBestEffort: () => Effect.succeed(undefined) },
        callbacks: {
          appendEventSafely: () => Effect.void,
          isSuppressed: () => false,
          reconcileVerificationsForSource: () => Effect.void,
          refresh: () => Effect.void,
          releaseInboxWake: () => Effect.succeed(true),
          render: () => {},
          retryResolvedVerificationRetirementForIdleVerifier: () => Effect.succeed(false),
          serializeVerificationMutation: (effect) =>
            Effect.sync(() => {
              serializedMutations += 1;
            }).pipe(Effect.andThen(effect)),
        },
        liveRuntimes,
        namespace,
        pullRequests: { syncCompletedReport: () => Effect.void },
        reporting: {
          persist: () =>
            Effect.sync(() => {
              persistedReports += 1;
              return {
                reference: {
                  createdAt: timestamp,
                  reportId: 'report-one',
                  status: 'completed' as const,
                  summaryTruncated: false,
                },
                reportId: 'report-one',
              };
            }),
        },
        reviewGates: {
          retryMergedRetirementForIdleAgent: () => Effect.void,
          retryMergedRetirementForWorkstream: () => Effect.void,
        },
      }),
    );
    const telemetry = {
      agentId: 'verifier-one',
      completedCompactionCount: 0,
      model: 'fixture/model',
      pid: 123,
      sampledAt: undefined,
      sessionFile: undefined,
      startedAt: 1,
      stats: undefined,
      status: 'running',
      stderr: '',
      task: 'Review.',
      thinkingLevel: 'low',
    } satisfies WorkerRuntimeSnapshot;

    await Effect.runPromise(
      coordinator.handle({
        agentId: 'unknown-verifier',
        lifecycleGeneration: 1,
        runtime: { ...telemetry, agentId: 'unknown-verifier' },
        type: 'telemetry',
      }),
    );
    await Effect.runPromise(
      coordinator.handle({
        agentId: 'verifier-one',
        lifecycleGeneration: 1,
        runtime: telemetry,
        type: 'telemetry',
      }),
    );
    await Effect.runPromise(
      coordinator.handle({
        agentId: 'verifier-one',
        lifecycleGeneration: 1,
        status: 'completed',
        summary: 'Delayed prior attempt.',
        type: 'report',
      }),
    );
    expect(liveRuntimes.size).toBe(0);
    expect(persistedReports).toBe(0);
    expect(namespace.state.revision).toBe(0);

    await Effect.runPromise(
      coordinator.handle({
        agentId: 'verifier-one',
        lifecycleGeneration: 2,
        status: 'idle',
        type: 'status',
      }),
    );
    expect(namespace.state.verifications['verify-one']?.attempts[1]?.status).toBe('idle');
    expect(namespace.state.inbox.map(({ type }) => type)).toEqual([
      'verification_terminal_report_missing',
    ]);
    expect(serializedMutations).toBe(3);
  });

  test('rejects a queued prior-generation verifier event after refresh advances canonical attempts', async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const attemptOne = {
      attempt: 1,
      createdAt: timestamp,
      evidenceStatus: 'current' as const,
      reviewCheckout: {
        createdAt: timestamp,
        managerId: 'manager-one',
        path: '/repo/.worktrees/pardes/manager-one/reviews/verify-one',
        reviewedHeadSha: 'a'.repeat(40),
        verificationId: 'verify-one',
      },
      reviewedHeadSha: 'a'.repeat(40),
      sourceBranchPointSha: '0'.repeat(40),
      status: 'running' as const,
      updatedAt: timestamp,
    };
    const initial: ManagerState = {
      agents: {
        'verifier-one': {
          createdAt: timestamp,
          id: 'verifier-one',
          model: 'fixture/model',
          role: 'verifier',
          sessionDir: '/sessions/verifier-one',
          status: 'running',
          task: 'Review.',
          thinkingLevel: 'low',
          updatedAt: timestamp,
          workstreamId: 'ws-one',
        },
      },
      inbox: [],
      managerId: 'manager-one',
      pullRequests: {},
      repo: {
        currentCheckout: '/repo',
        gitCommonDir: '/repo/.git',
        key: 'repo',
        primaryCheckout: '/repo',
      },
      revision: 0,
      schemaVersion: 1,
      verifications: {
        'verify-one': {
          attempts: [attemptOne],
          createdAt: timestamp,
          id: 'verify-one',
          model: 'fixture/model',
          sourceAgentId: 'agent-source',
          task: 'Review.',
          thinkingLevel: 'low',
          updatedAt: timestamp,
          verifierAgentId: 'verifier-one',
          workstreamId: 'ws-one',
        },
      },
      workstreams: {},
    };
    const state = { current: initial };
    const serializationEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseSerialization = await Effect.runPromise(Deferred.make<void>());
    let persistedReports = 0;
    const namespace = {
      get state() {
        return state.current;
      },
      set state(next: ManagerState) {
        state.current = next;
      },
      store: {
        mutate: <A, E>(
          mutation: (current: ManagerState) => Effect.Effect<readonly [A, ManagerState], E>,
        ) =>
          mutation(state.current).pipe(
            Effect.map(([result, proposed]) => {
              state.current = { ...proposed, revision: state.current.revision + 1 };
              return result;
            }),
          ),
      } as unknown as StateStoreShape,
    };
    const coordinator = await Effect.runPromise(
      makeWorkerSupervisorEventCoordinator({
        attachments: { auditHandoffBestEffort: () => Effect.succeed(undefined) },
        callbacks: {
          appendEventSafely: () => Effect.void,
          isSuppressed: () => false,
          reconcileVerificationsForSource: () => Effect.void,
          refresh: () => Effect.void,
          releaseInboxWake: () => Effect.succeed(true),
          render: () => {},
          retryResolvedVerificationRetirementForIdleVerifier: () => Effect.succeed(false),
          serializeVerificationMutation: (effect) =>
            Deferred.succeed(serializationEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSerialization)),
              Effect.andThen(effect),
            ),
        },
        liveRuntimes: new Map(),
        namespace,
        pullRequests: { syncCompletedReport: () => Effect.void },
        reporting: {
          persist: () =>
            Effect.sync(() => {
              persistedReports += 1;
              return {
                reference: {
                  createdAt: timestamp,
                  reportId: 'report-one',
                  status: 'completed' as const,
                  summaryTruncated: false,
                },
                reportId: 'report-one',
              };
            }),
        },
        reviewGates: {
          retryMergedRetirementForIdleAgent: () => Effect.void,
          retryMergedRetirementForWorkstream: () => Effect.void,
        },
      }),
    );

    const queued = Effect.runFork(
      coordinator.handle({
        agentId: 'verifier-one',
        lifecycleGeneration: 1,
        status: 'completed',
        summary: 'Delayed attempt one report.',
        type: 'report',
      }),
    );
    await Effect.runPromise(Deferred.await(serializationEntered));
    const verification = requiredValue(namespace.state.verifications['verify-one']);
    const attemptTwo = {
      ...attemptOne,
      attempt: 2,
      reviewCheckout: { ...attemptOne.reviewCheckout, reviewedHeadSha: 'b'.repeat(40) },
      reviewedHeadSha: 'b'.repeat(40),
      status: 'running' as const,
    };
    namespace.state = {
      ...namespace.state,
      verifications: {
        ...namespace.state.verifications,
        [verification.id]: {
          ...verification,
          attempts: [
            {
              ...attemptOne,
              evidenceStatus: 'stale',
              staleAt: timestamp,
              staleReason: 'superseded',
            },
            attemptTwo,
          ],
        },
      },
    };
    await Effect.runPromise(Deferred.succeed(releaseSerialization, undefined));
    await Effect.runPromise(Fiber.join(queued));

    expect(persistedReports).toBe(0);
    expect(namespace.state.revision).toBe(0);
    expect(namespace.state.inbox).toEqual([]);
    expect(namespace.state.verifications['verify-one']?.attempts).toEqual([
      { ...attemptOne, evidenceStatus: 'stale', staleAt: timestamp, staleReason: 'superseded' },
      attemptTwo,
    ]);
  });
});
