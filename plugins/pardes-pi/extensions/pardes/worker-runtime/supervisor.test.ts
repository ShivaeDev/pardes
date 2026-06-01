import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Cause, Context, Effect, Exit, Layer } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type GuardedWorkerSupervisorShape,
  makeWorkerSupervisor,
  type WorkerSendBehavior,
  type WorkerSpawnInput,
  WorkerSupervisor,
  type WorkerSupervisorEvent,
  type WorkerSupervisorShape,
} from './index.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

interface FakeRpcWorker {
  readonly root: string;
  readonly script: string;
  readonly commandLog: string;
}

interface FakeRpcWorkerOptions {
  readonly malformedResponseCommand?: string;
  readonly malformedStats?: boolean;
  readonly stalledCompact?: boolean;
}

function fakeRpcWorker(options: FakeRpcWorkerOptions = {}): FakeRpcWorker {
  const root = mkdtempSync(join(tmpdir(), 'pardes-rpc-worker-'));
  temporaryDirectories.push(root);
  const script = join(root, 'fake-worker.mjs');
  const commandLog = join(root, 'commands.jsonl');
  writeFileSync(
    script,
    `
import { appendFileSync } from "node:fs";
const commandLog = ${JSON.stringify(commandLog)};
const malformedResponseCommand = ${JSON.stringify(options.malformedResponseCommand)};
const malformedStats = ${JSON.stringify(options.malformedStats ?? false)};
const stalledCompact = ${JSON.stringify(options.stalledCompact ?? false)};
let buffer = "";
const state = {
  sessionFile: "/tmp/fake-pardes-session.jsonl",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  pendingMessageCount: 0,
};
let steering = [];
let followUp = [];
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function sendMany(values) { process.stdout.write(values.map((value) => JSON.stringify(value)).join("\\n") + "\\n"); }
function respond(command, data) { send({ type: "response", id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) }); }
function start() { state.isStreaming = true; send({ type: "agent_start" }); }
function end() { state.isStreaming = false; state.isCompacting = false; send({ type: "agent_end", messages: [] }); }
function updateQueue(nextSteering, nextFollowUp) {
  steering = nextSteering;
  followUp = nextFollowUp;
  state.pendingMessageCount = steering.length + followUp.length;
  send({ type: "queue_update", steering, followUp });
}
function startCompaction(reason) { state.isCompacting = true; send({ type: "compaction_start", reason }); }
function endCompaction(reason, result, aborted, willRetry, errorMessage) {
  state.isCompacting = false;
  send({ type: "compaction_end", reason, result, aborted, willRetry, ...(errorMessage === undefined ? {} : { errorMessage }) });
}
function report(summary = "fixture complete", details) {
  send({ type: "tool_execution_end", toolName: "report_to_manager", isError: false, result: { details: { pardesWorker: { type: "report", status: "completed", summary, ...(details === undefined ? {} : { details }) } } } });
}
function question() {
  send({ type: "tool_execution_end", toolName: "ask_manager", isError: false, result: { details: { pardesWorker: { type: "question", question: "Ship it?" } } } });
}
function malformedTargetedEvents() {
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 17 } });
  send({ type: "tool_execution_start", toolName: 17, args: {} });
  send({ type: "queue_update", steering: "invalid", followUp: [] });
  send({ type: "compaction_start", reason: "future" });
  send({ type: "tool_execution_end", toolName: "report_to_manager", isError: false, result: { details: { pardesWorker: { type: "report", status: "completed", summary: 17 } } } });
  send({ type: "tool_execution_end", toolName: "ask_manager", isError: false, result: { details: { pardesWorker: { type: "question", question: "Ship it?", context: 17 } } } });
  send({ type: "response", id: "malformed-unrelated-id", command: "prompt", success: "yes" });
}
function unrelatedTraffic() {
  start();
  send({ type: "session_info_changed", name: "ignored" });
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "ignored thinking" } });
  send({ type: "tool_execution_update", toolName: "bash", args: {}, partialResult: { content: [] } });
  send({ type: "tool_execution_end", toolName: "read", isError: false, result: { content: [] } });
  send({ type: "response", id: "valid-unrelated-id", command: "prompt", success: true });
  end();
}
function assistant(content) { return { role: "assistant", content }; }
function activityPreview() {
  const text = "  visible   response  ";
  send({ type: "message_start", message: assistant([]) });
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "SECRET thinking trace" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_end", content: text } });
  send({ type: "message_end", message: assistant([{ type: "thinking", thinking: "SECRET finalized thinking" }, { type: "text", text }]) });
  send({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "echo   INVOCATION_METADATA\\n" + "x".repeat(400) } });
  send({ type: "tool_execution_start", toolCallId: "call-write", toolName: "write", args: { path: "file.txt", content: "y".repeat(400) } });
  send({ type: "tool_execution_start", toolCallId: "call-edit", toolName: "edit", args: { path: "file.txt", edits: [{ oldText: "old", newText: "z".repeat(400) }] } });
  send({ type: "tool_execution_update", toolCallId: "call-bash", toolName: "bash", args: { command: "SECRET update args" }, partialResult: { content: [{ type: "text", text: "SECRET partial output" }] } });
  send({ type: "tool_execution_end", toolCallId: "call-bash", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "SECRET result body" }] } });
  report("SECRET pardes result payload");
}
function activityRing() {
  for (let index = 1; index <= 13; index++) {
    send({ type: "tool_execution_start", toolCallId: "call-ring-" + index, toolName: "read", args: { path: "file-" + String(index).padStart(2, "0") } });
  }
}
function activityCommonPaths() {
  send({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "src/input.ts", offset: 40 } });
  send({ type: "tool_execution_start", toolCallId: "call-write", toolName: "write", args: { path: "src/output.ts", content: "SECRET write content" } });
  send({ type: "tool_execution_start", toolCallId: "call-edit", toolName: "edit", args: { path: "src/output.ts", edits: [{ oldText: "SECRET old", newText: "SECRET new" }] } });
  send({ type: "tool_execution_start", toolCallId: "call-grep", toolName: "grep", args: { pattern: "TODO   marker", path: "src" } });
  send({ type: "tool_execution_start", toolCallId: "call-find", toolName: "find", args: { pattern: "*.ts" } });
}
function activityCommonMisc() {
  send({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "printf   hello\\nworld" } });
  send({ type: "tool_execution_start", toolCallId: "call-ls", toolName: "ls", args: {} });
  send({ type: "tool_execution_start", toolCallId: "call-report", toolName: "report_to_manager", args: { status: "progress", summary: "Implemented   summaries", details: "SECRET report details" } });
  send({ type: "tool_execution_start", toolCallId: "call-question", toolName: "ask_manager", args: { question: "Need   approval?", context: "SECRET question context" } });
  send({ type: "tool_execution_start", toolCallId: "call-custom", toolName: "custom_tool", args: { action: "inspect", payload: { secret: "SECRET nested body" }, note: "n".repeat(400) } });
}
function activityFallback() {
  send({ type: "message_start", message: assistant([]) });
  send({ type: "message_end", message: assistant([{ type: "thinking", thinking: "SECRET fallback thinking" }, { type: "text", text: "  fallback   visible  \\n" + "f".repeat(400) }]) });
  send({ type: "message_start", message: assistant([]) });
  send({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed visible  \\n" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " response" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "streamed visible  \\n response" } });
  send({ type: "message_end", message: assistant([{ type: "text", text: "streamed visible  \\n response" }]) });
}
function handle(command) {
  appendFileSync(commandLog, JSON.stringify(command) + "\\n");
  if (command.type === malformedResponseCommand) return send({ type: "response", id: command.id, command: command.type, success: "yes" });
  if (command.type === "get_state") return respond(command, state);
  if (command.type === "set_session_name") return respond(command);
  if (command.type === "set_steering_mode") { state.steeringMode = command.mode; return respond(command); }
  if (command.type === "set_follow_up_mode") { state.followUpMode = command.mode; return respond(command); }
  if (command.type === "get_session_stats") return respond(command, malformedStats ? { totalMessages: "invalid" } : { totalMessages: 8, toolCalls: 3, tokens: { input: 1200, output: 300, cacheRead: 400, cacheWrite: 100, total: 2000 }, cost: 0.125, contextUsage: { tokens: 5000, contextWindow: 10000, percent: 50 } });
  if (command.type === "compact") {
    startCompaction("manual");
    if (stalledCompact) return;
    const result = { summary: "manual summary", firstKeptEntryId: "entry-manual", tokensBefore: 75000, details: {} };
    endCompaction("manual", result, false, false);
    return respond(command, result);
  }
  if (command.type === "abort") return respond(command);
  if (command.type === "steer" || command.type === "follow_up") {
    respond(command);
    if (command.type === "steer") updateQueue([...steering, command.message], followUp);
    else updateQueue(steering, [...followUp, command.message]);
    if (command.message === "finish-stream") { updateQueue([], []); end(); }
    return;
  }
  if (command.type === "prompt") {
    if (command.message === "fast-report") {
      state.isStreaming = false;
      return sendMany([
        { type: "response", id: command.id, command: command.type, success: true },
        { type: "agent_start" },
        { type: "tool_execution_end", toolName: "report_to_manager", isError: false, result: { details: { pardesWorker: { type: "report", status: "completed", summary: "fast fixture complete" } } } },
        { type: "agent_end", messages: [] },
      ]);
    }
    respond(command);
    if (command.message === "crash") return setTimeout(() => process.exit(17), 10);
    if (command.message === "start-only") return start();
    if (command.message === "state-reconcile") {
      state.isStreaming = true;
      state.autoCompactionEnabled = false;
      state.pendingMessageCount = 2;
      return;
    }
    if (command.message === "queue-events") {
      start();
      updateQueue(["Focus on errors"], ["Summarize", "Run tests"]);
      return;
    }
    if (command.message === "compaction-lifecycle") {
      start();
      startCompaction("threshold");
      endCompaction("threshold", { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 150000, details: {} }, false, false);
      startCompaction("overflow");
      endCompaction("overflow", null, false, false, "quota exhausted");
      end();
      return;
    }
    if (command.message === "failed-compaction") {
      start();
      startCompaction("overflow");
      endCompaction("overflow", null, false, false, "quota exhausted");
      end();
      return;
    }
    if (command.message === "compacting-only") {
      start();
      startCompaction("threshold");
      return;
    }
    if (command.message === "activity-preview") {
      start();
      activityPreview();
      end();
      return;
    }
    if (command.message === "multi-meg-report") {
      start();
      report("multi-meg fixture complete", "D".repeat(4 * 1024 * 1024));
      end();
      return;
    }
    if (command.message === "activity-ring") {
      start();
      activityRing();
      end();
      return;
    }
    if (command.message === "activity-common-paths") {
      start();
      activityCommonPaths();
      end();
      return;
    }
    if (command.message === "activity-common-misc") {
      start();
      activityCommonMisc();
      end();
      return;
    }
    if (command.message === "activity-fallback") {
      start();
      activityFallback();
      end();
      return;
    }
    if (command.message === "idle-pending") {
      state.pendingMessageCount = 1;
      return;
    }
    if (command.message === "malformed-targeted-events") return malformedTargetedEvents();
    if (command.message === "unrelated-traffic") return unrelatedTraffic();
    start();
    report();
    question();
    end();
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\\r")) line = line.slice(0, -1);
    if (line) handle(JSON.parse(line));
  }
});
`,
  );
  return { commandLog, root, script };
}

