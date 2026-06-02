import { randomUUID } from 'node:crypto';
import { Clock, Context, Effect, Semaphore } from 'effect';
import type { ReportingShape } from '../reporting/index.ts';
import type { StateStoreShape } from '../storage/index.ts';
import type { WorkerRuntimeSnapshot, WorkerSupervisorEvent } from '../worker-runtime/index.ts';
import type { AgentAttachmentLifecycleCoordinatorShape } from './agent-attachment-lifecycle.ts';
import {
  type AgentRecord,
  currentVerificationAttempt,
  currentVerificationTerminalReportStatus,
  type ManagerEvent,
  type ManagerState,
} from './domain.ts';
import type { PullRequestPublicationCoordinatorShape } from './publication-coordinator.ts';
import type { ReviewGateLifecycleCoordinatorShape } from './review-gate-lifecycle.ts';
import {
  projectVerificationReviewLoopDisposition,
  updateCurrentVerificationAttempt,
} from './verification/index.ts';
import {
  applyHandoffAudit,
  boundedFailureSummary,
  isDuplicateWorkerAttention,
  type ReportArtifactPersistence,
  verifierIdleDisposition,
  workerEventSummary,
} from './worker-events.ts';

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

type ManagerEventAssociation = Pick<
  ManagerEvent,
  | 'workstreamId'
  | 'agentId'
  | 'pullRequestId'
  | 'verificationId'
  | 'reportId'
  | 'reportPreviewTruncated'
>;

function makeEvent(
  type: string,
  summary: string,
  createdAt: string,
  association: ManagerEventAssociation = {},
): ManagerEvent {
  return { createdAt, id: randomUUID(), summary, type, ...association };
}

interface WorkerEventProjection {
  readonly changed: boolean;
  readonly enqueued: boolean;
  readonly append: boolean;
}

interface WorkerEventFollowUp {
  readonly retryMergedRetirementForIdleAgent?: {
    readonly agentId: string;
    readonly workstreamId: string;
  };
  readonly retryResolvedVerificationRetirementForIdleVerifier?: {
    readonly agentId: string;
    readonly workstreamId: string;
  };
  readonly releaseInboxWake?: boolean;
  readonly reconcileVerificationsForSource?: string;
  readonly syncCompletedReport?: string;
}

/**
 * Telemetry is a retry edge only after an observed safe-idle settlement. The
 * supervisor's stopIfIdle preflight remains authoritative and may still decline
 * if its fresh RPC state changed after this bounded projection was emitted.
 */
function isSafelyIdleTelemetry(runtime: WorkerRuntimeSnapshot): boolean {
  return (
    runtime.status === 'idle' &&
    runtime.isStreaming !== true &&
    runtime.isCompacting !== true &&
    (runtime.pendingMessageCount ?? 0) === 0
  );
}

function becameSafelyIdleTelemetry(
  previous: WorkerRuntimeSnapshot | undefined,
  current: WorkerRuntimeSnapshot,
): boolean {
  return (
    isSafelyIdleTelemetry(current) && (previous === undefined || !isSafelyIdleTelemetry(previous))
  );
}

export interface WorkerSupervisorEventCoordinatorNamespace {
  readonly store: StateStoreShape;
  state: ManagerState;
}

export interface WorkerSupervisorEventCoordinatorShape {
  readonly handle: (event: WorkerSupervisorEvent) => Effect.Effect<void, unknown>;
}

export class WorkerSupervisorEventCoordinator extends Context.Service<
  WorkerSupervisorEventCoordinator,
  WorkerSupervisorEventCoordinatorShape
>()('pardes/WorkerSupervisorEventCoordinator') {}

export interface WorkerSupervisorEventCoordinatorCallbacks {
  readonly refresh: () => Effect.Effect<void, unknown>;
  readonly appendEventSafely: (event: ManagerEvent) => Effect.Effect<void>;
  readonly releaseInboxWake: () => Effect.Effect<boolean, unknown>;
  readonly render: () => void;
  readonly isSuppressed: (agentId: string) => boolean;
  readonly serializeVerificationMutation: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly reconcileVerificationsForSource: (agentId: string) => Effect.Effect<void, unknown>;
  readonly retryResolvedVerificationRetirementForIdleVerifier: (
    agentId: string,
  ) => Effect.Effect<boolean, unknown>;
}

