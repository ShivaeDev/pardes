import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Cause, Clock, Effect, Exit, Option, Schema, Semaphore } from 'effect';
import {
  discoverRepository,
  type ManagedWorktreeShape,
  makeManagedWorktreeService,
} from '../git/index.ts';
import {
  type GitHubHostedMetadataShape,
  type GitHubIntegrationHealthShape,
  type GitHubPublicationShape,
  type GitHubWatcherShape,
  makeGitHubHostedMetadataAdapter,
  makeGitHubIntegrationHealthService,
  makeGitHubPublicationService,
  makeGitHubWatcherService,
} from '../github/index.ts';
import { type ManagerPresentation, makeManagerPresentation } from '../presentation/index.ts';
import {
  makeReporting,
  ReportArtifactError,
  type ReportExcerptMetadata,
  type ReportHandoffSourceRole,
  type ReportingShape,
  renderReportHandoffMessage,
} from '../reporting/index.ts';
import { makeFileSystemStateStore, type StateStoreShape } from '../storage/index.ts';
import {
  type GuardedWorkerSupervisorShape,
  makeWorkerSupervisor,
  type WorkerRuntimeSnapshot,
  type WorkerSendBehavior,
  type WorkerSendResult,
  type WorkerStatus,
  type WorkerSupervisorEvent,
  type WorkerThinkingLevel,
} from '../worker-runtime/index.ts';
import {
  makeProcessLoadedPluginActivationSafety,
  type PluginActivationGuardOperation,
  type PluginActivationSafetyShape,
  type PluginActivationStatus,
} from './activation-safety.ts';
import {
  type AgentAttachmentLifecycleCoordinatorShape,
  makeAgentAttachmentLifecycleCoordinator,
} from './agent-attachment-lifecycle.ts';
import {
  type AgentRecord,
  type InboxHandoff,
  initialManagerState,
  type ManagerActivation,
  ManagerActivationSchema,
  type ManagerEvent,
  type ManagerState,
  type Workstream,
} from './domain.ts';
import {
  AgentLeaseCleanupRejectedError,
  AgentNotFoundError,
  AgentReportHandoffRejectedError,
  type AgentReportHandoffRejectedReason,
  InboxEventNotFoundError,
  InboxHandoffUnavailableError,
  InvalidManagedStateError,
  ManagerAlreadyActiveError,
  ManagerInactiveError,
  WorkstreamCompletionRejectedError,
  WorkstreamNotFoundError,
} from './errors.ts';
import {
  type InboxWakeRelease,
  inboxThroughCursor,
  makeInboxWake,
  projectInboxAttention,
  renderInboxWakeMessage,
  retainCurrentInboxHandoff,
  retainCurrentInboxWake,
  withInbox,
} from './inbox.ts';
import {
  type AgentSendReportInput,
  decodeAgentIdInput,
  decodeAgentLeaseCleanupInput,
  decodeAgentReviveInput,
  decodeAgentSendInput,
  decodeAgentSendReportInput,
  decodeAgentSpawnInput,
  decodeInboxAcknowledgeInput,
  decodeInboxGetInput,
  decodePullRequestCreateInput,
  decodeVerificationIdInput,
  decodeVerificationRefreshInput,
  decodeVerificationRequestInput,
  decodeWorkstreamCreateInput,
  decodeWorkstreamIdInput,
  type PullRequestCreateInput,
} from './inputs.ts';
import {
  type AgentLeaseCleanupProjection,
  agentLeaseCleanupEventSummary,
  cleanupAgentLease,
  inspectAgentLeaseCleanup,
  isResolvedByAgentLeaseCleanup,
  reconcileAgentLeaseCleanup,
} from './lease-cleanup.ts';
import {
  isNamespaceSegment,
  managerDirectory,
  validateManagerStateNamespace,
  validateRetainedAgentState,
} from './namespace.ts';
import {
  makePullRequestPublicationCoordinator,
  type PullRequestPublicationCoordinatorShape,
  type PullRequestPublicationNamespace,
} from './publication-coordinator.ts';
import {
  type GitHubRateLimitSymptomOwnershipPort,
  makeReviewGateLifecycleCoordinator,
  type ReviewGateLifecycleCoordinatorShape,
} from './review-gate-lifecycle.ts';
import {
  makeVerificationLifecycleCoordinator,
  updateCurrentVerificationAttempt,
  type VerificationLifecycleCoordinatorShape,
} from './verification/index.ts';
import {
  makeWorkerSupervisorEventCoordinator,
  type WorkerSupervisorEventCoordinatorShape,
} from './worker-event-coordinator.ts';
import {
  boundedEventSummary,
  boundedFailureSummary,
  truncateModelFacingText,
} from './worker-events.ts';

const SESSION_ENTRY_TYPE = 'pardes-manager';

export const MANAGER_COMPACTION_SAFETY_EXPIRY_MS = 5 * 60 * 1_000;
export type ManagerCompactionSafetyPhase =
  | 'started_unsettled'
  | 'succeeded_unsettled'
  | 'aborted_unsettled';

/**
 * Conservative manager-local observation of Pi compaction. Pi 0.75.5 exposes
 * start and persisted-success hooks to extensions, but not the later settlement
 * event that carries success, abort, and failure. A started_unsettled marker
 * therefore also covers an unreported failure. Any present marker holds
 * Pardes-owned triggerTurn delivery until one bounded recovery heuristic runs.
 */
export interface ManagerCompactionSafetySnapshot {
  readonly generation: number;
  readonly phase: ManagerCompactionSafetyPhase;
}

export interface ManagerCompactionSafetyScheduler {
  readonly schedule: (delayMs: number, task: () => void) => () => void;
}

const defaultManagerCompactionSafetyScheduler: ManagerCompactionSafetyScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
};

const ATTACHED_STATUSES = new Set(['starting', 'running', 'idle']);

interface ActiveManager extends PullRequestPublicationNamespace {
  readonly attachments: AgentAttachmentLifecycleCoordinatorShape;
  readonly pullRequests: PullRequestPublicationCoordinatorShape;
  readonly reviewGates: ReviewGateLifecycleCoordinatorShape;
  readonly reporting: ReportingShape;
  readonly verifications: VerificationLifecycleCoordinatorShape;
  readonly workerEvents: WorkerSupervisorEventCoordinatorShape;
}

interface PendingLifecycleRetry {
  readonly active: PullRequestPublicationNamespace;
  readonly retry: Effect.Effect<void, unknown>;
}

export interface AgentSpawnInput {
  readonly workstreamId: string;
  readonly title?: string;
  readonly task: string;
  readonly baselineBranch?: string;
  readonly model?: string;
  readonly thinkingLevel?: WorkerThinkingLevel;
}

export interface AgentStatus {
  readonly agent: AgentRecord;
  readonly runtime: WorkerRuntimeSnapshot | undefined;
}

export interface AgentSendResult extends AgentStatus {
  readonly delivery: WorkerSendResult;
}

export interface AgentReportHandoffResult extends Omit<ReportExcerptMetadata, 'agentId'> {
  readonly targetAgentId: string;
  readonly sourceAgentId: string;
  readonly sourceRole: ReportHandoffSourceRole;
  readonly behavior: 'prompt';
  readonly nextOffset?: number;
}

export type InboxAcknowledgementReason =
  | 'manager_acknowledged'
  | 'feedback_tool_submitted'
  | 'user_message_after_handoff';

export interface InboxAcknowledgement {
  readonly acknowledgedCount: number;
  readonly pendingCount: number;
  readonly queuedSuffixCount: number;
  readonly deliveredCursorAgeMs?: number;
  readonly cursor?: string;
  readonly staleCursor: boolean;
  readonly reason: InboxAcknowledgementReason;
}

export interface InboxHandoffStart extends Required<InboxHandoff> {
  readonly wakeToken: string;
}

interface AcknowledgeInboxOptions {
  readonly cursor?: string;
  readonly reason?: InboxAcknowledgementReason;
  readonly handoff?: InboxHandoff;
  readonly releaseSuccessor?: boolean;
}

function isSameInboxHandoff(
  left: InboxHandoff | undefined,
  right: InboxHandoff | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.token !== undefined &&
    right.token !== undefined &&
    left.cursor === right.cursor &&
    left.surfacedAt === right.surfacedAt &&
    left.token === right.token
  );
}

export type { PullRequestCreateInput } from './inputs.ts';
export type { PullRequestCreateResult } from './publication-coordinator.ts';
export type {
  GitHubRateLimitSymptom,
  GitHubRateLimitSymptomOwnershipPort,
} from './review-gate-lifecycle.ts';

export interface AgentCompactResult {
  readonly agentId: string;
  readonly status: WorkerStatus;
  readonly outcome: 'manual';
  readonly tokensBefore?: number;
  readonly aborted?: boolean;
  readonly willRetry?: boolean;
  readonly failureSummary?: string;
}

export interface AgentReloadResult {
  readonly agentId: string;
  readonly status: WorkerStatus;
  readonly outcome: 'child_extension_refreshed';
  readonly conversation: 'preserved';
  readonly worktree: 'preserved';
}

export interface ManagerControllerOptions {
  readonly worktrees?: ManagedWorktreeShape;
  readonly github?: GitHubPublicationShape;
  readonly githubWatcher?: GitHubWatcherShape;
  readonly githubIntegrationHealth?: GitHubIntegrationHealthShape;
  readonly githubRateLimitSymptomOwnership?: GitHubRateLimitSymptomOwnershipPort;
  readonly makeWorkers?: (
    onEvent: (event: WorkerSupervisorEvent) => Effect.Effect<void, unknown>,
  ) => GuardedWorkerSupervisorShape;
  readonly presentation?: Pick<ManagerPresentation, 'updateDashboard' | 'clearDashboard'>;
  readonly compactionSafetyScheduler?: ManagerCompactionSafetyScheduler;
  readonly activationSafety?: PluginActivationSafetyShape;
}

