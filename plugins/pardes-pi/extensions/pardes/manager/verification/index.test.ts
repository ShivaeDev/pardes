import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Duration, Effect, Exit } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type DetachedReviewCheckoutLease,
  type ManagedWorktreeShape,
  WorktreeError,
} from '../../git/index.ts';
import type { StateStoreShape } from '../../storage/index.ts';
import { requiredValue } from '../../test-support.ts';
import {
  type GuardedWorkerSupervisorShape,
  WorkerProcessError,
  type WorkerRuntimeSnapshot,
  type WorktreeBootstrapShape,
  WorktreeUpdateError,
} from '../../worker-runtime/index.ts';
import {
  currentVerificationAttempt,
  initialManagerState,
  type ManagerState,
  VERIFICATION_ATTEMPT_HISTORY_MAX,
  VERIFICATION_STALE_REASON_MAX_CHARS,
  type VerificationRecord,
} from '../domain.ts';
import { AgentNotFoundError } from '../errors.ts';
import { makeVerificationLifecycleCoordinator } from './index.ts';
import { verificationStaleReason } from './policy.ts';

const temporaryDirectories: string[] = [];
const timestamp = '2026-01-01T00:00:00.000Z';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

async function withoutConsoleError<A>(run: () => Promise<A>): Promise<A> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

interface VerificationFixtureOptions {
  readonly dirtyReviewCheckout?: boolean;
  readonly failMutationAt?: number;
  readonly failCallbackRefreshAt?: number;
  readonly failSpawnAt?: number;
  readonly failRefresh?: boolean;
  readonly failReviewCreate?: boolean;
  readonly failReviewInspect?: boolean;
  readonly failReviewProvisionAfterAllocation?: boolean;
  readonly failDiscard?: boolean;
  readonly createDelay?: Duration.Input;
  readonly mutateWriterAfterReviewCreate?: boolean;
  readonly worktreeBootstrap?: WorktreeBootstrapShape;
}

