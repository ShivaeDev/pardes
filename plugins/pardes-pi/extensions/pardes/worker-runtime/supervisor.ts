import { Context, type Duration, Effect, Layer, Option, Schedule, Semaphore } from 'effect';
import { AgentAlreadyRunningError, AgentNotFoundError } from '../agent-errors.ts';
import {
  appendActivityLine,
  appendAssistantActivity,
  closeAssistantActivity,
  createWorkerActivityState,
  summarizeToolInvocation,
  visibleAssistantText,
  type WorkerActivityState,
} from './activity.ts';
import type { ChildLaunchProfile } from './child-profile.ts';
import { type WorkerProcessError, WorkerRpcError } from './errors.ts';
import { makeWorkerEventDispatcher } from './events.ts';
import { ensureWorkerSessionDirectory, type WorkerProcessOptions } from './process.ts';
import {
  boundedProtocolErrorMessage,
  type WorkerRpcResponse,
  type WorkerRpcState,
  WorkerRpcWire,
} from './rpc/codecs.ts';
import { openWorkerRpcSession, type WorkerRpcSession } from './rpc/session.ts';

export type WorkerStatus = 'starting' | 'running' | 'idle' | 'stopped' | 'crashed';
export type WorkerThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type WorkerSendBehavior = 'auto' | 'prompt' | 'steer' | 'followUp';
export type WorkerResolvedSendBehavior = Exclude<WorkerSendBehavior, 'auto'>;
export type WorkerQueueMode = 'all' | 'one-at-a-time';

export interface WorkerSendResult {
  readonly requestedBehavior: WorkerSendBehavior;
  readonly deliveredAs: WorkerResolvedSendBehavior;
}
export type WorkerCompactionReason = 'manual' | 'threshold' | 'overflow';

export interface WorkerCompactionCompletion {
  readonly reason: WorkerCompactionReason;
  readonly succeeded: boolean;
  readonly aborted: boolean;
  readonly willRetry: boolean;
  readonly tokensBefore?: number;
  readonly errorMessage?: string;
  readonly completedAt: number;
}

export interface WorkerSpawnInput {
  readonly agentId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly sessionName: string;
  readonly task: string;
  readonly model: string;
  readonly thinkingLevel: WorkerThinkingLevel;
  readonly workerExtensionPath?: string;
  readonly childProfile?: ChildLaunchProfile;
  /** Ephemeral launch ownership token used to reject delayed prior-generation events. */
  readonly lifecycleGeneration?: number;
}

export interface WorkerSessionStats {
  readonly totalMessages: number;
  readonly toolCalls: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
  readonly contextUsage?: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  };
}

export interface WorkerRuntimeSnapshot {
  readonly agentId: string;
  readonly status: WorkerStatus;
  readonly pid: number | undefined;
  readonly sessionFile: string | undefined;
  readonly stderr: string;
  readonly startedAt: number;
  readonly task: string;
  readonly model: string;
  readonly thinkingLevel: WorkerThinkingLevel;
  readonly stats: WorkerSessionStats | undefined;
  readonly sampledAt: number | undefined;
  readonly completedCompactionCount: number;
  /** Ephemeral launch ownership token; never persisted in manager state. */
  readonly lifecycleGeneration?: number;
  readonly totalActiveMs?: number;
  readonly currentAskElapsedMs?: number;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly autoCompactionEnabled?: boolean;
  readonly pendingMessageCount?: number;
  readonly steeringMode?: WorkerQueueMode;
  readonly followUpMode?: WorkerQueueMode;
  readonly steeringQueueCount?: number;
  readonly followUpQueueCount?: number;
  readonly compactionReason?: WorkerCompactionReason;
  readonly compactionStartedAt?: number;
  readonly lastCompaction?: WorkerCompactionCompletion;
  /** Ephemeral monitor preview. This projection is never persisted in manager state. */
  readonly recentActivityLines?: ReadonlyArray<string>;
}

interface WorkerSupervisorEventOwnership {
  /** Ephemeral launch ownership token used to reject delayed prior-generation events. */
  readonly lifecycleGeneration?: number;
}

