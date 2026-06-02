import { Context, type Duration, Effect, Layer, Schedule } from 'effect';
import { AgentAlreadyRunningError, AgentNotFoundError } from '../agent-errors.ts';
import type { WorkerProtocolDiagnostic } from './diagnostics.ts';
import { type WorkerProcessError, WorkerRpcError } from './errors.ts';
import { makeWorkerEventDispatcher } from './events.ts';
import { ensureWorkerSessionDirectory, type WorkerProcessOptions } from './process.ts';
import {
  makeRetainedWorkerRuntime,
  type RetainedWorkerRuntime,
  reconcileRetainedWorkerRpcState,
  resetRetainedWorkerBusyState,
  runtimeEventOwnership,
  snapshotRetainedWorkerRuntime,
  transitionRetainedWorkerStatus,
  type WorkerResolvedSendBehavior,
  type WorkerRuntimeSnapshot,
  type WorkerSendBehavior,
  type WorkerSendResult,
  type WorkerSpawnInput,
  type WorkerStatus,
  type WorkerSupervisorEvent,
} from './retained-runtime.ts';
import {
  rpcPayloadDiagnostic,
  type WorkerRpcResponse,
  type WorkerRpcState,
  WorkerRpcWire,
} from './rpc/codecs.ts';
import { openWorkerRpcSession } from './rpc/session.ts';
import { makeWorkerRpcEventHandler } from './rpc-events.ts';

export type {
  WorkerCompactionCompletion,
  WorkerCompactionReason,
  WorkerQueueMode,
  WorkerResolvedSendBehavior,
  WorkerRuntimeSnapshot,
  WorkerSendBehavior,
  WorkerSendResult,
  WorkerSessionStats,
  WorkerSpawnInput,
  WorkerStatus,
  WorkerSupervisorEvent,
  WorkerThinkingLevel,
} from './retained-runtime.ts';

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

function workerRpcError(agentId: string, command: string, cause: unknown): WorkerRpcError {
  return new WorkerRpcError({ agentId, cause, command });
}

export function makeWorkerSupervisor(
  options: WorkerSupervisorOptions = {},
): GuardedWorkerSupervisorShape {
  const requestTimeoutMs = options.requestTimeoutMs ?? 5 * 60_000;
  const telemetryInterval = options.telemetryInterval ?? '500 millis';
  const now = options.now ?? Date.now;
  const runtimes = new Map<string, RetainedWorkerRuntime>();
  const eventDispatcher = makeWorkerEventDispatcher<WorkerSupervisorEvent>(options.onEvent);
  const notify = eventDispatcher.offer;

  const setStatus = (runtime: RetainedWorkerRuntime, status: WorkerStatus) => {
    if (runtime.status === status) return;
    transitionRetainedWorkerStatus(runtime, status, now(), notify);
  };

  const emitTelemetry = (runtime: RetainedWorkerRuntime) => {
    notify({
      agentId: runtime.input.agentId,
      runtime: snapshotRetainedWorkerRuntime(runtime, now()),
      type: 'telemetry',
      ...runtimeEventOwnership(runtime),
    });
  };

  const notifyProtocolError = (
    runtime: RetainedWorkerRuntime,
    diagnostic: WorkerProtocolDiagnostic | string,
    originalChars?: number,
  ) => {
    notify({
      agentId: runtime.input.agentId,
      diagnostic:
        typeof diagnostic === 'string'
          ? rpcPayloadDiagnostic(diagnostic, originalChars)
          : diagnostic,
      type: 'protocol_error',
      ...runtimeEventOwnership(runtime),
    });
  };

  const reconcileState = (runtime: RetainedWorkerRuntime, state: WorkerRpcState) =>
    reconcileRetainedWorkerRpcState(runtime, state, setStatus);

  const onRpcEvent = makeWorkerRpcEventHandler({
    emitTelemetry,
    notify,
    notifyProtocolError,
    now,
    setStatus,
  });

  const attachSession = (runtime: RetainedWorkerRuntime) => {
    runtime.session.start({
      onExit: (exitCode, signal, stderr) => {
        resetRetainedWorkerBusyState(runtime);
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
          ...runtimeEventOwnership(runtime),
        });
        void Effect.runPromise(runtime.session.close);
      },
      onProtocolError: (message) => notifyProtocolError(runtime, message),
      onValue: (event, record) => onRpcEvent(runtime, event, record),
    });
  };

  const request = (
    runtime: RetainedWorkerRuntime,
    rpcCommand: Record<string, unknown>,
  ): Effect.Effect<WorkerRpcResponse, WorkerRpcError> => runtime.session.request(rpcCommand);

  const getState = Effect.fnUntraced(function* (runtime: RetainedWorkerRuntime) {
    const response = yield* request(runtime, { type: 'get_state' });
    return yield* WorkerRpcWire.decodeState(response.data).pipe(
      Effect.mapError((cause) => workerRpcError(runtime.input.agentId, 'decode get_state', cause)),
    );
  });

  const sampleTelemetry = Effect.fnUntraced(function* (runtime: RetainedWorkerRuntime) {
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

  const startTelemetry = (runtime: RetainedWorkerRuntime) =>
    sampleTelemetry(runtime).pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced(telemetryInterval)),
      runtime.session.forkInScope,
    );

  const stopRuntime = (runtime: RetainedWorkerRuntime) =>
    Effect.gen(function* () {
      if (runtime.status === 'stopped' || runtime.status === 'crashed')
        return snapshotRetainedWorkerRuntime(runtime, now());
      runtime.expectedExit = true;
      yield* runtime.session.close;
      resetRetainedWorkerBusyState(runtime);
      setStatus(runtime, 'stopped');
      return snapshotRetainedWorkerRuntime(runtime, now());
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
      const runtime = makeRetainedWorkerRuntime(input, session, now());
      runtimes.set(input.agentId, runtime);
      attachSession(runtime);
      notify({
        agentId: input.agentId,
        status: 'starting',
        type: 'status',
        ...runtimeEventOwnership(runtime),
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
        return snapshotRetainedWorkerRuntime(runtime, now());
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
    action: (runtime: RetainedWorkerRuntime) => Effect.Effect<A, WorkerSupervisorError>,
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
      request(runtime, { type: 'compact' }).pipe(
        Effect.map(() => snapshotRetainedWorkerRuntime(runtime, now())),
      ),
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
      ? Effect.succeed(snapshotRetainedWorkerRuntime(runtime, now()))
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
      return Effect.succeed(snapshotRetainedWorkerRuntime(runtime, now()));
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