async function verificationFixture(options: VerificationFixtureOptions = {}) {
  const managerId = 'manager-one';
  const sourceAgentId = 'agent-source';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pardes-verification-')));
  temporaryDirectories.push(root);
  const gitCommonDir = join(root, '.git');
  const stateDirectory = join(root, 'state');
  const sourcePath = join(root, '.worktrees', 'pardes', managerId, sourceAgentId);
  mkdirSync(gitCommonDir, { recursive: true });
  mkdirSync(sourcePath, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  const branchPointSha = 'a'.repeat(40);
  const sourceHeadSha = 'b'.repeat(40);
  const repo = { currentCheckout: root, gitCommonDir, key: 'repo', primaryCheckout: root };
  const initial = initialManagerState(managerId, repo);
  const workstream = {
    createdAt: timestamp,
    id: 'ws-one',
    objective: 'Exercise verifier lifecycle.',
    status: 'active' as const,
    title: 'Verification',
    updatedAt: timestamp,
  };
  const sourceAgent = {
    createdAt: timestamp,
    id: sourceAgentId,
    model: 'fixture/model',
    role: 'worker' as const,
    sessionDir: join(stateDirectory, 'sessions', sourceAgentId),
    status: 'running' as const,
    task: 'Write safely.',
    thinkingLevel: 'low' as const,
    updatedAt: timestamp,
    workstreamId: workstream.id,
    worktree: {
      agentId: sourceAgentId,
      branch: `pardes/${managerId.slice(0, 8)}/${sourceAgentId}`,
      branchPointSha,
      createdAt: timestamp,
      managerId,
      path: sourcePath,
    },
  };
  let state: ManagerState = {
    ...initial,
    agents: { [sourceAgentId]: sourceAgent },
    workstreams: { [workstream.id]: workstream },
  };
  let mutation = 0;
  const store = {
    directory: stateDirectory,
    mutate: <A, E>(
      run: (current: ManagerState) => Effect.Effect<readonly [A, ManagerState], E>,
    ) => {
      mutation += 1;
      if (options.failMutationAt === mutation)
        return Effect.fail(new Error(`fixture persistence failure ${mutation}`));
      return run(state).pipe(
        Effect.map(([result, proposed]) => {
          state = { ...proposed, revision: state.revision + 1 };
          return result;
        }),
      );
    },
  } as unknown as StateStoreShape;
  const namespace = {
    managerId,
    repo,
    get state() {
      return state;
    },
    set state(next: ManagerState) {
      state = next;
    },
    store,
  };
  let reviewCreates = 0;
  let reviewRefreshes = 0;
  let reviewDiscards = 0;
  let failDiscard = options.failDiscard === true;
  let failRefresh = options.failRefresh === true;
  let activeReviewCreates = 0;
  let maximumActiveReviewCreates = 0;
  const reviewLease = (
    verificationId: string,
    reviewedHeadSha: string,
  ): DetachedReviewCheckoutLease => ({
    createdAt: timestamp,
    managerId,
    path: join(root, '.worktrees', 'pardes', managerId, 'reviews', verificationId),
    reviewedHeadSha,
    verificationId,
  });
  const makeReviewScratch = (verificationId: string, reviewedHeadSha: string) =>
    Effect.gen(function* () {
      activeReviewCreates += 1;
      maximumActiveReviewCreates = Math.max(maximumActiveReviewCreates, activeReviewCreates);
      if (options.createDelay) yield* Effect.sleep(options.createDelay);
      const lease = reviewLease(verificationId, reviewedHeadSha);
      mkdirSync(lease.path, { recursive: true });
      if (options.mutateWriterAfterReviewCreate)
        writeFileSync(
          join(sourcePath, 'writer-preserved.txt'),
          'writer changes are never scratch\n',
        );
      activeReviewCreates -= 1;
      return lease;
    });
  const worktrees = {
    discardDetachedReviewCheckout: (_owner, lease) =>
      Effect.sync(() => {
        reviewDiscards += 1;
      }).pipe(
        Effect.andThen(
          failDiscard
            ? Effect.fail(
                new WorktreeError({
                  cause: 'fixture failure',
                  operation: 'fixture checkout discard',
                  path: lease.path,
                }),
              )
            : Effect.sync(() => {
                rmSync(lease.path, { force: true, recursive: true });
              }),
        ),
      ),
    inspect: (_owner, lease) =>
      Effect.succeed({ changedPaths: [], dirty: false, headSha: sourceHeadSha, path: lease.path }),
    inspectDetachedReviewCheckout: (_owner, lease) =>
      options.failReviewInspect
        ? Effect.fail(
            new WorktreeError({
              cause: 'fixture failure',
              operation: 'fixture checkout inspect',
              path: lease.path,
            }),
          )
        : Effect.succeed({
            dirty: options.dirtyReviewCheckout === true,
            headSha: lease.reviewedHeadSha,
            path: lease.path,
          }),
    prepareDetachedReviewCheckout: (input) =>
      Effect.succeed(reviewLease(input.verificationId, input.reviewedHeadSha)),
    provisionDetachedReviewCheckout: (_owner, lease) =>
      Effect.sync(() => {
        reviewCreates += 1;
      }).pipe(
        Effect.andThen(
          options.failReviewCreate
            ? Effect.fail(
                new WorktreeError({
                  cause: 'fixture failure',
                  operation: 'fixture checkout create',
                  path: root,
                }),
              )
            : makeReviewScratch(lease.verificationId, lease.reviewedHeadSha).pipe(
                Effect.andThen(
                  options.failReviewProvisionAfterAllocation
                    ? Effect.fail(
                        new WorktreeError({
                          cause: 'fixture failure',
                          operation: 'fixture checkout post-add validation',
                          path: lease.path,
                        }),
                      )
                    : Effect.void,
                ),
              ),
        ),
      ),
    refreshDetachedReviewCheckout: (owner, _lease, reviewedHeadSha) =>
      Effect.sync(() => {
        reviewRefreshes += 1;
      }).pipe(
        Effect.andThen(
          failRefresh
            ? Effect.fail(
                new WorktreeError({
                  cause: 'fixture failure',
                  operation: 'fixture checkout refresh',
                  path: _lease.path,
                }),
              )
            : Effect.sync(() => {
                const lease = reviewLease(owner.verificationId, reviewedHeadSha);
                mkdirSync(lease.path, { recursive: true });
                return lease;
              }),
        ),
      ),
  } satisfies Partial<ManagedWorktreeShape>;
  const runtimes = new Map<string, WorkerRuntimeSnapshot>();
  let spawn = 0;
  const stops: string[] = [];
  const workers = {
    spawn: (input) =>
      Effect.gen(function* () {
        spawn += 1;
        if (options.failSpawnAt === spawn)
          return yield* Effect.fail(
            new WorkerProcessError({
              agentId: input.agentId,
              cause: `fixture failure ${spawn}`,
              operation: 'fixture runtime provisioning',
            }),
          );
        mkdirSync(input.sessionDir, { recursive: true });
        const sessionFile = input.sessionFile ?? join(input.sessionDir, 'fixture.jsonl');
        writeFileSync(sessionFile, 'fixture\n');
        const runtime: WorkerRuntimeSnapshot = {
          agentId: input.agentId,
          completedCompactionCount: 0,
          model: input.model,
          pid: 123,
          sampledAt: undefined,
          sessionFile,
          startedAt: Date.now(),
          stats: undefined,
          status: 'running',
          stderr: { omittedChars: 0, originalChars: 0, shownChars: 0, tail: '' },
          task: input.task,
          thinkingLevel: input.thinkingLevel,
          ...(input.lifecycleGeneration === undefined
            ? {}
            : { lifecycleGeneration: input.lifecycleGeneration }),
          isCompacting: false,
          isStreaming: true,
          pendingMessageCount: 0,
        };
        runtimes.set(input.agentId, runtime);
        return runtime;
      }),
    stop: (agentId) =>
      Effect.sync(() => {
        stops.push(agentId);
      }).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const runtime = runtimes.get(agentId);
            if (!runtime) return Effect.fail(new AgentNotFoundError({ agentId }));
            const stopped = { ...runtime, isStreaming: false, status: 'stopped' as const };
            runtimes.set(agentId, stopped);
            return Effect.succeed(stopped);
          }),
        ),
      ),
    stopIfIdle: (agentId) =>
      Effect.suspend(() => {
        const runtime = runtimes.get(agentId);
        if (!runtime) return Effect.fail(new AgentNotFoundError({ agentId }));
        if (runtime.status !== 'idle') return Effect.succeed(undefined);
        stops.push(agentId);
        const stopped = { ...runtime, isStreaming: false, status: 'stopped' as const };
        runtimes.set(agentId, stopped);
        return Effect.succeed(stopped);
      }),
  } satisfies Partial<GuardedWorkerSupervisorShape>;
  const ignoredEvents = new Set<string>();
  let callbackRefresh = 0;
  const coordinator = await Effect.runPromise(
    makeVerificationLifecycleCoordinator({
      callbacks: {
        appendEventSafely: () => Effect.void,
        defaultModel: () => 'fixture/model',
        defaultThinkingLevel: () => 'low',
        forgetRuntime: () => {},
        recordRuntime: () => {},
        refresh: () =>
          Effect.gen(function* () {
            callbackRefresh += 1;
            if (options.failCallbackRefreshAt === callbackRefresh)
              return yield* Effect.fail(
                new Error(`fixture callback refresh failure ${callbackRefresh}`),
              );
          }),
        releaseInboxWake: () => Effect.succeed(true),
        requirePinnedWorkerExtensionPath: () => Effect.succeed('/fixture/worker-extension.ts'),
        resumeWorkerEvents: (agentId) => {
          ignoredEvents.delete(agentId);
        },
        suppressWorkerEvents: (agentId) => {
          ignoredEvents.add(agentId);
        },
      },
      namespace,
      workers: workers as unknown as GuardedWorkerSupervisorShape,
      worktreeBootstrap: options.worktreeBootstrap ?? {
        run: () => Effect.succeed({ status: 'absent' }),
      },
      worktrees: worktrees as unknown as ManagedWorktreeShape,
    }),
  );
  return {
    coordinator,
    detachVerifierRuntime: (verification: VerificationRecord) => {
      runtimes.delete(verification.verifierAgentId);
    },
    maximumActiveReviewCreates: () => maximumActiveReviewCreates,
    namespace,
    permitDiscard: () => {
      failDiscard = false;
    },
    permitRefresh: () => {
      failRefresh = false;
    },
    reviewCreates: () => reviewCreates,
    reviewDiscards: () => reviewDiscards,
    reviewRefreshes: () => reviewRefreshes,
    runtimes,
    setVerifierIdle: (verification: VerificationRecord) => {
      const runtime = requiredValue(runtimes.get(verification.verifierAgentId));
      runtimes.set(verification.verifierAgentId, {
        ...runtime,
        isStreaming: false,
        status: 'idle',
      });
    },
    sourceAgentId,
    sourcePath,
    spawns: () => spawn,
    stops,
  };
}

