import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Cause, Clock, Context, Effect, Exit } from 'effect';
import {
  type ManagedLeaseOwner,
  type ManagedWorktreeShape,
  type RemoteBaselineError,
  resolveRemoteBaseline,
  type WorktreeServiceError,
} from '../git/index.ts';
import type { StateStoreShape, StoreError } from '../storage/index.ts';
import {
  type GuardedWorkerSupervisorShape,
  type WorkerRuntimeSnapshot,
  type WorkerSupervisorError,
  type WorkerThinkingLevel,
  type WorktreeBootstrapShape,
  WorktreeUpdateError,
} from '../worker-runtime/index.ts';
import type {
  AgentGitAuditTrigger,
  AgentRecord,
  ManagerEvent,
  ManagerState,
  Workstream,
} from './domain.ts';
import {
  AgentAlreadyRunningError,
  AgentCannotReviveError,
  AgentNotFoundError,
  AgentSpawnConfigurationError,
  formatPardesError,
  type InvalidManagedStateError,
  WorkstreamNotFoundError,
} from './errors.ts';
import {
  type ManagerNamespaceContext,
  managedLeaseOwner,
  validateRetainedAgentState,
} from './namespace.ts';
import {
  applyHandoffAudit,
  boundedEventSummary,
  failedHandoffAudit,
  type HandoffAuditOutcome,
  handoffAuditSuffix,
  successfulHandoffAudit,
} from './worker-events.ts';
import {
  EXTERNALLY_INTERRUPTED_BOOTSTRAP_SUMMARY,
  runDurableWorktreeBootstrap,
  settleUnrecordedWorktreeBootstrap,
} from './worktree-bootstrap.ts';

const ATTACHED_STATUSES = new Set(['starting', 'running', 'idle']);
const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

type FailedLeaseCleanup = 'removed_clean' | 'preserved_dirty' | 'preserved_unverified';

type ManagerEventAssociation = Pick<ManagerEvent, 'workstreamId' | 'agentId'>;

function makeEvent(
  type: string,
  summary: string,
  createdAt: string,
  association: ManagerEventAssociation = {},
): ManagerEvent {
  return { createdAt, id: randomUUID(), summary, type, ...association };
}

function agentSessionName(workstreamId: string, agentId: string, title?: string): string {
  return `${title ? `${title} · ` : ''}${workstreamId} · ${agentId}`;
}

function failedLeaseSummary(
  agentId: string,
  leasePath: string,
  cleanup: FailedLeaseCleanup,
): string {
  if (cleanup === 'removed_clean')
    return `Failed to start ${agentId}; removed clean managed worktree ${leasePath}.`;
  if (cleanup === 'preserved_dirty')
    return `Failed to start ${agentId}; preserved dirty managed worktree ${leasePath}.`;
  return `Failed to start ${agentId}; preserved managed worktree ${leasePath} because safe cleanup could not be established.`;
}

function leaseCleanupSummary(leasePath: string, cleanup: FailedLeaseCleanup): string {
  if (cleanup === 'removed_clean') return `Removed clean managed worktree ${leasePath}.`;
  if (cleanup === 'preserved_dirty') return `Preserved dirty managed worktree ${leasePath}.`;
  return `Preserved managed worktree ${leasePath} because safe cleanup could not be established.`;
}

export interface AgentAttachmentSpawnInput {
  readonly workstreamId: string;
  readonly title?: string;
  readonly task: string;
  readonly baselineBranch?: string;
  readonly model?: string;
  readonly thinkingLevel?: WorkerThinkingLevel;
}

export interface AgentAttachmentLifecycleNamespace extends ManagerNamespaceContext {
  readonly store: StateStoreShape;
  state: ManagerState;
}

export type AgentAttachmentLifecycleError =
  | StoreError
  | WorktreeServiceError
  | RemoteBaselineError
  | WorkerSupervisorError
  | WorktreeUpdateError
  | InvalidManagedStateError
  | WorkstreamNotFoundError
  | AgentSpawnConfigurationError
  | AgentNotFoundError
  | AgentAlreadyRunningError
  | AgentCannotReviveError;

