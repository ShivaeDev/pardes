import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Cause, Clock, Context, Effect, Exit, Semaphore } from 'effect';
import type { ManagedWorktreeShape } from '../git/index.ts';
import type { StateStoreShape } from '../storage/index.ts';
import {
  type GuardedWorkerSupervisorShape,
  verifierChildProfile,
  type WorkerRuntimeSnapshot,
  type WorkerThinkingLevel,
} from '../worker-runtime/index.ts';
import {
  type AgentRecord,
  currentVerificationAttempt,
  type ManagerEvent,
  type ManagerState,
  VERIFICATION_ATTEMPT_HISTORY_MAX,
  type VerificationAttempt,
  type VerificationRecord,
  type VerificationStatus,
} from './domain.ts';
import {
  AgentSpawnConfigurationError,
  VerificationNotFoundError,
  VerificationRefreshRejectedError,
  VerificationRequestRejectedError,
} from './errors.ts';
import {
  type ManagerNamespaceContext,
  managedLeaseOwner,
  validateRetainedAgentState,
} from './namespace.ts';

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));
const DEFAULT_VERIFICATION_TASK =
  'Independently review the complete captured worker diff and its relevant context adversarially for correctness issues, regressions, scope drift, generated artifacts, unnecessary complexity, and missing validation.';
const VERIFIER_REVIEW_COMPLETENESS_PROTOCOL = [
  'Review-completeness protocol:',
  '- Inspect the whole requested risk surface and relevant diff context before a terminal report; do not stop after the first finding.',
  '- Prefer one comprehensive pass. In one completed or blocked report, consolidate every currently known blocker, concern, and non-blocking note instead of serially drip-feeding findings that the same pass could discover.',
  '- For each concern, include bounded reproduction reasoning: inspected evidence, triggering condition or minimal reproduction, expected versus actual impact, and whether the concern was reproduced or is static reasoning. Summarize; do not dump bulk logs.',
  '- Separately state confidence and completeness limitations: areas inspected, validation run or not run, areas not inspected, and remaining uncertainty.',
  '- Use progress reports only for genuine interim checkpoints. Ask the manager only when a question truly blocks continued review.',
  '- This review is advisory evidence only. The owning manager retains judgment over action, publication, and merge decisions.',
].join('\n');

type ManagerEventAssociation = Pick<ManagerEvent, 'workstreamId' | 'agentId' | 'verificationId'>;

function makeEvent(
  type: string,
  summary: string,
  createdAt: string,
  association: ManagerEventAssociation = {},
): ManagerEvent {
  return { createdAt, id: randomUUID(), summary, type, ...association };
}

function rejected(sourceAgentId: string, reason: string): VerificationRequestRejectedError {
  return new VerificationRequestRejectedError({ reason, sourceAgentId });
}

