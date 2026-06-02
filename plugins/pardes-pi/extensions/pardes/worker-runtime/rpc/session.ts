import { StringDecoder } from 'node:string_decoder';
import { Effect, Exit, Option, Scope } from 'effect';
import {
  appendWorkerStderrTail,
  emptyWorkerStderrTail,
  type WorkerProtocolDiagnostic,
  type WorkerRpcRecordMetadata,
  type WorkerStderrTail,
  workerProtocolDiagnostic,
} from '../diagnostics.ts';
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
  readonly onValue: (event: unknown, record: WorkerRpcRecordMetadata) => void;
  readonly onProtocolError: (diagnostic: WorkerProtocolDiagnostic) => void;
  readonly onExit: (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: WorkerStderrTail,
  ) => void;
}

export interface WorkerRpcSession {
  readonly pid: number | undefined;
  readonly request: (
    rpcCommand: Record<string, unknown>,
  ) => Effect.Effect<WorkerRpcResponse, WorkerRpcError>;
  readonly start: (callbacks: WorkerRpcSessionCallbacks) => void;
  readonly stderr: () => WorkerStderrTail;
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
    let stderr = emptyWorkerStderrTail();
    const stderrDecoder = new StringDecoder('utf8');
    let stderrDecoderFlushed = false;
    let started = false;

    const appendStderr = (text: string) => {
      if (text) stderr = appendWorkerStderrTail(stderr, text);
    };
    const flushStderr = () => {
      if (stderrDecoderFlushed) return;
      stderrDecoderFlushed = true;
      appendStderr(stderrDecoder.end());
    };

    const start = (callbacks: WorkerRpcSessionCallbacks) => {
      if (started) return;
      started = true;
      attachWorkerRpcJsonl(child.stdout, {
        onProtocolError: callbacks.onProtocolError,
        onValue: (event, record) => {
          const envelope = WorkerRpcWire.decodeEnvelope(event);
          if (Option.isSome(envelope) && envelope.value.type === 'response') {
            if (rpcRequests.handleResponse(event) === 'invalid_uncorrelated_response') {
              callbacks.onProtocolError(
                workerProtocolDiagnostic(
                  'invalid_response',
                  'RPC response could not be correlated or decoded; response content was discarded.',
                  record.originalChars,
                ),
              );
            }
            return;
          }
          callbacks.onValue(event, record);
        },
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        appendStderr(typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk));
      });
      child.stderr.on('end', flushStderr);
      child.on('error', (cause) => {
        callbacks.onProtocolError(
          workerProtocolDiagnostic(
            'runtime_process_error',
            'Retained child process emitted an error; arbitrary process text was omitted.',
            cause.message.length,
          ),
        );
      });
      child.on('close', (exitCode, signal) => {
        flushStderr();
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
