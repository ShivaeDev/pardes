import { Effect, Exit } from 'effect';
import type { WorktreeInspection } from '../../git/index.ts';
import {
  type AgentRecord,
  currentVerificationAttempt,
  type VerificationRecord,
  type WorktreeLease,
} from '../domain.ts';
import { VerificationRequestRejectedError } from '../errors.ts';
import { managedLeaseOwner, validateRetainedAgentState } from '../namespace.ts';
import type { VerificationLifecycleCoordinatorOptions } from './contracts.ts';
import {
  boundedVerificationReason,
  makeVerificationEvent,
  nowIso,
  reviewCheckoutOwner,
  withStaleCurrentEvidence,
} from './policy.ts';

export interface InspectedVerificationSource {
  readonly inspected: WorktreeInspection;
  readonly source: AgentRecord;
  readonly worktree: WorktreeLease;
}

export interface VerificationEvidenceReconcilerShape {
  readonly inspectSource: (
    sourceAgentId: string,
  ) => Effect.Effect<InspectedVerificationSource, VerificationRequestRejectedError>;
  readonly reconcile: (verification: VerificationRecord) => Effect.Effect<void, unknown>;
}

function rejected(sourceAgentId: string, reason: string): VerificationRequestRejectedError {
  return new VerificationRequestRejectedError({ reason, sourceAgentId });
}

/** Inspect captured source and detached-checkout evidence, marking stale evidence durably and visibly. */
export function makeVerificationEvidenceReconciler(
  options: VerificationLifecycleCoordinatorOptions,
): VerificationEvidenceReconcilerShape {
  const { namespace, worktrees, callbacks } = options;

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

  const markStale = Effect.fnUntraced(function* (verification: VerificationRecord, reason: string) {
    if (currentVerificationAttempt(verification).evidenceStatus === 'stale') return;
    const timestamp = yield* nowIso;
    const event = makeVerificationEvent(
      'verification_evidence_stale',
      `${verification.id} attempt ${currentVerificationAttempt(verification).attempt} evidence is stale: ${boundedVerificationReason(reason)}`,
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
        reviewCheckoutOwner(namespace, verification.id),
        attempt.reviewCheckout,
      )
      .pipe(Effect.exit);
    if (Exit.isFailure(review) || review.value.headSha !== attempt.reviewedHeadSha) {
      yield* markStale(
        verification,
        'detached review checkout no longer points at its immutable reviewed head',
      );
      return;
    }
    if (review.value.dirty) {
      yield* markStale(
        verification,
        'detached review checkout became dirty after the reviewed head was captured',
      );
    }
  });

  return { inspectSource, reconcile };
}