function refreshRejected(verificationId: string, reason: string): VerificationRefreshRejectedError {
  return new VerificationRefreshRejectedError({ reason, verificationId });
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

export type VerificationReviewLoopDisposition = 'unassociated' | 'open' | 'resolved_terminal';

/** Pure conservative policy: any associated open writer gate keeps retained refresh available. */
export function projectVerificationReviewLoopDisposition(
  state: Pick<ManagerState, 'pullRequests'>,
  verification: Pick<VerificationRecord, 'sourceAgentId' | 'workstreamId'>,
): VerificationReviewLoopDisposition {
  const associations = Object.values(state.pullRequests).filter(
    (pullRequest) =>
      pullRequest.agentId === verification.sourceAgentId &&
      pullRequest.workstreamId === verification.workstreamId,
  );
  if (associations.some((pullRequest) => pullRequest.status === 'open')) return 'open';
  if (
    associations.some(
      (pullRequest) => pullRequest.status === 'merged' || pullRequest.status === 'closed',
    )
  )
    return 'resolved_terminal';
  return 'unassociated';
}

export function updateCurrentVerificationAttempt(
  verification: VerificationRecord,
  update: (attempt: VerificationAttempt) => VerificationAttempt,
): VerificationRecord {
  return {
    ...verification,
    attempts: [
      ...verification.attempts.slice(0, -1),
      update(currentVerificationAttempt(verification)),
    ],
  };
}

function withVerificationStatus(
  verification: VerificationRecord,
  status: VerificationStatus,
  updatedAt: string,
): VerificationRecord {
  return updateCurrentVerificationAttempt({ ...verification, updatedAt }, (attempt) => ({
    ...attempt,
    status,
    updatedAt,
  }));
}

function withStaleCurrentEvidence(
  verification: VerificationRecord,
  reason: string,
  timestamp: string,
): VerificationRecord {
  const staleReason = boundedReason(reason);
  return updateCurrentVerificationAttempt({ ...verification, updatedAt: timestamp }, (attempt) => ({
    ...attempt,
    evidenceStatus: 'stale',
    staleAt: timestamp,
    staleReason,
    updatedAt: timestamp,
  }));
}

function attemptFor(
  attempt: number,
  reviewedHeadSha: string,
  sourceBranchPointSha: string,
  reviewCheckout: VerificationAttempt['reviewCheckout'],
  timestamp: string,
): VerificationAttempt {
  return {
    attempt,
    createdAt: timestamp,
    evidenceStatus: 'current',
    reviewCheckout,
    reviewedHeadSha,
    sourceBranchPointSha,
    status: 'starting',
    updatedAt: timestamp,
  };
}

function verifierPrompt(
  task: string,
  attempt: number,
  reviewedHeadSha: string,
  sourceBranchPointSha: string,
): string {
  return `Requested review risk surface:\n${task}\n\nVerification attempt ${attempt}. Captured reviewed head: ${reviewedHeadSha}. Baseline: ${sourceBranchPointSha}. Bash is available for efficient rg, Git inspection, targeted queries, and disposable review scratch work. Bash can mutate files and same-user filesystem access is not isolation. Do not publish verifier commits; Pardes never uses this checkout as a publication source. Use verification_evidence for software-owned captured-head evidence and report_to_manager for bounded durable findings.\n\n${VERIFIER_REVIEW_COMPLETENESS_PROTOCOL}`;
}

export interface VerificationRequestInput {
  readonly sourceAgentId: string;
  readonly task?: string;
  readonly model?: string;
  readonly thinkingLevel?: WorkerThinkingLevel;
}

export interface VerificationLifecycleNamespace extends ManagerNamespaceContext {
  readonly store: StateStoreShape;
  state: ManagerState;
}

export interface VerificationLifecycleCallbacks {
  readonly refresh: (ctx?: ExtensionContext) => Effect.Effect<void, unknown>;
  readonly appendEventSafely: (event: ManagerEvent) => Effect.Effect<void>;
  readonly releaseInboxWake: () => Effect.Effect<boolean, unknown>;
  readonly defaultModel: (ctx?: ExtensionContext) => string | undefined;
  readonly defaultThinkingLevel: () => WorkerThinkingLevel;
  readonly requirePinnedWorkerExtensionPath: () => Effect.Effect<string, unknown>;
  readonly recordRuntime: (agentId: string, runtime: WorkerRuntimeSnapshot) => void;
  readonly forgetRuntime: (agentId: string) => void;
  readonly suppressWorkerEvents: (agentId: string) => void;
  readonly resumeWorkerEvents: (agentId: string) => void;
}

export interface VerificationLifecycleCoordinatorShape {
  readonly serializeMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly request: (
    input: VerificationRequestInput,
    ctx?: ExtensionContext,
  ) => Effect.Effect<VerificationRecord, unknown>;
  readonly refresh: (
    verificationId: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<VerificationRecord, unknown>;
  readonly status: (
    verificationId: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<VerificationRecord, unknown>;
  readonly reconcileForSource: (sourceAgentId: string) => Effect.Effect<void, unknown>;
  readonly retireResolvedForSource: (sourceAgentId: string) => Effect.Effect<void, unknown>;
  readonly retryResolvedRetirementForIdleVerifier: (
    verifierAgentId: string,
  ) => Effect.Effect<boolean, unknown>;
}

export class VerificationLifecycleCoordinator extends Context.Service<
  VerificationLifecycleCoordinator,
  VerificationLifecycleCoordinatorShape
>()('pardes/VerificationLifecycleCoordinator') {}

export interface VerificationLifecycleCoordinatorOptions {
  readonly namespace: VerificationLifecycleNamespace;
  readonly worktrees: ManagedWorktreeShape;
  readonly workers: GuardedWorkerSupervisorShape;
  readonly callbacks: VerificationLifecycleCallbacks;
}

/** Allocate one coordinator per active manager namespace so verifier lifecycle mutations share one permit. */
export const makeVerificationLifecycleCoordinator = Effect.fnUntraced(function* (
  options: VerificationLifecycleCoordinatorOptions,
) {
  const { namespace, worktrees, workers, callbacks } = options;
  const semaphore = yield* Semaphore.make(1);

  const requireVerification = Effect.fnUntraced(function* (verificationId: string) {
    const verification = namespace.state.verifications[verificationId];
    if (!verification) return yield* new VerificationNotFoundError({ verificationId });
    return verification;
  });

  const inspectSource = Effect.fnUntraced(function* (sourceAgentId: string) {
    const source = namespace.state.agents[sourceAgentId];
    if (!source) return yield* rejected(sourceAgentId, 'source managed worker does not exist');
    if (source.role !== 'worker' || !source.worktree)
      return yield* rejected(
        sourceAgentId,
        'source identity must name one writing worker with a managed worktree lease',
      );
    const worktree = source.worktree;
    const inspected = yield* validateRetainedAgentState(namespace, sourceAgentId, source).pipe(
      Effect.flatMap(() =>
        worktrees.inspect(managedLeaseOwner(namespace, sourceAgentId), worktree),
      ),
      Effect.mapError(() =>
        rejected(sourceAgentId, 'source managed worktree state could not be verified'),
      ),
    );
    return { inspected, source, worktree };
  });

  const reviewCheckoutOwner = (verificationId: string) => ({
    managerId: namespace.managerId,
    repo: namespace.repo,
    verificationId,
  });

  const discardReviewCheckoutSafely = (verification: VerificationRecord) => {
    const reviewCheckout = currentVerificationAttempt(verification).reviewCheckout;
    return worktrees
      .discardDetachedReviewCheckout(reviewCheckoutOwner(verification.id), reviewCheckout)
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error(
              `Pardes failed to discard detached verifier scratch ${reviewCheckout.path}`,
              error,
            );
            return false;
          }),
        ),
      );
  };

  const stopVerifierRuntimeSafely = Effect.fnUntraced(function* (agentId: string) {
    callbacks.suppressWorkerEvents(agentId);
    callbacks.forgetRuntime(agentId);
    yield* workers.stop(agentId).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (
            typeof error !== 'object' ||
            error === null ||
            !('_tag' in error) ||
            error._tag !== 'AgentNotFoundError'
          ) {
            console.error(
              `Pardes failed to stop detached verifier runtime ${agentId} during provisioning rollback`,
              error,
            );
          }
        }),
      ),
    );
    callbacks.resumeWorkerEvents(agentId);
    callbacks.forgetRuntime(agentId);
  });

  const markProvisioningFailed = Effect.fnUntraced(function* (
    verification: VerificationRecord,
    reason: string,
  ) {
    const timestamp = yield* nowIso;
    const marked = yield* namespace.store
      .mutate((state) => {
        const current = state.verifications[verification.id];
        if (!current) return Effect.succeed([undefined, state] as const);
        const agent = state.agents[current.verifierAgentId];
        const failed = {
          ...withVerificationStatus(
            withStaleCurrentEvidence(current, reason, timestamp),
            'crashed',
            timestamp,
          ),
          scratchCleanupPending: true,
        };
        return Effect.succeed([
          undefined,
          {
            ...state,
            agents:
              agent === undefined
                ? state.agents
                : {
                    ...state.agents,
                    [agent.id]: {
                      ...agent,
                      lastError:
                        'Verifier provisioning failed; detached scratch cleanup remains retryable.',
                      status: 'crashed',
                      updatedAt: timestamp,
                    },
                  },
            verifications: { ...state.verifications, [current.id]: failed },
          },
        ] as const);
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(marked)) {
      console.error(
        `Pardes failed to persist advisory verification ${verification.id} provisioning rollback`,
        Cause.squash(marked.cause),
      );
      return false;
    }
    yield* callbacks.refresh().pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            `Pardes failed to refresh state after advisory verification ${verification.id} provisioning rollback`,
            error,
          );
        }),
      ),
    );
    return true;
  });

  const removeRequestedVerificationAfterDiscard = Effect.fnUntraced(function* (
    verification: VerificationRecord,
  ) {
    const removed = yield* namespace.store
      .mutate((state) => {
        if (!state.verifications[verification.id] && !state.agents[verification.verifierAgentId])
          return Effect.succeed([undefined, state] as const);
        const agents = { ...state.agents };
        const verifications = { ...state.verifications };
        delete agents[verification.verifierAgentId];
        delete verifications[verification.id];
        return Effect.succeed([undefined, { ...state, agents, verifications }] as const);
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(removed)) {
      console.error(
        `Pardes failed to remove compensated advisory verification ${verification.id}`,
        Cause.squash(removed.cause),
      );
      return false;
    }
    yield* callbacks.refresh().pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            `Pardes failed to refresh state after compensating advisory verification ${verification.id}`,
            error,
          );
        }),
      ),
    );
    return true;
  });

  const rollbackRequestedVerification = Effect.fnUntraced(function* (
    verification: VerificationRecord,
    stopRuntime: boolean,
  ) {
    if (stopRuntime) yield* stopVerifierRuntimeSafely(verification.verifierAgentId);
    if (!(yield* markProvisioningFailed(verification, 'verifier request provisioning failed')))
      return;
    if (!(yield* discardReviewCheckoutSafely(verification))) return;
    yield* removeRequestedVerificationAfterDiscard(verification);
  });

  const markRefreshProvisioningFailed = Effect.fnUntraced(function* (
    verification: VerificationRecord,
    reason: string,
  ) {
    const timestamp = yield* nowIso;
    const marked = yield* namespace.store
      .mutate((state) => {
        const current = state.verifications[verification.id];
        if (!current) return Effect.succeed([undefined, state] as const);
        const agent = state.agents[current.verifierAgentId];
        const failed = {
          ...withVerificationStatus(
            withStaleCurrentEvidence(current, reason, timestamp),
            'crashed',
            timestamp,
          ),
          scratchCleanupPending: true,
        };
        return Effect.succeed([
          undefined,
          {
            ...state,
            agents:
              agent === undefined
                ? state.agents
                : {
                    ...state.agents,
                    [agent.id]: {
                      ...agent,
                      lastError:
                        'Verifier refresh provisioning failed; detached scratch cleanup remains retryable.',
                      status: 'crashed',
                      updatedAt: timestamp,
                    },
                  },
            verifications: { ...state.verifications, [current.id]: failed },
          },
        ] as const);
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(marked)) {
      console.error(
        `Pardes failed to persist advisory verification ${verification.id} refresh rollback`,
        Cause.squash(marked.cause),
      );
      return false;
    }
    yield* callbacks.refresh().pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            `Pardes failed to refresh state after advisory verification ${verification.id} refresh rollback`,
            error,
          );
        }),
      ),
    );
    return true;
  });

  const clearScratchCleanupPending = Effect.fnUntraced(function* (verificationId: string) {
    const cleared = yield* namespace.store
      .mutate((state) => {
        const current = state.verifications[verificationId];
        if (!current?.scratchCleanupPending) return Effect.succeed([undefined, state] as const);
        const { scratchCleanupPending: _scratchCleanupPending, ...withoutPendingCleanup } = current;
        const agent = state.agents[current.verifierAgentId];
        const agents =
          agent === undefined
            ? state.agents
            : (() => {
                const { lastError: _lastError, ...withoutStaleCleanupError } = agent;
                return { ...state.agents, [agent.id]: withoutStaleCleanupError };
              })();
        return Effect.succeed([
          undefined,
          {
            ...state,
            agents,
            verifications: { ...state.verifications, [verificationId]: withoutPendingCleanup },
          },
        ] as const);
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(cleared)) {
      console.error(
        `Pardes failed to clear advisory verification ${verificationId} scratch-cleanup marker`,
        Cause.squash(cleared.cause),
      );
      return false;
    }
    yield* callbacks.refresh().pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            `Pardes failed to refresh state after clearing advisory verification ${verificationId} scratch-cleanup marker`,
            error,
          );
        }),
      ),
    );
    return true;
  });

  const cleanupRefreshProvisioningFailure = Effect.fnUntraced(function* (
    verification: VerificationRecord,
    reason: string,
    stopRuntime: boolean,
  ) {
    if (stopRuntime) yield* stopVerifierRuntimeSafely(verification.verifierAgentId);
    const marked = yield* markRefreshProvisioningFailed(verification, reason);
    if (!marked) return;
    if (yield* discardReviewCheckoutSafely(verification))
      yield* clearScratchCleanupPending(verification.id);
  });

  const markStale = Effect.fnUntraced(function* (verification: VerificationRecord, reason: string) {
    if (currentVerificationAttempt(verification).evidenceStatus === 'stale') return;
    const timestamp = yield* nowIso;
    const event = makeEvent(
      'verification_evidence_stale',
      `${verification.id} attempt ${currentVerificationAttempt(verification).attempt} evidence is stale: ${boundedReason(reason)}`,
      timestamp,
      {
        agentId: verification.sourceAgentId,
        verificationId: verification.id,
        workstreamId: verification.workstreamId,
      },
    );
    const changed = yield* namespace.store.mutate((state) => {
      const current = state.verifications[verification.id];
      if (!current || currentVerificationAttempt(current).evidenceStatus === 'stale')
        return Effect.succeed([false, state] as const);
      return Effect.succeed([
        true,
        {
          ...state,
          inbox: [...state.inbox, event],
          verifications: {
            ...state.verifications,
            [verification.id]: withStaleCurrentEvidence(current, reason, timestamp),
          },
        },
      ] as const);
    });
    if (!changed) return;
    yield* callbacks.appendEventSafely(event);
    yield* callbacks.refresh();
    yield* callbacks.releaseInboxWake().pipe(Effect.catch(() => Effect.succeed(false)));
  });

  const reconcile = Effect.fnUntraced(function* (verification: VerificationRecord) {
    const attempt = currentVerificationAttempt(verification);
    if (attempt.evidenceStatus === 'stale') return;
    const sourceResult = yield* inspectSource(verification.sourceAgentId).pipe(Effect.exit);
    if (Exit.isFailure(sourceResult)) {
      yield* markStale(verification, 'source managed worktree state is no longer verifiable');
      return;
    }
    const source = sourceResult.value.inspected;
    if (source.headSha !== attempt.reviewedHeadSha) {
      yield* markStale(
        verification,
        `source head changed from ${attempt.reviewedHeadSha} to ${source.headSha}`,
      );
      return;
    }
    if (source.dirty) {
      yield* markStale(
        verification,
        'source managed worktree became dirty after the reviewed head was captured',
      );
      return;
    }
    const review = yield* worktrees
      .inspectDetachedReviewCheckout(
        { managerId: namespace.managerId, repo: namespace.repo, verificationId: verification.id },
        attempt.reviewCheckout,
      )
      .pipe(Effect.exit);
    if (Exit.isFailure(review) || review.value.headSha !== attempt.reviewedHeadSha) {
      yield* markStale(
        verification,
        'detached review checkout no longer points at its immutable reviewed head',
      );
    }
  });

  const requestUnlocked: VerificationLifecycleCoordinatorShape['request'] = Effect.fnUntraced(
    function* (input, ctx) {
      yield* callbacks.refresh(ctx);
      const workerExtensionPath = yield* callbacks.requirePinnedWorkerExtensionPath();
      const { source, inspected, worktree } = yield* inspectSource(input.sourceAgentId);
      if (inspected.dirty)
        return yield* rejected(
          input.sourceAgentId,
          'source managed worktree is dirty; commit or discard changes before requesting advisory review',
        );
      const model = input.model ?? callbacks.defaultModel(ctx);
      if (!model)
        return yield* new AgentSpawnConfigurationError({
          message:
            'Cannot spawn a Pardes verifier without a model. Select a manager model or pass an explicit model override.',
        });
      const thinkingLevel = input.thinkingLevel ?? callbacks.defaultThinkingLevel();
      const verificationId = `verify-${randomUUID().slice(0, 8)}`;
      const verifierAgentId = `verifier-${randomUUID().slice(0, 8)}`;
      const timestamp = yield* nowIso;
      const reviewCheckout = yield* worktrees.prepareDetachedReviewCheckout({
        managerId: namespace.managerId,
        repo: namespace.repo,
        reviewedHeadSha: inspected.headSha,
        verificationId,
      });
      const sessionDir = join(namespace.store.directory, 'sessions', verifierAgentId);
      const task = input.task ?? DEFAULT_VERIFICATION_TASK;
      const verifierAgent: AgentRecord = {
        createdAt: timestamp,
        id: verifierAgentId,
        model,
        role: 'verifier',
        sessionDir,
        status: 'starting',
        task,
        thinkingLevel,
        updatedAt: timestamp,
        workstreamId: source.workstreamId,
      };
      const firstAttempt = attemptFor(
        1,
        inspected.headSha,
        worktree.branchPointSha,
        reviewCheckout,
        timestamp,
      );
      const verification: VerificationRecord = {
        attempts: [firstAttempt],
        createdAt: timestamp,
        id: verificationId,
        model,
        scratchCleanupPending: true,
        sourceAgentId: source.id,
        task,
        thinkingLevel,
        updatedAt: timestamp,
        verifierAgentId,
        workstreamId: source.workstreamId,
      };
      const provisionalResult = yield* namespace.store
        .mutate((state) =>
          Effect.succeed([
            undefined,
            {
              ...state,
              agents: { ...state.agents, [verifierAgentId]: verifierAgent },
              verifications: { ...state.verifications, [verificationId]: verification },
            },
          ] as const),
        )
        .pipe(Effect.exit);
      if (Exit.isFailure(provisionalResult))
        return yield* Effect.failCause(provisionalResult.cause);
      yield* callbacks.refresh(ctx);
      const reviewCheckoutResult = yield* worktrees
        .provisionDetachedReviewCheckout(reviewCheckoutOwner(verificationId), reviewCheckout)
        .pipe(Effect.exit);
      if (Exit.isFailure(reviewCheckoutResult)) {
        yield* rollbackRequestedVerification(verification, false);
        return yield* Effect.failCause(reviewCheckoutResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeEvent(
          'verification_requested',
          `Requested advisory ${verificationId} attempt 1 for ${source.id} at immutable head ${inspected.headSha}; launched scratch verifier ${verifierAgentId} in a fresh detached checkout.`,
          timestamp,
          { agentId: verifierAgentId, verificationId, workstreamId: source.workstreamId },
        ),
      );
      const runtimeResult = yield* workers
        .spawn({
          agentId: verifierAgentId,
          childProfile: verifierChildProfile(worktree.branchPointSha, inspected.headSha),
          cwd: reviewCheckout.path,
          lifecycleGeneration: 1,
          model,
          sessionDir,
          sessionName: `Verifier · ${source.workstreamId} · ${verificationId}`,
          task: verifierPrompt(task, 1, inspected.headSha, worktree.branchPointSha),
          thinkingLevel,
          workerExtensionPath,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(runtimeResult)) {
        const failedAt = yield* nowIso;
        yield* rollbackRequestedVerification(verification, true);
        yield* callbacks.appendEventSafely(
          makeEvent(
            'verification_spawn_failed',
            `${verificationId} verifier runtime failed to start; attempted safe disposable verifier provisioning compensation: ${boundedReason(String(Cause.squash(runtimeResult.cause)))}`,
            failedAt,
            { agentId: verifierAgentId, verificationId, workstreamId: source.workstreamId },
          ),
        );
        return yield* Effect.failCause(runtimeResult.cause);
      }
      const runtime = runtimeResult.value;
      callbacks.recordRuntime(verifierAgentId, runtime);
      const launchedAt = yield* nowIso;
      const persistRuntimeResult = yield* namespace.store
        .mutate((state) => {
          const agent = state.agents[verifierAgentId] ?? verifierAgent;
          const current = state.verifications[verificationId] ?? verification;
          const { scratchCleanupPending: _scratchCleanupPending, ...attached } =
            withVerificationStatus(current, runtime.status, launchedAt);
          return Effect.succeed([
            undefined,
            {
              ...state,
              agents: {
                ...state.agents,
                [verifierAgentId]: {
                  ...agent,
                  status: runtime.status,
                  ...(runtime.sessionFile ? { sessionFile: runtime.sessionFile } : {}),
                  updatedAt: launchedAt,
                },
              },
              verifications: { ...state.verifications, [verificationId]: attached },
            },
          ] as const);
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(persistRuntimeResult)) {
        yield* rollbackRequestedVerification(verification, true);
        return yield* Effect.failCause(persistRuntimeResult.cause);
      }
      yield* callbacks.refresh(ctx);
      return yield* requireVerification(verificationId);
    },
  );

  const refreshUnlocked: VerificationLifecycleCoordinatorShape['refresh'] = Effect.fnUntraced(
    function* (verificationId, ctx) {
      yield* callbacks.refresh(ctx);
      const verification = namespace.state.verifications[verificationId];
      if (!verification) return yield* new VerificationNotFoundError({ verificationId });
      const retainedVerifierAgent = namespace.state.agents[verification.verifierAgentId];
      if (verification.scratchCleanupPending === true) {
        yield* stopVerifierRuntimeSafely(verification.verifierAgentId);
        if (!(yield* discardReviewCheckoutSafely(verification))) {
          return yield* refreshRejected(
            verificationId,
            'retained failed verifier scratch cleanup could not complete; durable retryable ownership was preserved',
          );
        }
        if (retainedVerifierAgent?.sessionFile) {
          if (!(yield* clearScratchCleanupPending(verificationId))) {
            return yield* refreshRejected(
              verificationId,
              'retained failed verifier scratch was discarded but durable compensation reconciliation could not complete',
            );
          }
          return yield* refreshRejected(
            verificationId,
            'retained failed verifier scratch cleanup completed; run verification_refresh again to deliberately relaunch the retained verifier conversation',
          );
        }
        if (!(yield* removeRequestedVerificationAfterDiscard(verification))) {
          return yield* refreshRejected(
            verificationId,
            'retained failed verifier scratch was discarded but durable compensation reconciliation could not complete',
          );
        }
        return yield* refreshRejected(
          verificationId,
          'retained failed verifier scratch cleanup completed; request a new advisory verification',
        );
      }
      if (
        projectVerificationReviewLoopDisposition(namespace.state, verification) ===
        'resolved_terminal'
      ) {
        return yield* refreshRejected(
          verificationId,
          'associated writer review loop is resolved terminal; request a new verification instead of reviving retained advisory history',
        );
      }
      const workerExtensionPath = yield* callbacks.requirePinnedWorkerExtensionPath();
      const { inspected, worktree } = yield* inspectSource(verification.sourceAgentId).pipe(
        Effect.mapError(() =>
          refreshRejected(
            verificationId,
            'associated source managed worktree state could not be verified',
          ),
        ),
      );
      if (inspected.dirty)
        return yield* refreshRejected(
          verificationId,
          'associated source managed worktree is dirty; writer changes are never discarded',
        );
      const verifierAgent = namespace.state.agents[verification.verifierAgentId];
      if (!verifierAgent || verifierAgent.role !== 'verifier')
        return yield* refreshRejected(
          verificationId,
          'retained verifier identity is missing or invalid',
        );
      yield* validateRetainedAgentState(namespace, verifierAgent.id, verifierAgent).pipe(
        Effect.mapError(() =>
          refreshRejected(verificationId, 'retained verifier session state could not be verified'),
        ),
      );
      if (!verifierAgent.sessionFile)
        return yield* refreshRejected(
          verificationId,
          'retained verifier has no persisted Pi session file',
        );
      const stoppedResult = yield* workers.stopIfIdle(verifierAgent.id).pipe(Effect.exit);
      if (Exit.isFailure(stoppedResult)) {
        const error = Cause.squash(stoppedResult.cause);
        const missingAttachment =
          typeof error === 'object' &&
          error !== null &&
          '_tag' in error &&
          error._tag === 'AgentNotFoundError';
        if (
          !missingAttachment ||
          (verifierAgent.status !== 'crashed' && verifierAgent.status !== 'stopped')
        ) {
          return yield* refreshRejected(
            verificationId,
            'retained verifier runtime is not attached',
          );
        }
      }
      const stopped = Exit.isSuccess(stoppedResult) ? stoppedResult.value : undefined;
      if (Exit.isSuccess(stoppedResult) && !stopped) {
        return yield* refreshRejected(
          verificationId,
          'retained verifier is active; wait for idle before refresh',
        );
      }
      if (stopped) callbacks.recordRuntime(verifierAgent.id, stopped);
      const stoppedAt = yield* nowIso;
      yield* namespace.store.mutate((state) => {
        const agent = state.agents[verifierAgent.id] ?? verifierAgent;
        const current = state.verifications[verificationId] ?? verification;
        return Effect.succeed([
          undefined,
          {
            ...state,
            agents: {
              ...state.agents,
              [verifierAgent.id]: { ...agent, status: 'stopped', updatedAt: stoppedAt },
            },
            verifications: {
              ...state.verifications,
              [verificationId]: withVerificationStatus(current, 'stopped', stoppedAt),
            },
          },
        ] as const);
      });
      yield* callbacks.refresh(ctx);
      const current = yield* requireVerification(verificationId);
      const reviewCheckoutResult = yield* worktrees
        .refreshDetachedReviewCheckout(
          reviewCheckoutOwner(verificationId),
          currentVerificationAttempt(current).reviewCheckout,
          inspected.headSha,
        )
        .pipe(Effect.exit);
      if (Exit.isFailure(reviewCheckoutResult)) {
        yield* cleanupRefreshProvisioningFailure(
          current,
          'disposable verifier checkout refresh failed after the retained verifier stopped',
          false,
        );
        return yield* Effect.failCause(reviewCheckoutResult.cause);
      }
      const reviewCheckout = reviewCheckoutResult.value;
      const refreshedAt = yield* nowIso;
      const attempt = currentVerificationAttempt(current).attempt + 1;
      const persistAttemptResult = yield* namespace.store
        .mutate((state) => {
          const persisted = state.verifications[verificationId] ?? current;
          const prior = withStaleCurrentEvidence(
            persisted,
            `superseded by refresh attempt ${attempt}`,
            refreshedAt,
          );
          const { scratchCleanupPending: _scratchCleanupPending, ...withoutPendingCleanup } = prior;
          const next: VerificationRecord = {
            ...withoutPendingCleanup,
            attempts: [
              ...prior.attempts.slice(-(VERIFICATION_ATTEMPT_HISTORY_MAX - 1)),
              attemptFor(
                attempt,
                inspected.headSha,
                worktree.branchPointSha,
                reviewCheckout,
                refreshedAt,
              ),
            ],
            updatedAt: refreshedAt,
          };
          const agent = state.agents[verifierAgent.id] ?? verifierAgent;
          const {
            lastError: _lastError,
            latestReport: _agentLatestReport,
            ...withoutOldAgentEvidence
          } = agent;
          return Effect.succeed([
            undefined,
            {
              ...state,
              agents: {
                ...state.agents,
                [verifierAgent.id]: {
                  ...withoutOldAgentEvidence,
                  status: 'starting',
                  updatedAt: refreshedAt,
                },
              },
              verifications: { ...state.verifications, [verificationId]: next },
            },
          ] as const);
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(persistAttemptResult)) {
        yield* cleanupRefreshProvisioningFailure(
          current,
          'failed to persist refreshed verifier attempt after disposable checkout provisioning',
          false,
        );
        return yield* Effect.failCause(persistAttemptResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeEvent(
          'verification_refresh_started',
          `Refreshing advisory ${verificationId} as attempt ${attempt} at latest clean source head ${inspected.headSha}; discarded disposable verifier-checkout mutations and retained the verifier conversation.`,
          refreshedAt,
          { agentId: verifierAgent.id, verificationId, workstreamId: verification.workstreamId },
        ),
      );
      yield* callbacks.refresh(ctx);
      const refreshedVerification = yield* requireVerification(verificationId);
      const runtimeResult = yield* workers
        .spawn({
          agentId: verifierAgent.id,
          childProfile: verifierChildProfile(worktree.branchPointSha, inspected.headSha),
          cwd: reviewCheckout.path,
          lifecycleGeneration: attempt,
          model: verification.model,
          sessionDir: verifierAgent.sessionDir,
          sessionFile: verifierAgent.sessionFile,
          sessionName: `Verifier · ${verification.workstreamId} · ${verificationId}`,
          task: verifierPrompt(
            verification.task,
            attempt,
            inspected.headSha,
            worktree.branchPointSha,
          ),
          thinkingLevel: verification.thinkingLevel,
          workerExtensionPath,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(runtimeResult)) {
        const failedAt = yield* nowIso;
        yield* cleanupRefreshProvisioningFailure(
          refreshedVerification,
          'refreshed verifier runtime failed to start',
          true,
        );
        yield* callbacks.appendEventSafely(
          makeEvent(
            'verification_refresh_failed',
            `${verificationId} attempt ${attempt} verifier runtime failed to relaunch; attempted safe disposable verifier provisioning cleanup: ${boundedReason(String(Cause.squash(runtimeResult.cause)))}`,
            failedAt,
            { agentId: verifierAgent.id, verificationId, workstreamId: verification.workstreamId },
          ),
        );
        return yield* Effect.failCause(runtimeResult.cause);
      }
      const runtime = runtimeResult.value;
      callbacks.recordRuntime(verifierAgent.id, runtime);
      const launchedAt = yield* nowIso;
      const persistRuntimeResult = yield* namespace.store
        .mutate((state) => {
          const agent = state.agents[verifierAgent.id] ?? verifierAgent;
          const persisted = state.verifications[verificationId] ?? refreshedVerification;
          return Effect.succeed([
            undefined,
            {
              ...state,
              agents: {
                ...state.agents,
                [verifierAgent.id]: {
                  ...agent,
                  status: runtime.status,
                  ...(runtime.sessionFile ? { sessionFile: runtime.sessionFile } : {}),
                  updatedAt: launchedAt,
                },
              },
              verifications: {
                ...state.verifications,
                [verificationId]: withVerificationStatus(persisted, runtime.status, launchedAt),
              },
            },
          ] as const);
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(persistRuntimeResult)) {
        yield* cleanupRefreshProvisioningFailure(
          refreshedVerification,
          'failed to persist refreshed verifier runtime attachment',
          true,
        );
        return yield* Effect.failCause(persistRuntimeResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeEvent(
          'verification_refreshed',
          `Relaunched ${verificationId} attempt ${attempt} in the retained verifier conversation at immutable source head ${inspected.headSha}.`,
          launchedAt,
          { agentId: verifierAgent.id, verificationId, workstreamId: verification.workstreamId },
        ),
      );
      yield* callbacks.refresh(ctx);
      return yield* requireVerification(verificationId);
    },
  );

  const retireIfResolved = Effect.fnUntraced(function* (verificationId: string) {
    const verification = namespace.state.verifications[verificationId];
    if (
      !verification ||
      projectVerificationReviewLoopDisposition(namespace.state, verification) !==
        'resolved_terminal'
    )
      return false;
    const verifierAgent = namespace.state.agents[verification.verifierAgentId];
    if (!verifierAgent || verifierAgent.role !== 'verifier' || verifierAgent.status !== 'idle')
      return false;
    const stoppedResult = yield* workers.stopIfIdle(verifierAgent.id).pipe(Effect.exit);
    if (Exit.isFailure(stoppedResult)) {
      const failedAt = yield* nowIso;
      yield* callbacks.appendEventSafely(
        makeEvent(
          'verification_auto_retire_failed',
          `${verification.id} could not safely stop idle retained verifier ${verifierAgent.id}; scratch checkout and advisory history were preserved: ${boundedReason(String(Cause.squash(stoppedResult.cause)))}`,
          failedAt,
          {
            agentId: verifierAgent.id,
            verificationId: verification.id,
            workstreamId: verification.workstreamId,
          },
        ),
      );
      return false;
    }
    const stopped = stoppedResult.value;
    if (!stopped || stopped.status !== 'stopped') return false;
    callbacks.recordRuntime(verifierAgent.id, stopped);
    const stoppedAt = yield* nowIso;
    const persisted = yield* namespace.store.mutate((state) => {
      const current = state.verifications[verification.id];
      const agent = state.agents[verifierAgent.id];
      if (
        !current ||
        !agent ||
        agent.role !== 'verifier' ||
        projectVerificationReviewLoopDisposition(state, current) !== 'resolved_terminal'
      ) {
        return Effect.succeed([false, state] as const);
      }
      return Effect.succeed([
        true,
        {
          ...state,
          agents: {
            ...state.agents,
            [agent.id]: { ...agent, status: 'stopped', updatedAt: stoppedAt },
          },
          verifications: {
            ...state.verifications,
            [current.id]: withVerificationStatus(current, 'stopped', stoppedAt),
          },
        },
      ] as const);
    });
    if (!persisted) return false;
    yield* callbacks.appendEventSafely(
      makeEvent(
        'verification_auto_retired',
        `${verification.id} safely stopped idle retained verifier ${verifierAgent.id} after its associated writer review loop resolved terminal; durable advisory history and scratch checkout metadata were preserved.`,
        stoppedAt,
        {
          agentId: verifierAgent.id,
          verificationId: verification.id,
          workstreamId: verification.workstreamId,
        },
      ),
    );
    yield* callbacks.refresh();
    return true;
  });

  const statusUnlocked: VerificationLifecycleCoordinatorShape['status'] = Effect.fnUntraced(
    function* (verificationId, ctx) {
      yield* callbacks.refresh(ctx);
      const verification = namespace.state.verifications[verificationId];
      if (!verification) return yield* new VerificationNotFoundError({ verificationId });
      yield* reconcile(verification);
      yield* callbacks.refresh(ctx);
      return yield* requireVerification(verificationId);
    },
  );

  const reconcileForSourceUnlocked: VerificationLifecycleCoordinatorShape['reconcileForSource'] =
    Effect.fnUntraced(function* (sourceAgentId) {
      yield* callbacks.refresh();
      const verifications = Object.values(namespace.state.verifications).filter(
        (verification) =>
          verification.sourceAgentId === sourceAgentId &&
          currentVerificationAttempt(verification).evidenceStatus === 'current',
      );
      for (const verification of verifications) yield* reconcile(verification);
    });

  const retireResolvedForSourceUnlocked: VerificationLifecycleCoordinatorShape['retireResolvedForSource'] =
    Effect.fnUntraced(function* (sourceAgentId) {
      yield* callbacks.refresh();
      const verificationIds = Object.values(namespace.state.verifications)
        .filter((verification) => verification.sourceAgentId === sourceAgentId)
        .map((verification) => verification.id);
      for (const verificationId of verificationIds) yield* retireIfResolved(verificationId);
    });

  const retryResolvedRetirementForIdleVerifierUnlocked = Effect.fnUntraced(function* (
    verifierAgentId: string,
  ) {
    yield* callbacks.refresh();
    const verification = Object.values(namespace.state.verifications).find(
      (candidate) => candidate.verifierAgentId === verifierAgentId,
    );
    return verification ? yield* retireIfResolved(verification.id) : false;
  });

  const serializeMutation: VerificationLifecycleCoordinatorShape['serializeMutation'] = (effect) =>
    semaphore.withPermit(effect);
  const retryResolvedRetirementForIdleVerifier: VerificationLifecycleCoordinatorShape['retryResolvedRetirementForIdleVerifier'] =
    (verifierAgentId) =>
      serializeMutation(retryResolvedRetirementForIdleVerifierUnlocked(verifierAgentId));
  const request: VerificationLifecycleCoordinatorShape['request'] = (input, ctx) =>
    serializeMutation(requestUnlocked(input, ctx));
  const refresh: VerificationLifecycleCoordinatorShape['refresh'] = (verificationId, ctx) =>
    serializeMutation(refreshUnlocked(verificationId, ctx));
  const status: VerificationLifecycleCoordinatorShape['status'] = (verificationId, ctx) =>
    serializeMutation(statusUnlocked(verificationId, ctx));
  const reconcileForSource: VerificationLifecycleCoordinatorShape['reconcileForSource'] = (
    sourceAgentId,
  ) => serializeMutation(reconcileForSourceUnlocked(sourceAgentId));
  const retireResolvedForSource: VerificationLifecycleCoordinatorShape['retireResolvedForSource'] =
    (sourceAgentId) => serializeMutation(retireResolvedForSourceUnlocked(sourceAgentId));

  return VerificationLifecycleCoordinator.of({
    reconcileForSource,
    refresh,
    request,
    retireResolvedForSource,
    retryResolvedRetirementForIdleVerifier,
    serializeMutation,
    status,
  });
});