function spawnInput(
  fixture: FakeRpcWorker,
  task: string,
  agentId = 'agent-fixture',
): WorkerSpawnInput {
  return {
    agentId,
    cwd: fixture.root,
    model: 'fixture/model',
    sessionDir: join(fixture.root, 'sessions', agentId),
    sessionName: `fixture ${agentId}`,
    task,
    thinkingLevel: 'low',
  };
}

function commands(fixture: FakeRpcWorker): ReadonlyArray<Record<string, unknown>> {
  try {
    return readFileSync(fixture.commandLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
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
  throw new Error('Timed out waiting for worker event');
}

async function expectSendFailure(
  supervisor: WorkerSupervisorShape,
  agentId: string,
  behavior: WorkerSendBehavior,
  guidance: string,
): Promise<void> {
  const exit = await Effect.runPromiseExit(supervisor.send(agentId, 'unsafe', behavior));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error('Expected worker send to fail');
  expect(Cause.squash(exit.cause)).toMatchObject({
    _tag: 'WorkerRpcError',
    agentId,
    cause: guidance,
    command: behavior,
  });
}

async function expectGuardedFailure(
  supervisor: GuardedWorkerSupervisorShape,
  operation: 'compact' | 'reload',
  agentId: string,
  guidance: string,
): Promise<void> {
  const exit = await Effect.runPromiseExit(supervisor[operation](agentId));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error(`Expected worker ${operation} to fail`);
  expect(Cause.squash(exit.cause)).toMatchObject({
    _tag: 'WorkerRpcError',
    agentId,
    cause: guidance,
    command: operation,
  });
}

describe('worker supervisor', () => {
  test('shuts down retained children when the supervisor Layer scope closes', async () => {
    const fixture = fakeRpcWorker();
    const input = spawnInput(fixture, 'quiet');
    const supervisor = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            WorkerSupervisor.layer({
              args: () => [fixture.script],
              command: process.execPath,
              telemetryInterval: '1 hour',
            }),
          );
          const service = Context.get(context, WorkerSupervisor);
          yield* service.spawn(input);
          return service;
        }),
      ),
    );

    expect((await Effect.runPromise(supervisor.status(input.agentId))).status).toBe('stopped');
  });

  test('forwards ephemeral lifecycle generation ownership through runtime snapshots and emitted events', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });
    const runtime = await Effect.runPromise(
      supervisor.spawn({ ...spawnInput(fixture, 'quiet'), lifecycleGeneration: 7 }),
    );
    await eventually(() => events.length > 0);
    expect(runtime.lifecycleGeneration).toBe(7);
    expect(events.every((event) => event.lifecycleGeneration === 7)).toBe(true);
    await Effect.runPromise(supervisor.shutdown());
  });

  test('pins one-at-a-time queue modes during bootstrap and revive', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    const input = spawnInput(fixture, 'quiet');
    const runtime = await Effect.runPromise(supervisor.spawn(input));
    expect(runtime).toMatchObject({
      autoCompactionEnabled: true,
      followUpMode: 'one-at-a-time',
      pendingMessageCount: 0,
      sessionFile: '/tmp/fake-pardes-session.jsonl',
      steeringMode: 'one-at-a-time',
    });
    expect(
      commands(fixture)
        .slice(0, 5)
        .map((command) => command.type),
    ).toEqual([
      'get_state',
      'set_session_name',
      'set_steering_mode',
      'set_follow_up_mode',
      'prompt',
    ]);

    await Effect.runPromise(supervisor.stop(input.agentId));
    await Effect.runPromise(
      supervisor.spawn({ ...input, sessionFile: runtime.sessionFile, task: 'quiet' }),
    );
    await Effect.runPromise(supervisor.stop(input.agentId));
    expect(
      commands(fixture).filter((command) => command.type === 'set_steering_mode'),
    ).toHaveLength(2);
    expect(
      commands(fixture).filter((command) => command.type === 'set_follow_up_mode'),
    ).toHaveLength(2);
    await Effect.runPromise(supervisor.shutdown());
  });

  test('reconciles decoded RPC state with stats on the 500ms default telemetry cadence', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'state-reconcile')));
    await eventually(async () => {
      const runtime = await Effect.runPromise(supervisor.status('agent-fixture'));
      return (
        runtime.status === 'running' &&
        runtime.stats?.tokens.total === 2000 &&
        runtime.sampledAt !== undefined
      );
    });
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      autoCompactionEnabled: false,
      followUpMode: 'one-at-a-time',
      followUpQueueCount: undefined,
      isCompacting: false,
      isStreaming: true,
      pendingMessageCount: 2,
      status: 'running',
      steeringMode: 'one-at-a-time',
      steeringQueueCount: undefined,
    });
    await eventually(
      () => commands(fixture).filter((command) => command.type === 'get_session_stats').length >= 2,
      1_800,
    );
    await Effect.runPromise(supervisor.shutdown());
  });

  test('rejects malformed correlated response envelopes with a typed WorkerRpcError', async () => {
    const fixture = fakeRpcWorker({ malformedResponseCommand: 'set_session_name' });
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    const exit = await Effect.runPromiseExit(supervisor.spawn(spawnInput(fixture, 'quiet')));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit))
      throw new Error('Expected malformed correlated response to fail worker spawn');
    expect(Cause.squash(exit.cause)).toMatchObject({
      _tag: 'WorkerRpcError',
      agentId: 'agent-fixture',
      cause: 'Invalid RPC response',
      command: 'set_session_name',
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('drops malformed stats samples at the schema boundary', async () => {
    const fixture = fakeRpcWorker({ malformedStats: true });
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '20 millis',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'quiet')));
    await eventually(() =>
      commands(fixture).some((command) => command.type === 'get_session_stats'),
    );
    await sleep(30);
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      sampledAt: undefined,
      stats: undefined,
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('emits bounded protocol errors for malformed targeted events and Pardes payloads', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'malformed-targeted-events')));
    await eventually(() => events.filter((event) => event.type === 'protocol_error').length === 7);
    const protocolErrors = events.flatMap((event) =>
      event.type === 'protocol_error' ? [event.message] : [],
    );
    expect(protocolErrors).toEqual([
      'Invalid text_delta RPC event',
      'Invalid tool_execution_start RPC event',
      'Invalid queue_update RPC event',
      'Invalid compaction_start RPC event',
      'Invalid report_to_manager Pardes payload',
      'Invalid ask_manager Pardes payload',
      'Invalid response RPC message',
    ]);
    expect(protocolErrors.every((message) => message.length <= 240)).toBe(true);
    expect(events.some((event) => event.type === 'report' || event.type === 'question')).toBe(
      false,
    );
    await Effect.runPromise(supervisor.shutdown());
  });

  test('ignores valid unrelated RPC traffic without protocol errors or activity previews', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'unrelated-traffic')));
    await eventually(() =>
      events.some((event) => event.type === 'status' && event.status === 'idle'),
    );
    expect(
      events.some(
        (event) =>
          event.type === 'protocol_error' || event.type === 'report' || event.type === 'question',
      ),
    ).toBe(false);
    expect(
      (await Effect.runPromise(supervisor.status('agent-fixture'))).recentActivityLines,
    ).toEqual([]);
    await Effect.runPromise(supervisor.shutdown());
  });

  test('projects queue update events into ephemeral telemetry snapshots', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'queue-events')));
    await eventually(() =>
      events.some((event) => event.type === 'telemetry' && event.runtime.pendingMessageCount === 3),
    );
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      followUpQueueCount: 2,
      isStreaming: true,
      pendingMessageCount: 3,
      steeringQueueCount: 1,
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('delivers legitimate multi-megabyte report details and continues into the later idle transition', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'multi-meg-report')));
    await eventually(() =>
      events.some((event) => event.type === 'status' && event.status === 'idle'),
    );
    const reports = events.filter(
      (event): event is Extract<WorkerSupervisorEvent, { readonly type: 'report' }> =>
        event.type === 'report',
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: 'completed',
      summary: 'multi-meg fixture complete',
    });
    expect(reports[0]?.details).toHaveLength(4 * 1_024 * 1_024);
    expect(events.some((event) => event.type === 'protocol_error')).toBe(false);
    expect((await Effect.runPromise(supervisor.status('agent-fixture'))).status).toBe('idle');
    await Effect.runPromise(supervisor.shutdown());
  });

  test('captures bounded one-line invocation summaries without tool output, results, or thinking', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'activity-preview')));
    await eventually(
      async () =>
        (await Effect.runPromise(supervisor.status('agent-fixture'))).recentActivityLines
          ?.length === 4,
    );
    const activity =
      (await Effect.runPromise(supervisor.status('agent-fixture'))).recentActivityLines ?? [];
    const toolLines = activity.slice(1);

    expect(activity[0]).toBe('visible response');
    expect(toolLines).toHaveLength(3);
    expect(toolLines[0]?.startsWith('› bash: echo INVOCATION_METADATA ')).toBe(true);
    expect(toolLines[0]).toHaveLength(240);
    expect(toolLines[0]?.endsWith('…')).toBe(true);
    expect(toolLines[1]).toBe('› write: file.txt');
    expect(toolLines[2]).toBe('› edit: file.txt');
    expect(toolLines.every((line) => !line.includes('\n') && !/\s{2,}/.test(line))).toBe(true);
    expect(activity.join('\n')).not.toContain('SECRET');
    expect(activity.join('\n')).not.toContain('partial output');
    expect(activity.join('\n')).not.toContain('result body');
    await Effect.runPromise(supervisor.shutdown());
  });

  test('formats common tool intent and bounded manager or unknown-tool summaries from start metadata', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(
      supervisor.spawn(spawnInput(fixture, 'activity-common-paths', 'agent-paths')),
    );
    await Effect.runPromise(
      supervisor.spawn(spawnInput(fixture, 'activity-common-misc', 'agent-misc')),
    );
    await eventually(
      async () =>
        (await Effect.runPromise(supervisor.status('agent-misc'))).recentActivityLines?.length ===
        5,
    );

    expect((await Effect.runPromise(supervisor.status('agent-paths'))).recentActivityLines).toEqual(
      [
        '› read: src/input.ts',
        '› write: src/output.ts',
        '› edit: src/output.ts',
        '› grep: TODO marker · src',
        '› find: *.ts · .',
      ],
    );
    const misc =
      (await Effect.runPromise(supervisor.status('agent-misc'))).recentActivityLines ?? [];
    expect(misc.slice(0, 4)).toEqual([
      '› bash: printf hello world',
      '› ls: .',
      '› report_to_manager: progress · Implemented summaries',
      '› ask_manager: Need approval?',
    ]);
    expect(misc[4]?.startsWith('› custom_tool: action=inspect · payload={…} · note=')).toBe(true);
    expect(misc[4]).toHaveLength(240);
    expect(misc[4]?.endsWith('…')).toBe(true);
    expect(misc.join('\n')).not.toContain('SECRET');
    expect(misc.join('\n')).not.toContain('{"');
    await Effect.runPromise(supervisor.shutdown());
  });

  test('keeps only the last 5 ephemeral activity lines', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'activity-ring')));
    await eventually(
      async () =>
        (
          await Effect.runPromise(supervisor.status('agent-fixture'))
        ).recentActivityLines?.[4]?.includes('file-13') === true,
    );
    expect(
      (await Effect.runPromise(supervisor.status('agent-fixture'))).recentActivityLines,
    ).toEqual(
      Array.from({ length: 5 }, (_, index) => `› read: file-${String(index + 9).padStart(2, '0')}`),
    );
    await Effect.runPromise(supervisor.shutdown());
  });

  test('keeps multiline streamed and fallback assistant text to one bounded row without duplication', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'activity-fallback')));
    await eventually(
      async () =>
        (await Effect.runPromise(supervisor.status('agent-fixture'))).recentActivityLines
          ?.length === 2,
    );
    const activity =
      (await Effect.runPromise(supervisor.status('agent-fixture'))).recentActivityLines ?? [];

    expect(activity[0]?.startsWith('fallback visible fff')).toBe(true);
    expect(activity[0]).toHaveLength(240);
    expect(activity[0]?.endsWith('…')).toBe(true);
    expect(activity[1]).toBe('streamed visible response');
    expect(activity.filter((line) => line === 'streamed visible response')).toHaveLength(1);
    expect(activity.every((line) => line.length <= 240 && !line.includes('\n'))).toBe(true);
    expect(activity.join('\n')).not.toContain('SECRET');
    await Effect.runPromise(supervisor.shutdown());
  });

  test('emits compaction lifecycle telemetry and explicit completion events', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'compaction-lifecycle')));
    await eventually(
      () => events.filter((event) => event.type === 'compaction_completed').length === 2,
    );
    expect(
      events.some(
        (event) =>
          event.type === 'telemetry' &&
          event.runtime.isCompacting === true &&
          event.runtime.compactionReason === 'threshold',
      ),
    ).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        compaction: expect.objectContaining({
          reason: 'threshold',
          succeeded: true,
          tokensBefore: 150000,
        }),
        type: 'compaction_completed',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        compaction: expect.objectContaining({
          aborted: false,
          errorMessage: 'quota exhausted',
          reason: 'overflow',
          succeeded: false,
        }),
        type: 'compaction_completed',
      }),
    );
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      compactionReason: undefined,
      completedCompactionCount: 2,
      isCompacting: false,
      lastCompaction: { errorMessage: 'quota exhausted', reason: 'overflow', succeeded: false },
    });

    await Effect.runPromise(supervisor.compact('agent-fixture'));
    await eventually(
      () => events.filter((event) => event.type === 'compaction_completed').length === 3,
    );
    expect(
      events.flatMap((event) =>
        event.type === 'telemetry' ? [event.runtime.completedCompactionCount] : [],
      ),
    ).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      completedCompactionCount: 3,
      lastCompaction: { reason: 'manual', succeeded: true, tokensBefore: 75000 },
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('runs bounded explicit manual compaction only after an idle preflight', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'quiet')));
    await eventually(async () => {
      const runtime = await Effect.runPromise(supervisor.status('agent-fixture'));
      return runtime.status === 'idle' && runtime.stats?.contextUsage?.percent === 50;
    });
    expect(await Effect.runPromise(supervisor.compact('agent-fixture'))).toMatchObject({
      completedCompactionCount: 1,
      isCompacting: false,
      lastCompaction: { reason: 'manual', succeeded: true, tokensBefore: 75000 },
      stats: { contextUsage: { contextWindow: 10000, percent: null, tokens: null } },
      status: 'idle',
    });
    expect(commands(fixture).filter((command) => command.type === 'compact')).toHaveLength(1);
    await eventually(() => events.some((event) => event.type === 'compaction_completed'));
    expect(events).toContainEqual(
      expect.objectContaining({
        compaction: expect.objectContaining({
          reason: 'manual',
          succeeded: true,
          tokensBefore: 75000,
        }),
        type: 'compaction_completed',
      }),
    );
    await Effect.runPromise(supervisor.shutdown());
  });

  test('retains sampled context usage after a failed compaction completion while still counting the attempt', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'quiet')));
    await eventually(async () => {
      const runtime = await Effect.runPromise(supervisor.status('agent-fixture'));
      return runtime.status === 'idle' && runtime.stats?.contextUsage?.percent === 50;
    });
    await Effect.runPromise(supervisor.send('agent-fixture', 'failed-compaction', 'prompt'));
    await eventually(
      async () =>
        (await Effect.runPromise(supervisor.status('agent-fixture'))).completedCompactionCount ===
        1,
    );
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      completedCompactionCount: 1,
      lastCompaction: { errorMessage: 'quota exhausted', reason: 'overflow', succeeded: false },
      stats: { contextUsage: { contextWindow: 10000, percent: 50, tokens: 5000 } },
      status: 'idle',
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('bounds explicit manual compaction by the RPC request timeout', async () => {
    const fixture = fakeRpcWorker({ stalledCompact: true });
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      requestTimeoutMs: 100,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'quiet')));
    await eventually(
      async () => (await Effect.runPromise(supervisor.status('agent-fixture'))).status === 'idle',
    );
    const exit = await Effect.runPromiseExit(supervisor.compact('agent-fixture'));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('Expected stalled worker compaction to fail');
    expect(Cause.squash(exit.cause)).toMatchObject({
      _tag: 'WorkerRpcError',
      agentId: 'agent-fixture',
      cause: 'Timed out after 100ms',
      command: 'compact',
    });
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      compactionReason: 'manual',
      isCompacting: true,
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('rejects explicit compaction and worker-extension reload unless the worker is idle with an empty queue', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'start-only', 'agent-active')));
    await Effect.runPromise(
      supervisor.spawn(spawnInput(fixture, 'compacting-only', 'agent-compacting')),
    );
    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'idle-pending', 'agent-pending')));
    for (const operation of ['compact', 'reload'] as const) {
      await expectGuardedFailure(
        supervisor,
        operation,
        'agent-active',
        `Worker is active; wait for idle before ${operation}.`,
      );
      await expectGuardedFailure(
        supervisor,
        operation,
        'agent-compacting',
        'Worker is compacting; retry after compaction completes.',
      );
      await expectGuardedFailure(
        supervisor,
        operation,
        'agent-pending',
        `Worker has pending queued messages; wait for queue drain before ${operation}.`,
      );
    }
    expect(commands(fixture).some((command) => command.type === 'compact')).toBe(false);
    expect(commands(fixture).filter((command) => command.type === 'set_session_name')).toHaveLength(
      3,
    );
    await Effect.runPromise(supervisor.shutdown());
  });

  test('reloads an idle retained worker extension from the same pinned snapshot by relaunching the same Pi session without prompting', async () => {
    const fixture = fakeRpcWorker();
    const workerExtensionPath =
      '/tmp/pardes-manager/runtime/child-extension/pinned/worker-runtime/child-extension.ts';
    const launches: Array<string | undefined> = [];
    const supervisor = makeWorkerSupervisor({
      args: (input) => {
        launches.push(input.workerExtensionPath);
        return [fixture.script];
      },
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    const initial = await Effect.runPromise(
      supervisor.spawn({ ...spawnInput(fixture, 'quiet'), workerExtensionPath }),
    );
    await eventually(
      async () => (await Effect.runPromise(supervisor.status('agent-fixture'))).status === 'idle',
    );
    expect(await Effect.runPromise(supervisor.compact('agent-fixture'))).toMatchObject({
      completedCompactionCount: 1,
    });
    expect(await Effect.runPromise(supervisor.reload('agent-fixture'))).toMatchObject({
      completedCompactionCount: 0,
      isCompacting: false,
      isStreaming: false,
      pendingMessageCount: 0,
      sessionFile: initial.sessionFile,
      status: 'idle',
    });
    expect(launches).toEqual([workerExtensionPath, workerExtensionPath]);
    expect(commands(fixture).filter((command) => command.type === 'prompt')).toHaveLength(1);
    expect(commands(fixture).filter((command) => command.type === 'set_session_name')).toHaveLength(
      2,
    );
    expect(
      commands(fixture).filter((command) => command.type === 'set_steering_mode'),
    ).toHaveLength(2);
    expect(
      commands(fixture).filter((command) => command.type === 'set_follow_up_mode'),
    ).toHaveLength(2);
    await Effect.runPromise(supervisor.shutdown());
  });

  test('auto-routes idle guidance as a prompt and rejects unsafe idle queue parking', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'quiet', 'agent-idle')));
    expect(await Effect.runPromise(supervisor.send('agent-idle', 'quiet', 'auto'))).toEqual({
      deliveredAs: 'prompt',
      requestedBehavior: 'auto',
    });
    await expectSendFailure(
      supervisor,
      'agent-idle',
      'steer',
      'Worker is idle; use auto or prompt instead of steer.',
    );
    await expectSendFailure(
      supervisor,
      'agent-idle',
      'followUp',
      'Worker is idle; use auto or prompt instead of followUp.',
    );
    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'idle-pending', 'agent-pending')));
    await expectSendFailure(
      supervisor,
      'agent-pending',
      'auto',
      'Worker is idle with pending queued messages; retry after queue drain.',
    );
    await expectSendFailure(
      supervisor,
      'agent-pending',
      'prompt',
      'Worker has pending queued messages; wait for queue drain before prompt.',
    );
    await Effect.runPromise(supervisor.shutdown());
  });

  test('auto-routes active guidance as a queued follow-up while reserving steer for explicit urgent intent', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'start-only')));
    await expectSendFailure(
      supervisor,
      'agent-fixture',
      'prompt',
      'Worker is active; use auto, steer, or followUp instead of prompt.',
    );
    expect(await Effect.runPromise(supervisor.send('agent-fixture', 'focus', 'steer'))).toEqual({
      deliveredAs: 'steer',
      requestedBehavior: 'steer',
    });
    expect(await Effect.runPromise(supervisor.send('agent-fixture', 'summarize', 'auto'))).toEqual({
      deliveredAs: 'followUp',
      requestedBehavior: 'auto',
    });
    expect(
      await Effect.runPromise(supervisor.send('agent-fixture', 'validate later', 'followUp')),
    ).toEqual({ deliveredAs: 'followUp', requestedBehavior: 'followUp' });
    await eventually(
      async () =>
        (await Effect.runPromise(supervisor.status('agent-fixture'))).pendingMessageCount === 3,
    );
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      followUpQueueCount: 2,
      isStreaming: true,
      pendingMessageCount: 3,
      steeringQueueCount: 1,
    });
    expect(commands(fixture).filter((command) => command.type === 'prompt')).toHaveLength(1);
    expect(commands(fixture).filter((command) => command.type === 'steer')).toHaveLength(1);
    expect(commands(fixture).filter((command) => command.type === 'follow_up')).toHaveLength(2);
    await Effect.runPromise(supervisor.shutdown());
  });

  test('routes from fresh RPC state when a child becomes active without emitting a lifecycle event', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'state-reconcile')));
    expect(await Effect.runPromise(supervisor.status('agent-fixture'))).toMatchObject({
      isStreaming: false,
      pendingMessageCount: 0,
      status: 'starting',
    });

    expect(
      await Effect.runPromise(supervisor.send('agent-fixture', 'race-follow-up', 'auto')),
    ).toEqual({ deliveredAs: 'followUp', requestedBehavior: 'auto' });
    expect(
      commands(fixture)
        .filter((command) => command.type === 'follow_up')
        .at(-1),
    ).toMatchObject({ message: 'race-follow-up' });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('tracks active execution across running and idle lifecycle transitions', async () => {
    const fixture = fakeRpcWorker();
    let now = 1_000;
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      now: () => now,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'start-only', 'agent-timing')));
    await eventually(
      async () => (await Effect.runPromise(supervisor.status('agent-timing'))).status === 'running',
    );

    now = 1_250;
    expect(await Effect.runPromise(supervisor.status('agent-timing'))).toMatchObject({
      currentAskElapsedMs: 250,
      status: 'running',
      totalActiveMs: 250,
    });

    await Effect.runPromise(supervisor.send('agent-timing', 'finish-stream', 'steer'));
    await eventually(
      async () => (await Effect.runPromise(supervisor.status('agent-timing'))).status === 'idle',
    );
    now = 2_000;
    expect(await Effect.runPromise(supervisor.status('agent-timing'))).toMatchObject({
      currentAskElapsedMs: undefined,
      status: 'idle',
      totalActiveMs: 250,
    });

    await Effect.runPromise(supervisor.send('agent-timing', 'start-only', 'prompt'));
    await eventually(
      async () => (await Effect.runPromise(supervisor.status('agent-timing'))).status === 'running',
    );
    now = 2_125;
    expect(await Effect.runPromise(supervisor.status('agent-timing'))).toMatchObject({
      currentAskElapsedMs: 125,
      status: 'running',
      totalActiveMs: 375,
    });

    await Effect.runPromise(supervisor.send('agent-timing', 'finish-stream', 'steer'));
    await eventually(
      async () => (await Effect.runPromise(supervisor.status('agent-timing'))).status === 'idle',
    );
    expect(await Effect.runPromise(supervisor.stop('agent-timing'))).toMatchObject({
      currentAskElapsedMs: undefined,
      status: 'stopped',
      totalActiveMs: 375,
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('treats compaction as busy for every delivery behavior', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'compacting-only')));
    await expectSendFailure(
      supervisor,
      'agent-fixture',
      'auto',
      'Worker is compacting; retry after compaction completes.',
    );
    await expectSendFailure(
      supervisor,
      'agent-fixture',
      'prompt',
      'Worker is compacting; retry after compaction completes.',
    );
    await expectSendFailure(
      supervisor,
      'agent-fixture',
      'steer',
      'Worker is compacting; retry after compaction completes.',
    );
    await expectSendFailure(
      supervisor,
      'agent-fixture',
      'followUp',
      'Worker is compacting; retry after compaction completes.',
    );
    await Effect.runPromise(supervisor.shutdown());
  });

  test('auto-stop retires only freshly confirmed idle workers without active queues or compaction', async () => {
    const fixture = fakeRpcWorker();
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'quiet', 'agent-idle')));
    await eventually(
      async () => (await Effect.runPromise(supervisor.status('agent-idle'))).status === 'idle',
    );
    expect(await Effect.runPromise(supervisor.stopIfIdle('agent-idle'))).toMatchObject({
      status: 'stopped',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'start-only', 'agent-running')));
    await eventually(
      async () =>
        (await Effect.runPromise(supervisor.status('agent-running'))).status === 'running',
    );
    expect(await Effect.runPromise(supervisor.stopIfIdle('agent-running'))).toBeUndefined();
    expect((await Effect.runPromise(supervisor.status('agent-running'))).status).toBe('running');

    await Effect.runPromise(
      supervisor.spawn(spawnInput(fixture, 'compacting-only', 'agent-compacting')),
    );
    await eventually(
      async () =>
        (await Effect.runPromise(supervisor.status('agent-compacting'))).isCompacting === true,
    );
    expect(await Effect.runPromise(supervisor.stopIfIdle('agent-compacting'))).toBeUndefined();
    expect(await Effect.runPromise(supervisor.status('agent-compacting'))).toMatchObject({
      isCompacting: true,
      status: 'running',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'idle-pending', 'agent-pending')));
    expect(await Effect.runPromise(supervisor.stopIfIdle('agent-pending'))).toBeUndefined();
    expect(await Effect.runPromise(supervisor.status('agent-pending'))).toMatchObject({
      pendingMessageCount: 1,
      status: 'starting',
    });
    await Effect.runPromise(supervisor.shutdown());
  });

  test('serializes fast child events and drains lifecycle-owned handlers on shutdown', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.gen(function* () {
          if (event.type === 'report') yield* Effect.sleep('50 millis');
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });

    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'fast-report', 'agent-fast')));
    await Effect.runPromise(supervisor.shutdown());
    const reportIndex = events.findIndex(
      (event) => event.type === 'report' && event.summary === 'fast fixture complete',
    );
    const idleIndex = events.findIndex(
      (event) => event.type === 'status' && event.status === 'idle',
    );
    expect(reportIndex).toBeGreaterThanOrEqual(0);
    expect(idleIndex).toBeGreaterThan(reportIndex);
  });

  test('emits an unexpected exit event when a child crashes', async () => {
    const fixture = fakeRpcWorker();
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = makeWorkerSupervisor({
      args: () => [fixture.script],
      command: process.execPath,
      onEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      telemetryInterval: '1 hour',
    });
    await Effect.runPromise(supervisor.spawn(spawnInput(fixture, 'quiet', 'agent-crash')));
    await Effect.runPromise(supervisor.send('agent-crash', 'crash', 'prompt'));
    await eventually(() => events.some((event) => event.type === 'unexpected_exit'));
    expect((await Effect.runPromise(supervisor.status('agent-crash'))).status).toBe('crashed');
    expect(events.some((event) => event.type === 'unexpected_exit' && event.exitCode === 17)).toBe(
      true,
    );
    await Effect.runPromise(supervisor.shutdown());
  });
});