function invalidManagedState(reason: string): InvalidManagedStateError {
  return new InvalidManagedStateError({ reason });
}

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

type ManagerEventAssociation = Pick<
  ManagerEvent,
  'workstreamId' | 'agentId' | 'pullRequestId' | 'reportId' | 'reportPreviewTruncated'
>;

function makeEvent(
  type: string,
  summary: string,
  createdAt: string,
  association: ManagerEventAssociation = {},
): ManagerEvent {
  return { createdAt, id: randomUUID(), summary, type, ...association };
}

function stateKnowsDurableReport(state: ManagerState, reportId: string): boolean {
  return (
    state.inbox.some((event) => event.reportId === reportId) ||
    Object.values(state.agents).some((agent) => agent.latestReport?.reportId === reportId) ||
    Object.values(state.verifications).some((verification) =>
      verification.attempts.some((attempt) => attempt.latestReport?.reportId === reportId),
    )
  );
}

function reportHandoffRejected(
  targetAgentId: string,
  reason: AgentReportHandoffRejectedReason,
): AgentReportHandoffRejectedError {
  return new AgentReportHandoffRejectedError({ reason, targetAgentId });
}

function latestActivation(ctx: ExtensionContext): ManagerActivation | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== 'custom' || entry.customType !== SESSION_ENTRY_TYPE) continue;
    const decoded = Schema.decodeUnknownOption(ManagerActivationSchema)(entry.data);
    if (Option.isSome(decoded)) return decoded.value;
  }
  return undefined;
}

export class ManagerController {
  private active: ActiveManager | undefined;
  private latestContext: ExtensionContext | undefined;
  private readonly worktrees: ManagedWorktreeShape;
  private readonly github: GitHubPublicationShape;
  private readonly githubHostedMetadata: GitHubHostedMetadataShape;
  private readonly githubWatcher: GitHubWatcherShape;
  private readonly githubIntegrationHealth: GitHubIntegrationHealthShape;
  private readonly githubRateLimitSymptomOwnership: GitHubRateLimitSymptomOwnershipPort | undefined;
  private readonly workers: GuardedWorkerSupervisorShape;
  private readonly presentation: Pick<ManagerPresentation, 'updateDashboard' | 'clearDashboard'>;
  private readonly activationSafety: PluginActivationSafetyShape;
  private readonly liveRuntimes = new Map<string, WorkerRuntimeSnapshot>();
  private readonly ignoredWorkerEvents = new Set<string>();
  private readonly lifecycleGate = Semaphore.makeUnsafe(1);
  private readonly pendingLifecycleRetries = new Map<string, PendingLifecycleRetry>();
  private lifecycleEpoch = 0;
  private lifecycleAcceptingOperations = false;
  private lifecycleTransitioning = false;
  private inboxWakeReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  private compactionSafety: ManagerCompactionSafetySnapshot | undefined;
  private compactionAbortCleanup: (() => void) | undefined;
  private compactionExpiryCleanup: (() => void) | undefined;
  private compactionSuccessSettlementCleanup: (() => void) | undefined;
  private nextCompactionGeneration = 0;
  private readonly compactionSafetyScheduler: ManagerCompactionSafetyScheduler;

  constructor(
    private readonly pi: ExtensionAPI,
    options: ManagerControllerOptions = {},
  ) {
    this.worktrees = options.worktrees ?? makeManagedWorktreeService();
    // One fresh controller owns one repository-pinned GitHub.com context. Ambient `gh`
    // credential switches cannot be proved here: callers must reload the manager first so a
    // fresh controller naturally drops this bounded hosted-metadata cache and debt ledger.
    const githubHostedMetadata = makeGitHubHostedMetadataAdapter();
    this.githubHostedMetadata = githubHostedMetadata;
    this.github =
      options.github ?? makeGitHubPublicationService({ hostedMetadata: githubHostedMetadata });
    this.githubWatcher =
      options.githubWatcher ?? makeGitHubWatcherService({ hostedMetadata: githubHostedMetadata });
    this.githubIntegrationHealth =
      options.githubIntegrationHealth ??
      makeGitHubIntegrationHealthService({ hostedMetadata: githubHostedMetadata });
    this.githubRateLimitSymptomOwnership = options.githubRateLimitSymptomOwnership;
    this.presentation = options.presentation ?? makeManagerPresentation();
    this.compactionSafetyScheduler =
      options.compactionSafetyScheduler ?? defaultManagerCompactionSafetyScheduler;
    this.activationSafety = options.activationSafety ?? makeProcessLoadedPluginActivationSafety();
    const onEvent = (event: WorkerSupervisorEvent) =>
      this.active?.workerEvents.handle(event) ?? Effect.void;
    this.workers = options.makeWorkers?.(onEvent) ?? makeWorkerSupervisor({ onEvent });
  }

  snapshot(): ManagerState | undefined {
    return this.active?.state;
  }

  runtimeSnapshots(): ReadonlyMap<string, WorkerRuntimeSnapshot> {
    return new Map(this.liveRuntimes);
  }

  compactionSafetySnapshot(): ManagerCompactionSafetySnapshot | undefined {
    return this.compactionSafety;
  }

  activationSafetySnapshot(): PluginActivationStatus {
    return this.activationSafety.snapshot();
  }

  readonly inspectActivationSafety = Effect.fnUntraced(function* (this: ManagerController) {
    const status = yield* this.activationSafety.inspect();
    this.render();
    return status;
  });

  private readonly requirePinnedChildRuntime = Effect.fnUntraced(function* (
    this: ManagerController,
    operation: PluginActivationGuardOperation,
  ) {
    const snapshot = yield* this.activationSafety.requireReady(operation).pipe(Effect.exit);
    this.render();
    if (Exit.isFailure(snapshot)) return yield* Effect.failCause(snapshot.cause);
    return snapshot.value;
  });

  isActive(): boolean {
    return this.active !== undefined;
  }

  private requireActive(): Effect.Effect<ActiveManager, ManagerInactiveError> {
    return this.active
      ? Effect.succeed(this.active)
      : Effect.fail(
          new ManagerInactiveError({
            message: 'Pardes manager is inactive. Run /pardes start first.',
          }),
        );
  }

  private lifecycleUnavailable(): ManagerInactiveError {
    return new ManagerInactiveError({
      message:
        'Pardes manager lifecycle is changing or stopped. Retry after the active session is rebound.',
    });
  }

