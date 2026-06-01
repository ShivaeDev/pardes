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
import type {
  GuardedWorkerSupervisorShape,
  WorkerRuntimeSnapshot,
  WorkerSupervisorError,
  WorkerThinkingLevel,
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
  return `Failed to start ${agentId}; preserved managed worktree ${leasePath} after cleanup verification failed.`;
}

function leaseCleanupSummary(leasePath: string, cleanup: FailedLeaseCleanup): string {
  if (cleanup === 'removed_clean') return `Removed clean managed worktree ${leasePath}.`;
  if (cleanup === 'preserved_dirty') return `Preserved dirty managed worktree ${leasePath}.`;
  return `Preserved managed worktree ${leasePath} because cleanup could not be verified.`;
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
  readonly callbacks: AgentAttachmentLifecycleCoordinatorCallbacks;
}

export function makeAgentAttachmentLifecycleCoordinator(
  options: AgentAttachmentLifecycleCoordinatorOptions,
): AgentAttachmentLifecycleCoordinatorShape {
  const { namespace, worktrees, workers, callbacks } = options;

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
      const result = yield* validateRetainedAgentState(namespace, agent.id, agent).pipe(
        Effect.flatMap(() => worktrees.inspect(managedLeaseOwner(namespace, agent.id), worktree)),
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
    yield* workers.stop(agentId).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            `Pardes failed to stop unattached worker runtime ${agentId} after persistence failure`,
            error,
          );
        }),
      ),
    );
    callbacks.resumeWorkerEvents(agentId);
    callbacks.forgetRuntime(agentId);
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

  const handleSpawnPersistenceFailure = Effect.fnUntraced(function* (
    state: ManagerState,
    workstream: Workstream,
    agentId: string,
    lease: NonNullable<AgentRecord['worktree']>,
    cause: Cause.Cause<unknown>,
  ) {
    yield* stopUnpersistedRuntime(agentId);
    yield* rollbackProvisionalAgent(workstream, agentId);
    const cleanup = yield* cleanupFailedLease(
      { agentId, managerId: state.managerId, repo: state.repo },
      lease,
    );
    const timestamp = yield* nowIso;
    yield* callbacks.appendEventSafely(
      makeEvent(
        'agent_spawn_persist_failed',
        `Started ${agentId} but failed to persist the runtime; stopped the unattached worker. ${leaseCleanupSummary(lease.path, cleanup)} ${formatPardesError(Cause.squash(cause))}`,
        timestamp,
      ),
    );
  });

  const handleRevivePersistenceFailure = Effect.fnUntraced(function* (
    agentId: string,
    cause: Cause.Cause<unknown>,
  ) {
    yield* stopUnpersistedRuntime(agentId);
    const timestamp = yield* nowIso;
    yield* callbacks.appendEventSafely(
      makeEvent(
        'agent_revive_persist_failed',
        `Revived ${agentId} but failed to persist the runtime; stopped the unattached worker. ${formatPardesError(Cause.squash(cause))}`,
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
        model,
        role: 'worker',
        sessionDir,
        status: 'starting',
        task: input.task,
        thinkingLevel,
        updatedAt: timestamp,
        workstreamId: input.workstreamId,
        worktree: lease,
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
      const runtimeResult = yield* workers
        .spawn({
          agentId,
          cwd: lease.path,
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
        yield* rollbackProvisionalAgent(workstream, agentId);
        const cleanup = yield* cleanupFailedLease(
          { agentId, managerId: state.managerId, repo: state.repo },
          lease,
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
        yield* handleSpawnPersistenceFailure(
          state,
          workstream,
          agentId,
          lease,
          persistResult.cause,
        );
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
      yield* callbacks.appendEventSafely(
        makeEvent(
          'agent_revive_started',
          `Reviving ${agentId} from ${agent.sessionFile}`,
          startingAt,
        ),
      );
      const runtimeResult = yield* workers
        .spawn({
          agentId,
          cwd: agent.worktree.path,
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
        yield* callbacks.appendEventSafely(
          makeEvent(
            'agent_revive_failed',
            `Failed to revive ${agentId}: ${formatPardesError(error)}`,
            failedAt,
          ),
        );
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
        yield* handleRevivePersistenceFailure(agentId, persistResult.cause);
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

  return AgentAttachmentLifecycleCoordinator.of({ auditHandoffBestEffort, revive, spawn, stop });
}
