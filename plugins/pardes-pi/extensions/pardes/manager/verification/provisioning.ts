import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Cause, Effect, Exit } from 'effect';
import { verifierChildProfile } from '../../worker-runtime/index.ts';
import {
  type AgentRecord,
  currentVerificationAttempt,
  VERIFICATION_ATTEMPT_HISTORY_MAX,
  type VerificationRecord,
} from '../domain.ts';
import {
  AgentSpawnConfigurationError,
  VerificationNotFoundError,
  VerificationRefreshRejectedError,
  VerificationRequestRejectedError,
} from '../errors.ts';
import { validateRetainedAgentState } from '../namespace.ts';
import type { VerificationProvisioningCompensationShape } from './compensation.ts';
import type {
  VerificationLifecycleCoordinatorOptions,
  VerificationRequestInput,
} from './contracts.ts';
import type { VerificationEvidenceReconcilerShape } from './evidence.ts';
import {
  DEFAULT_VERIFICATION_TASK,
  makeVerificationEvent,
  nowIso,
  projectVerificationReviewLoopDisposition,
  reviewCheckoutOwner,
  verificationAttemptFor,
  verifierPrompt,
  withStaleCurrentEvidence,
  withVerificationStatus,
} from './policy.ts';

export interface VerificationProvisionerShape {
  readonly request: (
    input: VerificationRequestInput,
    ctx?: ExtensionContext,
  ) => Effect.Effect<VerificationRecord, unknown>;
  readonly refresh: (
    verificationId: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<VerificationRecord, unknown>;
}

export interface VerificationProvisionerOperations {
  readonly compensation: VerificationProvisioningCompensationShape;
  readonly inspectSource: VerificationEvidenceReconcilerShape['inspectSource'];
  readonly requireVerification: (
    verificationId: string,
  ) => Effect.Effect<VerificationRecord, VerificationNotFoundError>;
}

function rejected(sourceAgentId: string, reason: string): VerificationRequestRejectedError {
  return new VerificationRequestRejectedError({ reason, sourceAgentId });
}

function refreshRejected(verificationId: string, reason: string): VerificationRefreshRejectedError {
  return new VerificationRefreshRejectedError({ reason, verificationId });
}

/** Provision initial and retained verifier attempts while preserving the retained conversation boundary. */
export function makeVerificationProvisioner(
  options: VerificationLifecycleCoordinatorOptions,
  operations: VerificationProvisionerOperations,
): VerificationProvisionerShape {
  const { namespace, worktrees, workers, callbacks } = options;
  const { compensation, inspectSource, requireVerification } = operations;

  const request: VerificationProvisionerShape['request'] = Effect.fnUntraced(
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
      const firstAttempt = verificationAttemptFor(
        1,
        inspected.headSha,
        worktree.branchPointSha,
        reviewCheckout,
        timestamp,
      );
      const verification: VerificationRecord = {
        archivedAttemptCount: 0,
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
        .provisionDetachedReviewCheckout(
          reviewCheckoutOwner(namespace, verificationId),
          reviewCheckout,
        )
        .pipe(Effect.exit);
      if (Exit.isFailure(reviewCheckoutResult)) {
        yield* compensation.rollbackRequestedVerification(verification, false);
        return yield* Effect.failCause(reviewCheckoutResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeVerificationEvent(
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
          managerId: namespace.managerId,
          model,
          repositoryKey: namespace.repo.key,
          sessionDir,
          sessionName: `Verifier · ${source.workstreamId} · ${verificationId}`,
          task: verifierPrompt(task, 1, inspected.headSha, worktree.branchPointSha),
          thinkingLevel,
          verificationId,
          workerExtensionPath,
          workstreamId: source.workstreamId,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(runtimeResult)) {
        const failedAt = yield* nowIso;
        yield* compensation.rollbackRequestedVerification(verification, true);
        yield* callbacks.appendEventSafely(
          makeVerificationEvent(
            'verification_spawn_failed',
            `${verificationId} verifier runtime failed to start [runtime_spawn_failed]; attempted safe disposable verifier provisioning compensation. Arbitrary runtime diagnostics omitted.`,
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
        yield* compensation.rollbackRequestedVerification(verification, true);
        return yield* Effect.failCause(persistRuntimeResult.cause);
      }
      yield* callbacks.refresh(ctx);
      return yield* requireVerification(verificationId);
    },
  );

  const refresh: VerificationProvisionerShape['refresh'] = Effect.fnUntraced(
    function* (verificationId, ctx) {
      yield* callbacks.refresh(ctx);
      const verification = namespace.state.verifications[verificationId];
      if (!verification) return yield* new VerificationNotFoundError({ verificationId });
      const retainedVerifierAgent = namespace.state.agents[verification.verifierAgentId];
      if (verification.scratchCleanupPending === true) {
        yield* compensation.stopVerifierRuntimeSafely(verification.verifierAgentId);
        if (!(yield* compensation.discardReviewCheckoutSafely(verification))) {
          return yield* refreshRejected(
            verificationId,
            'retained failed verifier scratch cleanup could not complete; durable retryable ownership was preserved',
          );
        }
        if (retainedVerifierAgent?.sessionFile) {
          if (!(yield* compensation.clearScratchCleanupPending(verificationId))) {
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
        if (!(yield* compensation.removeRequestedVerificationAfterDiscard(verification))) {
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
          reviewCheckoutOwner(namespace, verificationId),
          currentVerificationAttempt(current).reviewCheckout,
          inspected.headSha,
        )
        .pipe(Effect.exit);
      if (Exit.isFailure(reviewCheckoutResult)) {
        yield* compensation.cleanupRefreshProvisioningFailure(
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
            'refresh_superseded',
            refreshedAt,
            `by refresh attempt ${attempt}`,
          );
          const { scratchCleanupPending: _scratchCleanupPending, ...withoutPendingCleanup } = prior;
          const retainedPriorAttempts = prior.attempts.slice(
            -(VERIFICATION_ATTEMPT_HISTORY_MAX - 1),
          );
          const archivedAttemptCount =
            (prior.archivedAttemptCount ?? 0) +
            Math.max(0, prior.attempts.length - retainedPriorAttempts.length);
          const next: VerificationRecord = {
            ...withoutPendingCleanup,
            archivedAttemptCount,
            attempts: [
              ...retainedPriorAttempts,
              verificationAttemptFor(
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
        yield* compensation.cleanupRefreshProvisioningFailure(
          current,
          'failed to persist refreshed verifier attempt after disposable checkout provisioning',
          false,
        );
        return yield* Effect.failCause(persistAttemptResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeVerificationEvent(
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
          managerId: namespace.managerId,
          model: verification.model,
          repositoryKey: namespace.repo.key,
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
          verificationId,
          workerExtensionPath,
          workstreamId: verification.workstreamId,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(runtimeResult)) {
        const failedAt = yield* nowIso;
        yield* compensation.cleanupRefreshProvisioningFailure(
          refreshedVerification,
          'refreshed verifier runtime failed to start',
          true,
        );
        yield* callbacks.appendEventSafely(
          makeVerificationEvent(
            'verification_refresh_failed',
            `${verificationId} attempt ${attempt} verifier runtime failed to relaunch [runtime_spawn_failed]; attempted safe disposable verifier provisioning cleanup. Arbitrary runtime diagnostics omitted.`,
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
        yield* compensation.cleanupRefreshProvisioningFailure(
          refreshedVerification,
          'failed to persist refreshed verifier runtime attachment',
          true,
        );
        return yield* Effect.failCause(persistRuntimeResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeVerificationEvent(
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

  return { refresh, request };
}
