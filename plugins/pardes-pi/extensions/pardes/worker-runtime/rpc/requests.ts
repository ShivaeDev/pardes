import { randomUUID } from 'node:crypto';
import { Effect, Option } from 'effect';
import { WorkerRpcError } from '../errors.ts';
import { type WorkerRpcResponse, WorkerRpcWire } from './codecs.ts';

interface WorkerRpcRequestStdin {
  readonly write: (chunk: string, callback: (cause?: Error | null) => void) => unknown;
}

interface WorkerRpcRequestCorrelatorOptions {
  readonly agentId: string;
  readonly stdin: WorkerRpcRequestStdin;
  readonly requestTimeoutMs: number;
}

interface PendingRequest {
  readonly command: string;
  readonly resume: (effect: Effect.Effect<unknown, WorkerRpcError>) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function workerRpcError(agentId: string, command: string, cause: unknown): WorkerRpcError {
  return new WorkerRpcError({ agentId, cause, command });
}

export function makeWorkerRpcRequestCorrelator({
  agentId,
  stdin,
  requestTimeoutMs,
}: WorkerRpcRequestCorrelatorOptions) {
  const pending = new Map<string, PendingRequest>();

  const request = (
    rpcCommand: Record<string, unknown>,
  ): Effect.Effect<WorkerRpcResponse, WorkerRpcError> =>
    Effect.callback<WorkerRpcResponse, WorkerRpcError>((resume) => {
      const id = randomUUID();
      const commandName = typeof rpcCommand.type === 'string' ? rpcCommand.type : 'unknown';
      const timeout = setTimeout(() => {
        pending.delete(id);
        resume(
          Effect.fail(
            workerRpcError(agentId, commandName, `Timed out after ${requestTimeoutMs}ms`),
          ),
        );
      }, requestTimeoutMs);
      pending.set(id, {
        command: commandName,
        resume: resume as PendingRequest['resume'],
        timeout,
      });
      stdin.write(`${JSON.stringify({ id, ...rpcCommand })}\n`, (cause) => {
        if (!cause) return;
        clearTimeout(timeout);
        pending.delete(id);
        resume(Effect.fail(workerRpcError(agentId, commandName, cause)));
      });
      return Effect.sync(() => {
        clearTimeout(timeout);
        pending.delete(id);
      });
    });

  const handleResponse = (event: unknown): 'handled' | 'invalid_uncorrelated_response' => {
    const decoded = WorkerRpcWire.decodeResponse(event);
    if (Option.isNone(decoded)) {
      const correlation = WorkerRpcWire.decodeResponseCorrelation(event);
      const request = Option.isSome(correlation) ? pending.get(correlation.value.id) : undefined;
      if (request && Option.isSome(correlation)) {
        clearTimeout(request.timeout);
        pending.delete(correlation.value.id);
        request.resume(
          Effect.fail(workerRpcError(agentId, request.command, 'Invalid RPC response')),
        );
        return 'handled';
      }
      return 'invalid_uncorrelated_response';
    }
    const response: WorkerRpcResponse = decoded.value;
    if (!response.id) return 'handled';
    const request = pending.get(response.id);
    if (!request) return 'handled';
    clearTimeout(request.timeout);
    pending.delete(response.id);
    if (response.command !== request.command) {
      request.resume(
        Effect.fail(workerRpcError(agentId, request.command, 'Mismatched RPC response command')),
      );
    } else if (response.success) {
      request.resume(Effect.succeed(response));
    } else {
      request.resume(
        Effect.fail(
          workerRpcError(agentId, request.command, response.error ?? 'RPC request failed'),
        ),
      );
    }
    return 'handled';
  };

  const failPending = (cause: unknown): void => {
    for (const [id, request] of pending) {
      clearTimeout(request.timeout);
      pending.delete(id);
      request.resume(Effect.fail(workerRpcError(agentId, request.command, cause)));
    }
  };

  return { failPending, handleResponse, request } as const;
}
