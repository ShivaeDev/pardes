import { Effect, Exit, Option, Scope } from 'effect';
import type { WorkerProcessError, WorkerRpcError } from '../errors.ts';
import {
  spawnWorkerProcess,
  type WorkerProcessInput,
  type WorkerProcessOptions,
} from '../process.ts';
import { type WorkerRpcResponse, WorkerRpcWire } from './codecs.ts';
import { attachWorkerRpcJsonl } from './jsonl.ts';
import { makeWorkerRpcRequestCorrelator } from './requests.ts';

export interface WorkerRpcSessionCallbacks {
  readonly onValue: (event: unknown) => void;
  readonly onProtocolError: (message: string) => void;
  readonly onExit: (exitCode: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
}

export interface WorkerRpcSession {
  readonly pid: number | undefined;
  readonly request: (
    rpcCommand: Record<string, unknown>,
  ) => Effect.Effect<WorkerRpcResponse, WorkerRpcError>;
  readonly start: (callbacks: WorkerRpcSessionCallbacks) => void;
  readonly stderr: () => string;
  readonly forkInScope: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface WorkerRpcSessionOptions<Input extends WorkerProcessInput>
  extends WorkerProcessOptions<Input> {
  readonly requestTimeoutMs: number;
}

/**
 * Open one retained Pi RPC session resource.
 *
 * The session owns the child-process scope, transport framing, stdin request
 * correlation, pending-request failure on exit, and bounded stderr tail. The
 * supervisor remains responsible for retained-conversation policy and decides
 * how session events affect worker state.
 */
export function openWorkerRpcSession<Input extends WorkerProcessInput>(
  input: Input,
  options: WorkerRpcSessionOptions<Input>,
): Effect.Effect<WorkerRpcSession, WorkerProcessError> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const child = yield* spawnWorkerProcess(input, options).pipe(
      Scope.provide(scope),
      Effect.tapError(() => Scope.close(scope, Exit.void)),
    );
    const rpcRequests = makeWorkerRpcRequestCorrelator({
      agentId: input.agentId,
      requestTimeoutMs: options.requestTimeoutMs,
      stdin: child.stdin,
    });
    let stderr = '';
    let started = false;

    const start = (callbacks: WorkerRpcSessionCallbacks) => {
      if (started) return;
      started = true;
      attachWorkerRpcJsonl(child.stdout, {
        onProtocolError: callbacks.onProtocolError,
        onValue: (event) => {
          const envelope = WorkerRpcWire.decodeEnvelope(event);
          if (Option.isSome(envelope) && envelope.value.type === 'response') {
            if (rpcRequests.handleResponse(event) === 'invalid_uncorrelated_response') {
              callbacks.onProtocolError('Invalid response RPC message');
            }
            return;
          }
          callbacks.onValue(event);
        },
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4_000);
      });
      child.on('error', (cause) => {
        callbacks.onProtocolError(`Child process error: ${cause.message}`);
      });
      child.on('exit', (exitCode, signal) => {
        rpcRequests.failPending(
          `Worker exited with code ${String(exitCode)} and signal ${String(signal)}`,
        );
        callbacks.onExit(exitCode, signal, stderr);
      });
    };

    return {
      close: Scope.close(scope, Exit.void),
      forkInScope: (effect) =>
        effect.pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid),
      pid: child.pid,
      request: rpcRequests.request,
      start,
      stderr: () => stderr,
    };
  });
}