describe('advisory verification lifecycle', () => {
  test('preserves complete safe stale details when bounded and replaces oversized detail without midpoint clipping', () => {
    expect(verificationStaleReason('source_head_changed', 'from aaa to bbb')).toBe(
      '[source_head_changed] source head changed from aaa to bbb',
    );

    const privatePrefix = 'token=private-stale-detail';
    const oversized = verificationStaleReason(
      'provisioning_failed',
      `${privatePrefix}\u001b ${'x'.repeat(500)}`,
    );
    expect(oversized).toBe(
      '[provisioning_failed] verifier provisioning failed [detail omitted reason=verification_stale_detail_limit originalChars=527 shownChars=0 omittedChars=527]',
    );
    expect(oversized.length).toBeLessThanOrEqual(VERIFICATION_STALE_REASON_MAX_CHARS);
    expect(oversized).not.toContain(privatePrefix);
    expect(oversized).not.toContain('\u001b');
    expect(oversized).not.toContain('…');
  });

  test('marks detached review-checkout mutations as stale advisory evidence on status', async () => {
    const fixture = await verificationFixture({ dirtyReviewCheckout: true });
    const verification = await Effect.runPromise(
      fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
    );

    const stale = await Effect.runPromise(fixture.coordinator.status(verification.id));

    expect(currentVerificationAttempt(stale)).toMatchObject({
      evidenceStatus: 'stale',
      staleReason: '[review_checkout_dirty] detached review checkout became dirty',
      staleReasonCode: 'review_checkout_dirty',
    });
    expect(fixture.namespace.state.inbox).toEqual([
      expect.objectContaining({
        type: 'verification_evidence_stale',
        verificationId: verification.id,
      }),
    ]);
  });

  test('marks unavailable detached review checkout with a truthful unverifiable stale code', async () => {
    const fixture = await verificationFixture({ failReviewInspect: true });
    const verification = await Effect.runPromise(
      fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
    );

    const stale = await Effect.runPromise(fixture.coordinator.status(verification.id));

    expect(currentVerificationAttempt(stale)).toMatchObject({
      evidenceStatus: 'stale',
      staleReason:
        '[review_checkout_unverifiable] detached review checkout is unavailable or unverifiable',
      staleReasonCode: 'review_checkout_unverifiable',
    });
  });

  test('briefs initial and retained refresh attempts with one comprehensive advisory reporting protocol', async () => {
    const fixture = await verificationFixture();
    const requestedRiskSurface = 'Inspect authorization fallbacks and every touched caller.';
    const verification = await Effect.runPromise(
      fixture.coordinator.request({
        sourceAgentId: fixture.sourceAgentId,
        task: requestedRiskSurface,
      }),
    );
    const firstPrompt = fixture.runtimes.get(verification.verifierAgentId)?.task ?? '';

    expect(fixture.namespace.state.agents[verification.verifierAgentId]?.worktreeBootstrap).toEqual(
      expect.objectContaining({ script: 'script/update', status: 'absent' }),
    );
    expect(firstPrompt).toContain(`Requested review risk surface:\n${requestedRiskSurface}`);
    expect(firstPrompt).toContain(
      'Inspect the whole requested risk surface and relevant diff context before a terminal report',
    );
    expect(firstPrompt).toContain(
      'consolidate every currently known blocker, concern, and non-blocking note instead of serially drip-feeding findings',
    );
    expect(firstPrompt).toContain('bounded reproduction reasoning');
    expect(firstPrompt).toContain('whether the concern was reproduced or is static reasoning');
    expect(firstPrompt).toContain('Separately state confidence and completeness limitations');
    expect(firstPrompt).toContain(
      'The owning manager retains judgment over action, publication, and merge decisions',
    );
    expect(firstPrompt).toContain('report_to_manager for bounded durable findings');

    fixture.setVerifierIdle(verification);
    const refreshed = await Effect.runPromise(fixture.coordinator.refresh(verification.id));
    const refreshedPrompt = fixture.runtimes.get(verification.verifierAgentId)?.task ?? '';
    expect(currentVerificationAttempt(refreshed).attempt).toBe(2);
    expect(refreshedPrompt).toContain(`Requested review risk surface:\n${requestedRiskSurface}`);
    expect(refreshedPrompt).toContain('Prefer one comprehensive pass');
    expect(refreshedPrompt).toContain('Use progress reports only for genuine interim checkpoints');
    expect(refreshedPrompt).toContain('This review is advisory evidence only');
  });

  test('runs detached verifier checkout bootstrap before launch and compensates cleanly on failure', async () => {
    let bootstrapCwd: string | undefined;
    const fixture = await verificationFixture({
      worktreeBootstrap: {
        run: (cwd) => {
          bootstrapCwd = cwd;
          return Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: {
                stderrChars: 7,
                stderrTail: 'fixture',
                stdoutChars: 0,
                stdoutTail: '',
              },
              exitCode: 17,
              reason: 'nonzero_exit',
            }),
          );
        },
      },
    });

    await expect(
      withoutConsoleError(() =>
        Effect.runPromise(
          fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
        ),
      ),
    ).resolves.toBeInstanceOf(WorktreeUpdateError);
    expect(bootstrapCwd).toContain('/reviews/verify-');
    expect(fixture.spawns()).toBe(0);
    expect(fixture.reviewDiscards()).toBe(1);
    expect(Object.keys(fixture.namespace.state.verifications)).toEqual([]);
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  test('discards detached scratch and removes provisional records when request runtime provisioning fails without touching writer files', async () => {
    const fixture = await verificationFixture({
      failSpawnAt: 1,
      mutateWriterAfterReviewCreate: true,
    });
    await expect(
      Effect.runPromise(
        fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
      ),
    ).resolves.toBeInstanceOf(Error);
    expect(fixture.reviewDiscards()).toBe(1);
    expect(Object.keys(fixture.namespace.state.verifications)).toEqual([]);
    expect(Object.keys(fixture.namespace.state.agents)).toEqual([fixture.sourceAgentId]);
    expect(existsSync(join(fixture.sourcePath, 'writer-preserved.txt'))).toBe(true);
  });

  test('persists request provisioning intent before detached scratch allocation', async () => {
    const fixture = await verificationFixture({ failDiscard: true, failMutationAt: 1 });
    await expect(
      Effect.runPromise(
        fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
      ),
    ).resolves.toBeInstanceOf(Error);
    expect(fixture.reviewCreates()).toBe(0);
    expect(fixture.reviewDiscards()).toBe(0);
    expect(Object.keys(fixture.namespace.state.verifications)).toEqual([]);
  });

  test('recovers post-intent pre-provision refresh failure without allocating or touching writer scratch', async () => {
    const fixture = await verificationFixture({ failCallbackRefreshAt: 2 });
    await expect(
      Effect.runPromise(
        fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
      ),
    ).resolves.toBeInstanceOf(Error);
    const [verification] = Object.values(fixture.namespace.state.verifications);
    expect(verification).toMatchObject({ scratchCleanupPending: true });
    expect(currentVerificationAttempt(requiredValue(verification))).toMatchObject({
      evidenceStatus: 'current',
      status: 'starting',
    });
    expect(fixture.reviewCreates()).toBe(0);
    expect(
      existsSync(currentVerificationAttempt(requiredValue(verification)).reviewCheckout.path),
    ).toBe(false);

    const retry = await Effect.runPromise(
      fixture.coordinator.refresh(verification?.id).pipe(Effect.flip),
    );
    expect(retry).toMatchObject({
      _tag: 'VerificationRefreshRejectedError',
      reason:
        'retained failed verifier scratch cleanup completed; request a new advisory verification',
    });
    expect(fixture.reviewDiscards()).toBe(1);
    expect(fixture.stops).toHaveLength(1);
    expect(fixture.namespace.state.verifications).toEqual({});
    expect(Object.keys(fixture.namespace.state.agents)).toEqual([fixture.sourceAgentId]);
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  test('stops the unattached verifier and discards scratch when request runtime attachment persistence fails', async () => {
    const fixture = await verificationFixture({ failMutationAt: 3 });
    await expect(
      Effect.runPromise(
        fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
      ),
    ).resolves.toBeInstanceOf(Error);
    expect(fixture.reviewDiscards()).toBe(1);
    expect(fixture.stops).toHaveLength(1);
    expect(Object.keys(fixture.namespace.state.verifications)).toEqual([]);
  });

  test('retains visible retryable request compensation ownership when detached scratch disposal fails', async () => {
    const fixture = await verificationFixture({
      failDiscard: true,
      failSpawnAt: 1,
      mutateWriterAfterReviewCreate: true,
    });
    await expect(
      withoutConsoleError(() =>
        Effect.runPromise(
          fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
        ),
      ),
    ).resolves.toBeInstanceOf(Error);
    expect(fixture.reviewDiscards()).toBe(1);
    const [verification] = Object.values(fixture.namespace.state.verifications);
    expect(currentVerificationAttempt(requiredValue(verification))).toMatchObject({
      evidenceStatus: 'stale',
      status: 'crashed',
    });
    expect(fixture.namespace.state.agents[verification?.verifierAgentId]).toMatchObject({
      lastError: 'Verifier provisioning failed; detached scratch cleanup remains retryable.',
      status: 'crashed',
    });
    expect(
      existsSync(currentVerificationAttempt(requiredValue(verification)).reviewCheckout.path),
    ).toBe(true);
    expect(existsSync(join(fixture.sourcePath, 'writer-preserved.txt'))).toBe(true);
  });

  test('retains post-allocation adapter compensation ownership and software-retries scratch cleanup without a session', async () => {
    const fixture = await verificationFixture({
      failDiscard: true,
      failReviewProvisionAfterAllocation: true,
    });
    await expect(
      withoutConsoleError(() =>
        Effect.runPromise(
          fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
        ),
      ),
    ).resolves.toMatchObject({ _tag: 'WorktreeError' });
    const [verification] = Object.values(fixture.namespace.state.verifications);
    expect(verification).toMatchObject({ scratchCleanupPending: true });
    expect(currentVerificationAttempt(requiredValue(verification))).toMatchObject({
      evidenceStatus: 'stale',
      status: 'crashed',
    });
    expect(
      existsSync(currentVerificationAttempt(requiredValue(verification)).reviewCheckout.path),
    ).toBe(true);

    fixture.permitDiscard();
    const retry = await Effect.runPromise(
      fixture.coordinator.refresh(verification?.id).pipe(Effect.flip),
    );
    expect(retry).toMatchObject({
      _tag: 'VerificationRefreshRejectedError',
      reason:
        'retained failed verifier scratch cleanup completed; request a new advisory verification',
    });
    expect(fixture.reviewDiscards()).toBe(2);
    expect(
      existsSync(currentVerificationAttempt(requiredValue(verification)).reviewCheckout.path),
    ).toBe(false);
    expect(fixture.namespace.state.verifications).toEqual({});
    expect(Object.keys(fixture.namespace.state.agents)).toEqual([fixture.sourceAgentId]);
  });

  test('does not retain a verifier when detached checkout provisioning fails cleanly', async () => {
    const fixture = await verificationFixture({ failReviewCreate: true });
    await expect(
      Effect.runPromise(
        fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }).pipe(Effect.flip),
      ),
    ).resolves.toMatchObject({ _tag: 'WorktreeError' });
    expect(fixture.reviewCreates()).toBe(1);
    expect(fixture.reviewDiscards()).toBe(1);
    expect(Object.keys(fixture.namespace.state.verifications)).toEqual([]);
  });

  test('marks a failed refresh stale and discards only detached verifier scratch after checkout provisioning failure', async () => {
    const fixture = await verificationFixture({ failRefresh: true });
    const verification = await Effect.runPromise(
      fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
    );
    expect(verification.scratchCleanupPending).toBeUndefined();
    fixture.setVerifierIdle(verification);
    await expect(
      Effect.runPromise(fixture.coordinator.refresh(verification.id).pipe(Effect.flip)),
    ).resolves.toBeInstanceOf(Error);
    expect(fixture.reviewRefreshes()).toBe(1);
    expect(fixture.reviewDiscards()).toBe(1);
    expect(
      currentVerificationAttempt(
        requiredValue(fixture.namespace.state.verifications[verification.id]),
      ),
    ).toMatchObject({ evidenceStatus: 'stale', status: 'crashed' });
    expect(
      fixture.namespace.state.verifications[verification.id]?.scratchCleanupPending,
    ).toBeUndefined();
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  test('software-cleans retained-session refresh compensation after restart before an explicit retained-conversation relaunch', async () => {
    const fixture = await verificationFixture({ failDiscard: true, failRefresh: true });
    const verification = await Effect.runPromise(
      fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
    );
    fixture.setVerifierIdle(verification);
    await expect(
      withoutConsoleError(() =>
        Effect.runPromise(fixture.coordinator.refresh(verification.id).pipe(Effect.flip)),
      ),
    ).resolves.toBeInstanceOf(Error);
    expect(fixture.reviewDiscards()).toBe(1);
    expect(fixture.namespace.state.verifications[verification.id]).toMatchObject({
      scratchCleanupPending: true,
    });
    expect(
      currentVerificationAttempt(
        requiredValue(fixture.namespace.state.verifications[verification.id]),
      ),
    ).toMatchObject({ evidenceStatus: 'stale', status: 'crashed' });
    expect(fixture.namespace.state.agents[verification.verifierAgentId]).toMatchObject({
      lastError:
        'Verifier refresh provisioning failed; detached scratch cleanup remains retryable.',
      status: 'crashed',
    });
    expect(typeof fixture.namespace.state.agents[verification.verifierAgentId]?.sessionFile).toBe(
      'string',
    );
    expect(existsSync(currentVerificationAttempt(verification).reviewCheckout.path)).toBe(true);

    fixture.detachVerifierRuntime(verification);
    fixture.permitDiscard();
    const cleanup = await Effect.runPromise(
      fixture.coordinator.refresh(verification.id).pipe(Effect.flip),
    );
    expect(cleanup).toMatchObject({
      _tag: 'VerificationRefreshRejectedError',
      reason:
        'retained failed verifier scratch cleanup completed; run verification_refresh again to deliberately relaunch the retained verifier conversation',
    });
    expect(fixture.reviewDiscards()).toBe(2);
    expect(
      fixture.namespace.state.verifications[verification.id]?.scratchCleanupPending,
    ).toBeUndefined();
    expect(fixture.namespace.state.agents[verification.verifierAgentId]?.lastError).toBeUndefined();
    expect(existsSync(currentVerificationAttempt(verification).reviewCheckout.path)).toBe(false);
    expect(existsSync(fixture.sourcePath)).toBe(true);

    fixture.permitRefresh();
    const relaunched = await Effect.runPromise(fixture.coordinator.refresh(verification.id));
    expect(relaunched).toMatchObject({
      id: verification.id,
      verifierAgentId: verification.verifierAgentId,
    });
    expect(currentVerificationAttempt(relaunched)).toMatchObject({
      evidenceStatus: 'current',
      status: 'running',
    });
    expect(relaunched.attempts).toHaveLength(2);
    expect(existsSync(currentVerificationAttempt(verification).reviewCheckout.path)).toBe(true);
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  test('rejects a freshly inspected live busy verifier even when its durable projection is stale crashed', async () => {
    const fixture = await verificationFixture();
    const verification = await Effect.runPromise(
      fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
    );
    const agent = requiredValue(fixture.namespace.state.agents[verification.verifierAgentId]);
    fixture.namespace.state = {
      ...fixture.namespace.state,
      agents: { ...fixture.namespace.state.agents, [agent.id]: { ...agent, status: 'crashed' } },
      verifications: {
        ...fixture.namespace.state.verifications,
        [verification.id]: {
          ...verification,
          attempts: [
            ...verification.attempts.slice(0, -1),
            { ...currentVerificationAttempt(verification), status: 'crashed' },
          ],
        },
      },
    };
    const attemptsBefore = fixture.namespace.state.verifications[verification.id]?.attempts;
    const reviewRefreshesBefore = fixture.reviewRefreshes();
    const spawnsBefore = fixture.spawns();

    const rejected = await Effect.runPromise(
      fixture.coordinator.refresh(verification.id).pipe(Effect.flip),
    );
    expect(rejected).toMatchObject({
      _tag: 'VerificationRefreshRejectedError',
      reason: 'retained verifier is active; wait for idle before refresh',
    });
    expect(fixture.reviewRefreshes()).toBe(reviewRefreshesBefore);
    expect(fixture.spawns()).toBe(spawnsBefore);
    expect(fixture.namespace.state.verifications[verification.id]?.attempts).toEqual(
      attemptsBefore,
    );
    expect(existsSync(currentVerificationAttempt(verification).reviewCheckout.path)).toBe(true);
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  test('reruns bootstrap for a freshly refreshed verifier checkout and skips relaunch on failure', async () => {
    const bootstrapCwds: string[] = [];
    const fixture = await verificationFixture({
      worktreeBootstrap: {
        run: (cwd) => {
          bootstrapCwds.push(cwd);
          return bootstrapCwds.length === 1
            ? Effect.succeed({ status: 'absent' as const })
            : Effect.fail(
                new WorktreeUpdateError({
                  cwd,
                  diagnostic: {
                    stderrChars: 0,
                    stderrTail: '',
                    stdoutChars: 0,
                    stdoutTail: '',
                  },
                  exitCode: 9,
                  reason: 'nonzero_exit',
                }),
              );
        },
      },
    });
    const verification = await Effect.runPromise(
      fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
    );
    fixture.setVerifierIdle(verification);

    await expect(
      withoutConsoleError(() =>
        Effect.runPromise(fixture.coordinator.refresh(verification.id).pipe(Effect.flip)),
      ),
    ).resolves.toBeInstanceOf(WorktreeUpdateError);
    expect(bootstrapCwds).toHaveLength(2);
    expect(bootstrapCwds[1]).toBe(requiredValue(bootstrapCwds[0]));
    expect(fixture.spawns()).toBe(1);
    expect(fixture.reviewRefreshes()).toBe(1);
    expect(fixture.reviewDiscards()).toBe(1);
    expect(
      currentVerificationAttempt(
        requiredValue(fixture.namespace.state.verifications[verification.id]),
      ),
    ).toMatchObject({ evidenceStatus: 'stale', status: 'crashed' });
  });

  test('rolls back refreshed scratch after refreshed-attempt persistence or runtime provisioning fails', async () => {
    for (const options of [{ failMutationAt: 5 }, { failSpawnAt: 2 }]) {
      const fixture = await verificationFixture(options);
      const verification = await Effect.runPromise(
        fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
      );
      fixture.setVerifierIdle(verification);
      await expect(
        Effect.runPromise(fixture.coordinator.refresh(verification.id).pipe(Effect.flip)),
      ).resolves.toBeInstanceOf(Error);
      expect(fixture.reviewDiscards()).toBe(1);
      expect(
        currentVerificationAttempt(
          requiredValue(fixture.namespace.state.verifications[verification.id]),
        ),
      ).toMatchObject({ evidenceStatus: 'stale', status: 'crashed' });
      expect(existsSync(fixture.sourcePath)).toBe(true);
    }
  });

  test('counts archived attempts when retained verifier lineage reaches its durable cap', async () => {
    const fixture = await verificationFixture();
    let verification = await Effect.runPromise(
      fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
    );

    for (let index = 0; index < VERIFICATION_ATTEMPT_HISTORY_MAX + 1; index += 1) {
      fixture.setVerifierIdle(verification);
      verification = await Effect.runPromise(fixture.coordinator.refresh(verification.id));
    }

    expect(currentVerificationAttempt(verification).attempt).toBe(
      VERIFICATION_ATTEMPT_HISTORY_MAX + 2,
    );
    expect(verification.attempts).toHaveLength(VERIFICATION_ATTEMPT_HISTORY_MAX);
    expect(verification.archivedAttemptCount).toBe(2);
  });

  test('serializes concurrent requests and refreshes through one manager-scoped verifier permit', async () => {
    const fixture = await verificationFixture({ createDelay: '10 millis' });
    const requested = await Effect.runPromise(
      Effect.all(
        [
          fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
          fixture.coordinator.request({ sourceAgentId: fixture.sourceAgentId }),
        ],
        { concurrency: 'unbounded' },
      ),
    );
    expect(requested).toHaveLength(2);
    expect(fixture.maximumActiveReviewCreates()).toBe(1);

    const verification = requiredValue(requested[0]);
    fixture.setVerifierIdle(verification);
    const refreshed = await Effect.runPromise(
      Effect.all(
        [
          fixture.coordinator.refresh(verification.id).pipe(Effect.exit),
          fixture.coordinator.refresh(verification.id).pipe(Effect.exit),
        ],
        { concurrency: 'unbounded' },
      ),
    );
    expect(refreshed.filter(Exit.isSuccess)).toHaveLength(1);
    expect(refreshed.filter(Exit.isFailure)).toHaveLength(1);
  });
});