export interface WorkerSupervisorEventCoordinatorOptions {
  readonly namespace: WorkerSupervisorEventCoordinatorNamespace;
  readonly reporting: Pick<ReportingShape, 'persist'>;
  readonly attachments: Pick<AgentAttachmentLifecycleCoordinatorShape, 'auditHandoffBestEffort'>;
  readonly reviewGates: Pick<
    ReviewGateLifecycleCoordinatorShape,
    'retryMergedRetirementForIdleAgent' | 'retryMergedRetirementForWorkstream'
  >;
  readonly pullRequests: Pick<PullRequestPublicationCoordinatorShape, 'syncCompletedReport'>;
  readonly liveRuntimes: Map<string, WorkerRuntimeSnapshot>;
  readonly callbacks: WorkerSupervisorEventCoordinatorCallbacks;
}

/** Allocate one ordered incoming-worker-event coordinator per active manager namespace. */
export const makeWorkerSupervisorEventCoordinator = Effect.fnUntraced(function* (
  options: WorkerSupervisorEventCoordinatorOptions,
) {
  const { namespace, reporting, attachments, reviewGates, pullRequests, liveRuntimes, callbacks } =
    options;
  const semaphore = yield* Semaphore.make(1);
  const suppressIdleWakeupGenerations = new Map<string, number | undefined>();

  const consumeIdleWakeupSuppression = (workerEvent: WorkerSupervisorEvent): boolean => {
    if (!suppressIdleWakeupGenerations.has(workerEvent.agentId)) return false;
    const lifecycleGeneration = suppressIdleWakeupGenerations.get(workerEvent.agentId);
    suppressIdleWakeupGenerations.delete(workerEvent.agentId);
    return lifecycleGeneration === workerEvent.lifecycleGeneration;
  };

  const handleUnlocked = Effect.fnUntraced(function* (workerEvent: WorkerSupervisorEvent) {
    if (callbacks.isSuppressed(workerEvent.agentId)) return;
    const persistedVerification = Object.values(namespace.state.verifications).find(
      (verification) => verification.verifierAgentId === workerEvent.agentId,
    );
    if (
      persistedVerification !== undefined &&
      workerEvent.lifecycleGeneration !== currentVerificationAttempt(persistedVerification).attempt
    )
      return;
    const persistedAgent = namespace.state.agents[workerEvent.agentId];
    if (!persistedAgent) return;
    if (workerEvent.type === 'telemetry') {
      const previousRuntime = liveRuntimes.get(workerEvent.agentId);
      liveRuntimes.set(workerEvent.agentId, workerEvent.runtime);
      callbacks.render();
      const verification = persistedVerification;
      if (
        persistedAgent?.role === 'verifier' &&
        persistedAgent.status === 'idle' &&
        verification !== undefined &&
        projectVerificationReviewLoopDisposition(namespace.state, verification) ===
          'resolved_terminal' &&
        becameSafelyIdleTelemetry(previousRuntime, workerEvent.runtime)
      ) {
        return {
          retryResolvedVerificationRetirementForIdleVerifier: {
            agentId: persistedAgent.id,
            workstreamId: persistedAgent.workstreamId,
          },
        } satisfies WorkerEventFollowUp;
      }
      return undefined;
    }
    // Completion detail is already represented by the preceding telemetry
    // snapshot. Automatic compactions remain ephemeral monitor telemetry.
    if (workerEvent.type === 'compaction_completed') return;
    const liveRuntime = liveRuntimes.get(workerEvent.agentId);
    if (liveRuntime && workerEvent.type === 'status') {
      liveRuntimes.set(workerEvent.agentId, {
        ...liveRuntime,
        sessionFile: workerEvent.sessionFile ?? liveRuntime.sessionFile,
        status: workerEvent.status,
      });
    }
    if (liveRuntime && workerEvent.type === 'unexpected_exit') {
      liveRuntimes.set(workerEvent.agentId, {
        ...liveRuntime,
        status: 'crashed',
        stderr: workerEvent.stderr,
      });
    }
    const timestamp = yield* nowIso;
    const becameIdle =
      workerEvent.type === 'status' &&
      workerEvent.status === 'idle' &&
      persistedAgent.status !== 'idle';
    const reportPersistence: ReportArtifactPersistence | undefined =
      workerEvent.type === 'report'
        ? yield* reporting
            .persist({
              agentId: workerEvent.agentId,
              status: workerEvent.status,
              summary: workerEvent.summary,
              ...(workerEvent.details === undefined ? {} : { details: workerEvent.details }),
              createdAt: timestamp,
            })
            .pipe(
              Effect.map(({ reportId, reference }) => ({
                reference,
                reportId,
                status: 'persisted' as const,
              })),
              Effect.catch((error) =>
                Effect.succeed({
                  failureSummary: boundedFailureSummary(error),
                  status: 'failed' as const,
                }),
              ),
            )
        : undefined;
    const audit =
      workerEvent.type === 'report' && workerEvent.status === 'completed'
        ? yield* attachments.auditHandoffBestEffort(persistedAgent, 'completion')
        : undefined;
    if (
      workerEvent.type === 'report' &&
      (workerEvent.status === 'completed' ||
        (persistedAgent.role === 'verifier' && workerEvent.status === 'blocked'))
    )
      suppressIdleWakeupGenerations.set(workerEvent.agentId, workerEvent.lifecycleGeneration);
    else if (workerEvent.type !== 'status' || workerEvent.status !== 'idle')
      suppressIdleWakeupGenerations.delete(workerEvent.agentId);
    const suppressIdleWakeup =
      workerEvent.type === 'status' &&
      workerEvent.status === 'idle' &&
      consumeIdleWakeupSuppression(workerEvent);
    const verifierIdle = verifierIdleDisposition(
      workerEvent,
      persistedAgent,
      persistedVerification,
      suppressIdleWakeup,
    );
    const event = workerEventSummary(workerEvent, reportPersistence, audit, {
      suppressIdleWakeup,
      ...(verifierIdle === undefined ? {} : { verifierIdleDisposition: verifierIdle }),
    });
    const association: ManagerEventAssociation = {
      agentId: workerEvent.agentId,
      workstreamId: persistedAgent.workstreamId,
      ...(persistedVerification === undefined ? {} : { verificationId: persistedVerification.id }),
      ...(reportPersistence?.status === 'persisted'
        ? {
            reportId: reportPersistence.reportId,
            reportPreviewTruncated: event?.reportPreviewTruncated ?? false,
          }
        : {}),
    };
    const attention = event?.actionable
      ? makeEvent(event.type, event.summary, timestamp, association)
      : undefined;
    const projection = yield* namespace.store.mutate<WorkerEventProjection, never>((state) => {
      const agent = state.agents[workerEvent.agentId];
      if (!agent)
        return Effect.succeed([{ append: false, changed: false, enqueued: false }, state] as const);
      const transitioned: AgentRecord =
        workerEvent.type === 'status'
          ? {
              ...agent,
              status: workerEvent.status,
              ...((workerEvent.sessionFile ?? agent.sessionFile)
                ? { sessionFile: workerEvent.sessionFile ?? agent.sessionFile }
                : {}),
              updatedAt: timestamp,
            }
          : workerEvent.type === 'unexpected_exit'
            ? {
                ...agent,
                lastError: `Unexpected child exit (${String(workerEvent.exitCode ?? workerEvent.signal ?? 'unknown')})`,
                status: 'crashed',
                updatedAt: timestamp,
              }
            : agent;
      const auditedAgent = applyHandoffAudit(transitioned, audit);
      const nextAgent =
        reportPersistence?.status === 'persisted' && reportPersistence.reference
          ? { ...auditedAgent, latestReport: reportPersistence.reference }
          : auditedAgent;
      const duplicateAttention = isDuplicateWorkerAttention(
        state.inbox,
        workerEvent,
        event,
        reportPersistence,
      );
      const enqueue = event?.actionable === true && !duplicateAttention;
      const verification = Object.values(state.verifications).find(
        (candidate) => candidate.verifierAgentId === workerEvent.agentId,
      );
      const verificationStatus =
        workerEvent.type === 'status'
          ? workerEvent.status === 'idle'
            ? (currentVerificationTerminalReportStatus(verification) ?? workerEvent.status)
            : workerEvent.status
          : workerEvent.type === 'unexpected_exit'
            ? ('crashed' as const)
            : workerEvent.type === 'report' && workerEvent.status !== 'progress'
              ? workerEvent.status
              : verification === undefined
                ? undefined
                : currentVerificationAttempt(verification).status;
      const nextVerification =
        verification === undefined
          ? undefined
          : updateCurrentVerificationAttempt(
              { ...verification, updatedAt: timestamp },
              (attempt) => ({
                ...attempt,
                ...(verificationStatus === undefined ? {} : { status: verificationStatus }),
                ...(reportPersistence?.status === 'persisted' && reportPersistence.reference
                  ? { latestReport: reportPersistence.reference }
                  : {}),
                updatedAt: timestamp,
              }),
            );
      return Effect.succeed([
        { append: event !== undefined && !duplicateAttention, changed: true, enqueued: enqueue },
        {
          ...state,
          agents: { ...state.agents, [agent.id]: nextAgent },
          inbox: enqueue && attention ? [...state.inbox, attention] : state.inbox,
          verifications:
            nextVerification === undefined
              ? state.verifications
              : { ...state.verifications, [nextVerification.id]: nextVerification },
        },
      ] as const);
    });
    if (!projection.changed) return;
    if (event && projection.append)
      yield* callbacks.appendEventSafely(
        attention ?? makeEvent(event.type, event.summary, timestamp, association),
      );
    yield* callbacks.refresh();
    const safelyRetiredAfterIdle =
      becameIdle && namespace.state.agents[workerEvent.agentId]?.status === 'stopped';
    return {
      ...(becameIdle
        ? {
            retryMergedRetirementForIdleAgent: {
              agentId: persistedAgent.id,
              workstreamId: persistedAgent.workstreamId,
            },
          }
        : {}),
      ...(becameIdle
        ? {
            retryResolvedVerificationRetirementForIdleVerifier: {
              agentId: persistedAgent.id,
              workstreamId: persistedAgent.workstreamId,
            },
          }
        : {}),
      ...(event?.actionable &&
      projection.enqueued &&
      !(event.type === 'agent_idle' && safelyRetiredAfterIdle)
        ? { releaseInboxWake: true }
        : {}),
      ...(workerEvent.type === 'report' &&
      workerEvent.status === 'completed' &&
      persistedAgent.role === 'worker'
        ? {
            reconcileVerificationsForSource: workerEvent.agentId,
            syncCompletedReport: workerEvent.agentId,
          }
        : {}),
    } satisfies WorkerEventFollowUp;
  });

  const runFollowUp = Effect.fnUntraced(function* (followUp: WorkerEventFollowUp | undefined) {
    if (!followUp) return;
    if (followUp.retryMergedRetirementForIdleAgent) {
      yield* reviewGates.retryMergedRetirementForIdleAgent(
        followUp.retryMergedRetirementForIdleAgent.agentId,
        followUp.retryMergedRetirementForIdleAgent.workstreamId,
      );
    }
    if (followUp.retryResolvedVerificationRetirementForIdleVerifier) {
      const { agentId, workstreamId } = followUp.retryResolvedVerificationRetirementForIdleVerifier;
      const retiredVerifier =
        yield* callbacks.retryResolvedVerificationRetirementForIdleVerifier(agentId);
      if (retiredVerifier) yield* reviewGates.retryMergedRetirementForWorkstream(workstreamId);
    }
    if (followUp.releaseInboxWake) yield* callbacks.releaseInboxWake();
    if (followUp.reconcileVerificationsForSource)
      yield* callbacks.reconcileVerificationsForSource(followUp.reconcileVerificationsForSource);
    if (followUp.syncCompletedReport)
      yield* pullRequests.syncCompletedReport(followUp.syncCompletedReport);
  });

  const handle: WorkerSupervisorEventCoordinatorShape['handle'] = (event) =>
    semaphore
      .withPermit(
        Effect.suspend(() =>
          Object.values(namespace.state.verifications).some(
            (verification) => verification.verifierAgentId === event.agentId,
          )
            ? callbacks.serializeVerificationMutation(handleUnlocked(event))
            : handleUnlocked(event),
        ),
      )
      .pipe(Effect.flatMap(runFollowUp));

  return WorkerSupervisorEventCoordinator.of({ handle });
});