export interface AgentAttachmentLifecycleCoordinatorShape {
  readonly spawn: (
    input: AgentAttachmentSpawnInput,
    workerExtensionPath: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<AgentRecord, AgentAttachmentLifecycleError>;
  readonly revive: (
    agentId: string,
    message: string,
    workerExtensionPath: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<AgentRecord, AgentAttachmentLifecycleError>;
  readonly stop: (
    agentId: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<AgentRecord, AgentAttachmentLifecycleError>;
  readonly stopIfIdleForWorkstreamCompletion: (
    agentId: string,
    ctx?: ExtensionContext,
  ) => Effect.Effect<AgentRecord | undefined, AgentAttachmentLifecycleError>;
  readonly auditHandoffBestEffort: (
    agent: AgentRecord,
    trigger: Exclude<AgentGitAuditTrigger, 'publication'>,
  ) => Effect.Effect<HandoffAuditOutcome | undefined>;
}

export class AgentAttachmentLifecycleCoordinator extends Context.Service<
  AgentAttachmentLifecycleCoordinator,
  AgentAttachmentLifecycleCoordinatorShape
>()('pardes/AgentAttachmentLifecycleCoordinator') {}

export interface AgentAttachmentLifecycleCoordinatorCallbacks {
  readonly refresh: (
    ctx?: ExtensionContext,
  ) => Effect.Effect<void, StoreError | InvalidManagedStateError>;
  readonly appendEventSafely: (event: ManagerEvent) => Effect.Effect<void>;
  readonly render: () => void;
  readonly defaultModel: (ctx?: ExtensionContext) => string | undefined;
  readonly defaultThinkingLevel: () => WorkerThinkingLevel;
  readonly recordRuntime: (agentId: string, runtime: WorkerRuntimeSnapshot) => void;
  readonly forgetRuntime: (agentId: string) => void;
  readonly suppressWorkerEvents: (agentId: string) => void;
  readonly resumeWorkerEvents: (agentId: string) => void;
}

export interface AgentAttachmentLifecycleCoordinatorOptions {
  readonly namespace: AgentAttachmentLifecycleNamespace;
  readonly worktrees: ManagedWorktreeShape;
  readonly workers: GuardedWorkerSupervisorShape;
  readonly worktreeBootstrap: WorktreeBootstrapShape;
  readonly callbacks: AgentAttachmentLifecycleCoordinatorCallbacks;
}

export function makeAgentAttachmentLifecycleCoordinator(
  options: AgentAttachmentLifecycleCoordinatorOptions,
): AgentAttachmentLifecycleCoordinatorShape {
  const { namespace, worktrees, workers, worktreeBootstrap, callbacks } = options;

  const requirePersistedAgent = Effect.fnUntraced(function* (agentId: string) {
    const agent = namespace.state.agents[agentId];
    if (!agent) return yield* new AgentNotFoundError({ agentId });
    return agent;
  });

  const auditHandoffBestEffort: AgentAttachmentLifecycleCoordinatorShape['auditHandoffBestEffort'] =
    Effect.fnUntraced(function* (agent, trigger) {
      if (!agent.worktree) return undefined;
      const worktree = agent.worktree;
      const checkedAt = yield* nowIso;
      const inspect =
        trigger === 'completion' && worktrees.inspectWithProvenance !== undefined
          ? worktrees.inspectWithProvenance
          : worktrees.inspect;
      const result = yield* validateRetainedAgentState(namespace, agent.id, agent).pipe(
        Effect.flatMap(() => inspect(managedLeaseOwner(namespace, agent.id), worktree)),
        Effect.exit,
      );
      return Exit.isSuccess(result)
        ? successfulHandoffAudit(trigger, checkedAt, result.value)
        : failedHandoffAudit(trigger, checkedAt, Cause.squash(result.cause));
    });

  const cleanupFailedLease = Effect.fnUntraced(function* (
    owner: ManagedLeaseOwner,
    lease: NonNullable<AgentRecord['worktree']>,
  ) {
    const removal = yield* worktrees.removeIfClean(owner, lease).pipe(
      Effect.as<FailedLeaseCleanup>('removed_clean'),
      Effect.catch((error) => Effect.succeed(error)),
    );
    if (removal === 'removed_clean') return removal;
    if (typeof removal !== 'string' && removal._tag === 'DirtyWorktreeError')
      return 'preserved_dirty' as const;
    console.error(
      `Pardes failed to clean up managed worktree ${lease.path} after spawn failure`,
      removal,
    );
    return 'preserved_unverified' as const;
  });

  const stopUnpersistedRuntime = Effect.fnUntraced(function* (agentId: string) {
    callbacks.suppressWorkerEvents(agentId);
    callbacks.forgetRuntime(agentId);
    const stop = yield* workers.stop(agentId).pipe(Effect.exit);
    callbacks.resumeWorkerEvents(agentId);
    callbacks.forgetRuntime(agentId);
    if (Exit.isSuccess(stop)) return true;
    console.error(
      `Pardes failed to stop unattached worker runtime ${agentId} after persistence failure`,
      Cause.squash(stop.cause),
    );
    return false;
  });

  const settleFailedRuntimeLaunch = Effect.fnUntraced(function* (agentId: string) {
    callbacks.suppressWorkerEvents(agentId);
    const stopped = yield* workers.stop(agentId).pipe(Effect.exit);
    callbacks.resumeWorkerEvents(agentId);
    callbacks.forgetRuntime(agentId);
    if (Exit.isSuccess(stopped)) return true;
    const error = Cause.squash(stopped.cause);
    if (error instanceof AgentNotFoundError) return true;
    console.error(
      `Pardes could not prove failed worker runtime launch ${agentId} was stopped`,
      error,
    );
    return false;
  });

  const rollbackProvisionalAgent = Effect.fnUntraced(function* (
    workstream: Workstream,
    agentId: string,
  ) {
    const timestamp = yield* nowIso;
    const withoutProvisionalAgent = (state: ManagerState): ManagerState => {
      const agents = { ...state.agents };
      delete agents[agentId];
      const hasAttachedWorker = Object.values(agents).some(
        (agent) => agent.workstreamId === workstream.id && ATTACHED_STATUSES.has(agent.status),
      );
      const currentWorkstream = state.workstreams[workstream.id] ?? workstream;
      return {
        ...state,
        agents,
        workstreams: {
          ...state.workstreams,
          [workstream.id]: {
            ...currentWorkstream,
            status: hasAttachedWorker ? 'active' : workstream.status,
            updatedAt: timestamp,
          },
        },
      };
    };
    const rollback = yield* namespace.store
      .mutate((state) => Effect.succeed([undefined, withoutProvisionalAgent(state)] as const))
      .pipe(Effect.exit);
    if (Exit.isFailure(rollback)) {
      console.error(
        `Pardes failed to roll back provisional agent ${agentId}`,
        Cause.squash(rollback.cause),
      );
      namespace.state = withoutProvisionalAgent(namespace.state);
      callbacks.render();
      return;
    }
    yield* callbacks.refresh();
  });

  const retainFailedAgentLease = Effect.fnUntraced(function* (
    agent: AgentRecord,
    cleanup: Exclude<FailedLeaseCleanup, 'removed_clean'>,
    failedAt: string,
    failure: string,
    bootstrapFailureSummary?: string,
  ) {
    const withRetainedOwnership = (state: ManagerState): ManagerState => {
      const current = state.agents[agent.id] ?? agent;
      return {
        ...state,
        agents: {
          ...state.agents,
          [agent.id]: {
            ...current,
            lastError:
              cleanup === 'preserved_dirty'
                ? `${failure} The dirty managed worktree and durable lease ownership were retained for inspection and cleanup.`
                : `${failure} Safe managed-worktree cleanup or process termination could not be established; durable lease ownership was retained.`,
            status: 'crashed' as const,
            updatedAt: failedAt,
            worktreeBootstrap: settleUnrecordedWorktreeBootstrap(
              current.worktreeBootstrap,
              failedAt,
              bootstrapFailureSummary,
            ),
          },
        },
      };
    };
    const retained = yield* namespace.store
      .mutate((state) => Effect.succeed([undefined, withRetainedOwnership(state)] as const))
      .pipe(Effect.exit);
    if (Exit.isFailure(retained)) {
      console.error(
        `Pardes failed to persist retained managed-worktree ownership for ${agent.id}`,
        Cause.squash(retained.cause),
      );
      namespace.state = withRetainedOwnership(namespace.state);
      callbacks.render();
      return;
    }
    yield* callbacks.refresh();
  });

  const settleInterruptedWriterBootstrap = Effect.fnUntraced(function* (
    agent: AgentRecord,
    workstream: Workstream,
  ) {
    const interruptedAt = yield* nowIso;
    yield* retainFailedAgentLease(
      agent,
      'preserved_unverified',
      interruptedAt,
      'Repository bootstrap was externally interrupted; completion and process termination are unknown.',
      EXTERNALLY_INTERRUPTED_BOOTSTRAP_SUMMARY,
    );
    yield* callbacks.appendEventSafely(
      makeEvent(
        'agent_worktree_bootstrap_interrupted',
        `${agent.id} repository bootstrap was externally interrupted; no child worker was launched, process termination is not assumed, and conservative lease ownership was retained.`,
        interruptedAt,
        { agentId: agent.id, workstreamId: workstream.id },
      ),
    );
  });

  const handleSpawnPersistenceFailure = Effect.fnUntraced(function* (
    state: ManagerState,
    workstream: Workstream,
    agent: AgentRecord,
    lease: NonNullable<AgentRecord['worktree']>,
    cause: Cause.Cause<unknown>,
  ) {
    const stopped = yield* stopUnpersistedRuntime(agent.id);
    const cleanup = stopped
      ? yield* cleanupFailedLease(
          { agentId: agent.id, managerId: state.managerId, repo: state.repo },
          lease,
        )
      : ('preserved_unverified' as const);
    const timestamp = yield* nowIso;
    if (cleanup === 'removed_clean') yield* rollbackProvisionalAgent(workstream, agent.id);
    else
      yield* retainFailedAgentLease(
        agent,
        cleanup,
        timestamp,
        'The spawned worker attachment could not be persisted.',
      );
    yield* callbacks.appendEventSafely(
      makeEvent(
        'agent_spawn_persist_failed',
        `Started ${agent.id} but failed to persist the runtime; ${stopped ? 'stopped the unattached worker' : 'could not prove the unattached worker stopped'}. ${leaseCleanupSummary(lease.path, cleanup)} ${formatPardesError(Cause.squash(cause))}`,
        timestamp,
      ),
    );
  });

  const handleRevivePersistenceFailure = Effect.fnUntraced(function* (
    agentId: string,
    fallbackStatus: AgentRecord['status'],
    cause: Cause.Cause<unknown>,
  ) {
    const stopped = yield* stopUnpersistedRuntime(agentId);
    const timestamp = yield* nowIso;
    yield* namespace.store
      .mutate((state) => {
        const currentAgent = state.agents[agentId];
        if (!currentAgent) return Effect.succeed([undefined, state] as const);
        return Effect.succeed([
          undefined,
          {
            ...state,
            agents: {
              ...state.agents,
              [agentId]: { ...currentAgent, status: fallbackStatus, updatedAt: timestamp },
            },
          },
        ] as const);
      })
      .pipe(Effect.catch(() => Effect.void));
    const currentAgent = namespace.state.agents[agentId];
    if (currentAgent)
      namespace.state = {
        ...namespace.state,
        agents: {
          ...namespace.state.agents,
          [agentId]: { ...currentAgent, status: fallbackStatus, updatedAt: timestamp },
        },
      };
    callbacks.render();
    yield* callbacks.appendEventSafely(
      makeEvent(
        'agent_revive_persist_failed',
        `Revived ${agentId} but failed to persist the runtime; ${stopped ? 'stopped the unattached worker' : 'could not prove the unattached worker stopped'}. ${formatPardesError(Cause.squash(cause))}`,
        timestamp,
      ),
    );
  });

  const spawn: AgentAttachmentLifecycleCoordinatorShape['spawn'] = Effect.fnUntraced(
    function* (input, workerExtensionPath, ctx) {
      yield* callbacks.refresh(ctx);
      const state = namespace.state;
      const workstream = state.workstreams[input.workstreamId];
      if (!workstream)
        return yield* new WorkstreamNotFoundError({ workstreamId: input.workstreamId });
      const model = input.model ?? callbacks.defaultModel(ctx);
      if (!model)
        return yield* new AgentSpawnConfigurationError({
          message:
            'Cannot spawn a Pardes worker without a model. Select a manager model or pass an explicit model override.',
        });
      const thinkingLevel = input.thinkingLevel ?? callbacks.defaultThinkingLevel();
      const timestamp = yield* nowIso;
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      const sessionDir = join(namespace.store.directory, 'sessions', agentId);
      const baseline = yield* resolveRemoteBaseline(state.repo, input.baselineBranch);
      const lease = yield* worktrees.create({
        agentId,
        branchPointSha: baseline.sha,
        managerId: state.managerId,
        name: workstream.title,
        repo: state.repo,
      });
      yield* callbacks.appendEventSafely(
        makeEvent(
          'agent_spawn_started',
          `Starting ${agentId} in ${lease.path} from ${baseline.remote}/${baseline.branch} at ${baseline.sha}`,
          timestamp,
        ),
      );
      const agent: AgentRecord = {
        id: agentId,
        ...(input.title === undefined ? {} : { title: input.title }),
        createdAt: timestamp,
        lifecycleGeneration: 1,
        model,
        role: 'worker',
        sessionDir,
        status: 'starting',
        task: input.task,
        thinkingLevel,
        updatedAt: timestamp,
        workstreamId: input.workstreamId,
        worktree: lease,
        worktreeBootstrap: {
          script: 'script/update',
          startedAt: timestamp,
          status: 'running',
        },
      };
      const provisionalAt = yield* nowIso;
      const provisionalResult = yield* namespace.store
        .mutate((current) =>
          Effect.succeed([
            undefined,
            {
              ...current,
              agents: { ...current.agents, [agent.id]: { ...agent, updatedAt: provisionalAt } },
              workstreams: {
                ...current.workstreams,
                [workstream.id]: { ...workstream, status: 'active', updatedAt: provisionalAt },
              },
            },
          ] as const),
        )
        .pipe(Effect.exit);
      if (Exit.isFailure(provisionalResult)) {
        const cleanup = yield* cleanupFailedLease(
          { agentId, managerId: state.managerId, repo: state.repo },
          lease,
        );
        yield* callbacks.appendEventSafely(
          makeEvent(
            'agent_spawn_persist_failed',
            `Failed to persist ${agentId} before worker bootstrap. ${leaseCleanupSummary(lease.path, cleanup)} ${formatPardesError(Cause.squash(provisionalResult.cause))}`,
            provisionalAt,
          ),
        );
        return yield* Effect.failCause(provisionalResult.cause);
      }
      yield* callbacks.refresh(ctx);
      const bootstrapResult = yield* runDurableWorktreeBootstrap({
        agent,
        bootstrap: worktreeBootstrap,
        callbacks: {
          appendEventSafely: callbacks.appendEventSafely,
          event: (type, summary, createdAt) =>
            makeEvent(`agent_${type}`, summary, createdAt, {
              agentId,
              workstreamId: workstream.id,
            }),
        },
        cwd: lease.path,
        label: `${agentId} fresh managed worktree`,
        namespace,
      }).pipe(
        Effect.exit,
        Effect.onInterrupt(() =>
          Effect.uninterruptible(settleInterruptedWriterBootstrap(agent, workstream)),
        ),
      );
      if (Exit.isFailure(bootstrapResult)) {
        const failedAt = yield* nowIso;
        const bootstrapError = Cause.squash(bootstrapResult.cause);
        const cleanup =
          bootstrapError instanceof WorktreeUpdateError &&
          (bootstrapError.reason === 'timeout' ||
            bootstrapError.reason === 'process_lifecycle_unsettled')
            ? ('preserved_unverified' as const)
            : yield* cleanupFailedLease(
                { agentId, managerId: state.managerId, repo: state.repo },
                lease,
              );
        if (cleanup === 'removed_clean') yield* rollbackProvisionalAgent(workstream, agentId);
        else
          yield* retainFailedAgentLease(
            agent,
            cleanup,
            failedAt,
            'Repository script/update failed.',
          );
        yield* callbacks.appendEventSafely(
          makeEvent(
            'agent_spawn_failed',
            `${failedLeaseSummary(agentId, lease.path, cleanup)} Repository worktree bootstrap did not complete successfully; child launch was skipped.`,
            failedAt,
            { agentId, workstreamId: workstream.id },
          ),
        );
        return yield* Effect.failCause(bootstrapResult.cause);
      }
      const runtimeResult = yield* workers
        .spawn({
          agentId,
          cwd: lease.path,
          lifecycleGeneration: agent.lifecycleGeneration,
          model,
          sessionDir,
          sessionName: agentSessionName(input.workstreamId, agentId, input.title),
          task: input.task,
          thinkingLevel,
          workerExtensionPath,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(runtimeResult)) {
        const failedAt = yield* nowIso;
        const runtimeSettled = yield* settleFailedRuntimeLaunch(agentId);
        const cleanup = runtimeSettled
          ? yield* cleanupFailedLease(
              { agentId, managerId: state.managerId, repo: state.repo },
              lease,
            )
          : ('preserved_unverified' as const);
        if (cleanup === 'removed_clean') yield* rollbackProvisionalAgent(workstream, agentId);
        else
          yield* retainFailedAgentLease(
            agent,
            cleanup,
            failedAt,
            'Worker runtime launch failed after repository bootstrap succeeded.',
          );
        const error = Cause.squash(runtimeResult.cause);
        yield* callbacks.appendEventSafely(
          makeEvent(
            'agent_spawn_failed',
            `${failedLeaseSummary(agentId, lease.path, cleanup)} ${formatPardesError(error)}`,
            failedAt,
          ),
        );
        return yield* Effect.failCause(runtimeResult.cause);
      }
      const runtime = runtimeResult.value;
      callbacks.recordRuntime(agentId, runtime);
      const updatedAt = yield* nowIso;
      const persistResult = yield* namespace.store
        .mutate((current) => {
          const currentAgent = current.agents[agentId] ?? agent;
          return Effect.succeed([
            undefined,
            {
              ...current,
              agents: {
                ...current.agents,
                [agent.id]: {
                  ...currentAgent,
                  status: runtime.status,
                  ...(runtime.sessionFile ? { sessionFile: runtime.sessionFile } : {}),
                  updatedAt,
                },
              },
            },
          ] as const);
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(persistResult)) {
        yield* handleSpawnPersistenceFailure(state, workstream, agent, lease, persistResult.cause);
        return yield* Effect.failCause(persistResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeEvent('agent_spawned', `Started ${agent.id} (${runtime.status})`, updatedAt),
      );
      yield* callbacks.refresh(ctx);
      return yield* requirePersistedAgent(agentId);
    },
  );

  const revive: AgentAttachmentLifecycleCoordinatorShape['revive'] = Effect.fnUntraced(
    function* (agentId, message, workerExtensionPath, ctx) {
      yield* callbacks.refresh(ctx);
      const agent = namespace.state.agents[agentId];
      if (!agent) return yield* new AgentNotFoundError({ agentId });
      if (ATTACHED_STATUSES.has(agent.status))
        return yield* new AgentAlreadyRunningError({ agentId });
      if (!agent.worktree)
        return yield* new AgentCannotReviveError({
          agentId,
          reason: 'worker has no managed worktree lease',
        });
      yield* validateRetainedAgentState(namespace, agentId, agent);
      if (!agent.sessionFile)
        return yield* new AgentCannotReviveError({
          agentId,
          reason: 'worker has no persisted Pi session file',
        });
      yield* worktrees.inspect(managedLeaseOwner(namespace, agentId), agent.worktree);
      const startingAt = yield* nowIso;
      const lifecycleGeneration = (agent.lifecycleGeneration ?? 0) + 1;
      const cancelledIntent = namespace.state.workstreamCompletionIntents[
        agent.workstreamId
      ]?.pendingAgents.some((pending) => pending.agentId === agentId);
      yield* namespace.store.mutate((state) => {
        const currentAgent = state.agents[agentId] ?? agent;
        const workstreamCompletionIntents = { ...state.workstreamCompletionIntents };
        if (
          workstreamCompletionIntents[agent.workstreamId]?.pendingAgents.some(
            (pending) => pending.agentId === agentId,
          )
        )
          delete workstreamCompletionIntents[agent.workstreamId];
        const {
          latestReport: _latestReport,
          lastError: _lastError,
          terminalReportAwaitingIdle: _terminalReportAwaitingIdle,
          ...withoutPriorOutcome
        } = currentAgent;
        return Effect.succeed([
          undefined,
          {
            ...state,
            agents: {
              ...state.agents,
              [agentId]: {
                ...withoutPriorOutcome,
                lifecycleGeneration,
                status: 'starting',
                updatedAt: startingAt,
              },
            },
            workstreamCompletionIntents,
          },
        ] as const);
      });
      if (cancelledIntent)
        yield* callbacks.appendEventSafely(
          makeEvent(
            'workstream_completion_intent_cancelled',
            `Cancelled deferred completion for ${agent.workstreamId}: ${agentId} advanced to lifecycle generation ${lifecycleGeneration}.`,
            startingAt,
            { agentId, workstreamId: agent.workstreamId },
          ),
        );
      yield* callbacks.appendEventSafely(
        makeEvent(
          'agent_revive_started',
          `Reviving ${agentId} from ${agent.sessionFile} as lifecycle generation ${lifecycleGeneration}`,
          startingAt,
        ),
      );
      yield* callbacks.refresh(ctx);
      const runtimeResult = yield* workers
        .spawn({
          agentId,
          cwd: agent.worktree.path,
          lifecycleGeneration,
          model: agent.model,
          sessionDir: agent.sessionDir,
          sessionFile: agent.sessionFile,
          sessionName: agentSessionName(agent.workstreamId, agentId, agent.title),
          task: message,
          thinkingLevel: agent.thinkingLevel,
          workerExtensionPath,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(runtimeResult)) {
        const failedAt = yield* nowIso;
        const error = Cause.squash(runtimeResult.cause);
        yield* namespace.store.mutate((state) => {
          const currentAgent = state.agents[agentId] ?? agent;
          return Effect.succeed([
            undefined,
            {
              ...state,
              agents: {
                ...state.agents,
                [agentId]: { ...currentAgent, status: agent.status, updatedAt: failedAt },
              },
            },
          ] as const);
        });
        yield* callbacks.appendEventSafely(
          makeEvent(
            'agent_revive_failed',
            `Failed to revive ${agentId} as lifecycle generation ${lifecycleGeneration}: ${formatPardesError(error)}`,
            failedAt,
          ),
        );
        yield* callbacks.refresh(ctx);
        return yield* Effect.failCause(runtimeResult.cause);
      }
      const runtime = runtimeResult.value;
      callbacks.recordRuntime(agentId, runtime);
      const revivedAt = yield* nowIso;
      const persistResult = yield* namespace.store
        .mutate((current) => {
          const currentAgent = current.agents[agentId] ?? agent;
          const { lastError: _lastError, ...withoutLastError } = currentAgent;
          return Effect.succeed([
            undefined,
            {
              ...current,
              agents: {
                ...current.agents,
                [agentId]: {
                  ...withoutLastError,
                  status: runtime.status,
                  ...(runtime.sessionFile ? { sessionFile: runtime.sessionFile } : {}),
                  updatedAt: revivedAt,
                },
              },
            },
          ] as const);
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(persistResult)) {
        yield* handleRevivePersistenceFailure(agentId, agent.status, persistResult.cause);
        return yield* Effect.failCause(persistResult.cause);
      }
      yield* callbacks.appendEventSafely(
        makeEvent('agent_revived', `Revived ${agentId} (${runtime.status})`, revivedAt),
      );
      yield* callbacks.refresh(ctx);
      return yield* requirePersistedAgent(agentId);
    },
  );

  const stop: AgentAttachmentLifecycleCoordinatorShape['stop'] = Effect.fnUntraced(
    function* (agentId, ctx) {
      yield* callbacks.refresh(ctx);
      const agent = namespace.state.agents[agentId];
      if (!agent) return yield* new AgentNotFoundError({ agentId });
      const stoppedRuntime = yield* workers.stop(agentId);
      callbacks.recordRuntime(agentId, stoppedRuntime);
      const audit = yield* auditHandoffBestEffort(agent, 'stop');
      const timestamp = yield* nowIso;
      yield* namespace.store.mutate((current) => {
        const currentAgent = current.agents[agentId] ?? agent;
        return Effect.succeed([
          undefined,
          {
            ...current,
            agents: {
              ...current.agents,
              [agentId]: {
                ...applyHandoffAudit(currentAgent, audit),
                status: 'stopped',
                updatedAt: timestamp,
              },
            },
          },
        ] as const);
      });
      yield* callbacks.appendEventSafely(
        makeEvent(
          'agent_stopped',
          boundedEventSummary([
            `Stopped ${agentId}; managed worktree preserved.`,
            handoffAuditSuffix(audit),
          ]),
          timestamp,
        ),
      );
      yield* callbacks.refresh(ctx);
      return yield* requirePersistedAgent(agentId);
    },
  );

  const stopIfIdleForWorkstreamCompletion: AgentAttachmentLifecycleCoordinatorShape['stopIfIdleForWorkstreamCompletion'] =
    Effect.fnUntraced(function* (agentId, ctx) {
      yield* callbacks.refresh(ctx);
      const agent = namespace.state.agents[agentId];
      if (!agent) return yield* new AgentNotFoundError({ agentId });
      const stoppedRuntime = yield* workers.stopIfIdle(agentId);
      if (!stoppedRuntime || stoppedRuntime.status !== 'stopped') return undefined;
      callbacks.recordRuntime(agentId, stoppedRuntime);
      const audit = yield* auditHandoffBestEffort(agent, 'stop');
      const timestamp = yield* nowIso;
      yield* namespace.store.mutate((current) => {
        const currentAgent = current.agents[agentId] ?? agent;
        return Effect.succeed([
          undefined,
          {
            ...current,
            agents: {
              ...current.agents,
              [agentId]: {
                ...applyHandoffAudit(currentAgent, audit),
                status: 'stopped',
                updatedAt: timestamp,
              },
            },
          },
        ] as const);
      });
      yield* callbacks.appendEventSafely(
        makeEvent(
          'agent_workstream_completion_stopped',
          boundedEventSummary([
            `Stopped idle ${agentId} during explicit workstream completion; managed worktree, branch history, and session preserved.`,
            handoffAuditSuffix(audit),
          ]),
          timestamp,
          { agentId, workstreamId: agent.workstreamId },
        ),
      );
      yield* callbacks.refresh(ctx);
      return yield* requirePersistedAgent(agentId);
    });

  return AgentAttachmentLifecycleCoordinator.of({
    auditHandoffBestEffort,
    revive,
    spawn,
    stop,
    stopIfIdleForWorkstreamCompletion,
  });
}