export type WorkerSupervisorEvent =
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'status';
      readonly agentId: string;
      readonly status: WorkerStatus;
      readonly sessionFile?: string;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'telemetry';
      readonly agentId: string;
      readonly runtime: WorkerRuntimeSnapshot;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'compaction_completed';
      readonly agentId: string;
      readonly compaction: WorkerCompactionCompletion;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'report';
      readonly agentId: string;
      readonly status: 'progress' | 'completed' | 'blocked';
      readonly summary: string;
      readonly details?: string;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'question';
      readonly agentId: string;
      readonly question: string;
      readonly context?: string;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'unexpected_exit';
      readonly agentId: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: string;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'protocol_error';
      readonly agentId: string;
      readonly message: string;
    });

export interface WorkerSupervisorShape {
  readonly spawn: (
    input: WorkerSpawnInput,
  ) => Effect.Effect<WorkerRuntimeSnapshot, WorkerSupervisorError>;
  readonly send: (
    agentId: string,
    message: string,
    behavior: WorkerSendBehavior,
  ) => Effect.Effect<WorkerSendResult, WorkerSupervisorError>;
  readonly status: (agentId: string) => Effect.Effect<WorkerRuntimeSnapshot, AgentNotFoundError>;
  readonly stop: (agentId: string) => Effect.Effect<WorkerRuntimeSnapshot, AgentNotFoundError>;
  readonly stopIfIdle: (
    agentId: string,
  ) => Effect.Effect<WorkerRuntimeSnapshot | undefined, WorkerSupervisorError>;
  readonly shutdown: () => Effect.Effect<void>;
}

export interface GuardedWorkerSupervisorShape extends WorkerSupervisorShape {
  readonly compact: (
    agentId: string,
  ) => Effect.Effect<WorkerRuntimeSnapshot, WorkerSupervisorError>;
  readonly reload: (agentId: string) => Effect.Effect<WorkerRuntimeSnapshot, WorkerSupervisorError>;
}

export type WorkerSupervisorError =
  | AgentAlreadyRunningError
  | AgentNotFoundError
  | WorkerProcessError
  | WorkerRpcError;

export interface WorkerSupervisorOptions extends WorkerProcessOptions<WorkerSpawnInput> {
  readonly requestTimeoutMs?: number;
  readonly telemetryInterval?: Duration.Input;
  readonly now?: () => number;
  readonly onEvent?: (event: WorkerSupervisorEvent) => Effect.Effect<void, unknown>;
}

/** Caller-facing retained-conversation port with scope-owned production cleanup. */
export class WorkerSupervisor extends Context.Service<
  WorkerSupervisor,
  GuardedWorkerSupervisorShape
>()('pardes/worker-runtime/WorkerSupervisor') {
  static readonly layer = (options: WorkerSupervisorOptions = {}) =>
    Layer.effect(
      WorkerSupervisor,
      Effect.acquireRelease(
        Effect.sync(() => makeWorkerSupervisor(options)),
        (supervisor) => supervisor.shutdown(),
      ),
    );
}

interface Runtime {
  readonly input: WorkerSpawnInput;
  readonly session: WorkerRpcSession;
  readonly deliverySemaphore: Semaphore.Semaphore;
  readonly startedAt: number;
  status: WorkerStatus;
  sessionFile: string | undefined;
  stats: WorkerSessionStats | undefined;
  sampledAt: number | undefined;
  completedCompactionCount: number;
  totalActiveMs: number;
  currentAskStartedAt: number | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  pendingMessageCount: number;
  steeringMode: WorkerQueueMode;
  followUpMode: WorkerQueueMode;
  steeringQueueCount: number | undefined;
  followUpQueueCount: number | undefined;
  compactionReason: WorkerCompactionReason | undefined;
  compactionStartedAt: number | undefined;
  lastCompaction: WorkerCompactionCompletion | undefined;
  activity: WorkerActivityState;
  assistantActivitySawDelta: boolean;
  assistantActivityCapturedText: boolean;
  expectedExit: boolean;
}

