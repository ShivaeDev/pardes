import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Cause, Effect, Exit } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import type { WorkerProtocolDiagnostic, WorkerStderrTail } from '../diagnostics.ts';
import type { WorkerProcessInput } from '../process.ts';
import { openWorkerRpcSession } from './session.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function fakeRpcWorker(): {
  readonly root: string;
  readonly script: string;
  readonly input: WorkerProcessInput;
} {
  const root = mkdtempSync(join(tmpdir(), 'pardes-rpc-session-'));
  temporaryDirectories.push(root);
  const script = join(root, 'fake-session.mjs');
  writeFileSync(
    script,
    `
let buffer = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function respond(command, data) { send({ type: "response", id: command.id, command: command.type, success: true, data }); }
function handle(command) {
  if (command.type === "echo") {
    process.stderr.write("prefix-" + "x".repeat(5_000));
    send({ type: "notice", value: command.value });
    return respond(command, { echoed: command.value });
  }
  if (command.type === "invalid-uncorrelated") {
    send({ type: "response", id: "unrelated", command: command.type, success: "yes" });
    return respond(command);
  }
  if (command.type === "stall") return setTimeout(() => process.exit(23), 10);
  respond(command);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
`,
  );
  return {
    input: {
      agentId: 'agent-session',
      cwd: root,
      model: 'fixture/model',
      sessionDir: join(root, 'sessions'),
      thinkingLevel: 'low',
    },
    root,
    script,
  };
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for RPC session lifecycle');
}

describe('worker RPC session', () => {
  test('owns framing, request correlation, stderr tailing, and pending failure on exit', async () => {
    const fixture = fakeRpcWorker();
    const values: unknown[] = [];
    const protocolErrors: WorkerProtocolDiagnostic[] = [];
    const exits: Array<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: WorkerStderrTail;
    }> = [];
    const session = await Effect.runPromise(
      openWorkerRpcSession(fixture.input, {
        args: () => [fixture.script],
        command: process.execPath,
        requestTimeoutMs: 1_000,
      }),
    );
    session.start({
      onExit: (exitCode, signal, stderr) => {
        exits.push({ exitCode, signal, stderr });
      },
      onProtocolError: (message) => {
        protocolErrors.push(message);
      },
      onValue: (event) => {
        values.push(event);
      },
    });

    expect(
      await Effect.runPromise(session.request({ type: 'echo', value: 'fixture' })),
    ).toMatchObject({
      command: 'echo',
      data: { echoed: 'fixture' },
    });
    await eventually(() => values.length === 1 && session.stderr().shownChars === 4_000);
    expect(values).toEqual([{ type: 'notice', value: 'fixture' }]);
    expect(session.stderr()).toEqual({
      omissionReason: 'stderr_tail_limit',
      omittedChars: 1_007,
      originalChars: 5_007,
      shownChars: 4_000,
      tail: 'x'.repeat(4_000),
    });

    await Effect.runPromise(session.request({ type: 'invalid-uncorrelated' }));
    expect(protocolErrors).toEqual([
      {
        countAccuracy: 'exact',
        message: 'RPC response could not be correlated or decoded; response content was discarded.',
        omittedChars: 0,
        originalChars: 0,
        reason: 'invalid_response',
        shownChars: 0,
      },
    ]);

    const stalled = await Effect.runPromiseExit(session.request({ type: 'stall' }));
    expect(Exit.isFailure(stalled)).toBe(true);
    if (Exit.isSuccess(stalled)) throw new Error('Expected exit to fail the pending request');
    expect(Cause.squash(stalled.cause)).toMatchObject({
      _tag: 'WorkerRpcError',
      agentId: 'agent-session',
      cause: 'Worker exited with code 23 and signal null',
      command: 'stall',
    });
    await eventually(() => exits.length === 1);
    expect(exits[0]).toEqual({ exitCode: 23, signal: null, stderr: session.stderr() });
    await Effect.runPromise(session.close);
  });

  test('closes the scope-owned retained subprocess', async () => {
    const fixture = fakeRpcWorker();
    const exits: Array<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }> = [];
    const session = await Effect.runPromise(
      openWorkerRpcSession(fixture.input, {
        args: () => [fixture.script],
        command: process.execPath,
        requestTimeoutMs: 1_000,
      }),
    );
    session.start({
      onExit: (exitCode, signal) => {
        exits.push({ exitCode, signal });
      },
      onProtocolError: () => undefined,
      onValue: () => undefined,
    });

    await Effect.runPromise(session.close);
    expect(exits).toEqual([{ exitCode: null, signal: 'SIGTERM' }]);
  });
});
