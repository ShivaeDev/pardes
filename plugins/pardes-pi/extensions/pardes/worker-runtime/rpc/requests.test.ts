import { Cause, Effect, Exit, Fiber } from 'effect';
import { describe, expect, test } from 'vitest';
import { requiredValue } from '../../test-support.ts';
import type { WorkerRpcResponse } from './codecs.ts';
import { makeWorkerRpcRequestCorrelator } from './requests.ts';

interface CapturedCommand extends Record<string, unknown> {
  readonly id: string;
  readonly type: string;
}

function fakeStdin(
  onWrite?: (command: CapturedCommand, callback: (cause?: Error | null) => void) => void,
) {
  const commands: CapturedCommand[] = [];
  return {
    commands,
    stdin: {
      write(chunk: string, callback: (cause?: Error | null) => void) {
        const command = JSON.parse(chunk) as CapturedCommand;
        commands.push(command);
        onWrite?.(command, callback);
        return true;
      },
    },
  };
}

function successfulResponse(
  command: CapturedCommand,
  overrides: Record<string, unknown> = {},
): WorkerRpcResponse {
  return {
    command: command.type,
    id: command.id,
    success: true,
    type: 'response',
    ...overrides,
  } as WorkerRpcResponse;
}

function expectWorkerRpcFailure(
  exit: Exit.Exit<unknown, unknown>,
  command: string,
  cause: unknown,
): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error('Expected worker RPC request to fail');
  expect(Cause.squash(exit.cause)).toMatchObject({
    _tag: 'WorkerRpcError',
    agentId: 'agent-correlator',
    cause,
    command,
  });
}

describe('worker RPC request correlator', () => {
  test('allocates a UUID request ID and completes a matching response', async () => {
    const fixture = fakeStdin();
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 1_000,
      stdin: fixture.stdin,
    });
    const fiber = Effect.runFork(correlator.request({ message: 'Implement it', type: 'prompt' }));
    const command = requiredValue(fixture.commands[0]);

    expect(command).toMatchObject({ message: 'Implement it', type: 'prompt' });
    expect(command.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const response = successfulResponse(command, { data: { accepted: true } });
    expect(correlator.handleResponse(response)).toBe('handled');
    expect(await Effect.runPromise(Fiber.join(fiber))).toEqual(response);
  });

  test('fails RPC rejections and mismatched response commands with typed errors owned by the request command', async () => {
    const fixture = fakeStdin();
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 1_000,
      stdin: fixture.stdin,
    });

    const rejected = Effect.runFork(correlator.request({ type: 'prompt' }));
    expect(
      correlator.handleResponse({
        ...successfulResponse(requiredValue(fixture.commands[0])),
        error: 'denied',
        success: false,
      }),
    ).toBe('handled');
    expectWorkerRpcFailure(await Effect.runPromiseExit(Fiber.join(rejected)), 'prompt', 'denied');

    const mismatched = Effect.runFork(correlator.request({ type: 'prompt' }));
    expect(
      correlator.handleResponse(
        successfulResponse(requiredValue(fixture.commands[1]), { command: 'steer' }),
      ),
    ).toBe('handled');
    expectWorkerRpcFailure(
      await Effect.runPromiseExit(Fiber.join(mismatched)),
      'prompt',
      'Mismatched RPC response command',
    );
  });

  test('fails malformed correlated responses but identifies malformed uncorrelated responses', async () => {
    const fixture = fakeStdin();
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 1_000,
      stdin: fixture.stdin,
    });
    const fiber = Effect.runFork(correlator.request({ type: 'get_state' }));
    const command = requiredValue(fixture.commands[0]);

    expect(correlator.handleResponse({ ...successfulResponse(command), success: 'yes' })).toBe(
      'handled',
    );
    expectWorkerRpcFailure(
      await Effect.runPromiseExit(Fiber.join(fiber)),
      'get_state',
      'Invalid RPC response',
    );
    expect(
      correlator.handleResponse({
        command: 'prompt',
        id: 'unrelated-id',
        success: 'yes',
        type: 'response',
      }),
    ).toBe('invalid_uncorrelated_response');
  });

  test('silently handles a valid unrelated response without consuming the matching request', async () => {
    const fixture = fakeStdin();
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 1_000,
      stdin: fixture.stdin,
    });
    const fiber = Effect.runFork(correlator.request({ type: 'prompt' }));
    const command = requiredValue(fixture.commands[0]);

    expect(
      correlator.handleResponse({
        command: 'prompt',
        id: 'unrelated-id',
        success: true,
        type: 'response',
      }),
    ).toBe('handled');
    expect(correlator.handleResponse(successfulResponse(command))).toBe('handled');
    expect(await Effect.runPromise(Fiber.join(fiber))).toEqual(successfulResponse(command));
  });

  test('times out requests and silently ignores valid late responses', async () => {
    const fixture = fakeStdin();
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 20,
      stdin: fixture.stdin,
    });
    const fiber = Effect.runFork(correlator.request({ type: 'compact' }));
    const command = requiredValue(fixture.commands[0]);

    expectWorkerRpcFailure(
      await Effect.runPromiseExit(Fiber.join(fiber)),
      'compact',
      'Timed out after 20ms',
    );
    expect(correlator.handleResponse(successfulResponse(command))).toBe('handled');
  });

  test('removes request ownership when the waiting fiber is interrupted', async () => {
    const fixture = fakeStdin();
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 1_000,
      stdin: fixture.stdin,
    });
    const fiber = Effect.runFork(correlator.request({ type: 'prompt' }));
    const command = requiredValue(fixture.commands[0]);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(correlator.handleResponse({ ...successfulResponse(command), success: 'yes' })).toBe(
      'invalid_uncorrelated_response',
    );
  });

  test('fails and removes request ownership when stdin invokes its write callback with an error', async () => {
    const writeError = new Error('stdin closed');
    const fixture = fakeStdin((_command, callback) => callback(writeError));
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 1_000,
      stdin: fixture.stdin,
    });

    const exit = await Effect.runPromiseExit(correlator.request({ type: 'prompt' }));
    expectWorkerRpcFailure(exit, 'prompt', writeError);
    expect(
      correlator.handleResponse({
        ...successfulResponse(requiredValue(fixture.commands[0])),
        success: 'yes',
      }),
    ).toBe('invalid_uncorrelated_response');
  });

  test('fails every inflight request on lifecycle failure and silently ignores valid late responses', async () => {
    const fixture = fakeStdin();
    const correlator = makeWorkerRpcRequestCorrelator({
      agentId: 'agent-correlator',
      requestTimeoutMs: 1_000,
      stdin: fixture.stdin,
    });
    const first = Effect.runFork(correlator.request({ type: 'prompt' }));
    const second = Effect.runFork(correlator.request({ type: 'get_state' }));
    const [firstCommand, secondCommand] = fixture.commands;

    correlator.failPending('worker exited');
    expectWorkerRpcFailure(
      await Effect.runPromiseExit(Fiber.join(first)),
      'prompt',
      'worker exited',
    );
    expectWorkerRpcFailure(
      await Effect.runPromiseExit(Fiber.join(second)),
      'get_state',
      'worker exited',
    );
    expect(correlator.handleResponse(successfulResponse(requiredValue(firstCommand)))).toBe(
      'handled',
    );
    expect(correlator.handleResponse(successfulResponse(requiredValue(secondCommand)))).toBe(
      'handled',
    );
  });
});
