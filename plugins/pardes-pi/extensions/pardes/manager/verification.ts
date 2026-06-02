import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context, Effect, Semaphore } from 'effect';
import { currentVerificationAttempt, type VerificationRecord } from './domain.ts';
import { VerificationNotFoundError } from './errors.ts';
import { makeVerificationProvisioningCompensation } from './verification-compensation.ts';
import type {
  VerificationLifecycleCoordinatorOptions,
  VerificationRequestInput,
} from './verification-contracts.ts';
import { makeVerificationEvidenceReconciler } from './verification-evidence.ts';
import { makeVerificationProvisioner } from './verification-provisioning.ts';
import { makeVerificationRetirement } from './verification-retirement.ts';

export type {
  VerificationLifecycleCallbacks,
  VerificationLifecycleCoordinatorOptions,
  VerificationLifecycleNamespace,
  VerificationRequestInput,
} from './verification-contracts.ts';
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

/** Allocate one coordinator per active manager namespace so verifier lifecycle mutations share one permit. */
export const makeVerificationLifecycleCoordinator = Effect.fnUntraced(function* (
  options: VerificationLifecycleCoordinatorOptions,
) {
  const { namespace, callbacks } = options;
  const semaphore = yield* Semaphore.make(1);

  const requireVerification = Effect.fnUntraced(function* (verificationId: string) {
    const verification = namespace.state.verifications[verificationId];
    if (!verification) return yield* new VerificationNotFoundError({ verificationId });
    return verification;
  });

  const evidence = makeVerificationEvidenceReconciler(options);
  const compensation = makeVerificationProvisioningCompensation(options);
  const provisioner = makeVerificationProvisioner(options, {
    compensation,
    inspectSource: evidence.inspectSource,
    requireVerification,
  });
  const retirement = makeVerificationRetirement(options);

  const statusUnlocked: VerificationLifecycleCoordinatorShape['status'] = Effect.fnUntraced(
    function* (verificationId, ctx) {
      yield* callbacks.refresh(ctx);
      const verification = namespace.state.verifications[verificationId];
      if (!verification) return yield* new VerificationNotFoundError({ verificationId });
      yield* evidence.reconcile(verification);
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
      for (const verification of verifications) yield* evidence.reconcile(verification);
    });

  const retireResolvedForSourceUnlocked: VerificationLifecycleCoordinatorShape['retireResolvedForSource'] =
    Effect.fnUntraced(function* (sourceAgentId) {
      yield* callbacks.refresh();
      const verificationIds = Object.values(namespace.state.verifications)
        .filter((verification) => verification.sourceAgentId === sourceAgentId)
        .map((verification) => verification.id);
      for (const verificationId of verificationIds)
        yield* retirement.retireIfResolved(verificationId);
    });

  const retryResolvedRetirementForIdleVerifierUnlocked = Effect.fnUntraced(function* (
    verifierAgentId: string,
  ) {
    yield* callbacks.refresh();
    const verification = Object.values(namespace.state.verifications).find(
      (candidate) => candidate.verifierAgentId === verifierAgentId,
    );
    return verification ? yield* retirement.retireIfResolved(verification.id) : false;
  });

  const serializeMutation: VerificationLifecycleCoordinatorShape['serializeMutation'] = (effect) =>
    semaphore.withPermit(effect);
  const retryResolvedRetirementForIdleVerifier: VerificationLifecycleCoordinatorShape['retryResolvedRetirementForIdleVerifier'] =
    (verifierAgentId) =>
      serializeMutation(retryResolvedRetirementForIdleVerifierUnlocked(verifierAgentId));
  const request: VerificationLifecycleCoordinatorShape['request'] = (input, ctx) =>
    serializeMutation(provisioner.request(input, ctx));
  const refresh: VerificationLifecycleCoordinatorShape['refresh'] = (verificationId, ctx) =>
    serializeMutation(provisioner.refresh(verificationId, ctx));
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
