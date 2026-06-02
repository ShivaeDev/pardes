import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Effect, Exit } from 'effect';
import { currentVerificationTerminalReportStatus } from '../domain.ts';
import type { VerificationLifecycleCoordinatorOptions } from './contracts.ts';
import {
  makeVerificationEvent,
  nowIso,
  projectVerificationReviewLoopDisposition,
  withVerificationStatus,
} from './policy.ts';

export interface VerificationRetirementShape {
  readonly retireIfResolved: (verificationId: string) => Effect.Effect<boolean, unknown>;
  readonly stopIdleForWorkstreamCompletion: (
    verifierAgentId: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<boolean, unknown>;
}

/** Stop an idle retained verifier only after its associated writer review loop resolves terminal. */
export function makeVerificationRetirement(
  options: VerificationLifecycleCoordinatorOptions,
): VerificationRetirementShape {
  const { namespace, workers, callbacks } = options;

  const retireIfResolved = Effect.fnUntraced(function* (verificationId: string) {
    const verification = namespace.state.verifications[verificationId];
    if (
      !verification ||
      projectVerificationReviewLoopDisposition(namespace.state, verification) !==
        'resolved_terminal'
    )
      return false;
    const verifierAgent = namespace.state.agents[verification.verifierAgentId];
    if (
      !verifierAgent ||
      verifierAgent.role !== 'verifier' ||
      verifierAgent.status !== 'idle' ||
      currentVerificationTerminalReportStatus(verification) === undefined
    )
      return false;
    const stoppedResult = yield* workers.stopIfIdle(verifierAgent.id).pipe(Effect.exit);
    if (Exit.isFailure(stoppedResult)) {
      const failedAt = yield* nowIso;
      yield* callbacks.appendEventSafely(
        makeVerificationEvent(
          'verification_auto_retire_failed',
          `${verification.id} could not safely stop idle retained verifier ${verifierAgent.id} [runtime_stop_failed]; scratch checkout and advisory history were preserved. Arbitrary runtime diagnostics omitted.`,
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
      makeVerificationEvent(
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

  const stopIdleForWorkstreamCompletion = Effect.fnUntraced(function* (
    verifierAgentId: string,
    ctx?: ExtensionContext,
  ) {
    yield* callbacks.refresh(ctx);
    const verification = Object.values(namespace.state.verifications).find(
      (candidate) => candidate.verifierAgentId === verifierAgentId,
    );
    const verifierAgent = namespace.state.agents[verifierAgentId];
    if (!verification || !verifierAgent || verifierAgent.role !== 'verifier') return false;
    const stoppedResult = yield* workers.stopIfIdle(verifierAgent.id);
    if (!stoppedResult || stoppedResult.status !== 'stopped') return false;
    callbacks.recordRuntime(verifierAgent.id, stoppedResult);
    const stoppedAt = yield* nowIso;
    const persisted = yield* namespace.store.mutate((state) => {
      const current = state.verifications[verification.id];
      const agent = state.agents[verifierAgent.id];
      if (!current || !agent || agent.role !== 'verifier')
        return Effect.succeed([false, state] as const);
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
      makeVerificationEvent(
        'verification_workstream_completion_stopped',
        `${verification.id} safely stopped idle retained verifier ${verifierAgent.id} during explicit workstream completion; durable advisory history and scratch checkout metadata were preserved.`,
        stoppedAt,
        {
          agentId: verifierAgent.id,
          verificationId: verification.id,
          workstreamId: verification.workstreamId,
        },
      ),
    );
    yield* callbacks.refresh(ctx);
    return true;
  });

  return { retireIfResolved, stopIdleForWorkstreamCompletion };
}