  /**
   * Keep child-RPC and retained-lease side effects inside one manager-local
   * epoch. A transition closes admission before waiting for the current permit,
   * so already-running work finishes conservatively while later commands fail
   * closed rather than launching against a retiring binding.
   */
  private withActiveLifecyclePermit<A, E, R>(
    operation: () => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ManagerInactiveError, R> {
    return Effect.gen(
      function* (this: ManagerController) {
        const epoch = this.lifecycleEpoch;
        if (!this.lifecycleAcceptingOperations || this.lifecycleTransitioning)
          return yield* this.lifecycleUnavailable();
        return yield* this.lifecycleGate
          .withPermit(
            Effect.gen(
              function* (this: ManagerController) {
                if (
                  !this.lifecycleAcceptingOperations ||
                  this.lifecycleTransitioning ||
                  this.lifecycleEpoch !== epoch
                )
                  return yield* this.lifecycleUnavailable();
                return yield* operation();
              }.bind(this),
            ),
          )
          .pipe(Effect.ensuring(this.drainPendingLifecycleRetries()));
      }.bind(this),
    );
  }

  private tryWithActiveLifecyclePermit<A, E, R>(
    active: PullRequestPublicationNamespace,
    retryKey: string,
    operation: Effect.Effect<A, E, R>,
    retry: Effect.Effect<void, unknown>,
  ): Effect.Effect<boolean, E, R> {
    return Effect.suspend(() => {
      if (!this.lifecycleAcceptingOperations || this.lifecycleTransitioning)
        return Effect.succeed(false);
      return this.lifecycleGate
        .withPermitsIfAvailable(1)(operation)
        .pipe(
          Effect.flatMap((result) => {
            if (Option.isSome(result)) return Effect.succeed(true);
            return Effect.sync(() => {
              if (
                this.active === active &&
                this.lifecycleAcceptingOperations &&
                !this.lifecycleTransitioning
              ) {
                this.pendingLifecycleRetries.set(`${active.managerId}/${retryKey}`, {
                  active,
                  retry,
                });
              }
              return false;
            });
          }),
        );
    });
  }

  /** Drain each manager-local missed mechanical retirement once after the lifecycle gate is free. */
  private drainPendingLifecycleRetries(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const active = this.active;
      if (
        !active ||
        !this.lifecycleAcceptingOperations ||
        this.lifecycleTransitioning ||
        this.pendingLifecycleRetries.size === 0
      )
        return Effect.void;
      const retries = [...this.pendingLifecycleRetries.entries()].filter(
        ([, retry]) => retry.active === active,
      );
      for (const [key] of this.pendingLifecycleRetries) this.pendingLifecycleRetries.delete(key);
      if (retries.length === 0) return Effect.void;
      return this.lifecycleGate
        .withPermit(
          Effect.forEach(
            retries,
            ([key, retry]) =>
              retry.retry.pipe(
                Effect.catch((error) =>
                  Effect.sync(() =>
                    console.error(`Pardes failed queued lifecycle retry ${key}.`, error),
                  ),
                ),
              ),
            { discard: true },
          ),
        )
        .pipe(Effect.andThen(this.drainPendingLifecycleRetries()));
    });
  }

  private withLifecycleTransition<A, E, R>(
    operation: (epoch: number) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.suspend(() => {
      const epoch = ++this.lifecycleEpoch;
      this.pendingLifecycleRetries.clear();
      this.lifecycleAcceptingOperations = false;
      this.lifecycleTransitioning = true;
      return this.lifecycleGate.withPermit(operation(epoch)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.lifecycleEpoch === epoch) this.lifecycleTransitioning = false;
          }),
        ),
      );
    });
  }

  private reopenLifecycle(epoch: number): void {
    if (this.lifecycleEpoch !== epoch) return;
    this.lifecycleAcceptingOperations = true;
  }

  readonly inspectStorage = Effect.fnUntraced(function* (this: ManagerController) {
    const active = yield* this.requireActive();
    return yield* active.store.inspectStorage();
  });

  readonly inspectGitHubIntegrationHealth = Effect.fnUntraced(function* (this: ManagerController) {
    const active = yield* this.requireActive();
    return yield* this.githubIntegrationHealth.inspect({
      cwd: active.repo.primaryCheckout,
      pullRequests: Object.values(active.state.pullRequests)
        .filter((pullRequest) => pullRequest.status === 'open')
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((pullRequest) => ({
          id: pullRequest.id,
          url: pullRequest.url,
          ...(pullRequest.number === undefined ? {} : { number: pullRequest.number }),
          ...(pullRequest.lastPushedHeadSha === undefined
            ? {}
            : { lastPushedHeadSha: pullRequest.lastPushedHeadSha }),
          ...(pullRequest.headBranch === undefined ? {} : { headBranch: pullRequest.headBranch }),
          ...(pullRequest.watcherFailure === undefined
            ? {}
            : { watcherFailure: pullRequest.watcherFailure }),
        })),
    });
  });

  private render(ctx = this.latestContext): void {
    if (!ctx) return;
    if (this.active)
      this.presentation.updateDashboard(
        ctx,
        this.active.state,
        this.liveRuntimes,
        this.compactionSafety,
        this.githubHostedMetadata.compactStatusUnsafe(),
      );
    else this.presentation.clearDashboard(ctx);
  }

  private stopObservingCompactionAbort(): void {
    this.compactionAbortCleanup?.();
    this.compactionAbortCleanup = undefined;
  }

  private cancelCompactionExpiry(): void {
    this.compactionExpiryCleanup?.();
    this.compactionExpiryCleanup = undefined;
  }

  private cancelCompactionSuccessSettlement(): void {
    this.compactionSuccessSettlementCleanup?.();
    this.compactionSuccessSettlementCleanup = undefined;
  }

  private clearCompactionSafety(): void {
    this.stopObservingCompactionAbort();
    this.cancelCompactionExpiry();
    this.cancelCompactionSuccessSettlement();
    this.compactionSafety = undefined;
  }

  /** Clear one owned hold and request at most one still-relevant durable cursor. */
  private resumeHeldInboxWake(generation: number, ctx = this.latestContext): void {
    if (this.compactionSafety?.generation !== generation) return;
    this.clearCompactionSafety();
    this.render(ctx);
    if (ctx) this.scheduleInboxWakeAfterIdle(ctx);
  }

  private scheduleCompactionExpiry(generation: number, ctx = this.latestContext): void {
    this.cancelCompactionExpiry();
    this.compactionExpiryCleanup = this.compactionSafetyScheduler.schedule(
      MANAGER_COMPACTION_SAFETY_EXPIRY_MS,
      () => {
        if (this.compactionSafety?.generation !== generation) return;
        this.compactionExpiryCleanup = undefined;
        // Best-effort residual-risk fallback only: Pi 0.75.5 has no public
        // compaction_end / isCompacting API, so an abort, failure, or stall cannot
        // be distinguished from a still-running compaction. Never shorten this
        // bound or turn it into a loop. TODO: replace this expiry with upstream
        // extension-facing compaction_end / isCompacting when Pi exposes them.
        this.resumeHeldInboxWake(generation, ctx);
      },
    );
  }

  /** Mark the earliest compaction point observable through Pi's public extension API. */
  observeCompactionStart(signal: AbortSignal, ctx = this.latestContext): boolean {
    if (!this.active) return false;
    this.clearCompactionSafety();
    const marker: ManagerCompactionSafetySnapshot = {
      generation: ++this.nextCompactionGeneration,
      phase: 'started_unsettled',
    };
    this.compactionSafety = marker;
    const onAbort = () => {
      if (this.compactionSafety?.generation !== marker.generation) return;
      this.stopObservingCompactionAbort();
      this.compactionSafety = { ...marker, phase: 'aborted_unsettled' };
      this.render(ctx);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.compactionAbortCleanup = () => signal.removeEventListener('abort', onAbort);
    this.scheduleCompactionExpiry(marker.generation, ctx);
    if (signal.aborted) onAbort();
    this.render(ctx);
    return true;
  }

  /**
   * Pi 0.75.5 awaits extension `session_compact` handlers, then synchronously
   * emits its internal `compaction_end` and clears the compaction controller in
   * `finally` before timers run. The next macrotask is therefore the clean-ish
   * public success recovery edge. Generation ownership prevents stale callbacks
   * from clearing a newer hold. TODO: replace this heuristic with upstream
   * extension-facing `compaction_end` / `isCompacting` when Pi exposes them.
   */
  observeCompactionSuccess(ctx = this.latestContext): boolean {
    const marker = this.compactionSafety;
    if (!marker) return false;
    this.stopObservingCompactionAbort();
    this.compactionSafety = { ...marker, phase: 'succeeded_unsettled' };
    this.cancelCompactionSuccessSettlement();
    this.compactionSuccessSettlementCleanup = this.compactionSafetyScheduler.schedule(0, () => {
      if (this.compactionSafety?.generation !== marker.generation) return;
      this.compactionSuccessSettlementCleanup = undefined;
      this.resumeHeldInboxWake(marker.generation, ctx);
    });
    this.render(ctx);
    return true;
  }

  private readonly appendEventSafely = Effect.fnUntraced(function* (
    this: ManagerController,
    store: StateStoreShape,
    event: ManagerEvent,
  ) {
    yield* store.appendEvent(event).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(`Pardes failed to append manager event ${event.type}`, error);
        }),
      ),
    );
  });

  private cancelScheduledInboxWakeRelease(): void {
    if (this.inboxWakeReleaseTimer === undefined) return;
    clearTimeout(this.inboxWakeReleaseTimer);
    this.inboxWakeReleaseTimer = undefined;
  }

  /**
   * Pi keeps `ctx.isIdle()` false until awaited `agent_end` handlers settle. Queue
   * one macrotask from that hook rather than enqueueing one irreversible Pi
   * follow-up per durable event while the manager is busy. A compaction hold
   * prevents even scheduling this delivery. Clean-ish success recovery and the
   * bounded fallback each clear their own generation before calling this method;
   * loaded/rebound `session_start` also retries from restored durable state.
   */
  scheduleInboxWakeAfterIdle(ctx: ExtensionContext): void {
    const state = this.active?.state;
    if (
      this.compactionSafety ||
      !state ||
      state.inbox.length === 0 ||
      retainCurrentInboxWake(state.inbox, state.inboxWake) ||
      this.inboxWakeReleaseTimer !== undefined
    )
      return;
    this.inboxWakeReleaseTimer = setTimeout(() => {
      this.inboxWakeReleaseTimer = undefined;
      Effect.runPromise(this.releaseInboxWake(ctx)).catch((error) => {
        console.error('Pardes failed to release a manager inbox wake after idle.', error);
      });
    }, 0);
  }

  /**
   * Release at most one durable, tokenized Pi wake for the currently unpresented
   * inbox batch. Holds return before minting a durable presentation cursor, so a
   * later restore can retry. Recovery never acknowledges inbox rows. They remain
   * authoritative even after a cursor is minted: UI status and model tools
   * continue to expose pending attention until explicit acknowledgement.
   */
  readonly releaseInboxWake = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx = this.latestContext,
  ) {
    const active = this.active;
    if (
      this.compactionSafety ||
      !active ||
      !ctx ||
      active.state.inbox.length === 0 ||
      retainCurrentInboxWake(active.state.inbox, active.state.inboxWake)
    )
      return false;
    if (!ctx.isIdle()) return false;
    const timestamp = yield* nowIso;
    const release = yield* active.store.mutate<InboxWakeRelease | undefined, never>((state) => {
      const retainedWake = retainCurrentInboxWake(state.inbox, state.inboxWake);
      if (state.inbox.length === 0 || retainedWake)
        return Effect.succeed([undefined, state] as const);
      const wake = makeInboxWake(state.managerId, state.inbox, timestamp);
      if (!wake) return Effect.succeed([undefined, withInbox(state, state.inbox)] as const);
      return Effect.succeed([
        { inbox: state.inbox, wake },
        { ...withInbox(state, state.inbox), inboxWake: wake },
      ] as const);
    });
    yield* this.refreshActiveState(active, ctx);
    if (!release || this.active !== active) return false;
    const coveredCount =
      inboxThroughCursor(release.inbox, release.wake.cursor)?.length ?? release.wake.pendingCount;
    const queuedSuffixCount = Math.max(0, release.inbox.length - coveredCount);
    yield* this.appendEventSafely(
      active.store,
      makeEvent(
        'inbox_wake_released',
        `Released ${release.wake.token} for ${coveredCount} durable inbox event${coveredCount === 1 ? '' : 's'} through cursor ${release.wake.cursor}; ${queuedSuffixCount} queued suffix event${queuedSuffixCount === 1 ? '' : 's'}.`,
        timestamp,
      ),
    );
    this.pi.sendMessage(renderInboxWakeMessage(release), {
      deliverAs: 'followUp',
      triggerTurn: true,
    });
    return true;
  });

  private readonly refreshActiveState = Effect.fnUntraced(function* (
    this: ManagerController,
    active: PullRequestPublicationNamespace,
    ctx?: ExtensionContext,
  ) {
    const state = yield* active.store.load();
    yield* validateManagerStateNamespace(active, state);
    active.state = state;
    this.render(ctx);
  });

  private readonly makePullRequests = Effect.fnUntraced(function* (
    this: ManagerController,
    active: PullRequestPublicationNamespace,
    reviewGates: ReviewGateLifecycleCoordinatorShape,
  ) {
    return yield* makePullRequestPublicationCoordinator({
      callbacks: {
        appendEventSafely: (event) => this.appendEventSafely(active.store, event),
        observePublishedTerminal: (event) =>
          reviewGates
            .observePublishedTerminal(event)
            .pipe(
              Effect.catch(() =>
                Effect.sync(() =>
                  console.error('Pardes failed to route published terminal pull-request metadata.'),
                ),
              ),
            ),
        reconcilePullRequestsSafely: () => this.reconcilePullRequestsSafely(),
        refresh: (ctx) => this.refreshActiveState(active, ctx),
        releaseInboxWake: () => this.releaseInboxWake(),
      },
      github: this.github,
      namespace: active,
      worktrees: this.worktrees,
    });
  });

  private makeAttachments(
    active: PullRequestPublicationNamespace,
  ): AgentAttachmentLifecycleCoordinatorShape {
    return makeAgentAttachmentLifecycleCoordinator({
      callbacks: {
        appendEventSafely: (event) => this.appendEventSafely(active.store, event),
        defaultModel: (ctx) => (ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
        defaultThinkingLevel: () => this.pi.getThinkingLevel(),
        forgetRuntime: (agentId) => {
          this.liveRuntimes.delete(agentId);
        },
        recordRuntime: (agentId, runtime) => {
          this.liveRuntimes.set(agentId, runtime);
        },
        refresh: (ctx) => this.refreshActiveState(active, ctx),
        render: () => this.render(),
        resumeWorkerEvents: (agentId) => {
          this.ignoredWorkerEvents.delete(agentId);
        },
        suppressWorkerEvents: (agentId) => {
          this.ignoredWorkerEvents.add(agentId);
        },
      },
      namespace: active,
      workers: this.workers,
      worktrees: this.worktrees,
    });
  }

  private readonly makeReviewGates = Effect.fnUntraced(function* (
    this: ManagerController,
    active: PullRequestPublicationNamespace,
    attachments: AgentAttachmentLifecycleCoordinatorShape,
    verifications: VerificationLifecycleCoordinatorShape,
  ) {
    return yield* makeReviewGateLifecycleCoordinator({
      callbacks: {
        appendEventSafely: (event) => this.appendEventSafely(active.store, event),
        auditAutoStop: (agent) => attachments.auditHandoffBestEffort(agent, 'auto_stop'),
        githubRateLimitSymptomOwnership: this.githubRateLimitSymptomOwnership,
        liveRuntimes: () => this.liveRuntimes,
        recordStoppedRuntime: (agentId, runtime) => {
          this.liveRuntimes.set(agentId, runtime);
        },
        refresh: () => this.refreshActiveState(active),
        releaseInboxWake: () => this.releaseInboxWake(),
        retireResolvedVerificationsForSource: (sourceAgentId) =>
          verifications.retireResolvedForSource(sourceAgentId),
        stopIdleWorker: (agentId) => this.workers.stopIfIdle(agentId),
        trySerializeWorkstreamCompletion: (retryKey, effect, retry) =>
          this.tryWithActiveLifecyclePermit(active, retryKey, effect, retry),
      },
      namespace: active,
    });
  });

  private readonly makeVerifications = Effect.fnUntraced(function* (
    this: ManagerController,
    active: PullRequestPublicationNamespace,
  ) {
    return yield* makeVerificationLifecycleCoordinator({
      callbacks: {
        appendEventSafely: (event) => this.appendEventSafely(active.store, event),
        defaultModel: (ctx) => (ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
        defaultThinkingLevel: () => this.pi.getThinkingLevel(),
        forgetRuntime: (agentId) => {
          this.liveRuntimes.delete(agentId);
        },
        recordRuntime: (agentId, runtime) => {
          this.liveRuntimes.set(agentId, runtime);
        },
        refresh: (ctx) => this.refreshActiveState(active, ctx),
        releaseInboxWake: () => this.releaseInboxWake(),
        requirePinnedWorkerExtensionPath: () =>
          this.requirePinnedChildRuntime('agent_spawn').pipe(
            Effect.map((snapshot) => snapshot.workerExtensionPath),
          ),
        resumeWorkerEvents: (agentId) => {
          this.ignoredWorkerEvents.delete(agentId);
        },
        suppressWorkerEvents: (agentId) => {
          this.ignoredWorkerEvents.add(agentId);
        },
      },
      namespace: active,
      workers: this.workers,
      worktrees: this.worktrees,
    });
  });

  private readonly makeWorkerEvents = Effect.fnUntraced(function* (
    this: ManagerController,
    active: PullRequestPublicationNamespace,
    reporting: ReportingShape,
    attachments: AgentAttachmentLifecycleCoordinatorShape,
    pullRequests: PullRequestPublicationCoordinatorShape,
    reviewGates: ReviewGateLifecycleCoordinatorShape,
    verifications: VerificationLifecycleCoordinatorShape,
  ) {
    return yield* makeWorkerSupervisorEventCoordinator({
      attachments,
      callbacks: {
        appendEventSafely: (event) => this.appendEventSafely(active.store, event),
        isSuppressed: (agentId) => this.ignoredWorkerEvents.has(agentId),
        reconcileVerificationsForSource: (agentId) => verifications.reconcileForSource(agentId),
        refresh: () => this.refreshActiveState(active),
        releaseInboxWake: () => this.releaseInboxWake(),
        render: () => this.render(),
        retryResolvedVerificationRetirementForIdleVerifier: (agentId) =>
          verifications.retryResolvedRetirementForIdleVerifier(agentId),
        serializeVerificationMutation: (effect) => verifications.serializeMutation(effect),
      },
      liveRuntimes: this.liveRuntimes,
      namespace: active,
      pullRequests,
      reporting,
      reviewGates,
    });
  });

  private readonly reconcilePullRequestsSafely = Effect.fnUntraced(function* (
    this: ManagerController,
  ) {
    yield* this.githubWatcher
      .reconcile()
      .pipe(
        Effect.catch(() =>
          Effect.sync(() => console.error('Pardes failed to reconcile published pull requests.')),
        ),
      );
  });

  private readonly stopAttachedWorkers = Effect.fnUntraced(function* (
    this: ManagerController,
    active: ActiveManager,
  ) {
    yield* this.workers.shutdown();
    this.liveRuntimes.clear();
    this.ignoredWorkerEvents.clear();
    const timestamp = yield* nowIso;
    const stateBeforeRetirement = yield* active.store.load();
    yield* validateManagerStateNamespace(active, stateBeforeRetirement);
    active.state = stateBeforeRetirement;
    const hasAttached = Object.values(stateBeforeRetirement.agents).some((agent) =>
      ATTACHED_STATUSES.has(agent.status),
    );
    if (!hasAttached) return;
    yield* active.store.mutate((state) => {
      const attachedAgentIds = new Set(
        Object.values(state.agents)
          .filter((agent) => ATTACHED_STATUSES.has(agent.status))
          .map((agent) => agent.id),
      );
      return Effect.succeed([
        undefined,
        {
          ...state,
          agents: Object.fromEntries(
            Object.entries(state.agents).map(([id, agent]) => [
              id,
              attachedAgentIds.has(id)
                ? { ...agent, status: 'stopped' as const, updatedAt: timestamp }
                : agent,
            ]),
          ),
          verifications: Object.fromEntries(
            Object.entries(state.verifications).map(([id, verification]) => [
              id,
              attachedAgentIds.has(verification.verifierAgentId)
                ? updateCurrentVerificationAttempt(
                    { ...verification, updatedAt: timestamp },
                    (attempt) => ({ ...attempt, status: 'stopped' as const, updatedAt: timestamp }),
                  )
                : verification,
            ]),
          ),
        },
      ] as const);
    });
    const state = yield* active.store.load();
    yield* validateManagerStateNamespace(active, state);
    active.state = state;
    this.render();
  });

  private readonly activateUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx: ExtensionContext,
  ) {
    if (this.active)
      return yield* new ManagerAlreadyActiveError({ managerId: this.active.state.managerId });
    this.clearCompactionSafety();
    const repo = yield* discoverRepository(ctx.cwd);
    yield* this.githubHostedMetadata
      .ensureControllerScope(repo.primaryCheckout)
      .pipe(
        Effect.mapError(() =>
          invalidManagedState(
            'loaded controller is pinned to another GitHub.com repository context; reload the manager extension to create a fresh controller',
          ),
        ),
      );
    const managerId = randomUUID();
    const directory = managerDirectory(repo, managerId);
    const state = initialManagerState(managerId, repo);
    const store = yield* makeFileSystemStateStore(directory);
    yield* store.initialize(state);
    yield* this.activationSafety.materialize(directory);
    const active: PullRequestPublicationNamespace = { managerId, repo, state, store };
    const attachments = this.makeAttachments(active);
    const reporting = makeReporting(store);
    const verifications = yield* this.makeVerifications(active);
    const reviewGates = yield* this.makeReviewGates(active, attachments, verifications);
    const pullRequests = yield* this.makePullRequests(active, reviewGates);
    const workerEvents = yield* this.makeWorkerEvents(
      active,
      reporting,
      attachments,
      pullRequests,
      reviewGates,
      verifications,
    );
    this.active = Object.assign(active, {
      attachments,
      pullRequests,
      reporting,
      reviewGates,
      verifications,
      workerEvents,
    });
    this.latestContext = ctx;
    this.pi.appendEntry(SESSION_ENTRY_TYPE, {
      enabled: true,
      managerId,
      stateDir: directory,
    } satisfies ManagerActivation);
    this.render(ctx);
    yield* this.githubWatcher.start(reviewGates.watcherCallbacks);
    return state;
  });

  private readonly disarmInboxHandoffForLifecycleStop = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx?: ExtensionContext,
  ) {
    const state = yield* this.refresh(ctx).pipe(Effect.exit);
    if (Exit.isFailure(state)) {
      console.error(
        `Pardes failed to disarm inbox handoff during lifecycle stop; continuing teardown: ${boundedFailureSummary(Cause.squash(state.cause))}`,
      );
      return false;
    }
    const wake = retainCurrentInboxWake(state.value.inbox, state.value.inboxWake);
    const handoff = retainCurrentInboxHandoff(state.value.inbox, wake, state.value.inboxHandoff);
    // Tokenless restored markers are intentionally ambiguous. Keep them inert
    // until explicit manager acknowledgement or a fresh identified surface.
    if (!wake || !handoff?.token) return false;
    const disarmed = yield* this.disarmInboxHandoff(
      {
        cursor: handoff.cursor,
        surfacedAt: handoff.surfacedAt,
        token: handoff.token,
        wakeToken: wake.token,
      },
      ctx,
    ).pipe(Effect.exit);
    if (Exit.isFailure(disarmed)) {
      console.error(
        `Pardes failed to disarm inbox handoff during lifecycle stop; continuing teardown: ${boundedFailureSummary(Cause.squash(disarmed.cause))}`,
      );
      return false;
    }
    return disarmed.value;
  });

  readonly activate = (ctx: ExtensionContext) =>
    Effect.gen(
      function* (this: ManagerController) {
        if (this.active)
          return yield* new ManagerAlreadyActiveError({ managerId: this.active.state.managerId });
        if (this.lifecycleTransitioning) return yield* this.lifecycleUnavailable();
        return yield* this.withLifecycleTransition((epoch) =>
          this.activateUnlocked(ctx).pipe(
            Effect.tap(() => Effect.sync(() => this.reopenLifecycle(epoch))),
          ),
        );
      }.bind(this),
    );

  private readonly deactivateUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx: ExtensionContext,
  ) {
    const active = yield* this.requireActive();
    this.cancelScheduledInboxWakeRelease();
    this.clearCompactionSafety();
    yield* this.disarmInboxHandoffForLifecycleStop(ctx);
    yield* this.githubWatcher.stop();
    yield* this.stopAttachedWorkers(active);
    this.pi.appendEntry(SESSION_ENTRY_TYPE, {
      enabled: false,
      managerId: active.state.managerId,
    } satisfies ManagerActivation);
    this.active = undefined;
    this.latestContext = ctx;
    this.render(ctx);
  });

  readonly deactivate = (ctx: ExtensionContext) =>
    this.withLifecycleTransition(() => this.deactivateUnlocked(ctx));

  private readonly shutdownUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx?: ExtensionContext,
  ) {
    if (ctx) this.latestContext = ctx;
    this.cancelScheduledInboxWakeRelease();
    this.clearCompactionSafety();
    if (this.active) yield* this.disarmInboxHandoffForLifecycleStop(ctx);
    yield* this.githubWatcher.stop();
    if (!this.active) {
      yield* this.workers.shutdown();
      this.liveRuntimes.clear();
      this.ignoredWorkerEvents.clear();
      return;
    }
    yield* this.stopAttachedWorkers(this.active);
  });

  readonly shutdown = (ctx?: ExtensionContext) =>
    this.withLifecycleTransition(() => this.shutdownUnlocked(ctx));

  private readonly restoreUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx: ExtensionContext,
  ) {
    this.cancelScheduledInboxWakeRelease();
    this.clearCompactionSafety();
    this.latestContext = ctx;
    yield* this.githubWatcher.stop();
    if (this.active) yield* this.stopAttachedWorkers(this.active);
    else {
      yield* this.workers.shutdown();
      this.liveRuntimes.clear();
      this.ignoredWorkerEvents.clear();
    }
    const activation = latestActivation(ctx);
    if (!activation?.enabled || !activation.stateDir) {
      this.active = undefined;
      this.render(ctx);
      return undefined;
    }
    if (!activation.managerId || !isNamespaceSegment(activation.managerId)) {
      return yield* invalidManagedState('manager activation namespace is invalid');
    }
    const repo = yield* discoverRepository(ctx.cwd);
    yield* this.githubHostedMetadata
      .ensureControllerScope(repo.primaryCheckout)
      .pipe(
        Effect.mapError(() =>
          invalidManagedState(
            'loaded controller is pinned to another GitHub.com repository context; reload the manager extension to create a fresh controller',
          ),
        ),
      );
    if (activation.stateDir !== managerDirectory(repo, activation.managerId)) {
      return yield* invalidManagedState(
        'manager state directory does not match its activation namespace',
      );
    }
    const store = yield* makeFileSystemStateStore(activation.stateDir);
    const namespace = { managerId: activation.managerId, repo, store };
    let state = yield* store.load();
    yield* validateManagerStateNamespace(namespace, state);
    const retainedWake = retainCurrentInboxWake(state.inbox, state.inboxWake);
    const retainedHandoff = retainCurrentInboxHandoff(
      state.inbox,
      retainedWake,
      state.inboxHandoff,
    );
    if (retainedWake !== state.inboxWake || retainedHandoff !== state.inboxHandoff) {
      yield* store.mutate((current) =>
        Effect.succeed([undefined, withInbox(current, current.inbox)] as const),
      );
      state = yield* store.load();
      yield* validateManagerStateNamespace(namespace, state);
    }
    yield* this.activationSafety.materialize(activation.stateDir);
    const detached = Object.values(state.agents).filter((agent) =>
      ATTACHED_STATUSES.has(agent.status),
    );
    if (detached.length > 0) {
      const timestamp = yield* nowIso;
      const detachedAttention = detached.map((agent) =>
        makeEvent(
          'agent_detached',
          `${agent.id} runtime is detached after manager restoration.`,
          timestamp,
          { agentId: agent.id, workstreamId: agent.workstreamId },
        ),
      );
      yield* store.mutate((current) =>
        Effect.succeed([
          undefined,
          {
            ...current,
            agents: Object.fromEntries(
              Object.entries(current.agents).map(([id, agent]) => [
                id,
                ATTACHED_STATUSES.has(agent.status)
                  ? {
                      ...agent,
                      lastError: 'Worker runtime is not attached to this manager process.',
                      status: 'crashed' as const,
                      updatedAt: timestamp,
                    }
                  : agent,
              ]),
            ),
            inbox: [...current.inbox, ...detachedAttention],
            verifications: Object.fromEntries(
              Object.entries(current.verifications).map(([id, verification]) => [
                id,
                detached.some((agent) => agent.id === verification.verifierAgentId)
                  ? updateCurrentVerificationAttempt(
                      { ...verification, updatedAt: timestamp },
                      (attempt) => ({
                        ...attempt,
                        status: 'crashed' as const,
                        updatedAt: timestamp,
                      }),
                    )
                  : verification,
              ]),
            ),
          },
        ] as const),
      );
      for (const attention of detachedAttention) yield* this.appendEventSafely(store, attention);
      yield* this.appendEventSafely(
        store,
        makeEvent(
          'agents_detached',
          `Marked ${detached.length} detached worker runtime${detached.length === 1 ? '' : 's'} as crashed.`,
          timestamp,
        ),
      );
      state = yield* store.load();
      yield* validateManagerStateNamespace(namespace, state);
    }
    const activeNamespace: PullRequestPublicationNamespace = { ...namespace, state };
    const attachments = this.makeAttachments(activeNamespace);
    const reporting = makeReporting(store);
    const verifications = yield* this.makeVerifications(activeNamespace);
    const reviewGates = yield* this.makeReviewGates(activeNamespace, attachments, verifications);
    const pullRequests = yield* this.makePullRequests(activeNamespace, reviewGates);
    const workerEvents = yield* this.makeWorkerEvents(
      activeNamespace,
      reporting,
      attachments,
      pullRequests,
      reviewGates,
      verifications,
    );
    const active = Object.assign(activeNamespace, {
      attachments,
      pullRequests,
      reporting,
      reviewGates,
      verifications,
      workerEvents,
    });
    this.active = active;
    this.render(ctx);
    yield* reviewGates.retirePersistedMergedPullRequests();
    yield* this.githubWatcher.start(reviewGates.watcherCallbacks);
    return active.state;
  });

  readonly restore = (ctx: ExtensionContext) =>
    this.withLifecycleTransition((epoch) =>
      this.restoreUnlocked(ctx).pipe(
        Effect.tap((state) =>
          Effect.sync(() => {
            if (state) this.reopenLifecycle(epoch);
          }),
        ),
      ),
    );

  readonly refresh = Effect.fnUntraced(function* (this: ManagerController, ctx?: ExtensionContext) {
    const active = yield* this.requireActive();
    const state = yield* active.store.load();
    yield* validateManagerStateNamespace(active, state);
    active.state = state;
    this.render(ctx);
    return active.state;
  });

  readonly createWorkstream = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: { readonly title: string; readonly objective: string },
    ctx?: ExtensionContext,
  ) {
    const input = yield* decodeWorkstreamCreateInput(rawInput);
    const active = yield* this.requireActive();
    const timestamp = yield* nowIso;
    const workstream: Workstream = {
      createdAt: timestamp,
      id: `ws-${randomUUID().slice(0, 8)}`,
      objective: input.objective,
      status: 'planned',
      title: input.title,
      updatedAt: timestamp,
    };
    yield* active.store.mutate((state) =>
      Effect.succeed([
        undefined,
        { ...state, workstreams: { ...state.workstreams, [workstream.id]: workstream } },
      ] as const),
    );
    yield* this.appendEventSafely(
      active.store,
      makeEvent('workstream_created', `Created ${workstream.id}: ${workstream.title}`, timestamp),
    );
    yield* this.refreshActiveState(active, ctx);
    return workstream;
  });

  readonly listWorkstreams = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx?: ExtensionContext,
  ) {
    const state = yield* this.refresh(ctx);
    return Object.values(state.workstreams).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  });

  readonly getWorkstream = Effect.fnUntraced(function* (
    this: ManagerController,
    rawWorkstreamId: string,
    ctx?: ExtensionContext,
  ) {
    const { workstreamId } = yield* decodeWorkstreamIdInput({ workstreamId: rawWorkstreamId });
    const state = yield* this.refresh(ctx);
    const workstream = state.workstreams[workstreamId];
    if (!workstream) return yield* new WorkstreamNotFoundError({ workstreamId });
    return workstream;
  });

  private readonly completeWorkstreamUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawWorkstreamId: string,
    ctx?: ExtensionContext,
  ) {
    const { workstreamId } = yield* decodeWorkstreamIdInput({ workstreamId: rawWorkstreamId });
    const active = yield* this.requireActive();
    const state = yield* this.refresh(ctx);
    const workstream = state.workstreams[workstreamId];
    if (!workstream) return yield* new WorkstreamNotFoundError({ workstreamId });
    const reject = (reason: string) =>
      new WorkstreamCompletionRejectedError({ reason, workstreamId });
    if (
      Object.values(state.pullRequests).some(
        (pullRequest) => pullRequest.workstreamId === workstreamId && pullRequest.status === 'open',
      )
    ) {
      return yield* reject('an unresolved open review gate still requires retained ownership');
    }
    const attachedChildren = Object.values(state.agents)
      .filter((agent) => {
        if (agent.workstreamId !== workstreamId) return false;
        const runtime = this.liveRuntimes.get(agent.id);
        return (
          ATTACHED_STATUSES.has(agent.status) ||
          (runtime !== undefined && ATTACHED_STATUSES.has(runtime.status))
        );
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const busyChild = attachedChildren.find((agent) => {
      const status = this.liveRuntimes.get(agent.id)?.status ?? agent.status;
      return status !== 'idle' && status !== 'stopped' && status !== 'crashed';
    });
    if (busyChild)
      return yield* reject(
        `attached child ${busyChild.id} is not safely idle; no busy child was interrupted`,
      );
    for (const agent of attachedChildren) {
      const stopped = yield* (
        agent.role === 'verifier'
          ? active.verifications.stopIdleForWorkstreamCompletion(agent.id, ctx)
          : active.attachments
              .stopIfIdleForWorkstreamCompletion(agent.id, ctx)
              .pipe(Effect.map((record) => record !== undefined))
      ).pipe(
        Effect.mapError(() =>
          reject(
            `attached child ${agent.id} could not be safely stopped; retained artifacts were preserved`,
          ),
        ),
      );
      if (!stopped)
        return yield* reject(
          `attached child ${agent.id} is not safely idle; no busy child was interrupted`,
        );
    }
    const timestamp = yield* nowIso;
    const transitioned = yield* active.store.mutate((current) => {
      const currentWorkstream = current.workstreams[workstreamId] ?? workstream;
      if (
        Object.values(current.pullRequests).some(
          (pullRequest) =>
            pullRequest.workstreamId === workstreamId && pullRequest.status === 'open',
        )
      ) {
        return Effect.fail(
          reject('an unresolved open review gate still requires retained ownership'),
        );
      }
      if (currentWorkstream.status === 'complete') return Effect.succeed([false, current] as const);
      return Effect.succeed([
        true,
        {
          ...current,
          workstreams: {
            ...current.workstreams,
            [workstreamId]: { ...currentWorkstream, status: 'complete', updatedAt: timestamp },
          },
        },
      ] as const);
    });
    if (transitioned) {
      yield* this.appendEventSafely(
        active.store,
        makeEvent(
          'workstream_completed',
          `Completed ${workstreamId}: ${workstream.title}. Safely stopped ${attachedChildren.length} idle attached child${attachedChildren.length === 1 ? '' : 'ren'}; retained artifacts and review history preserved.`,
          timestamp,
        ),
      );
    }
    yield* this.refreshActiveState(active, ctx);
    const completed = active.state.workstreams[workstreamId];
    if (!completed) return yield* new WorkstreamNotFoundError({ workstreamId });
    return completed;
  });

  readonly completeWorkstream = (rawWorkstreamId: string, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.completeWorkstreamUnlocked(rawWorkstreamId, ctx));

  /** Persist that the one delivered cursor was explicitly surfaced for user feedback. */
  readonly beginInboxHandoff = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx?: ExtensionContext,
  ) {
    const active = yield* this.requireActive();
    const state = yield* this.refresh(ctx);
    const wake = retainCurrentInboxWake(state.inbox, state.inboxWake);
    if (!wake)
      return yield* new InboxHandoffUnavailableError({
        reason: state.inboxWake ? 'stale_delivered_cursor' : 'no_delivered_cursor',
      });
    const timestamp = yield* nowIso;
    const handoff: InboxHandoffStart = {
      cursor: wake.cursor,
      surfacedAt: timestamp,
      token: randomUUID(),
      wakeToken: wake.token,
    };
    yield* active.store.mutate((current) => {
      const retainedWake = retainCurrentInboxWake(current.inbox, current.inboxWake);
      if (retainedWake?.cursor !== wake.cursor)
        return Effect.fail(new InboxHandoffUnavailableError({ reason: 'stale_delivered_cursor' }));
      return Effect.succeed([
        undefined,
        {
          ...withInbox(current, current.inbox),
          inboxHandoff: {
            cursor: handoff.cursor,
            surfacedAt: handoff.surfacedAt,
            token: handoff.token,
          },
        },
      ] as const);
    });
    yield* this.appendEventSafely(
      active.store,
      makeEvent(
        'inbox_handoff_surfaced',
        `Surfaced delivered inbox cursor ${wake.cursor} for explicit user feedback.`,
        timestamp,
      ),
    );
    yield* this.refreshActiveState(active, ctx);
    return handoff;
  });

  /** Disarm only the exact surfaced dialog marker without consuming its delivered cursor or inbox rows. */
  readonly disarmInboxHandoff = Effect.fnUntraced(function* (
    this: ManagerController,
    handoff: InboxHandoffStart,
    ctx?: ExtensionContext,
  ) {
    const active = yield* this.requireActive();
    const disarmed = yield* active.store.mutate<boolean, never>((current) => {
      const next = withInbox(current, current.inbox);
      if (!isSameInboxHandoff(next.inboxHandoff, handoff))
        return Effect.succeed([false, next] as const);
      const { inboxHandoff: _inboxHandoff, ...withoutHandoff } = next;
      return Effect.succeed([true, withoutHandoff] as const);
    });
    yield* this.refreshActiveState(active, ctx);
    return disarmed;
  });

  /**
   * Consume only one explicit through-cursor. The default is the currently
   * delivered wake cursor; callers handling an unpresented row autonomously may
   * supply the exact cursor they inspected. Rows appended behind that cursor are
   * never consumed by the same acknowledgement.
   */
  readonly acknowledgeInbox = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx?: ExtensionContext,
    options: AcknowledgeInboxOptions = {},
  ) {
    const active = yield* this.requireActive();
    const { cursor: requestedCursor } = yield* decodeInboxAcknowledgeInput(
      options.cursor === undefined ? {} : { cursor: options.cursor },
    );
    const reason = options.reason ?? 'manager_acknowledged';
    const state = yield* this.refresh(ctx);
    const cursor = requestedCursor ?? retainCurrentInboxWake(state.inbox, state.inboxWake)?.cursor;
    if (!cursor)
      return {
        acknowledgedCount: 0,
        pendingCount: state.inbox.length,
        queuedSuffixCount: 0,
        reason,
        staleCursor: false,
      } satisfies InboxAcknowledgement;
    const timestamp = yield* nowIso;
    const acknowledgement = yield* active.store.mutate<InboxAcknowledgement, never>((current) => {
      const retainedWake = retainCurrentInboxWake(current.inbox, current.inboxWake);
      const retainedHandoff = retainCurrentInboxHandoff(
        current.inbox,
        retainedWake,
        current.inboxHandoff,
      );
      const attention = projectInboxAttention(
        current.inbox,
        retainedWake,
        retainedHandoff,
        Date.parse(timestamp),
      );
      const deliveredAge =
        attention.deliveredCursorAgeMs === undefined
          ? {}
          : { deliveredCursorAgeMs: attention.deliveredCursorAgeMs };
      const covered = inboxThroughCursor(current.inbox, cursor);
      const eligible =
        covered !== undefined &&
        !covered.some((event) => event.presentationBlocked === true) &&
        (retainedWake === undefined || retainedWake.cursor === cursor) &&
        (options.handoff === undefined ||
          (retainedWake?.cursor === cursor &&
            isSameInboxHandoff(retainedHandoff, options.handoff)));
      if (!eligible) {
        return Effect.succeed([
          {
            acknowledgedCount: 0,
            pendingCount: current.inbox.length,
            queuedSuffixCount: attention.queuedSuffixCount,
            ...deliveredAge,
            cursor,
            reason,
            staleCursor: true,
          },
          withInbox(current, current.inbox),
        ] as const);
      }
      return Effect.succeed([
        {
          acknowledgedCount: covered.length,
          pendingCount: current.inbox.length - covered.length,
          queuedSuffixCount: current.inbox.length - covered.length,
          ...deliveredAge,
          cursor,
          reason,
          staleCursor: false,
        },
        withInbox(current, current.inbox.slice(covered.length)),
      ] as const);
    });
    if (acknowledgement.acknowledgedCount > 0) {
      yield* this.appendEventSafely(
        active.store,
        makeEvent(
          'inbox_cursor_acknowledged',
          `Acknowledged ${acknowledgement.acknowledgedCount} inbox event${acknowledgement.acknowledgedCount === 1 ? '' : 's'} through cursor ${cursor} (${reason}); ${acknowledgement.queuedSuffixCount} queued suffix event${acknowledgement.queuedSuffixCount === 1 ? '' : 's'}.`,
          timestamp,
        ),
      );
    }
    yield* this.refreshActiveState(active, ctx);
    const wakeContext = ctx ?? this.latestContext;
    if (options.releaseSuccessor === false) {
      if (wakeContext) this.scheduleInboxWakeAfterIdle(wakeContext);
    } else {
      const released = yield* this.releaseInboxWake(ctx);
      if (!released && wakeContext) this.scheduleInboxWakeAfterIdle(wakeContext);
    }
    return acknowledgement;
  });

  /** Submit the exact surfaced handoff without allowing cursor or marker substitution. */
  readonly submitInboxHandoff = Effect.fnUntraced(function* (
    this: ManagerController,
    handoff: InboxHandoffStart,
    ctx?: ExtensionContext,
  ) {
    return yield* this.acknowledgeInbox(ctx, {
      cursor: handoff.cursor,
      handoff,
      reason: 'feedback_tool_submitted',
    });
  });

  /** Consume at most one exact surfaced cursor before a supported normal user prompt proceeds. */
  readonly acknowledgeInboxAfterHandoff = Effect.fnUntraced(function* (
    this: ManagerController,
    ctx?: ExtensionContext,
  ) {
    const state = yield* this.refresh(ctx);
    const handoff = retainCurrentInboxHandoff(state.inbox, state.inboxWake, state.inboxHandoff);
    // Restored pre-token markers are intentionally ambiguous: preserve their
    // durable rows until explicit manager acknowledgement or a fresh handoff.
    if (!handoff?.token) return undefined;
    return yield* this.acknowledgeInbox(ctx, {
      cursor: handoff.cursor,
      handoff,
      reason: 'user_message_after_handoff',
      releaseSuccessor: false,
    });
  });

  /** Read one known currently-pending durable attention row without exposing raw state or audit history. */
  readonly getInboxEvent = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: unknown,
    ctx?: ExtensionContext,
  ) {
    const { eventId } = yield* decodeInboxGetInput(rawInput);
    const state = yield* this.refresh(ctx);
    const event = state.inbox.find((candidate) => candidate.id === eventId);
    if (!event) return yield* new InboxEventNotFoundError({ eventId });
    return event;
  });

  readonly getReport = Effect.fnUntraced(function* (this: ManagerController, rawInput: unknown) {
    const active = yield* this.requireActive();
    return yield* active.reporting.getExcerpt(rawInput);
  });

  private readonly createPullRequestUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: PullRequestCreateInput,
    ctx?: ExtensionContext,
  ) {
    const input = yield* decodePullRequestCreateInput(rawInput);
    const active = yield* this.requireActive();
    return yield* active.pullRequests.publish(input, ctx);
  });

  readonly createPullRequest = (rawInput: PullRequestCreateInput, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.createPullRequestUnlocked(rawInput, ctx));

  private readonly requestVerificationUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: unknown,
    ctx?: ExtensionContext,
  ) {
    const input = yield* decodeVerificationRequestInput(rawInput);
    const active = yield* this.requireActive();
    return yield* active.verifications.request(input, ctx);
  });

  readonly requestVerification = (rawInput: unknown, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.requestVerificationUnlocked(rawInput, ctx));

  readonly verificationStatus = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: unknown,
    ctx?: ExtensionContext,
  ) {
    const { verificationId } = yield* decodeVerificationIdInput(rawInput);
    const active = yield* this.requireActive();
    return yield* active.verifications.status(verificationId, ctx);
  });

  private readonly refreshVerificationUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: unknown,
    ctx?: ExtensionContext,
  ) {
    const { verificationId } = yield* decodeVerificationRefreshInput(rawInput);
    const active = yield* this.requireActive();
    return yield* active.verifications.refresh(verificationId, ctx);
  });

  readonly refreshVerification = (rawInput: unknown, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.refreshVerificationUnlocked(rawInput, ctx));

  private readonly spawnAgentUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: AgentSpawnInput,
    ctx?: ExtensionContext,
  ) {
    const input = yield* decodeAgentSpawnInput(rawInput);
    const active = yield* this.requireActive();
    const snapshot = yield* this.requirePinnedChildRuntime('agent_spawn');
    return yield* active.attachments.spawn(input, snapshot.workerExtensionPath, ctx);
  });

  readonly spawnAgent = (rawInput: AgentSpawnInput, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.spawnAgentUnlocked(rawInput, ctx));

  readonly agentStatus = Effect.fnUntraced(function* (
    this: ManagerController,
    rawAgentId: string,
    ctx?: ExtensionContext,
  ) {
    const { agentId } = yield* decodeAgentIdInput({ agentId: rawAgentId });
    const state = yield* this.refresh(ctx);
    const agent = state.agents[agentId];
    if (!agent) return yield* new AgentNotFoundError({ agentId });
    const runtime = yield* this.workers
      .status(agentId)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (runtime) this.liveRuntimes.set(agentId, runtime);
    this.render(ctx);
    return { agent, runtime } satisfies AgentStatus;
  });

  private readonly sendAgentUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawAgentId: string,
    rawMessage: string,
    rawBehavior?: WorkerSendBehavior,
    ctx?: ExtensionContext,
  ) {
    const {
      agentId,
      message,
      behavior = 'auto',
    } = yield* decodeAgentSendInput({
      agentId: rawAgentId,
      message: rawMessage,
      ...(rawBehavior === undefined ? {} : { behavior: rawBehavior }),
    });
    const active = yield* this.requireActive();
    const state = yield* this.refresh(ctx);
    if (!state.agents[agentId]) return yield* new AgentNotFoundError({ agentId });
    const delivery = yield* this.workers.send(agentId, message, behavior);
    const timestamp = yield* nowIso;
    const routing =
      delivery.requestedBehavior === delivery.deliveredAs
        ? ''
        : ` (${delivery.requestedBehavior}-routed)`;
    yield* this.appendEventSafely(
      active.store,
      makeEvent(
        'agent_message_sent',
        `Sent ${delivery.deliveredAs} message${routing} to ${agentId}`,
        timestamp,
      ),
    );
    const status = yield* this.agentStatus(agentId, ctx);
    return { ...status, delivery } satisfies AgentSendResult;
  });

  readonly sendAgent = (
    rawAgentId: string,
    rawMessage: string,
    rawBehavior?: WorkerSendBehavior,
    ctx?: ExtensionContext,
  ) =>
    this.withActiveLifecyclePermit(() =>
      this.sendAgentUnlocked(rawAgentId, rawMessage, rawBehavior, ctx),
    );

  private readonly sendReportToAgentUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: AgentSendReportInput,
    ctx?: ExtensionContext,
  ) {
    const input = yield* decodeAgentSendReportInput(rawInput);
    const active = yield* this.requireActive();
    const state = yield* this.refresh(ctx);
    const target = state.agents[input.agentId];
    if (!target) return yield* new AgentNotFoundError({ agentId: input.agentId });
    if (target.status !== 'idle') {
      return yield* reportHandoffRejected(
        input.agentId,
        target.status === 'stopped' || target.status === 'crashed'
          ? 'target_not_attached'
          : 'target_not_idle',
      );
    }
    yield* validateRetainedAgentState(active, input.agentId, target);
    if (!stateKnowsDurableReport(state, input.reportId))
      return yield* new ReportArtifactError({ reason: 'not_found', reportId: input.reportId });
    const { agentId: _targetAgentId, message, ...excerptInput } = input;
    const excerpt = yield* active.reporting.getExcerpt(excerptInput);
    const source = state.agents[excerpt.agentId];
    if (!source || source.id !== excerpt.agentId || !isNamespaceSegment(source.id)) {
      return yield* reportHandoffRejected(input.agentId, 'source_not_managed');
    }
    if (source.role !== 'worker' && source.role !== 'verifier') {
      return yield* reportHandoffRejected(input.agentId, 'source_role_unsupported');
    }
    const handoff = renderReportHandoffMessage({
      excerpt,
      sourceRole: source.role,
      ...(message === undefined ? {} : { message }),
    });
    yield* this.workers
      .send(input.agentId, handoff, 'prompt')
      .pipe(
        Effect.mapError((error) =>
          error._tag === 'AgentNotFoundError'
            ? reportHandoffRejected(input.agentId, 'target_not_attached')
            : error,
        ),
      );
    const timestamp = yield* nowIso;
    yield* this.appendEventSafely(
      active.store,
      makeEvent(
        'agent_report_handoff_sent',
        `Sent bounded ${source.role} report ${excerpt.reportId} ${excerpt.field} excerpt at offset ${excerpt.offset} to ${input.agentId} as prompt.`,
        timestamp,
        { agentId: input.agentId, reportId: excerpt.reportId, workstreamId: target.workstreamId },
      ),
    );
    return {
      behavior: 'prompt',
      field: excerpt.field,
      hasMore: excerpt.hasMore,
      offset: excerpt.offset,
      reportId: excerpt.reportId,
      returnedChars: excerpt.returnedChars,
      sourceAgentId: excerpt.agentId,
      sourceRole: source.role,
      status: excerpt.status,
      targetAgentId: input.agentId,
      totalChars: excerpt.totalChars,
      ...(excerpt.hasMore ? { nextOffset: excerpt.offset + excerpt.returnedChars } : {}),
    } satisfies AgentReportHandoffResult;
  });

  readonly sendReportToAgent = (rawInput: AgentSendReportInput, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.sendReportToAgentUnlocked(rawInput, ctx));

  private readonly reviveAgentUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawAgentId: string,
    rawMessage: string,
    ctx?: ExtensionContext,
  ) {
    const { agentId, message } = yield* decodeAgentReviveInput({
      agentId: rawAgentId,
      message: rawMessage,
    });
    const active = yield* this.requireActive();
    const snapshot = yield* this.requirePinnedChildRuntime('agent_revive');
    return yield* active.attachments.revive(agentId, message, snapshot.workerExtensionPath, ctx);
  });

  readonly reviveAgent = (rawAgentId: string, rawMessage: string, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.reviveAgentUnlocked(rawAgentId, rawMessage, ctx));

  private readonly compactAgentUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawAgentId: string,
    ctx?: ExtensionContext,
  ) {
    const { agentId } = yield* decodeAgentIdInput({ agentId: rawAgentId });
    const active = yield* this.requireActive();
    const state = yield* this.refresh(ctx);
    const agent = state.agents[agentId];
    if (!agent) return yield* new AgentNotFoundError({ agentId });
    const compacted = yield* this.workers.compact(agentId).pipe(Effect.exit);
    if (Exit.isFailure(compacted)) {
      const failedAt = yield* nowIso;
      yield* this.appendEventSafely(
        active.store,
        makeEvent(
          'agent_compact_failed',
          boundedEventSummary([
            `Manual compaction failed for ${agentId}.`,
            boundedFailureSummary(Cause.squash(compacted.cause)),
          ]),
          failedAt,
          { agentId, workstreamId: agent.workstreamId },
        ),
      );
      return yield* Effect.failCause(compacted.cause);
    }
    const runtime = compacted.value;
    this.liveRuntimes.set(agentId, runtime);
    this.render(ctx);
    const completion =
      runtime.lastCompaction?.reason === 'manual' ? runtime.lastCompaction : undefined;
    const result: AgentCompactResult = {
      agentId,
      outcome: 'manual',
      status: runtime.status,
      ...(completion?.tokensBefore === undefined ? {} : { tokensBefore: completion.tokensBefore }),
      ...(completion === undefined
        ? {}
        : { aborted: completion.aborted, willRetry: completion.willRetry }),
      ...(completion?.errorMessage === undefined
        ? {}
        : { failureSummary: truncateModelFacingText(completion.errorMessage) }),
    };
    const compactedAt = yield* nowIso;
    yield* this.appendEventSafely(
      active.store,
      makeEvent(
        'agent_compacted',
        boundedEventSummary([
          `Requested manual compaction for ${agentId} (${runtime.status}).`,
          result.failureSummary ? `Bounded child outcome: ${result.failureSummary}` : '',
        ]),
        compactedAt,
        { agentId, workstreamId: agent.workstreamId },
      ),
    );
    return result;
  });

  readonly compactAgent = (rawAgentId: string, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.compactAgentUnlocked(rawAgentId, ctx));

  private readonly reloadAgentUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawAgentId: string,
    ctx?: ExtensionContext,
  ) {
    const { agentId } = yield* decodeAgentIdInput({ agentId: rawAgentId });
    const active = yield* this.requireActive();
    yield* this.requirePinnedChildRuntime('agent_reload');
    const state = yield* this.refresh(ctx);
    const agent = state.agents[agentId];
    if (!agent) return yield* new AgentNotFoundError({ agentId });
    const reloaded = yield* Effect.gen(
      function* (this: ManagerController) {
        yield* validateRetainedAgentState(active, agentId, agent);
        if (!agent.sessionFile)
          return yield* invalidManagedState('agent has no persisted Pi session file to reload');
        const attachedRuntime = this.liveRuntimes.get(agentId);
        if (attachedRuntime && attachedRuntime.sessionFile !== agent.sessionFile) {
          return yield* invalidManagedState(
            'attached worker session file does not match its validated persisted session file',
          );
        }
        const runtime = yield* this.workers.reload(agentId);
        this.liveRuntimes.set(agentId, runtime);
        this.render(ctx);
        if (runtime.sessionFile !== agent.sessionFile) {
          return yield* invalidManagedState(
            'reloaded worker session file does not match its validated persisted session file',
          );
        }
        const reloadedAt = yield* nowIso;
        yield* active.store.mutate((current) => {
          const currentAgent = current.agents[agentId] ?? agent;
          return Effect.succeed([
            undefined,
            {
              ...current,
              agents: {
                ...current.agents,
                [agentId]: {
                  ...currentAgent,
                  sessionFile: runtime.sessionFile,
                  status: runtime.status,
                  updatedAt: reloadedAt,
                },
              },
            },
          ] as const);
        });
        yield* this.refreshActiveState(active, ctx);
        return {
          agentId,
          conversation: 'preserved',
          outcome: 'child_extension_refreshed',
          status: runtime.status,
          worktree: 'preserved',
        } satisfies AgentReloadResult;
      }.bind(this),
    ).pipe(Effect.exit);
    if (Exit.isFailure(reloaded)) {
      const failedAt = yield* nowIso;
      yield* this.appendEventSafely(
        active.store,
        makeEvent(
          'agent_reload_failed',
          boundedEventSummary([
            `Child-extension refresh failed for ${agentId}.`,
            boundedFailureSummary(Cause.squash(reloaded.cause)),
          ]),
          failedAt,
          { agentId, workstreamId: agent.workstreamId },
        ),
      );
      return yield* Effect.failCause(reloaded.cause);
    }
    const result = reloaded.value;
    const completedAt = yield* nowIso;
    yield* this.appendEventSafely(
      active.store,
      makeEvent(
        'agent_reloaded',
        boundedEventSummary([
          `Refreshed child extension for ${agentId} (${result.status}); retained conversation and managed worktree preserved; sent no prompt.`,
        ]),
        completedAt,
        { agentId, workstreamId: agent.workstreamId },
      ),
    );
    return result;
  });

  readonly reloadAgent = (rawAgentId: string, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.reloadAgentUnlocked(rawAgentId, ctx));

  private readonly cleanupAgentLeaseUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawInput: {
      readonly agentId: string;
      readonly action: 'inspect' | 'cleanup';
      readonly forceDiscardDirty?: boolean;
      readonly forceDeleteUnmergedBranch?: boolean;
    },
    ctx?: ExtensionContext,
  ) {
    const input = yield* decodeAgentLeaseCleanupInput(rawInput);
    const active = yield* this.requireActive();
    const state = yield* this.refresh(ctx);
    if (
      input.action === 'inspect' &&
      (input.forceDiscardDirty === true || input.forceDeleteUnmergedBranch === true)
    ) {
      return yield* new AgentLeaseCleanupRejectedError({
        agentId: input.agentId,
        reason: 'force intent is valid only for an explicit cleanup action',
      });
    }
    const cleanupContext = {
      namespace: active,
      runtimes: this.liveRuntimes,
      state,
      worktrees: this.worktrees,
    };
    if (input.action === 'inspect')
      return yield* inspectAgentLeaseCleanup(cleanupContext, input.agentId);
    const { projection, outcome } = yield* cleanupAgentLease(cleanupContext, input.agentId, {
      ...(input.forceDiscardDirty === undefined
        ? {}
        : { forceDiscardDirty: input.forceDiscardDirty }),
      ...(input.forceDeleteUnmergedBranch === undefined
        ? {}
        : { forceDeleteUnmergedBranch: input.forceDeleteUnmergedBranch }),
    });
    const timestamp = yield* nowIso;
    yield* active.store.mutate((current) => {
      const currentAgent = current.agents[input.agentId];
      if (!currentAgent)
        return Effect.fail(
          invalidManagedState('cleaned agent record disappeared before durable reconciliation'),
        );
      const inbox = current.inbox.filter(
        (event) => !isResolvedByAgentLeaseCleanup(event, input.agentId),
      );
      const withReconciledInbox =
        inbox.length === current.inbox.length ? current : withInbox(current, inbox);
      return Effect.succeed([
        undefined,
        {
          ...withReconciledInbox,
          agents: {
            ...withReconciledInbox.agents,
            [input.agentId]: reconcileAgentLeaseCleanup(currentAgent, outcome, timestamp),
          },
        },
      ] as const);
    });
    yield* this.appendEventSafely(
      active.store,
      makeEvent(
        'agent_lease_cleaned',
        boundedEventSummary([agentLeaseCleanupEventSummary(projection)]),
        timestamp,
        { agentId: input.agentId, workstreamId: state.agents[input.agentId]?.workstreamId },
      ),
    );
    yield* this.refreshActiveState(active, ctx);
    // Explicit retained-lease cleanup is the deliberate resolution edge for a
    // stopped owner's dirty or failed handoff audit. Re-run conservative merged
    // retirement only after cleanup durably removes that unresolved projection.
    yield* active.reviewGates
      .retryMergedRetirementForWorkstream(state.agents[input.agentId]?.workstreamId, {
        alreadySerialized: true,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            console.error(
              'Pardes failed to retry merged retirement after explicit retained-lease cleanup.',
              error,
            ),
          ),
        ),
      );
    return projection satisfies AgentLeaseCleanupProjection;
  });

  readonly cleanupAgentLease = (
    rawInput: {
      readonly agentId: string;
      readonly action: 'inspect' | 'cleanup';
      readonly forceDiscardDirty?: boolean;
      readonly forceDeleteUnmergedBranch?: boolean;
    },
    ctx?: ExtensionContext,
  ) => this.withActiveLifecyclePermit(() => this.cleanupAgentLeaseUnlocked(rawInput, ctx));

  private readonly stopAgentUnlocked = Effect.fnUntraced(function* (
    this: ManagerController,
    rawAgentId: string,
    ctx?: ExtensionContext,
  ) {
    const { agentId } = yield* decodeAgentIdInput({ agentId: rawAgentId });
    const active = yield* this.requireActive();
    const stopped = yield* active.attachments.stop(agentId, ctx);
    // A merge can race a deliberately retained owner that was briefly revived
    // for bounded diagnosis. Stopping that owner is a safe retry edge for the
    // already-terminal stream; open gates and other blockers still fail closed.
    yield* active.reviewGates
      .retryMergedRetirementForWorkstream(stopped.workstreamId, { alreadySerialized: true })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            console.error(
              'Pardes failed to retry merged retirement after explicit owner stop.',
              error,
            ),
          ),
        ),
      );
    return stopped;
  });

  readonly stopAgent = (rawAgentId: string, ctx?: ExtensionContext) =>
    this.withActiveLifecyclePermit(() => this.stopAgentUnlocked(rawAgentId, ctx));
}