function workerRpcError(agentId: string, command: string, cause: unknown): WorkerRpcError {
  return new WorkerRpcError({ agentId, cause, command });
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

/** Mirror Pi's post-compaction RPC state until the next sampled assistant usage is available. */
function recalibratingContextStats(
  stats: WorkerSessionStats | undefined,
): WorkerSessionStats | undefined {
  if (!stats?.contextUsage) return stats;
  return {
    ...stats,
    contextUsage: { ...stats.contextUsage, percent: null, tokens: null },
  };
}

function snapshot(runtime: Runtime, now: number): WorkerRuntimeSnapshot {
  const currentAskElapsedMs =
    runtime.currentAskStartedAt === undefined
      ? undefined
      : elapsedMs(runtime.currentAskStartedAt, now);
  return {
    agentId: runtime.input.agentId,
    completedCompactionCount: runtime.completedCompactionCount,
    model: runtime.input.model,
    pid: runtime.session.pid,
    sampledAt: runtime.sampledAt,
    sessionFile: runtime.sessionFile,
    startedAt: runtime.startedAt,
    stats: runtime.stats,
    status: runtime.status,
    stderr: runtime.session.stderr(),
    task: runtime.input.task,
    thinkingLevel: runtime.input.thinkingLevel,
    ...(runtime.input.lifecycleGeneration === undefined
      ? {}
      : { lifecycleGeneration: runtime.input.lifecycleGeneration }),
    autoCompactionEnabled: runtime.autoCompactionEnabled,
    compactionReason: runtime.compactionReason,
    compactionStartedAt: runtime.compactionStartedAt,
    currentAskElapsedMs,
    followUpMode: runtime.followUpMode,
    followUpQueueCount: runtime.followUpQueueCount,
    isCompacting: runtime.isCompacting,
    isStreaming: runtime.isStreaming,
    lastCompaction: runtime.lastCompaction,
    pendingMessageCount: runtime.pendingMessageCount,
    recentActivityLines: [...runtime.activity.recentActivityLines],
    steeringMode: runtime.steeringMode,
    steeringQueueCount: runtime.steeringQueueCount,
    totalActiveMs: runtime.totalActiveMs + (currentAskElapsedMs ?? 0),
  };
}

export function makeWorkerSupervisor(
  options: WorkerSupervisorOptions = {},
): GuardedWorkerSupervisorShape {
  const requestTimeoutMs = options.requestTimeoutMs ?? 5 * 60_000;
  const telemetryInterval = options.telemetryInterval ?? '500 millis';
  const now = options.now ?? Date.now;
  const runtimes = new Map<string, Runtime>();
  const eventDispatcher = makeWorkerEventDispatcher(options.onEvent);
  const notify = eventDispatcher.offer;

  const eventOwnership = (runtime: Runtime): WorkerSupervisorEventOwnership =>
    runtime.input.lifecycleGeneration === undefined
      ? {}
      : { lifecycleGeneration: runtime.input.lifecycleGeneration };

  const setStatus = (runtime: Runtime, status: WorkerStatus) => {
    if (runtime.status === status) return;
    const transitionedAt = now();
    if (runtime.currentAskStartedAt !== undefined && status !== 'running') {
      runtime.totalActiveMs += elapsedMs(runtime.currentAskStartedAt, transitionedAt);
      runtime.currentAskStartedAt = undefined;
    }
    if (runtime.status !== 'running' && status === 'running')
      runtime.currentAskStartedAt = transitionedAt;
    runtime.status = status;
    notify({
      agentId: runtime.input.agentId,
      sessionFile: runtime.sessionFile,
      status,
      type: 'status',
      ...eventOwnership(runtime),
    });
  };

  const emitTelemetry = (runtime: Runtime) => {
    notify({
      agentId: runtime.input.agentId,
      runtime: snapshot(runtime, now()),
      type: 'telemetry',
      ...eventOwnership(runtime),
    });
  };

  const notifyProtocolError = (runtime: Runtime, message: string) => {
    notify({
      agentId: runtime.input.agentId,
      message: boundedProtocolErrorMessage(message),
      type: 'protocol_error',
      ...eventOwnership(runtime),
    });
  };

  const reconcileState = (runtime: Runtime, state: WorkerRpcState) => {
    runtime.sessionFile = state.sessionFile ?? runtime.sessionFile;
    runtime.isStreaming = state.isStreaming;
    runtime.isCompacting = state.isCompacting;
    runtime.autoCompactionEnabled = state.autoCompactionEnabled;
    runtime.pendingMessageCount = state.pendingMessageCount;
    runtime.steeringMode = state.steeringMode;
    runtime.followUpMode = state.followUpMode;
    if (state.pendingMessageCount === 0) {
      runtime.steeringQueueCount = 0;
      runtime.followUpQueueCount = 0;
    } else if (
      (runtime.steeringQueueCount ?? 0) + (runtime.followUpQueueCount ?? 0) !==
      state.pendingMessageCount
    ) {
      runtime.steeringQueueCount = undefined;
      runtime.followUpQueueCount = undefined;
    }
    if (state.isStreaming) setStatus(runtime, 'running');
    else if (!state.isCompacting && runtime.status === 'running') setStatus(runtime, 'idle');
    if (!state.isCompacting) {
      runtime.compactionReason = undefined;
      runtime.compactionStartedAt = undefined;
    }
  };

  const onRpcEvent = (runtime: Runtime, event: unknown) => {
    const envelope = WorkerRpcWire.decodeEnvelope(event);
    if (Option.isNone(envelope)) return;

    if (envelope.value.type === 'message_start') {
      const decoded = WorkerRpcWire.decodeMessageStartEvent(event);
      if (Option.isNone(decoded)) {
        notifyProtocolError(runtime, 'Invalid message_start RPC event');
        return;
      }
      if (decoded.value.message.role !== 'assistant') return;
      const message = WorkerRpcWire.decodeAssistantMessage(decoded.value.message);
      if (Option.isNone(message)) {
        notifyProtocolError(runtime, 'Invalid assistant message_start RPC event');
        return;
      }
      runtime.activity = closeAssistantActivity(runtime.activity);
      runtime.assistantActivitySawDelta = false;
      runtime.assistantActivityCapturedText = false;
      return;
    }

    if (envelope.value.type === 'message_update') {
      const decoded = WorkerRpcWire.decodeMessageUpdateEvent(event);
      if (Option.isNone(decoded)) {
        notifyProtocolError(runtime, 'Invalid message_update RPC event');
        return;
      }
      const updateEnvelope = WorkerRpcWire.decodeAssistantMessageEventEnvelope(
        decoded.value.assistantMessageEvent,
      );
      if (Option.isNone(updateEnvelope)) {
        notifyProtocolError(runtime, 'Invalid assistant message_update RPC event');
        return;
      }
      if (updateEnvelope.value.type === 'text_start') {
        if (
          Option.isNone(
            WorkerRpcWire.decodeAssistantTextStartEvent(decoded.value.assistantMessageEvent),
          )
        ) {
          notifyProtocolError(runtime, 'Invalid text_start RPC event');
          return;
        }
        runtime.assistantActivitySawDelta = false;
        if (runtime.assistantActivityCapturedText)
          runtime.activity = appendAssistantActivity(runtime.activity, '\n');
        return;
      }
      if (updateEnvelope.value.type === 'text_delta') {
        const update = WorkerRpcWire.decodeAssistantTextDeltaEvent(
          decoded.value.assistantMessageEvent,
        );
        if (Option.isNone(update)) {
          notifyProtocolError(runtime, 'Invalid text_delta RPC event');
          return;
        }
        runtime.activity = appendAssistantActivity(runtime.activity, update.value.delta);
        runtime.assistantActivitySawDelta = true;
        runtime.assistantActivityCapturedText = true;
        emitTelemetry(runtime);
        return;
      }
      if (updateEnvelope.value.type === 'text_end') {
        const update = WorkerRpcWire.decodeAssistantTextEndEvent(
          decoded.value.assistantMessageEvent,
        );
        if (Option.isNone(update)) {
          notifyProtocolError(runtime, 'Invalid text_end RPC event');
          return;
        }
        if (!runtime.assistantActivitySawDelta) {
          runtime.activity = appendAssistantActivity(runtime.activity, update.value.content);
          runtime.assistantActivityCapturedText = true;
          emitTelemetry(runtime);
        }
        return;
      }
      return;
    }

    if (envelope.value.type === 'message_end') {
      const decoded = WorkerRpcWire.decodeMessageEndEvent(event);
      if (Option.isNone(decoded)) {
        notifyProtocolError(runtime, 'Invalid message_end RPC event');
        return;
      }
      if (decoded.value.message.role !== 'assistant') return;
      const message = WorkerRpcWire.decodeAssistantMessage(decoded.value.message);
      if (Option.isNone(message)) {
        notifyProtocolError(runtime, 'Invalid assistant message_end RPC event');
        return;
      }
      const text = visibleAssistantText(message.value);
      if (!runtime.assistantActivityCapturedText && text) {
        runtime.activity = appendAssistantActivity(runtime.activity, text);
        emitTelemetry(runtime);
      }
      runtime.activity = closeAssistantActivity(runtime.activity);
      return;
    }

    if (envelope.value.type === 'tool_execution_start') {
      const decoded = WorkerRpcWire.decodeToolExecutionStartEvent(event);
      if (Option.isNone(decoded)) {
        notifyProtocolError(runtime, 'Invalid tool_execution_start RPC event');
        return;
      }
      runtime.activity = closeAssistantActivity(runtime.activity);
      runtime.activity = appendActivityLine(
        runtime.activity,
        summarizeToolInvocation(decoded.value.toolName, decoded.value.args),
      );
      emitTelemetry(runtime);
      return;
    }

    if (envelope.value.type === 'agent_start') {
      if (Option.isNone(WorkerRpcWire.decodeAgentStartEvent(event))) {
        notifyProtocolError(runtime, 'Invalid agent_start RPC event');
        return;
      }
      runtime.isStreaming = true;
      setStatus(runtime, 'running');
      return;
    }

    if (envelope.value.type === 'agent_end') {
      if (Option.isNone(WorkerRpcWire.decodeAgentEndEvent(event))) {
        notifyProtocolError(runtime, 'Invalid agent_end RPC event');
        return;
      }
      runtime.isStreaming = false;
      setStatus(runtime, 'idle');
      return;
    }

    if (envelope.value.type === 'queue_update') {
      const decoded = WorkerRpcWire.decodeQueueUpdateEvent(event);
      if (Option.isNone(decoded)) {
        notifyProtocolError(runtime, 'Invalid queue_update RPC event');
        return;
      }
      runtime.steeringQueueCount = decoded.value.steering.length;
      runtime.followUpQueueCount = decoded.value.followUp.length;
      runtime.pendingMessageCount = runtime.steeringQueueCount + runtime.followUpQueueCount;
      emitTelemetry(runtime);
      return;
    }

    if (envelope.value.type === 'compaction_start') {
      const decoded = WorkerRpcWire.decodeCompactionStartEvent(event);
      if (Option.isNone(decoded)) {
        notifyProtocolError(runtime, 'Invalid compaction_start RPC event');
        return;
      }
      runtime.isCompacting = true;
      runtime.compactionReason = decoded.value.reason;
      runtime.compactionStartedAt = now();
      emitTelemetry(runtime);
      return;
    }

    if (envelope.value.type === 'compaction_end') {
      const decoded = WorkerRpcWire.decodeCompactionEndEvent(event);
      if (Option.isNone(decoded)) {
        notifyProtocolError(runtime, 'Invalid compaction_end RPC event');
        return;
      }
      const compaction: WorkerCompactionCompletion = {
        aborted: decoded.value.aborted,
        reason: decoded.value.reason,
        succeeded: decoded.value.result !== undefined && decoded.value.result !== null,
        willRetry: decoded.value.willRetry,
        ...(decoded.value.result && { tokensBefore: decoded.value.result.tokensBefore }),
        ...(decoded.value.errorMessage === undefined
          ? {}
          : { errorMessage: decoded.value.errorMessage }),
        completedAt: now(),
      };
      runtime.isCompacting = false;
      runtime.compactionReason = undefined;
      runtime.compactionStartedAt = undefined;
      runtime.lastCompaction = compaction;
      runtime.completedCompactionCount += 1;
      if (compaction.succeeded) runtime.stats = recalibratingContextStats(runtime.stats);
      emitTelemetry(runtime);
      notify({
        agentId: runtime.input.agentId,
        compaction,
        type: 'compaction_completed',
        ...eventOwnership(runtime),
      });
      return;
    }

    if (envelope.value.type !== 'tool_execution_end') return;
    const decoded = WorkerRpcWire.decodeToolExecutionEndEvent(event);
    if (Option.isNone(decoded)) {
      notifyProtocolError(runtime, 'Invalid tool_execution_end RPC event');
      return;
    }
    if (
      decoded.value.isError ||
      (decoded.value.toolName !== 'report_to_manager' && decoded.value.toolName !== 'ask_manager')
    )
      return;
    const result = WorkerRpcWire.decodePardesWorkerToolResult(decoded.value.result);
    if (Option.isNone(result)) {
      notifyProtocolError(runtime, `Invalid ${decoded.value.toolName} Pardes payload`);
      return;
    }
    if (decoded.value.toolName === 'report_to_manager') {
      const payload = WorkerRpcWire.decodePardesReportPayload(result.value.details.pardesWorker);
      if (Option.isNone(payload)) {
        notifyProtocolError(runtime, 'Invalid report_to_manager Pardes payload');
        return;
      }
      notify({
        agentId: runtime.input.agentId,
        details: payload.value.details,
        status: payload.value.status,
        summary: payload.value.summary,
        type: 'report',
        ...eventOwnership(runtime),
      });
      return;
    }
    const payload = WorkerRpcWire.decodePardesQuestionPayload(result.value.details.pardesWorker);
    if (Option.isNone(payload)) {
      notifyProtocolError(runtime, 'Invalid ask_manager Pardes payload');
      return;
    }
    notify({
      agentId: runtime.input.agentId,
      context: payload.value.context,
      question: payload.value.question,
      type: 'question',
      ...eventOwnership(runtime),
    });
  };

  const attachSession = (runtime: Runtime) => {
    runtime.session.start({
      onExit: (exitCode, signal, stderr) => {
        runtime.isStreaming = false;
        runtime.isCompacting = false;
        runtime.compactionReason = undefined;
        runtime.compactionStartedAt = undefined;
        if (runtime.expectedExit) {
          setStatus(runtime, 'stopped');
          return;
        }
        setStatus(runtime, 'crashed');
        notify({
          agentId: runtime.input.agentId,
          exitCode,
          signal,
          stderr,
          type: 'unexpected_exit',
          ...eventOwnership(runtime),
        });
        void Effect.runPromise(runtime.session.close);
      },
      onProtocolError: (message) => notifyProtocolError(runtime, message),
      onValue: (event) => onRpcEvent(runtime, event),
    });
  };

  const request = (
    runtime: Runtime,
    rpcCommand: Record<string, unknown>,
  ): Effect.Effect<WorkerRpcResponse, WorkerRpcError> => runtime.session.request(rpcCommand);

  const getState = Effect.fnUntraced(function* (runtime: Runtime) {
    const response = yield* request(runtime, { type: 'get_state' });
    return yield* WorkerRpcWire.decodeState(response.data).pipe(
      Effect.mapError((cause) => workerRpcError(runtime.input.agentId, 'decode get_state', cause)),
    );
  });

  const sampleTelemetry = Effect.fnUntraced(function* (runtime: Runtime) {
    const [state, statsResponse] = yield* Effect.all(
      [getState(runtime), request(runtime, { type: 'get_session_stats' })],
      { concurrency: 'unbounded' },
    );
    const stats = yield* WorkerRpcWire.decodeSessionStats(statsResponse.data).pipe(
      Effect.mapError((cause) =>
        workerRpcError(runtime.input.agentId, 'decode get_session_stats', cause),
      ),
    );
    reconcileState(runtime, state);
    runtime.stats = stats;
    runtime.sampledAt = now();
    emitTelemetry(runtime);
  });

  const startTelemetry = (runtime: Runtime) =>
    sampleTelemetry(runtime).pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced(telemetryInterval)),
      runtime.session.forkInScope,
    );

  const stopRuntime = (runtime: Runtime) =>
    Effect.gen(function* () {
      if (runtime.status === 'stopped' || runtime.status === 'crashed')
        return snapshot(runtime, now());
      runtime.expectedExit = true;
      yield* runtime.session.close;
      runtime.isStreaming = false;
      runtime.isCompacting = false;
      runtime.compactionReason = undefined;
      runtime.compactionStartedAt = undefined;
      setStatus(runtime, 'stopped');
      return snapshot(runtime, now());
    });

  const launchWorker = (
    input: WorkerSpawnInput,
    initialPrompt: string | undefined,
  ): Effect.Effect<WorkerRuntimeSnapshot, WorkerSupervisorError> =>
    Effect.gen(function* () {
      const previous = runtimes.get(input.agentId);
      if (previous && previous.status !== 'stopped' && previous.status !== 'crashed') {
        return yield* new AgentAlreadyRunningError({ agentId: input.agentId });
      }
      yield* ensureWorkerSessionDirectory(input);
      yield* eventDispatcher.start;
      const session = yield* openWorkerRpcSession(input, { ...options, requestTimeoutMs });
      const runtime: Runtime = {
        activity: createWorkerActivityState(),
        assistantActivityCapturedText: false,
        assistantActivitySawDelta: false,
        autoCompactionEnabled: false,
        compactionReason: undefined,
        compactionStartedAt: undefined,
        completedCompactionCount: 0,
        currentAskStartedAt: undefined,
        deliverySemaphore: Semaphore.makeUnsafe(1),
        expectedExit: false,
        followUpMode: 'one-at-a-time',
        followUpQueueCount: undefined,
        input,
        isCompacting: false,
        isStreaming: false,
        lastCompaction: undefined,
        pendingMessageCount: 0,
        sampledAt: undefined,
        session,
        sessionFile: undefined,
        startedAt: now(),
        stats: undefined,
        status: 'starting',
        steeringMode: 'one-at-a-time',
        steeringQueueCount: undefined,
        totalActiveMs: 0,
      };
      runtimes.set(input.agentId, runtime);
      attachSession(runtime);
      notify({
        agentId: input.agentId,
        status: 'starting',
        type: 'status',
        ...eventOwnership(runtime),
      });
      return yield* Effect.gen(function* () {
        reconcileState(runtime, yield* getState(runtime));
        yield* request(runtime, { name: input.sessionName, type: 'set_session_name' });
        yield* request(runtime, { mode: 'one-at-a-time', type: 'set_steering_mode' });
        runtime.steeringMode = 'one-at-a-time';
        yield* request(runtime, { mode: 'one-at-a-time', type: 'set_follow_up_mode' });
        runtime.followUpMode = 'one-at-a-time';
        if (initialPrompt === undefined) {
          if (!runtime.isStreaming && !runtime.isCompacting) setStatus(runtime, 'idle');
        } else {
          yield* request(runtime, { message: initialPrompt, type: 'prompt' });
        }
        yield* startTelemetry(runtime);
        return snapshot(runtime, now());
      }).pipe(Effect.tapError(() => stopRuntime(runtime)));
    });

  const spawnWorker: WorkerSupervisorShape['spawn'] = (input) => launchWorker(input, input.task);

  const send: WorkerSupervisorShape['send'] = (agentId, message, behavior) =>
    Effect.gen(function* () {
      const runtime = runtimes.get(agentId);
      if (!runtime || runtime.status === 'stopped' || runtime.status === 'crashed')
        return yield* new AgentNotFoundError({ agentId });
      return yield* runtime.deliverySemaphore.withPermit(
        Effect.gen(function* () {
          if (
            runtimes.get(agentId) !== runtime ||
            runtime.status === 'stopped' ||
            runtime.status === 'crashed'
          ) {
            return yield* new AgentNotFoundError({ agentId });
          }
          const state = yield* getState(runtime);
          reconcileState(runtime, state);
          emitTelemetry(runtime);
          if (state.isCompacting) {
            return yield* workerRpcError(
              agentId,
              behavior,
              'Worker is compacting; retry after compaction completes.',
            );
          }
          const deliveredAs: WorkerResolvedSendBehavior =
            behavior === 'auto'
              ? state.isStreaming
                ? 'followUp'
                : state.pendingMessageCount === 0
                  ? 'prompt'
                  : yield* workerRpcError(
                      agentId,
                      behavior,
                      'Worker is idle with pending queued messages; retry after queue drain.',
                    )
              : behavior;
          if (deliveredAs === 'prompt' && (state.isStreaming || state.pendingMessageCount > 0)) {
            return yield* workerRpcError(
              agentId,
              behavior,
              state.isStreaming
                ? 'Worker is active; use auto, steer, or followUp instead of prompt.'
                : 'Worker has pending queued messages; wait for queue drain before prompt.',
            );
          }
          if (deliveredAs !== 'prompt' && !state.isStreaming) {
            return yield* workerRpcError(
              agentId,
              behavior,
              `Worker is idle; use auto or prompt instead of ${deliveredAs}.`,
            );
          }
          const command =
            deliveredAs === 'followUp'
              ? { message, type: 'follow_up' }
              : deliveredAs === 'steer'
                ? { message, type: 'steer' }
                : { message, type: 'prompt' };
          // Pi has no conditional direct prompt/steer/follow-up RPC command. Auto
          // routing uses the closest fresh RPC state under a per-worker permit; a
          // stream may still transition before acceptance, leaving only that
          // bounded RPC transition window.
          yield* request(runtime, command);
          return { deliveredAs, requestedBehavior: behavior };
        }),
      );
    });

  const withIdleRuntime = <A>(
    agentId: string,
    operation: 'compact' | 'reload',
    action: (runtime: Runtime) => Effect.Effect<A, WorkerSupervisorError>,
  ): Effect.Effect<A, WorkerSupervisorError> =>
    Effect.gen(function* () {
      const runtime = runtimes.get(agentId);
      if (!runtime || runtime.status === 'stopped' || runtime.status === 'crashed')
        return yield* new AgentNotFoundError({ agentId });
      return yield* runtime.deliverySemaphore.withPermit(
        Effect.gen(function* () {
          if (
            runtimes.get(agentId) !== runtime ||
            runtime.status === 'stopped' ||
            runtime.status === 'crashed'
          ) {
            return yield* new AgentNotFoundError({ agentId });
          }
          const state = yield* getState(runtime);
          reconcileState(runtime, state);
          emitTelemetry(runtime);
          if (state.isCompacting) {
            return yield* workerRpcError(
              agentId,
              operation,
              'Worker is compacting; retry after compaction completes.',
            );
          }
          if (state.isStreaming) {
            return yield* workerRpcError(
              agentId,
              operation,
              `Worker is active; wait for idle before ${operation}.`,
            );
          }
          if (state.pendingMessageCount > 0) {
            return yield* workerRpcError(
              agentId,
              operation,
              `Worker has pending queued messages; wait for queue drain before ${operation}.`,
            );
          }
          return yield* action(runtime);
        }),
      );
    });

  const compact: GuardedWorkerSupervisorShape['compact'] = (agentId) =>
    withIdleRuntime(agentId, 'compact', (runtime) =>
      request(runtime, { type: 'compact' }).pipe(Effect.map(() => snapshot(runtime, now()))),
    );

  const reload: GuardedWorkerSupervisorShape['reload'] = (agentId) =>
    withIdleRuntime(agentId, 'reload', (runtime) =>
      Effect.gen(function* () {
        if (!runtime.sessionFile)
          return yield* workerRpcError(
            agentId,
            'reload',
            'Worker has no retained Pi session file to reload.',
          );
        const retainedInput: WorkerSpawnInput = {
          ...runtime.input,
          sessionFile: runtime.sessionFile,
        };
        yield* stopRuntime(runtime);
        return yield* launchWorker(retainedInput, undefined);
      }),
    );

  const status: WorkerSupervisorShape['status'] = (agentId) => {
    const runtime = runtimes.get(agentId);
    return runtime
      ? Effect.succeed(snapshot(runtime, now()))
      : Effect.fail(new AgentNotFoundError({ agentId }));
  };

  const stop: WorkerSupervisorShape['stop'] = (agentId) => {
    const runtime = runtimes.get(agentId);
    return runtime ? stopRuntime(runtime) : Effect.fail(new AgentNotFoundError({ agentId }));
  };

  const stopIfIdle: WorkerSupervisorShape['stopIfIdle'] = (agentId) => {
    const runtime = runtimes.get(agentId);
    if (!runtime) return Effect.fail(new AgentNotFoundError({ agentId }));
    if (runtime.status === 'stopped' || runtime.status === 'crashed')
      return Effect.succeed(snapshot(runtime, now()));
    return runtime.deliverySemaphore.withPermit(
      Effect.gen(function* () {
        reconcileState(runtime, yield* getState(runtime));
        emitTelemetry(runtime);
        if (
          runtime.status !== 'idle' ||
          runtime.isStreaming ||
          runtime.isCompacting ||
          runtime.pendingMessageCount > 0
        )
          return undefined;
        runtime.expectedExit = true;
        return yield* stopRuntime(runtime);
      }),
    );
  };

  const shutdown = () =>
    Effect.gen(function* () {
      yield* Effect.forEach(runtimes.values(), stopRuntime, { discard: true });
      yield* eventDispatcher.shutdown;
    });

  return { compact, reload, send, shutdown, spawn: spawnWorker, status, stop, stopIfIdle };
}
