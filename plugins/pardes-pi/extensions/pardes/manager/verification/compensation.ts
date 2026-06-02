import { Cause, Effect, Exit } from 'effect';
import { currentVerificationAttempt, type VerificationRecord } from '../domain.ts';
import type { VerificationLifecycleCoordinatorOptions } from './contracts.ts';
import {
  nowIso,
  reviewCheckoutOwner,
  withStaleCurrentEvidence,
  withVerificationStatus,
} from './policy.ts';

export interface VerificationProvisioningCompensationShape {
  readonly clearScratchCleanupPending: (verificationId: string) => Effect.Effect<boolean>;
  readonly cleanupRefreshProvisioningFailure: (
    verification: VerificationRecord,
    reason: string,
    stopRuntime: boolean,
  ) => Effect.Effect<void>;
  readonly discardReviewCheckoutSafely: (
    verification: VerificationRecord,
  ) => Effect.Effect<boolean>;
  readonly removeRequestedVerificationAfterDiscard: (
    verification: VerificationRecord,
  ) => Effect.Effect<boolean>;
  readonly rollbackRequestedVerification: (
    verification: VerificationRecord,
    stopRuntime: boolean,
  ) => Effect.Effect<void>;
  readonly stopVerifierRuntimeSafely: (agentId: string) => Effect.Effect<void>;
}

/** Preserve durable retryable ownership while compensating disposable verifier provisioning failures. */
export function makeVerificationProvisioningCompensation(
  options: VerificationLifecycleCoordinatorOptions,
): VerificationProvisioningCompensationShape {
  const { namespace, worktrees, workers, callbacks } = options;

  const discardReviewCheckoutSafely: VerificationProvisioningCompensationShape['discardReviewCheckoutSafely'] =
    (verification) => {
      const reviewCheckout = currentVerificationAttempt(verification).reviewCheckout;
      return worktrees
        .discardDetachedReviewCheckout(
          reviewCheckoutOwner(namespace, verification.id),
          reviewCheckout,
        )
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
    phase: 'request' | 'refresh',
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
                        phase === 'request'
                          ? 'Verifier provisioning failed; detached scratch cleanup remains retryable.'
                          : 'Verifier refresh provisioning failed; detached scratch cleanup remains retryable.',
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
        phase === 'request'
          ? `Pardes failed to persist advisory verification ${verification.id} provisioning rollback`
          : `Pardes failed to persist advisory verification ${verification.id} refresh rollback`,
        Cause.squash(marked.cause),
      );
      return false;
    }
    yield* callbacks.refresh().pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            phase === 'request'
              ? `Pardes failed to refresh state after advisory verification ${verification.id} provisioning rollback`
              : `Pardes failed to refresh state after advisory verification ${verification.id} refresh rollback`,
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

  const rollbackRequestedVerification = Effect.fnUntraced(function* (
    verification: VerificationRecord,
    stopRuntime: boolean,
  ) {
    if (stopRuntime) yield* stopVerifierRuntimeSafely(verification.verifierAgentId);
    if (
      !(yield* markProvisioningFailed(
        verification,
        'verifier request provisioning failed',
        'request',
      ))
    )
      return;
    if (!(yield* discardReviewCheckoutSafely(verification))) return;
    yield* removeRequestedVerificationAfterDiscard(verification);
  });

  const cleanupRefreshProvisioningFailure = Effect.fnUntraced(function* (
    verification: VerificationRecord,
    reason: string,
    stopRuntime: boolean,
  ) {
    if (stopRuntime) yield* stopVerifierRuntimeSafely(verification.verifierAgentId);
    const marked = yield* markProvisioningFailed(verification, reason, 'refresh');
    if (!marked) return;
    if (yield* discardReviewCheckoutSafely(verification))
      yield* clearScratchCleanupPending(verification.id);
  });

  return {
    cleanupRefreshProvisioningFailure,
    clearScratchCleanupPending,
    discardReviewCheckoutSafely,
    removeRequestedVerificationAfterDiscard,
    rollbackRequestedVerification,
    stopVerifierRuntimeSafely,
  };
}
