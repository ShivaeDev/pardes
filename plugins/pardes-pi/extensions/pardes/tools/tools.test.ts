import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  GITHUB_CHECK_METADATA_TRUST_LABEL,
  GITHUB_CI_LOG_EXCERPT_TRUST_LABEL,
  GITHUB_DISCUSSION_EXCERPT_TRUST_LABEL,
  GITHUB_HOSTED_DRILLDOWN_EXCERPT_MAX_CHARS,
  GITHUB_HOSTED_DRILLDOWN_MAX_PAGE,
  GitHubCommandError,
  type GitHubIntegrationHealthInspection,
  GitHubResponseError,
} from '../github/index.ts';
import { createPardesCommandHandler } from '../index.ts';
import {
  type AgentRecord,
  type AgentStatus,
  AUTONOMOUS_INBOX_PATH,
  INBOX_EVENT_EXCERPT_MAX_OFFSET,
  INBOX_TWO_PATH_GUIDANCE,
  initialManagerState,
  MANAGER_EVENT_DETAILS_MAX_CHARS,
  type ManagerController,
  type ManagerEvent,
  type PluginActivationStatus,
  PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE,
  type PullRequestRecord,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
  type VerificationRecord,
  type Workstream,
} from '../manager/index.ts';
import type { ManagerPresentation } from '../presentation/index.ts';
import { REPORT_EXCERPT_MAX_CHARS, REPORT_HANDOFF_NOTE_MAX_CHARS } from '../reporting/index.ts';
import {
  STORAGE_EVENT_SCAN_MAX_BYTES,
  STORAGE_REPORT_SCAN_MAX_ENTRIES,
  type StorageInspection,
} from '../storage/index.ts';
import { requiredValue } from '../test-support.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import {
  COMPOSITION_MAX_CLUSTERS,
  COMPOSITION_MAX_GATES_PER_CLUSTER,
  COMPOSITION_MAX_PATHS_PER_ROW,
  COMPOSITION_MAX_UNCERTAIN_GATES,
  CONTROL_PLANE_MAX_ROWS,
  CONTROL_PLANE_MAX_TEXT_LENGTH,
  INBOX_EVENT_CHILD_TRUST_LABEL,
  INBOX_EVENT_DETAIL_RENDER_MAX_CHARS,
  INBOX_EVENT_EXTERNAL_FEEDBACK_TRUST_LABEL,
  INBOX_EVENT_EXTERNAL_METADATA_TRUST_LABEL,
  INBOX_EVENT_VERIFIER_TRUST_LABEL,
  RESOLVED_WORK_CLEANUP_DEFAULT_ROWS,
  registerAgentTools,
  registerHostedDrilldownTools,
  registerPullRequestTools,
  registerQuestionTool,
  registerWorkstreamTools,
} from './index.ts';
import { githubIntegrationHealthLines } from './projections/inspections.ts';
import { compositionLines } from './projections/reviews.ts';
import { verificationLines, verificationStatusLines } from './projections/verifications.ts';

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly details?: unknown;
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly parameters: {
    readonly additionalProperties?: boolean;
    readonly properties: Readonly<
      Record<
        string,
        {
          readonly minLength?: number;
          readonly maxLength?: number;
          readonly minimum?: number;
          readonly maximum?: number;
          readonly pattern?: string;
          readonly description?: string;
          readonly anyOf?: ReadonlyArray<{ readonly const?: unknown }>;
        }
      >
    >;
    readonly required?: ReadonlyArray<string>;
  };
  readonly prepareArguments?: (args: unknown) => unknown;
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) => Promise<ToolResult>;
}

function registry() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<
    string,
    Array<
      (
        event: { readonly message?: unknown; readonly messages?: unknown[] },
        ctx: ExtensionContext,
      ) => unknown
    >
  >();
  const messages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
  const pi = {
    on(
      eventName: string,
      handler: (
        event: { readonly message?: unknown; readonly messages?: unknown[] },
        ctx: ExtensionContext,
      ) => unknown,
    ) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
    registerTool(tool: unknown) {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const emit = (
    eventName: string,
    event: { readonly message?: unknown; readonly messages?: unknown[] },
  ) => {
    for (const handler of handlers.get(eventName) ?? []) handler(event, ctx);
  };
  return { emit, messages, pi, tools };
}

const ctx = { isIdle: () => true } as ExtensionContext;
const signal = new AbortController().signal;
const onUpdate = (_update: unknown) => {};
const createdAt = '2026-06-01T00:00:00.000Z';

function worker(): AgentRecord {
  return {
    createdAt,
    id: 'agent-12345678',
    model: 'fixture/model',
    role: 'worker',
    sessionDir: '/tmp/pardes/session',
    status: 'running',
    task: 'Exercise concise agent status output.',
    thinkingLevel: 'high',
    title: 'Schema ergonomics',
    updatedAt: createdAt,
    workstreamId: 'ws-12345678',
  };
}

function workstream(
  id: string,
  status: Workstream['status'],
  title = `Title for ${id}`,
): Workstream {
  return { createdAt, id, objective: `Objective for ${id}`, status, title, updatedAt: createdAt };
}

function runtime(overrides: Partial<WorkerRuntimeSnapshot> = {}): WorkerRuntimeSnapshot {
  return {
    agentId: 'agent-12345678',
    completedCompactionCount: 0,
    currentAskElapsedMs: 5_000,
    followUpMode: 'one-at-a-time',
    followUpQueueCount: 0,
    isStreaming: true,
    model: 'fixture/model',
    pendingMessageCount: 1,
    pid: 123,
    recentActivityLines: ['› read: extensions/pardes/tools/index.ts'],
    sampledAt: 2_000,
    sessionFile: '/tmp/pardes/session/fixture.jsonl',
    startedAt: 1_000,
    stats: {
      contextUsage: { contextWindow: 10_000, percent: 25, tokens: 2_500 },
      cost: 0.012,
      tokens: { cacheRead: 10, cacheWrite: 0, input: 100, output: 20, total: 130 },
      toolCalls: 3,
      totalMessages: 4,
    },
    status: 'running',
    stderr: { omittedChars: 0, originalChars: 17, shownChars: 17, tail: 'diagnostic stderr' },
    steeringMode: 'all',
    steeringQueueCount: 1,
    task: 'Exercise compact runtime status output.',
    thinkingLevel: 'high',
    totalActiveMs: 65_000,
    ...overrides,
  };
}

function managerState() {
  return initialManagerState('manager-12345678', {
    currentCheckout: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    key: 'repo-1',
    primaryCheckout: '/tmp/repo',
  });
}

describe('Pardes model-visible tools', () => {
  test('preserves the model-visible registration order used by the extension', () => {
    const { pi, tools } = registry();
    const manager = {} as ManagerController;
    registerQuestionTool(pi, manager);
    registerWorkstreamTools(pi, manager);
    registerAgentTools(pi, manager);

    expect([...tools.keys()]).toEqual([
      'question',
      'pardes_status',
      'workstream_create',
      'workstream_list',
      'workstream_get',
      'workstream_complete',
      'report_get',
      'agent_send_report',
      'inbox_get',
      'inbox_acknowledge',
      'pull_request_create',
      'pull_request_ci_inspect',
      'pull_request_ci_log_excerpt_get',
      'pull_request_discussion_excerpt_get',
      'verification_request',
      'verification_refresh',
      'verification_status',
      'agent_spawn',
      'agent_status',
      'agent_send',
      'agent_compact',
      'agent_reload',
      'agent_revive',
      'agent_stop',
      'agent_lease_cleanup',
    ]);
  });

  test('defaults spawn to a software-resolved origin baseline without requiring raw SHA bookkeeping', () => {
    const { pi, tools } = registry();
    registerAgentTools(pi, {} as ManagerController);

    const spawn = requiredValue(tools.get('agent_spawn'));
    expect(spawn.parameters.required).toEqual(['task', 'workstreamId']);
    expect(spawn.parameters.properties.title?.maxLength).toBe(80);
    expect(spawn.parameters.properties.branchPointSha).toBeUndefined();
    expect(spawn.parameters.properties.baselineBranch).toBeDefined();
    expect(spawn.parameters.properties.ownedPaths).toBeUndefined();
    expect(spawn.parameters.required).not.toContain('model');
    expect(spawn.parameters.required).not.toContain('thinkingLevel');
    expect(spawn.parameters.required).not.toContain('title');
    expect(spawn.parameters.required).not.toContain('baselineBranch');
  });

  test('aligns tool JSON schemas with authoritative bounded manager inputs', () => {
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, {} as ManagerController);
    registerAgentTools(pi, {} as ManagerController);
    const lexicalId = { maxLength: 100, minLength: 1, pattern: '^[a-zA-Z0-9._-]+$' };
    const assertLexicalId = (toolName: string, propertyName: string) => {
      expect(tools.get(toolName)?.parameters.properties[propertyName]).toMatchObject(lexicalId);
    };

    expect(tools.get('workstream_create')?.parameters.properties.title).toMatchObject({
      maxLength: 256,
      minLength: 1,
    });
    expect(tools.get('workstream_create')?.parameters.properties.objective).toMatchObject({
      maxLength: 10_000,
      minLength: 1,
    });
    assertLexicalId('workstream_get', 'workstreamId');
    assertLexicalId('workstream_complete', 'workstreamId');
    expect(tools.get('report_get')?.parameters.properties.reportId).toMatchObject({
      maxLength: 100,
      minLength: 1,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$',
    });
    expect(Object.keys(tools.get('report_get')?.parameters.properties ?? {})).toEqual(['reportId']);
    expect(tools.get('report_get')?.parameters.required).toEqual(['reportId']);
    assertLexicalId('agent_send_report', 'agentId');
    expect(tools.get('agent_send_report')?.parameters.properties.reportId).toMatchObject({
      maxLength: 100,
      minLength: 1,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$',
    });
    expect(tools.get('agent_send_report')?.parameters.properties.maxChars).toMatchObject({
      maximum: REPORT_EXCERPT_MAX_CHARS,
      minimum: 1,
    });
    expect(tools.get('agent_send_report')?.parameters.properties.message).toMatchObject({
      maxLength: REPORT_HANDOFF_NOTE_MAX_CHARS,
      minLength: 1,
    });
    assertLexicalId('inbox_get', 'eventId');
    expect(tools.get('inbox_get')?.parameters.properties.offset).toMatchObject({ minimum: 0 });
    expect(tools.get('inbox_get')?.parameters.properties.maxChars).toMatchObject({
      maximum: REPORT_EXCERPT_MAX_CHARS,
      minimum: 1,
    });
    assertLexicalId('inbox_acknowledge', 'cursor');
    const publish = requiredValue(tools.get('pull_request_create'));
    assertLexicalId('pull_request_create', 'workstreamId');
    assertLexicalId('pull_request_create', 'agentId');
    expect(publish.parameters.properties.title).toMatchObject({ maxLength: 256, minLength: 1 });
    expect(publish.parameters.properties.body).toMatchObject({ maxLength: 10_000, minLength: 1 });
    expect(publish.parameters.properties.baseBranch).toMatchObject({
      maxLength: 255,
      minLength: 1,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$',
    });

    const spawn = requiredValue(tools.get('agent_spawn'));
    assertLexicalId('agent_spawn', 'workstreamId');
    expect(spawn.parameters.properties.title).toMatchObject({ maxLength: 80, minLength: 1 });
    expect(spawn.parameters.properties.task).toMatchObject({ maxLength: 10_000, minLength: 1 });
    expect(spawn.parameters.properties.baselineBranch).toMatchObject({
      maxLength: 255,
      minLength: 1,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$',
    });
    expect(spawn.parameters.properties.model).toMatchObject({ maxLength: 256, minLength: 1 });
    expect(spawn.parameters.properties.thinkingLevel?.anyOf?.map((schema) => schema.const)).toEqual(
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    );

    assertLexicalId('verification_request', 'sourceAgentId');
    expect(tools.get('verification_request')?.parameters.properties.task).toMatchObject({
      maxLength: 10_000,
      minLength: 1,
    });
    expect(tools.get('verification_request')?.parameters.properties.task?.description).toContain(
      'whole surface and relevant diff context before a terminal report',
    );
    assertLexicalId('verification_refresh', 'verificationId');
    assertLexicalId('verification_status', 'verificationId');

    assertLexicalId('agent_status', 'agentId');
    expect(
      tools.get('agent_status')?.parameters.properties.mode?.anyOf?.map((schema) => schema.const),
    ).toEqual(['summary', 'audit', 'runtime']);
    expect(tools.get('agent_status')?.parameters.properties.verbose).toBeUndefined();
    expect(tools.get('agent_status')?.parameters.additionalProperties).toBe(false);
    assertLexicalId('agent_send', 'agentId');
    expect(tools.get('agent_send')?.parameters.properties.message).toMatchObject({
      maxLength: 10_000,
      minLength: 1,
    });
    expect(
      tools.get('agent_send')?.parameters.properties.behavior?.anyOf?.map((schema) => schema.const),
    ).toEqual(['auto', 'prompt', 'steer', 'followUp']);
    assertLexicalId('agent_revive', 'agentId');
    expect(tools.get('agent_revive')?.parameters.properties.message).toMatchObject({
      maxLength: 10_000,
      minLength: 1,
    });
    assertLexicalId('agent_stop', 'agentId');
    assertLexicalId('agent_compact', 'agentId');
    assertLexicalId('agent_reload', 'agentId');
    assertLexicalId('agent_lease_cleanup', 'agentId');
    expect(
      tools
        .get('agent_lease_cleanup')
        ?.parameters.properties.action?.anyOf?.map((schema) => schema.const),
    ).toEqual(['inspect', 'cleanup']);
    for (const toolName of ['agent_compact', 'agent_reload']) {
      const lifecycle = requiredValue(tools.get(toolName));
      expect(lifecycle.parameters.required).toEqual(['agentId']);
      expect(Object.keys(lifecycle.parameters.properties)).toEqual(['agentId']);
      expect(lifecycle.parameters.additionalProperties).toBe(false);
    }
  });

  test('describes advisory request and retained refresh as comprehensive manager-judged review protocols', () => {
    const { pi, tools } = registry();
    registerAgentTools(pi, {} as ManagerController);
    const request = requiredValue(tools.get('verification_request'));
    const refresh = requiredValue(tools.get('verification_refresh'));

    expect(request.description).toContain('inspect the whole requested risk surface');
    expect(request.description).toContain(
      'consolidate all currently known blockers, concerns, and notes in one bounded durable report',
    );
    expect(request.description).toContain('include bounded reproduction reasoning');
    expect(request.description).toContain('distinguish confidence from completeness limitations');
    expect(request.description).toContain('avoid serial finding drip-feed');
    expect(request.description).toContain('manager retains judgment');
    expect(request.promptSnippet).toContain('comprehensive advisory verifier');
    expect(refresh.description).toContain('comprehensive one-pass reporting protocol');
    expect(refresh.description).toContain(
      'retained advisory evidence remains subject to manager judgment',
    );
  });

  test('teaches the same explicit two-path cursor rule across inbox and user-judgment tool descriptions', () => {
    const { pi, tools } = registry();
    registerQuestionTool(pi, {} as ManagerController);
    registerWorkstreamTools(pi, {} as ManagerController);

    const canonicalGuidelines = [
      AUTONOMOUS_INBOX_PATH,
      USER_JUDGMENT_INBOX_PATH,
      USER_JUDGMENT_HANDOFF_PATH,
    ];
    const status = requiredValue(tools.get('pardes_status'));
    expect(status.promptGuidelines).toEqual(canonicalGuidelines);
    expect(status.promptSnippet).toBe(
      'Inspect concise bounded Pardes manager status and judge inbox attention before acknowledgement',
    );
    for (const name of ['inbox_get', 'inbox_acknowledge', 'question']) {
      const tool = requiredValue(tools.get(name));
      expect(tool.description, name).toContain(INBOX_TWO_PATH_GUIDANCE);
      expect(tool.promptGuidelines, name).toEqual(expect.arrayContaining(canonicalGuidelines));
    }
    expect(requiredValue(tools.get('inbox_get')).promptSnippet).toBe(
      'Read and judge one known durable Pardes attention row after compact inbox status',
    );
    expect(requiredValue(tools.get('inbox_acknowledge')).promptSnippet).toBe(
      'Acknowledge autonomous handled Pardes inbox rows through one exact cursor; never pre-acknowledge user judgment',
    );
    expect(requiredValue(tools.get('question')).promptSnippet).toBe(
      'Ask one structured or free-form user question and safely resolve any cursor delivered when it opens',
    );
    expect(requiredValue(tools.get('inbox_acknowledge')).description).toContain(
      'Use only for the autonomous path after rows are handled',
    );
    expect(requiredValue(tools.get('question')).description).toContain(
      'consumes only it after a valid non-blank answer',
    );
  });

  test('exposes a cheap concise aggregate status without refreshing or leaking raw state', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active', 'Active implementation');
    const planned = workstream('ws-planned', 'planned', 'Planned backlog');
    const complete = workstream('ws-complete', 'complete', 'Completed history');
    const agent = { ...worker(), lastError: 'Fixture warning.', workstreamId: active.id };
    const pullRequest: PullRequestRecord = {
      agentId: agent.id,
      createdAt,
      id: 'pr-42',
      number: 42,
      observation: {
        ci: 'failing',
        mergeable: 'mergeable',
        number: 42,
        reviewDecision: 'unknown',
        status: 'open',
      },
      status: 'open',
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/42',
      workstreamId: active.id,
    };
    const inbox: ManagerEvent = {
      createdAt,
      id: 'event-1',
      summary: 'CI requires attention.',
      type: 'ci_failed',
    };
    const state = {
      ...base,
      agents: { [agent.id]: agent },
      inbox: [inbox],
      pullRequests: { [pullRequest.id]: pullRequest },
      revision: 7,
      workstreams: { [active.id]: active, [planned.id]: planned, [complete.id]: complete },
    };
    let storageInspections = 0;
    const manager = {
      inspectStorage: () =>
        Effect.sync(() => {
          storageInspections += 1;
          throw new Error('Default summary must not inspect storage.');
        }),
      runtimeSnapshots: () => new Map([[agent.id, runtime()]]),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);

    const status = requiredValue(tools.get('pardes_status'));
    expect(status.parameters.properties.maxRows?.maximum).toBe(CONTROL_PLANE_MAX_ROWS);
    expect(status.parameters.properties.maxRows?.description).toContain(
      'Maximum returned rows for views other than inbox',
    );
    expect(status.parameters.properties.maxRows?.description).toContain(
      'Inbox preserves its fixed authored orientation rows and omission metadata even when they exceed this target.',
    );
    const result = await status.execute('call-1', {}, signal, onUpdate, ctx);
    expect(result.content[0]?.text).toBe(
      [
        'pardes manager-12345678 · revision 7',
        'workstreams: 1 active · 1 planned · 1 complete · 0 cancelled',
        'workers: 1 running · 0 idle · 0 starting · 0 crashed · 1 warnings',
        'review gates: 1 open · 1 attention · advisory verifications: 0 current · 0 stale · inbox: 1 pending',
        'attention index: 3 signals · first 3 shown · drill down: inbox | reviews(attention) | agents(warnings)',
        '! inbox event-1 [ci_failed] · judge first: inbox_get({ eventId })',
        '! review #42 [open] · ws-active · agent-12345678 · ⚠ ci:failing',
        '! worker agent-12345678 [running] · ws-active · ⚠ error',
      ].join('\n'),
    );
    expect(result.content[0]?.text).not.toContain('Objective');
    expect(result.content[0]?.text).not.toContain('sessionDir');
    expect(result.details).toBeUndefined();
    expect(storageInspections).toBe(0);

    const workers = await status.execute('call-2', { view: 'agents' }, signal, onUpdate, ctx);
    expect(workers.content[0]?.text).toContain(
      'agent-12345678 [running] ws-active “Schema ergonomics” · ctx:25% · active:1m05s · ask:5s · streaming · queued:1 · ⚠ error',
    );
  });

  test('keeps default attention orientation stable, priority-ordered, provenance-safe, and capped at five rows', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active');
    const warningAgent = (id: string, overrides: Partial<AgentRecord> = {}): AgentRecord => ({
      ...worker(),
      id,
      lastError: '/tmp/private-worker-diagnostic must stay out of overview',
      workstreamId: active.id,
      ...overrides,
    });
    const warningReview = (
      id: string,
      number: number,
      agentId: string,
      observation: PullRequestRecord['observation'],
    ): PullRequestRecord => ({
      agentId,
      createdAt,
      id,
      number,
      observation,
      status: 'open',
      updatedAt: createdAt,
      url: `https://github.test/acme/project/pull/${number}`,
      workstreamId: active.id,
    });
    const agentZ = warningAgent('agent-z');
    const agentA = warningAgent('agent-a', {
      gitAudit: { checkedAt: createdAt, dirty: true, status: 'succeeded', trigger: 'completion' },
      lastError: undefined,
    });
    const reviewZ = warningReview('pr-z', 42, agentZ.id, {
      ci: 'unknown',
      mergeable: 'conflicting',
      number: 42,
      reviewDecision: 'unknown',
      status: 'open',
    });
    const reviewA = warningReview('pr-a', 41, agentA.id, {
      ci: 'failing',
      mergeable: 'unknown',
      number: 41,
      reviewDecision: 'unknown',
      status: 'open',
    });
    const inbox: ReadonlyArray<ManagerEvent> = [
      {
        createdAt,
        id: 'event-z',
        summary: '/tmp/private-external-feedback must stay out of overview',
        type: 'discussion_feedback',
      },
      {
        createdAt,
        id: '/tmp/private-event-id',
        summary: '/tmp/private-worker-question must stay out of overview',
        type: 'agent_question',
      },
    ];
    const state = {
      ...base,
      agents: { [agentZ.id]: agentZ, [agentA.id]: agentA },
      inbox,
      pullRequests: { [reviewZ.id]: reviewZ, [reviewA.id]: reviewA },
      workstreamCompletionIntents: {
        [active.id]: {
          pendingAgents: [
            { agentId: agentA.id, lifecycleGeneration: 1, reportId: 'report-terminal' },
          ],
          requestedAt: createdAt,
          workstreamId: active.id,
        },
      },
      workstreams: { [active.id]: active },
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);

    const result = await requiredValue(tools.get('pardes_status')).execute(
      'call-1',
      {},
      signal,
      onUpdate,
      ctx,
    );
    const text = result.content[0]?.text;
    const lines = text.split('\n');

    expect(lines.slice(0, 6)).toEqual([
      'pardes manager-12345678 · revision 0',
      'workstreams: 1 active · 0 planned · 0 complete · 0 cancelled',
      'workers: 2 running · 0 idle · 0 starting · 0 crashed · 2 warnings',
      'review gates: 2 open · 2 attention · advisory verifications: 0 current · 0 stale · inbox: 2 pending',
      'completion intents: 1 pending · 1 generation-owned terminal child awaiting authoritative idle',
      'attention index: 6 signals · first 5 shown · drill down: inbox | reviews(attention) | agents(warnings)',
    ]);
    expect(lines.slice(6, 11)).toEqual([
      '! inbox event-z [discussion_feedback] · judge first: inbox_get({ eventId })',
      '! inbox redacted-event [agent_question] · judge first: inbox_get({ eventId })',
      '! review #41 [open] · ws-active · agent-a · ⚠ ci:failing',
      '! review #42 [open] · ws-active · agent-z · ⚠ merge:conflicting',
      '! worker agent-a [running] · ws-active · ⚠ dirty worktree',
    ]);
    expect(lines[11]).toBe('… +1 more attention signal omitted (1 worker)');
    expect(lines.filter((line) => line.startsWith('! '))).toHaveLength(5);
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(text).not.toContain('/tmp');
    expect(text).not.toContain('must stay out of overview');
    expect(text).not.toContain('agent-z [running]');
  });

  test('keeps shared-input drift advisory in the cheap overview and offers a fresh bounded path-free activation projection alongside the attention index', async () => {
    const activation: PluginActivationStatus = {
      current: {
        sourceControl: 'dirty',
        tree: { fingerprint: 'b'.repeat(64), kind: 'known', sourceFileCount: 2 },
      },
      lifecycle: 'allowed',
      loaded: {
        sourceControl: 'clean',
        tree: { fingerprint: 'a'.repeat(64), kind: 'known', sourceFileCount: 2 },
      },
      reason: 'pinned_snapshot_ready',
      snapshot: { identity: 'c'.repeat(64), inputFileCount: 2, state: 'ready' },
      status: 'changed',
    };
    const inbox: ManagerEvent = {
      createdAt,
      id: 'event-activation',
      summary: 'Do not copy this summary into overview.',
      type: 'ci_failed',
    };
    let inspections = 0;
    const manager = {
      activationSafetySnapshot: () => activation,
      inspectActivationSafety: () =>
        Effect.sync(() => {
          inspections += 1;
          return activation;
        }),
      runtimeSnapshots: () => new Map(),
      snapshot: () => ({ ...managerState(), inbox: [inbox] }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    expect(status.parameters.properties.view?.anyOf?.map((schema) => schema.const)).toContain(
      'activation',
    );
    const summary = await status.execute('call-1', {}, signal, onUpdate, ctx);
    expect(summary.content[0]?.text).toContain(
      'activation advisory: shared child runtime inputs changed · pinned snapshot lifecycle allowed · inspect: pardes_status(view="activation")',
    );
    expect(summary.content[0]?.text).toContain(
      'attention index: 1 signal · first 1 shown · drill down: inbox',
    );
    expect(summary.content[0]?.text).toContain(
      '! inbox event-activation [ci_failed] · judge first: inbox_get({ eventId })',
    );
    expect(inspections).toBe(0);

    const explicit = await status.execute('call-2', { view: 'activation' }, signal, onUpdate, ctx);
    expect(inspections).toBe(1);
    expect(explicit.content[0]?.text).toBe(
      [
        'activation safety: shared inputs changed · fresh spawn, revive, verifier launch, and child reload allowed',
        `pinned child runtime: ${'c'.repeat(64)} (2 input files)`,
        `shared child inputs: loaded ${'a'.repeat(64)} (2 source files) · current ${'b'.repeat(64)} (2 source files)`,
        'source control: loaded clean · current dirty',
        'operator boundary: coordinate pull/reload manually; Pardes does not fetch, pull, or reload plugin sources automatically',
      ].join('\n'),
    );
    expect(explicit.content[0]?.text).not.toContain('/tmp/private/plugin-checkout');
    expect(explicit.details).toBeUndefined();
  });

  test('keeps GitHub network inspection opt-in and renders bounded content-free integration-health metadata', async () => {
    const inspection: GitHubIntegrationHealthInspection = {
      bounds: { maxHostedChecksPerRef: 50, maxPullRequests: 12 },
      defaultBranch: {
        advertisedHeadSha: 'a'.repeat(40),
        availability: 'available',
        defaultBranch: 'main',
        hostedChecks: {
          availability: 'available',
          ci: 'failing',
          completeness: 'complete',
          countAccuracy: 'exact',
          headSha: 'a'.repeat(40),
          observedCheckCount: 2,
          observedFailingCheckCount: 1,
          relation: 'current',
        },
      },
      inspectedPullRequestCount: 1,
      observation: 'opt_in_read_only_hosted_metadata',
      omittedPullRequestCount: 0,
      pullRequests: [
        {
          auditedHeadSha: 'b'.repeat(40),
          hostedChecks: {
            availability: 'available',
            ci: 'failing',
            completeness: 'complete',
            countAccuracy: 'exact',
            headSha: 'c'.repeat(40),
            observedCheckCount: 1,
            observedFailingCheckCount: 1,
            relation: 'current',
          },
          id: 'pr-42',
          number: 42,
          observedHeadSha: 'b'.repeat(40),
          pullRequestHead: 'current',
          sharedFailingWorkflowCount: 1,
          watcherFailure: {
            kind: 'authentication_likely',
            summary: 'GitHub CLI authentication likely failed; run gh auth status.',
          },
        },
      ],
      rateLimit: {
        credentialContext: 'github_com_controller_lifetime',
        fallback: 'available',
        graphql: {
          availability: 'available',
          limit: 5_000,
          pressure: 'near_exhaustion',
          remaining: 100,
          resetAt: '2026-06-01T01:00:00Z',
          source: 'graphql',
        },
        observation: 'bounded_hosted_rate_budget',
        rest: {
          availability: 'available',
          limit: 5_000,
          pressure: 'ready',
          remaining: 4_000,
          resetAt: '2026-06-01T01:00:00Z',
          source: 'rest_fallback',
        },
        watcherPolling: {
          effectiveRemaining: 100,
          reason: 'proactive_throttle',
          status: 'deferred',
          tier: 'paused',
          until: '2026-06-01T01:00:00Z',
        },
      },
    };
    let inspections = 0;
    const manager = {
      inspectGitHubIntegrationHealth: () =>
        Effect.sync(() => {
          inspections += 1;
          return inspection;
        }),
      runtimeSnapshots: () => new Map(),
      snapshot: () => managerState(),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    expect(status.parameters.properties.view?.anyOf?.map((schema) => schema.const)).toContain(
      'github',
    );
    const summary = await status.execute('call-1', {}, signal, onUpdate, ctx);
    expect(inspections).toBe(0);
    expect(summary.content[0]?.text).not.toContain('github integration health');

    const explicit = await status.execute('call-2', { view: 'github' }, signal, onUpdate, ctx);
    expect(inspections).toBe(1);
    expect(explicit.content[0]?.text).toBe(
      [
        'github integration health: opt-in read-only hosted metadata · 1 review gate inspected',
        `default branch main · advertised:${'a'.repeat(40)} · hosted:${'a'.repeat(40)} [current/complete] · ci:failing · checks:2 · fail:1`,
        'rate scope: GitHub.com repository pinned/controller lifetime · caller must not switch gh credentials in place · reload manager first for fresh cache',
        'rate budget: graphql:100/5000 [near_exhaustion/graphql] · reset:2026-06-01T01:00:00Z',
        'rate fallback: rest:4000/5000 [ready/rest_fallback] · reset:2026-06-01T01:00:00Z · endpoint:available · watcher-last-disposition:deferred(proactive_throttle)',
        `#42 · audited:${'b'.repeat(40)} · observed:${'b'.repeat(40)} [current] · hosted:${'c'.repeat(40)} [current/complete] · ci:failing · checks:1 · fail:1 · likely-main-shared-failures:1`,
        '↳ #42 watcher diagnosis [authentication_likely]: GitHub CLI authentication likely failed; run gh auth status.',
        'bounds: first 12 open review gates · first 50 server-selected hosted checks per ref · no logs, bodies, fetch, or pull',
      ].join('\n'),
    );
    expect(explicit.content[0]?.text).not.toContain('https://');
    expect(explicit.details).toBeUndefined();

    const partial = githubIntegrationHealthLines({
      ...inspection,
      pullRequests: [
        {
          ...requiredValue(inspection.pullRequests[0]),
          hostedChecks: {
            availability: 'available',
            ci: 'unknown',
            completeness: 'partial',
            countAccuracy: 'lower_bound',
            headSha: 'c'.repeat(40),
            observedCheckCount: 1,
            observedFailingCheckCount: 0,
            relation: 'current',
          },
        },
      ],
    });
    expect(partial).toContain('[current/partial] · ci:unknown · checks:≥1 · fail:≥0');
    expect(partial).not.toContain('likely-main-shared-failures');
  });

  test('offers an explicit bounded read-only storage projection without returning paths, listings, or artifact content', async () => {
    const storage: StorageInspection = {
      bounds: {
        eventScanMaxBytes: STORAGE_EVENT_SCAN_MAX_BYTES,
        reportScanMaxEntries: STORAGE_REPORT_SCAN_MAX_ENTRIES,
      },
      events: {
        bytes: 131_072,
        eventLines: 73,
        eventLinesAccuracy: 'lower_bound',
        kind: 'regular_file',
        omissionReason: 'event_scan_byte_limit',
        omittedBytes: STORAGE_EVENT_SCAN_MAX_BYTES,
        scannedBytes: STORAGE_EVENT_SCAN_MAX_BYTES,
      },
      reports: {
        kind: 'directory',
        metricsAccuracy: 'lower_bound',
        omissionReason: 'direct_entry_scan_limit',
        omittedEntriesLowerBound: 1,
        otherEntries: 2,
        reportBytes: 4_096,
        reports: 128,
        scannedEntries: STORAGE_REPORT_SCAN_MAX_ENTRIES,
      },
      root: { kind: 'directory' },
      state: { bytes: 512, kind: 'regular_file' },
    };
    let inspections = 0;
    const manager = {
      inspectStorage: () =>
        Effect.sync(() => {
          inspections += 1;
          return storage;
        }),
      runtimeSnapshots: () => new Map(),
      snapshot: () => managerState(),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    expect(status.parameters.properties.view?.anyOf?.map((schema) => schema.const)).toContain(
      'storage',
    );
    const result = await status.execute(
      'call-1',
      { maxRows: 999, view: 'storage' },
      signal,
      onUpdate,
      ctx,
    );
    const text = result.content[0]?.text;

    expect(inspections).toBe(1);
    expect(text).toContain('storage: read-only bounded inspection · root directory');
    expect(text).toContain('state: regular file · 512 bytes');
    expect(text).toContain(
      'events: regular file · 131072 bytes · ≥73 event lines · scan limited [event_scan_byte_limit]: original=131072 shown=65536 omitted=65536 bytes',
    );
    expect(text).toContain(
      'reports: directory · ≥128 reports · ≥4096 bytes · 2 other direct entries observed · scan limited [direct_entry_scan_limit]: shown=128 omitted>=1 direct entries',
    );
    expect(text).toContain('no artifact contents returned');
    expect(text.split('\n').length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_ROWS);
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(text).not.toContain('/tmp');
    expect(result.details).toBeUndefined();
  });

  test('adds bounded canonical disposition tags to idle status rows without tagging terminal history', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active');
    const idleAgent = (id: string, overrides: Partial<AgentRecord> = {}): AgentRecord => ({
      ...worker(),
      id,
      status: 'idle',
      workstreamId: active.id,
      ...overrides,
    });
    const unclassified = idleAgent('agent-unclassified');
    const review = idleAgent('agent-review');
    const merged = idleAgent('agent-merged');
    const attention = idleAgent('agent-attention', { lastError: 'Persisted warning.' });
    const terminal = idleAgent('agent-terminal', { status: 'stopped' });
    const reviewGate = (
      id: string,
      agentId: string,
      status: PullRequestRecord['status'],
    ): PullRequestRecord => ({
      agentId,
      createdAt,
      id,
      status,
      updatedAt: createdAt,
      url: `https://github.test/acme/project/pull/${id}`,
      workstreamId: active.id,
    });
    const open = reviewGate('pr-open', review.id, 'open');
    const mergedGate = reviewGate('pr-merged', merged.id, 'merged');
    const terminalGate = reviewGate('pr-terminal', terminal.id, 'merged');
    const state = {
      ...base,
      agents: Object.fromEntries(
        [unclassified, review, merged, attention, terminal].map((agent) => [agent.id, agent]),
      ),
      pullRequests: {
        [open.id]: open,
        [mergedGate.id]: mergedGate,
        [terminalGate.id]: terminalGate,
      },
      workstreams: { [active.id]: active },
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);

    const result = await requiredValue(tools.get('pardes_status')).execute(
      'call-1',
      { agentFilter: 'all', view: 'agents' },
      signal,
      onUpdate,
      ctx,
    );
    const text = result.content[0]?.text;

    expect(text).toContain('agent-unclassified [idle] [disposition:idle_unclassified]');
    expect(text).toContain('agent-review [idle] [disposition:review_gate_open]');
    expect(text).toContain('agent-merged [idle] [disposition:merged_retirement_pending]');
    expect(text).toContain('agent-attention [idle] [disposition:needs_attention]');
    expect(text).toContain('agent-terminal [stopped] ws-active');
    expect(text).not.toContain('agent-terminal [stopped] [disposition:');
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(text.split('\n').length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_ROWS);
  });

  test('makes resolved terminal verifier history and conservative refresh policy explicit in bounded verification projections', () => {
    const base = managerState();
    const checkout = {
      createdAt,
      managerId: base.managerId,
      path: '/tmp/repo/.worktrees/pardes/manager-12345678/verify-12345678',
      reviewedHeadSha: 'a'.repeat(40),
      verificationId: 'verify-12345678',
    };
    const verification: VerificationRecord = {
      attempts: [
        {
          attempt: 1,
          createdAt,
          evidenceStatus: 'current',
          reviewCheckout: checkout,
          reviewedHeadSha: checkout.reviewedHeadSha,
          sourceBranchPointSha: 'b'.repeat(40),
          status: 'stopped',
          updatedAt: createdAt,
        },
      ],
      createdAt,
      id: checkout.verificationId,
      model: 'fixture/model',
      sourceAgentId: 'agent-writer',
      task: 'Review terminal fixture.',
      thinkingLevel: 'high',
      updatedAt: createdAt,
      verifierAgentId: 'verifier-12345678',
      workstreamId: 'ws-active',
    };
    const terminalGate: PullRequestRecord = {
      agentId: verification.sourceAgentId,
      createdAt,
      id: 'pr-terminal',
      status: 'merged',
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/42',
      workstreamId: verification.workstreamId,
    };
    const state = {
      ...base,
      pullRequests: { [terminalGate.id]: terminalGate },
      verifications: { [verification.id]: verification },
    };

    expect(verificationLines(state)).toContain('review-loop:resolved_terminal');
    expect(verificationStatusLines(verification, state)).toContain(
      'review-loop:resolved_terminal · refresh:new verification request required',
    );
  });

  test('offers bounded resolved-work cleanup guidance without mutating or exposing artifact paths', async () => {
    const base = managerState();
    const complete = workstream('ws-complete', 'complete');
    const retained = {
      ...worker(),
      id: 'agent-retained',
      status: 'stopped' as const,
      workstreamId: complete.id,
      worktree: {
        agentId: 'agent-retained',
        branch: 'pardes/manager-12345678/agent-retained',
        branchPointSha: 'b'.repeat(40),
        createdAt,
        managerId: base.managerId,
        path: '/tmp/private/writer-checkout',
      },
    };
    const verifier = {
      ...worker(),
      id: 'verifier-history',
      role: 'verifier' as const,
      status: 'stopped' as const,
      workstreamId: complete.id,
    };
    const verification: VerificationRecord = {
      attempts: [
        {
          attempt: 1,
          createdAt,
          evidenceStatus: 'current',
          reviewCheckout: {
            createdAt,
            managerId: base.managerId,
            path: '/tmp/private/review-checkout',
            reviewedHeadSha: 'a'.repeat(40),
            verificationId: 'verify-history',
          },
          reviewedHeadSha: 'a'.repeat(40),
          sourceBranchPointSha: 'b'.repeat(40),
          status: 'stopped',
          updatedAt: createdAt,
        },
      ],
      createdAt,
      id: 'verify-history',
      model: 'fixture/model',
      scratchCleanupPending: true,
      sourceAgentId: retained.id,
      task: 'Review terminal fixture.',
      thinkingLevel: 'high',
      updatedAt: createdAt,
      verifierAgentId: verifier.id,
      workstreamId: complete.id,
    };
    const merged: PullRequestRecord = {
      agentId: retained.id,
      createdAt,
      id: 'pr-merged',
      status: 'merged',
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/42',
      workstreamId: complete.id,
    };
    const state = {
      ...base,
      agents: { [retained.id]: retained, [verifier.id]: verifier },
      pullRequests: { [merged.id]: merged },
      verifications: { [verification.id]: verification },
      workstreams: { [complete.id]: complete },
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    expect(status.parameters.properties.view?.anyOf?.map((schema) => schema.const)).toContain(
      'cleanup',
    );
    const result = await status.execute('call-cleanup', { view: 'cleanup' }, signal, onUpdate, ctx);
    const text = result.content[0]?.text;

    expect(text).toContain(
      'resolved merged loops: 1 merged review gate · 1 workstream · 0 domain completions pending',
    );
    expect(text).toContain(
      'history-only verifiers: 1 retained record · 0 retirements pending · retain advisory records as history',
    );
    expect(text).toContain(
      'detached retained workers: 1 total · 1 resolved lease inspect candidate · 0 open-review owners retained',
    );
    expect(text).toContain(
      'disposable verifier scratch metadata: 1 terminal lease retained by default · 1 cleanup retry pending',
    );
    expect(text).toContain(
      'agent_lease_cleanup({ agentId, action:"inspect" }) one at a time; clean explicitly only after review · candidates: agent-retained',
    );
    expect(text).toContain(
      'verification_refresh({ verificationId }) only for listed disposable verifier scratch · pending: verify-history',
    );
    expect(text).toContain(
      'safety: artifact cleanup is not a domain transition; never auto-delete or manually remove paths; never infer force flags, discard dirty worker content, or delete unmerged history',
    );
    expect(text).not.toContain('/tmp/private');
    expect(text).not.toContain('forceDiscardDirty: true');
    expect(text).not.toContain('forceDeleteUnmergedBranch: true');
    expect(text.split('\n').length).toBeLessThanOrEqual(RESOLVED_WORK_CLEANUP_DEFAULT_ROWS);
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(result.details).toBeUndefined();
  });

  test('hard-bounds compact worker and inbox index rows and text', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active');
    const agents = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => {
        const id = `agent-${String(index).padStart(8, '0')}`;
        return [id, { ...worker(), id, title: 'x'.repeat(240), workstreamId: active.id }];
      }),
    );
    const runtimes = new Map(Object.keys(agents).map((agentId) => [agentId, runtime({ agentId })]));
    const longSummary = 'y'.repeat(400);
    const inbox = Array.from({ length: 11 }, (_, index) => ({
      createdAt,
      id: `event-${index}`,
      summary: longSummary,
      type: 'agent_question',
    }));
    const state = { ...base, agents, inbox, workstreams: { [active.id]: active } };
    const manager = {
      runtimeSnapshots: () => runtimes,
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    const workers = await status.execute(
      'call-1',
      { agentFilter: 'all', maxRows: 999, view: 'agents' },
      signal,
      onUpdate,
      ctx,
    );
    const workerText = workers.content[0]?.text;
    expect(workerText.split('\n')).toHaveLength(CONTROL_PLANE_MAX_ROWS);
    expect(workerText.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(workerText).toContain('more rows');
    expect(workerText).not.toContain('x'.repeat(240));

    const pending = await status.execute(
      'call-2',
      { maxRows: 999, view: 'inbox' },
      signal,
      onUpdate,
      ctx,
    );
    expect(pending.content[0]?.text.split('\n').length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_ROWS);
    expect(pending.content[0]?.text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(pending.content[0]?.text).not.toContain(longSummary);

    const tinyInbox = await status.execute(
      'call-3',
      { maxRows: 1, view: 'inbox' },
      signal,
      onUpdate,
      ctx,
    );
    expect(tinyInbox.content[0]?.text).toContain(`path autonomous: ${AUTONOMOUS_INBOX_PATH}`);
    expect(tinyInbox.content[0]?.text).toContain(`path judgment: ${USER_JUDGMENT_INBOX_PATH}`);
    expect(tinyInbox.content[0]?.text).toContain(`judgment handoff: ${USER_JUDGMENT_HANDOFF_PATH}`);
    expect(tinyInbox.content[0]?.text).toContain('… +11 more inbox index rows omitted');
    expect(tinyInbox.content[0]?.text.split('\n').length).toBeGreaterThan(1);
    expect(tinyInbox.content[0]?.text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
  });

  test('filters compact workstream surfaces so active work and planned backlog avoid completed history', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active', 'Active implementation');
    const planned = workstream('ws-planned', 'planned', 'Planned backlog');
    const complete = workstream('ws-complete', 'complete', 'Completed history');
    const workstreams = [active, planned, complete];
    const state = {
      ...base,
      workstreams: Object.fromEntries(workstreams.map((item) => [item.id, item])),
    };
    const manager = {
      listWorkstreams: () => Effect.succeed(workstreams),
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);

    const list = requiredValue(tools.get('workstream_list'));
    const activeList = await list.execute('call-1', {}, signal, onUpdate, ctx);
    expect(activeList.content[0]?.text).toContain('ws-active [active]');
    expect(activeList.content[0]?.text).not.toContain('ws-planned');
    expect(activeList.content[0]?.text).not.toContain('ws-complete');
    expect(activeList.details).toBeUndefined();

    const plannedList = await list.execute('call-2', { status: 'planned' }, signal, onUpdate, ctx);
    expect(plannedList.content[0]?.text).toContain('ws-planned [planned] Planned backlog');
    expect(plannedList.content[0]?.text).not.toContain('ws-complete');

    const indexed = await requiredValue(tools.get('pardes_status')).execute(
      'call-3',
      { view: 'workstreams', workstreamStatus: 'planned' },
      signal,
      onUpdate,
      ctx,
    );
    expect(indexed.content[0]?.text).toContain('ws-planned [planned] Planned backlog');
    expect(indexed.content[0]?.text).not.toContain('ws-complete');
  });

  test('offers compact review-gate and inbox views with an attention refinement', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active');
    const calm: PullRequestRecord = {
      agentId: 'agent-calm',
      createdAt,
      id: 'pr-41',
      number: 41,
      observation: {
        ci: 'passing',
        mergeable: 'mergeable',
        number: 41,
        reviewDecision: 'approved',
        status: 'open',
      },
      status: 'open',
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/41',
      workstreamId: active.id,
    };
    const attention: PullRequestRecord = {
      ...calm,
      agentId: 'agent-attention',
      id: 'pr-42',
      number: 42,
      observation: {
        ci: 'failing',
        mergeable: 'conflicting',
        number: 42,
        reviewDecision: 'changes_requested',
        status: 'open',
      },
      url: 'https://github.test/acme/project/pull/42',
    };
    const inbox = [
      {
        createdAt,
        id: 'event-1',
        summary: 'Review gate needs a follow-up.',
        type: 'review_feedback',
      },
    ];
    const state = {
      ...base,
      githubRateMetadataUnavailableAt: createdAt,
      inbox: [
        ...inbox,
        {
          createdAt,
          id: 'event-blocked-merge',
          presentationBlocked: true,
          summary: '#42 externally merged; bounded retirement outcome is pending.',
          type: 'merged',
        },
      ],
      inboxWake: { createdAt, cursor: 'event-1', pendingCount: 1, token: 'wake-fixture' },
      pullRequests: { [calm.id]: calm, [attention.id]: attention },
      workstreams: { [active.id]: active },
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    const reviews = await status.execute(
      'call-1',
      { reviewFilter: 'attention', view: 'reviews' },
      signal,
      onUpdate,
      ctx,
    );
    expect(reviews.content[0]?.text).toContain(
      'review gates: 2 open · 1 attention · 2 total (1 attention)',
    );
    expect(reviews.content[0]?.text).toContain(
      'global GitHub warning [external-metadata]: rate metadata unavailable or invalid · watcher polling deferred',
    );
    expect(reviews.content[0]?.text).toContain('#42 [open]');
    expect(reviews.content[0]?.text).not.toContain('#41 [open]');

    const pending = await status.execute('call-2', { view: 'inbox' }, signal, onUpdate, ctx);
    expect(pending.content[0]?.text).toContain(
      'inbox: 2 pending events · read and judge one: inbox_get({ eventId })',
    );
    expect(pending.content[0]?.text).toContain('delivery: cursor event-1 · delivered age:');
    expect(pending.content[0]?.text).toContain(
      '· queued suffix:1 · awaiting-user:no · wake wake-fixture · ack-safe cursor:event-1/1 · frontier:event-1/1 · blocked:1 · barrier:event-blocked-merge(software_refinement_pending)',
    );
    expect(pending.content[0]?.text).toContain(`path autonomous: ${AUTONOMOUS_INBOX_PATH}`);
    expect(pending.content[0]?.text).toContain(`path judgment: ${USER_JUDGMENT_INBOX_PATH}`);
    expect(pending.content[0]?.text).toContain(`judgment handoff: ${USER_JUDGMENT_HANDOFF_PATH}`);
    expect(pending.content[0]?.text).toContain(
      'event-1 [review_feedback] · external-metadata · drill-down: inbox_get({ eventId:event-1 })',
    );
    expect(pending.content[0]?.text).toContain(
      'event-blocked-merge [merged] · external-metadata · refinement barrier:software_refinement_pending; do not acknowledge · drill-down: inbox_get({ eventId:event-blocked-merge })',
    );

    const summary = await status.execute('call-3', {}, signal, onUpdate, ctx);
    expect(summary.content[0]?.text).toContain('· blocked:1');
    expect(summary.content[0]?.text).toContain(
      '! inbox event-blocked-merge [merged] · software refinement pending; judge first: inbox_get({ eventId }); do not acknowledge',
    );
  });

  test('offers an explicit read-only composition plan with overlap clusters, independent gates, and conservative uncertain evidence', async () => {
    const base = managerState();
    const exactPush = 'a'.repeat(40);
    const reviewGate = (
      id: string,
      number: number,
      publishedChangedPaths: ReadonlyArray<string> | undefined,
      overrides: Partial<PullRequestRecord> = {},
    ): PullRequestRecord => ({
      agentId: `agent-${number}`,
      id,
      lastPushedHeadSha: exactPush,
      number,
      status: 'open',
      url: `https://github.test/acme/project/pull/${number}`,
      workstreamId: `ws-${number}`,
      ...(publishedChangedPaths === undefined ? {} : { publishedChangedPaths }),
      createdAt,
      updatedAt: createdAt,
      ...overrides,
    });
    const overlapA = reviewGate('pr-01', 1, ['src/a.ts', 'src/shared.ts']);
    const overlapB = reviewGate('pr-02', 2, ['src/b.ts', 'src/shared.ts']);
    const independent = reviewGate('pr-03', 3, ['src/independent.ts']);
    const stale = reviewGate('pr-04', 4, ['src/last-known.ts'], {
      headDivergedAt: createdAt,
      watcherFailedAt: createdAt,
    });
    const unavailable = reviewGate('pr-05', 5, undefined);
    const terminal = reviewGate('pr-06', 6, ['src/shared.ts'], { status: 'merged' });
    const state = {
      ...base,
      pullRequests: Object.fromEntries(
        [overlapA, overlapB, independent, stale, unavailable, terminal].map((gate) => [
          gate.id,
          gate,
        ]),
      ),
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    expect(status.parameters.properties.view?.anyOf?.map((schema) => schema.const)).toContain(
      'composition',
    );
    const result = await status.execute('call-1', { view: 'composition' }, signal, onUpdate, ctx);
    const text = result.content[0]?.text;

    expect(text).toContain(
      'composition plan: 5 open gates · 2 software-known clusters (1 independent/1 overlap) · 2 uncertain',
    );
    expect(text).toContain(
      'merge-wave hint: user controls merges; pair independent clusters only; serialize overlaps; after each merge refresh/re-audit remainder; inspect uncertain gates first',
    );
    expect(text).toContain(
      'uncertain #4 [stale:remote-head,watcher] · independence:not established · last-known paths(1):src/last-known.ts',
    );
    expect(text).toContain(
      'uncertain #5 [unavailable:exact-push paths absent] · independence:not established',
    );
    expect(text).toContain(
      'cluster 1 [overlap:2] #1,#2 · sequence:merge one then refresh/re-audit remainder · paths(3):src/a.ts,src/b.ts,src/shared.ts',
    );
    expect(text).toContain(
      'cluster 2 [independent] #3 · wave:may pair · paths(1):src/independent.ts',
    );
    expect(text).not.toContain('#6');
    expect(text.split('\n').length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_ROWS);
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(result.details).toBeUndefined();
  });

  test('hard-caps composition rows, clusters, uncertain gates, gate labels, and changed-path previews', () => {
    const base = managerState();
    const exactPush = 'a'.repeat(40);
    const known = (index: number, paths: ReadonlyArray<string>): PullRequestRecord => ({
      agentId: `agent-${index}`,
      createdAt,
      id: `pr-${String(index).padStart(2, '0')}`,
      lastPushedHeadSha: exactPush,
      number: index,
      publishedChangedPaths: paths,
      status: 'open',
      updatedAt: createdAt,
      url: `https://github.test/acme/project/pull/${index}`,
      workstreamId: `ws-${index}`,
    });
    const uncertain = (index: number): PullRequestRecord => ({
      ...known(index, ['src/last-known.ts']),
      watcherFailedAt: createdAt,
    });
    const overlapPaths = (index: number) => [
      'src/common.ts',
      `src/path-${index}.ts`,
      'src/path-a.ts',
      'src/path-b.ts',
      'src/path-c.ts',
      'src/path-d.ts',
    ];
    const gates = [
      ...Array.from({ length: COMPOSITION_MAX_GATES_PER_CLUSTER + 2 }, (_, index) =>
        known(index + 1, overlapPaths(index + 1)),
      ),
      ...Array.from({ length: COMPOSITION_MAX_CLUSTERS + 1 }, (_, index) =>
        known(index + 20, [`src/independent-${index}.ts`]),
      ),
      ...Array.from({ length: COMPOSITION_MAX_UNCERTAIN_GATES + 2 }, (_, index) =>
        uncertain(index + 40),
      ),
    ];
    const text = compositionLines(
      { ...base, pullRequests: Object.fromEntries(gates.map((gate) => [gate.id, gate])) },
      999,
    );

    expect(text).toContain(
      `composition plan: ${gates.length} open gates · ${COMPOSITION_MAX_CLUSTERS + 2} software-known clusters (${COMPOSITION_MAX_CLUSTERS + 1} independent/1 overlap) · ${COMPOSITION_MAX_UNCERTAIN_GATES + 2} uncertain`,
    );
    expect(text).toContain(
      `cluster 1 [overlap:${COMPOSITION_MAX_GATES_PER_CLUSTER + 2}] #1,#2,#3,#4,…+2`,
    );
    expect(text).toContain(
      `… omitted by composition caps: 2 software-known clusters · 2 uncertain gates`,
    );
    expect(text).toContain(
      `bounds: first ${COMPOSITION_MAX_CLUSTERS} software-known clusters · first ${COMPOSITION_MAX_UNCERTAIN_GATES} uncertain gates · first ${COMPOSITION_MAX_GATES_PER_CLUSTER} gates/cluster · first ${COMPOSITION_MAX_PATHS_PER_ROW} paths/row`,
    );
    expect(text).toContain(',…+');
    expect(text).not.toContain('uncertain #43');
    expect(text.split('\n').length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_ROWS);
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
  });

  test('keeps acknowledged discussion pagination-gap surfaces visible in default and review status', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active');
    const gap: PullRequestRecord = {
      agentId: 'agent-gap',
      createdAt,
      discussionPaginationGaps: ['issue_comment', 'inline_review_comment'],
      id: 'pr-gap',
      number: 42,
      observation: {
        ci: 'passing',
        mergeable: 'mergeable',
        number: 42,
        reviewDecision: 'approved',
        status: 'open',
      },
      status: 'open',
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/42',
      workstreamId: active.id,
    };
    // The durable warning must remain self-describing after its inbox row was acknowledged.
    const state = {
      ...base,
      inbox: [],
      pullRequests: { [gap.id]: gap },
      workstreams: { [active.id]: active },
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    const summary = await status.execute('call-1', {}, signal, onUpdate, ctx);
    const reviews = await status.execute(
      'call-2',
      { reviewFilter: 'attention', view: 'reviews' },
      signal,
      onUpdate,
      ctx,
    );
    for (const result of [summary, reviews]) {
      expect(result.content[0]?.text).toContain(
        'discussion-gap:2(issue_comment,inline_review_comment)',
      );
      expect(result.content[0]?.text).not.toContain('external GitHub feedback');
      expect(result.content[0]?.text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    }
    expect(summary.content[0]?.text).toContain(
      'review gates: 1 open · 1 attention · advisory verifications: 0 current · 0 stale · inbox: 0 pending',
    );
    expect(summary.content[0]?.text).toContain(
      '! review #42 [open] · ws-active · agent-gap · ⚠ discussion-gap:2(issue_comment,inline_review_comment)',
    );
    expect(reviews.content[0]?.text).toContain(
      '#42 [open] ws-active · agent-gap · ci:passing · review:approved · merge:mergeable · ⚠ discussion-gap:2(issue_comment,inline_review_comment)',
    );
  });

  test('keeps the current bounded watcher diagnosis visible in default and review status after inbox acknowledgement', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active');
    const gate: PullRequestRecord = {
      agentId: 'agent-watcher',
      createdAt,
      id: 'pr-watcher',
      number: 42,
      status: 'open',
      updatedAt: createdAt,
      url: 'https://github.test/acme/project/pull/42',
      watcherFailedAt: createdAt,
      watcherFailure: {
        kind: 'authentication_likely',
        summary: 'GitHub CLI authentication likely failed; run gh auth status.',
      },
      workstreamId: active.id,
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => ({
        ...base,
        inbox: [],
        pullRequests: { [gate.id]: gate },
        workstreams: { [active.id]: active },
      }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    const summary = await status.execute('call-1', {}, signal, onUpdate, ctx);
    const reviews = await status.execute(
      'call-2',
      { reviewFilter: 'attention', view: 'reviews' },
      signal,
      onUpdate,
      ctx,
    );

    expect(summary.content[0]?.text).toContain(
      '! review #42 [open] · ws-active · agent-watcher · ⚠ watcher:authentication_likely',
    );
    expect(reviews.content[0]?.text).toContain(
      '#42 [open] ws-active · agent-watcher · observation:none · ⚠ watcher:authentication_likely',
    );
    expect(reviews.content[0]?.text).toContain(
      '↳ #42 watcher diagnosis [authentication_likely]: GitHub CLI authentication likely failed; run gh auth status.',
    );
    expect(`${summary.content[0]?.text}\n${reviews.content[0]?.text}`).not.toContain('stderr');
  });

  test('exposes delivered, awaiting-user, and queued-suffix inbox handoff state compactly', async () => {
    const first = {
      createdAt,
      id: 'event-first',
      summary: 'First presented question.',
      type: 'agent_question',
    };
    const suffix = {
      createdAt,
      id: 'event-suffix',
      summary: 'Later queued question.',
      type: 'agent_question',
    };
    const state = {
      ...managerState(),
      inbox: [first, suffix],
      inboxHandoff: { cursor: first.id, surfacedAt: createdAt },
      inboxWake: { createdAt, cursor: first.id, pendingCount: 1, token: 'wake-first' },
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);

    const inbox = await requiredValue(tools.get('pardes_status')).execute(
      'call-1',
      { view: 'inbox' },
      signal,
      onUpdate,
      ctx,
    );
    const summary = await requiredValue(tools.get('pardes_status')).execute(
      'call-2',
      {},
      signal,
      onUpdate,
      ctx,
    );
    for (const result of [inbox, summary]) {
      expect(result.content[0]?.text).toContain('delivery: cursor event-first · delivered age:');
      expect(result.content[0]?.text).toContain(
        '· queued suffix:1 · awaiting-user:yes · wake wake-first',
      );
      expect(result.content[0]?.text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    }
  });

  test('excludes terminal warned review gates from attention projections while retaining open warned gates', async () => {
    const base = managerState();
    const active = workstream('ws-active', 'active');
    const warnedGate = (
      id: string,
      number: number,
      status: PullRequestRecord['status'],
    ): PullRequestRecord => ({
      agentId: `agent-${status}`,
      createdAt,
      id,
      number,
      observation: {
        ci: 'failing',
        mergeable: 'conflicting',
        number,
        reviewDecision: 'changes_requested',
        status,
      },
      status,
      updatedAt: createdAt,
      url: `https://github.test/acme/project/pull/${number}`,
      workstreamId: active.id,
    });
    const open = warnedGate('pr-open', 42, 'open');
    const merged = warnedGate('pr-merged', 43, 'merged');
    const closed = warnedGate('pr-closed', 44, 'closed');
    const state = {
      ...base,
      pullRequests: { [open.id]: open, [merged.id]: merged, [closed.id]: closed },
      workstreams: { [active.id]: active },
    };
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => state,
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const status = requiredValue(tools.get('pardes_status'));

    const summary = await status.execute('call-1', {}, signal, onUpdate, ctx);
    expect(summary.content[0]?.text).toContain(
      'review gates: 1 open · 1 attention · advisory verifications: 0 current · 0 stale · inbox: 0 pending',
    );

    const reviews = await status.execute(
      'call-2',
      { reviewFilter: 'attention', view: 'reviews' },
      signal,
      onUpdate,
      ctx,
    );
    expect(reviews.content[0]?.text).toContain(
      'review gates: 1 open · 1 attention · 3 total (1 attention)',
    );
    expect(reviews.content[0]?.text).toContain('#42 [open]');
    expect(reviews.content[0]?.text).not.toContain('#43 [merged]');
    expect(reviews.content[0]?.text).not.toContain('#44 [closed]');
  });

  test('returns concise agent status by default and safely bounds removed legacy diagnostic requests', async () => {
    const { pi, tools } = registry();
    const status: AgentStatus = { agent: worker(), runtime: undefined };
    const manager = { agentStatus: () => Effect.succeed(status) } as unknown as ManagerController;
    registerAgentTools(pi, manager);
    const agentStatus = requiredValue(tools.get('agent_status'));

    expect(agentStatus.description).toContain('Defaults to a concise summary');
    expect(agentStatus.description).toContain(
      "Retrieve a durable report's complete canonical body separately with one report_get({ reportId }) call",
    );
    expect(agentStatus.description).not.toContain('Full diagnostics');
    const concise = await agentStatus.execute(
      'call-1',
      { agentId: status.agent.id },
      signal,
      onUpdate,
      ctx,
    );
    expect(concise.content[0]?.text).toBe(
      'Worker agent-12345678 “Schema ergonomics” is running. Workstream ws-12345678.',
    );
    expect(concise.content[0]?.text).not.toContain('sessionDir');
    expect(concise.details).toBeUndefined();

    for (const legacy of [
      { agentId: status.agent.id, verbose: true },
      { agentId: status.agent.id, mode: 'full' },
    ]) {
      const bounded = await agentStatus.execute('call-legacy', legacy, signal, onUpdate, ctx);
      expect(bounded.content[0]?.text).toBe(concise.content[0]?.text);
      expect(bounded.content[0]?.text).not.toContain('sessionDir');
      expect(bounded.details).toBeUndefined();
    }
  });

  test('defaults retained-agent guidance to routine auto-routing while preserving explicit urgent steer', async () => {
    const sends: Array<{
      readonly agentId: string;
      readonly message: string;
      readonly behavior: string;
    }> = [];
    const manager = {
      sendAgent: (
        agentId: string,
        message: string,
        behavior: 'auto' | 'prompt' | 'steer' | 'followUp',
      ) =>
        Effect.sync(() => {
          sends.push({ agentId, behavior, message });
          return {
            agent: worker(),
            delivery: {
              deliveredAs: behavior === 'auto' ? ('followUp' as const) : behavior,
              requestedBehavior: behavior,
            },
            runtime: runtime({
              stderr: {
                omittedChars: 0,
                originalChars: 27,
                shownChars: 27,
                tail: 'token=private-stderr-secret',
              },
            }),
          };
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerAgentTools(pi, manager);
    const send = requiredValue(tools.get('agent_send'));

    expect(send.description).toContain(
      'Defaults to routine auto-routing: prompt while idle, queued follow-up while active',
    );
    expect(send.description).toContain('Reserve explicit steer for urgent interruption');
    expect(send.description).toContain(PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE);
    expect(send.promptGuidelines).toEqual([PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE]);
    expect(send.promptSnippet).toBe(
      'Send routine auto-routed guidance to a retained Pardes worker; for published-review feedback require additive descendant commits only; steer only for urgent interruption',
    );
    const automatic = await send.execute(
      'call-1',
      { agentId: 'agent-12345678', message: 'Routine follow-up.' },
      signal,
      onUpdate,
      ctx,
    );
    const urgent = await send.execute(
      'call-2',
      { agentId: 'agent-12345678', behavior: 'steer', message: 'Stop and inspect the failure.' },
      signal,
      onUpdate,
      ctx,
    );

    expect(sends).toEqual([
      { agentId: 'agent-12345678', behavior: 'auto', message: 'Routine follow-up.' },
      { agentId: 'agent-12345678', behavior: 'steer', message: 'Stop and inspect the failure.' },
    ]);
    expect(automatic.content[0]?.text).toBe(
      'Sent followUp message (auto-routed) to agent-12345678.',
    );
    expect(urgent.content[0]?.text).toBe('Sent steer message to agent-12345678.');
    expect(automatic.details).toEqual({
      agentId: 'agent-12345678',
      delivery: { deliveredAs: 'followUp', requestedBehavior: 'auto' },
    });
    expect(JSON.stringify(automatic.details)).not.toContain('private-stderr-secret');
    expect(JSON.stringify(automatic.details)).not.toContain('runtime');
  });

  test('supports bounded audit and runtime agent drill-downs without raw diagnostics', async () => {
    const detailedAgent: AgentRecord = {
      ...worker(),
      changedPaths: ['extensions/pardes/tools/index.ts', 'extensions/pardes/tools/tools.test.ts'],
      gitAudit: { checkedAt: createdAt, dirty: true, status: 'succeeded', trigger: 'completion' },
      lastError: 'A deliberately diagnostic last error.',
      worktree: {
        agentId: 'agent-12345678',
        branch: 'pardes/manager-/agent-12345678',
        branchPointSha: 'a'.repeat(40),
        createdAt,
        managerId: 'manager-12345678',
        path: '/tmp/repo/.worktrees/pardes/manager-12345678/agent-12345678',
      },
    };
    const status: AgentStatus = { agent: detailedAgent, runtime: runtime() };
    const provenanceRequests: boolean[] = [];
    const manager = {
      agentStatus: (_agentId: string, _ctx: ExtensionContext, includeGitProvenance = false) =>
        Effect.sync(() => {
          provenanceRequests.push(includeGitProvenance);
          return status;
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerAgentTools(pi, manager);
    const agentStatus = requiredValue(tools.get('agent_status'));

    const audit = await agentStatus.execute(
      'call-1',
      { agentId: status.agent.id, mode: 'audit' },
      signal,
      onUpdate,
      ctx,
    );
    expect(audit.content[0]?.text).toContain(
      'latest git audit: succeeded · completion · dirty worktree',
    );
    expect(audit.content[0]?.text).toContain(
      'total audited changed paths: 2 paths · complete first-N rows follow · omitted:see suffix row if present; otherwise 0',
    );
    expect(audit.content[0]?.text).toContain('↳ extensions/pardes/tools/index.ts');
    expect(audit.content[0]?.text).toContain('↳ extensions/pardes/tools/tools.test.ts');
    expect(audit.content[0]?.text).not.toContain('owned paths');
    expect(audit.content[0]?.text).not.toContain('scope violations');
    expect(audit.content[0]?.text).not.toContain('sessionDir');
    expect(audit.content[0]?.text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
    expect(audit.details).toBeUndefined();

    const live = await agentStatus.execute(
      'call-2',
      { agentId: status.agent.id, mode: 'runtime' },
      signal,
      onUpdate,
      ctx,
    );
    expect(live.content[0]?.text).toContain(
      'ctx:25% · active:1m05s · ask:5s · streaming · queued:1',
    );
    expect(live.content[0]?.text).toContain('usage: 130 tokens · 3 tool calls · $0.012');
    expect(live.content[0]?.text).toContain('compaction: inactive · auto unknown · completed 0');
    expect(live.content[0]?.text).not.toContain('diagnostic stderr');
    expect(live.content[0]?.text).not.toContain('sessionFile');
    expect(live.details).toBeUndefined();
    expect(provenanceRequests).toEqual([true, false]);
  });

  test('keeps additive merge context distinct from complete first-N cooperative candidate paths', async () => {
    const baselineSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const authoredPaths = [
      'src/authored-a.ts',
      'src/authored-b.ts',
      'src/authored-c.ts',
      'src/authored-d.ts',
      'src/authored-e.ts',
      'src/authored-f.ts',
    ];
    const detailedAgent: AgentRecord = {
      ...worker(),
      changedPaths: [...authoredPaths, 'src/main-only.ts'],
      gitAudit: {
        checkedAt: createdAt,
        dirty: false,
        status: 'succeeded',
        trigger: 'completion',
      },
    };
    const manager = {
      agentStatus: () =>
        Effect.succeed({
          agent: detailedAgent,
          gitProvenance: {
            attribution: 'cooperative_first_parent' as const,
            bounds: { maxFirstParentCommits: 200, maxPaths: 512 },
            branchPointSha: baselineSha,
            firstParentNonMergeCommitCount: 2,
            firstParentNonMergePaths: authoredPaths,
            headSha,
            latestDelta: {
              changedPaths: ['src/main-only.ts'],
              commitSha: headSha,
              kind: 'merge_commit' as const,
            },
            mergeCommitCount: 1,
            mergePaths: ['src/main-only.ts'],
            status: 'available' as const,
            totalBranchCommitCount: 3,
            totalBranchDeltaPaths: [...authoredPaths, 'src/main-only.ts'],
          },
          runtime: undefined,
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerAgentTools(pi, manager);

    const result = await requiredValue(tools.get('agent_status')).execute(
      'call-provenance',
      { agentId: detailedAgent.id, mode: 'audit' },
      signal,
      onUpdate,
      ctx,
    );
    const text = result.content[0]?.text ?? '';

    expect(text).toContain(
      'worker-branch non-merge change candidates: 2 commits · 6 paths · cooperative first-parent evidence',
    );
    expect(text).toContain(
      'merge context: 1 merge commit · 1 first-parent-diff path · exact conflict-resolution ownership not inferred',
    );
    expect(text).toContain(
      `total branch-point delta: 3 first-parent commits · 7 paths · ${baselineSha}..${headSha}`,
    );
    expect(text).toContain(`latest delta: merge_commit commit:${headSha} · 1 path`);
    expect(text).toContain(
      'worker-branch non-merge candidate paths: 6 paths · complete first-N rows follow · omitted:see suffix row if present; otherwise 0',
    );
    for (const path of authoredPaths.slice(0, 3)) expect(text).toContain(`↳ ${path}`);
    expect(text).toContain('… +3 more worker-branch non-merge candidate paths omitted');
    expect(text).not.toMatch(/worker feature|worker-authored|authored by/);
    expect(text).not.toContain('src/authored-d.ts');
    expect(text).not.toContain('src/main-only.ts');
    expect(text.length).toBeLessThanOrEqual(CONTROL_PLANE_MAX_TEXT_LENGTH);
  });

  test('renders explicit dirty provenance refusal with complete first-N live dirty paths', async () => {
    const dirtyPaths = [
      'src/dirty-a.ts',
      'src/dirty-b.ts',
      'src/dirty-c.ts',
      'src/dirty-d.ts',
      'src/dirty-e.ts',
    ];
    const detailedAgent: AgentRecord = {
      ...worker(),
      changedPaths: [...dirtyPaths, 'src/stale-committed.ts'],
      gitAudit: {
        checkedAt: createdAt,
        dirty: true,
        status: 'succeeded',
        trigger: 'completion',
      },
    };
    const manager = {
      agentStatus: () =>
        Effect.succeed({
          agent: detailedAgent,
          gitProvenance: {
            bounds: { maxFirstParentCommits: 200, maxPaths: 512 },
            dirtyPaths,
            reason: 'dirty_worktree' as const,
            status: 'unavailable' as const,
          },
          runtime: undefined,
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerAgentTools(pi, manager);

    const result = await requiredValue(tools.get('agent_status')).execute(
      'call-dirty-provenance',
      { agentId: detailedAgent.id, mode: 'audit' },
      signal,
      onUpdate,
      ctx,
    );
    const text = result.content[0]?.text ?? '';

    expect(text).toContain(
      'worker-branch non-merge candidate provenance: unavailable · reason:dirty_worktree · bounds:first 200 first-parent commits/512 paths/category',
    );
    expect(text).toContain('dirty paths: 5 paths');
    for (const path of dirtyPaths.slice(0, 4)) expect(text).toContain(`↳ ${path}`);
    expect(text).toContain('… +1 more dirty paths omitted');
    expect(text).not.toContain('src/dirty-e.ts');
    expect(text).not.toContain('src/stale-committed.ts');
  });

  test('registers narrow guarded child lifecycle tools with bounded path-free projections and distinct reload semantics', async () => {
    const { pi, tools } = registry();
    const boundedFailure = 'bounded-child-outcome '.repeat(8).trim();
    const manager = {
      compactAgent: (agentId: string) =>
        Effect.succeed({
          aborted: true,
          agentId,
          failureSummary: boundedFailure,
          outcome: 'manual' as const,
          status: 'idle' as const,
          tokensBefore: 321,
          willRetry: false,
        }),
      reloadAgent: (agentId: string) =>
        Effect.succeed({
          agentId,
          conversation: 'preserved' as const,
          outcome: 'child_extension_refreshed' as const,
          status: 'idle' as const,
          worktree: 'preserved' as const,
        }),
    } as unknown as ManagerController;
    registerAgentTools(pi, manager);
    const compact = requiredValue(tools.get('agent_compact'));
    const reload = requiredValue(tools.get('agent_reload'));

    expect(compact.description).toContain('attached-idle manual compaction');
    expect(compact.description).toContain('not manager plugin /reload');
    expect(compact.description).toContain('does not toggle automatic compaction');
    expect(reload.description).toContain('attached-idle child extension');
    expect(reload.description).toContain('managed worktree and retained conversation');
    expect(reload.description).toContain('sending no prompt');
    expect(reload.description).toContain('not manager plugin /reload');
    expect(reload.description).toContain('not agent_revive or automatic revival');
    for (const lifecycle of [compact, reload]) {
      expect(lifecycle.parameters.required).toEqual(['agentId']);
      expect(Object.keys(lifecycle.parameters.properties)).toEqual(['agentId']);
      for (const excluded of [
        'force',
        'reason',
        'path',
        'briefing',
        'extensionPath',
        'allAgents',
        'autoCompaction',
      ]) {
        expect(lifecycle.parameters.properties[excluded]).toBeUndefined();
      }
    }

    const compacted = await compact.execute(
      'call-1',
      { agentId: 'agent-12345678' },
      signal,
      onUpdate,
      ctx,
    );
    expect(compacted.content[0]?.text).toContain(
      'Requested manual compaction for agent-12345678 (idle).',
    );
    expect(compacted.content[0]?.text.length).toBeLessThanOrEqual(180);
    expect(compacted.details).toEqual({
      aborted: true,
      agentId: 'agent-12345678',
      failureSummary: boundedFailure,
      outcome: 'manual',
      status: 'idle',
      tokensBefore: 321,
      willRetry: false,
    });

    const reloaded = await reload.execute(
      'call-2',
      { agentId: 'agent-12345678' },
      signal,
      onUpdate,
      ctx,
    );
    expect(reloaded.content[0]?.text).toBe(
      'Refreshed child extension for agent-12345678 (idle); retained conversation and managed worktree preserved; sent no prompt.',
    );
    expect(reloaded.details).toEqual({
      agentId: 'agent-12345678',
      conversation: 'preserved',
      outcome: 'child_extension_refreshed',
      status: 'idle',
      worktree: 'preserved',
    });
    for (const result of [compacted, reloaded]) {
      expect(JSON.stringify(result)).not.toContain('/tmp/private/session.jsonl');
      expect(JSON.stringify(result)).not.toContain('lastCompaction');
      expect(JSON.stringify(result)).not.toContain('extensionPath');
    }
  });

  test('returns a bounded explicit-stop warning when the latest stop Git audit failed', async () => {
    const { pi, tools } = registry();
    const stopped = {
      ...worker(),
      gitAudit: {
        checkedAt: createdAt,
        failureSummary: 'inspection unavailable '.repeat(20),
        status: 'failed' as const,
        trigger: 'stop' as const,
      },
      status: 'stopped' as const,
    };
    const manager = { stopAgent: () => Effect.succeed(stopped) } as unknown as ManagerController;
    registerAgentTools(pi, manager);

    const result = await requiredValue(tools.get('agent_stop')).execute(
      'call-1',
      { agentId: stopped.id },
      signal,
      onUpdate,
      ctx,
    );

    expect(result.content[0]?.text).toContain(
      'Stopped agent-12345678; managed worktree preserved. Warning: Git audit failed:',
    );
    expect(result.content[0]?.text.length).toBeLessThan(220);
  });

  test('registers one-agent explicit retained-lease cleanup with compact session and revival semantics', async () => {
    const { pi, tools } = registry();
    const projection = {
      action: 'cleanup' as const,
      agentId: 'agent-12345678',
      branch: 'present_unmerged' as const,
      branchOutcome: 'preserved_unmerged' as const,
      changedPathCount: 0,
      revival: 'disabled_no_worktree' as const,
      session: 'preserved_history_only' as const,
      worktree: 'already_missing' as const,
      worktreeOutcome: 'already_missing' as const,
    };
    const manager = {
      cleanupAgentLease: () => Effect.succeed(projection),
    } as unknown as ManagerController;
    registerAgentTools(pi, manager);
    const cleanup = requiredValue(tools.get('agent_lease_cleanup'));

    expect(cleanup.description).toContain('one stopped/crashed retained managed lease');
    expect(cleanup.description).toContain(
      'Dirty discard and unmerged-history deletion require separate explicit force intent',
    );
    expect(cleanup.parameters.required).toEqual(['action', 'agentId']);
    expect(cleanup.parameters.properties.forceDiscardDirty).toBeDefined();
    expect(cleanup.parameters.properties.forceDeleteUnmergedBranch).toBeDefined();
    for (const excluded of ['path', 'branch', 'allAgents', 'sweep', 'shell'])
      expect(cleanup.parameters.properties[excluded]).toBeUndefined();

    const result = await cleanup.execute(
      'call-1',
      { action: 'cleanup', agentId: projection.agentId },
      signal,
      onUpdate,
      ctx,
    );
    expect(result.content[0]?.text).toContain(
      'worktree already_missing · branch present_unmerged · 0 changed paths',
    );
    expect(result.content[0]?.text).toContain(
      'outcome: worktree already_missing · branch preserved_unmerged',
    );
    expect(result.content[0]?.text).toContain(
      'session: preserved_history_only · revival: disabled_no_worktree',
    );
    expect(result.details).toEqual(projection);
    expect(JSON.stringify(result)).not.toContain('/tmp');
  });

  test('registers a bounded publication-only PR tool without any autonomous merge surface', async () => {
    const { pi, tools } = registry();
    const manager = {
      createPullRequest: () =>
        Effect.succeed({
          action: 'created' as const,
          browserHandoff: { requestedMode: 'none' as const, status: 'not_requested' as const },
          localTracking: {
            localBranch: 'local/pardes/review-gate',
            remote: 'origin' as const,
            remoteBranch: 'remote/pardes/review-gate',
            status: 'configured' as const,
          },
          openedInBrowser: false,
          pullRequest: { number: 42, url: 'https://github.test/acme/project/pull/42' },
        }),
    } as unknown as ManagerController;
    registerPullRequestTools(pi, manager);

    const publish = requiredValue(tools.get('pull_request_create'));
    expect(publish.description).toBe(
      "Audit an active-workstream managed worker's committed changes, push its exact SHA to a managed remote review branch, verify the hosted head, configure the retained local branch to track that remote branch, and create or update a GitHub review gate. Browser handoff is explicit: none, background, or foreground. Rejects completed or otherwise non-active workstreams. Never merges.",
    );
    expect(publish.promptSnippet).toBe(
      'Publish a committed Pardes worker branch as a pull-request review gate',
    );
    expect(publish.parameters.required).toEqual([
      'agentId',
      'baseBranch',
      'body',
      'title',
      'workstreamId',
    ]);
    expect(publish.parameters.properties.title?.maxLength).toBe(256);
    expect(publish.parameters.properties.body?.maxLength).toBe(10_000);
    expect(publish.parameters.properties.body?.description).toBe(
      'Reviewer-first pull-request body with concise Why / How / Decisions / Callouts content',
    );
    expect(publish.parameters.properties.baseBranch?.maxLength).toBe(255);
    expect(publish.parameters.required).not.toContain('browserMode');
    expect(publish.parameters.required).not.toContain('openInBrowser');
    expect(publish.parameters.properties.browserMode?.anyOf).toEqual([
      { const: 'none', type: 'string' },
      { const: 'background', type: 'string' },
      { const: 'foreground', type: 'string' },
    ]);
    expect(publish.parameters.properties.browserMode?.description).toContain("Defaults to 'none'");
    expect(publish.parameters.properties.openInBrowser?.description).toContain(
      'Compatibility alias',
    );
    expect([...tools.keys()].some((name) => name.includes('merge'))).toBe(false);
    const result = await publish.execute(
      'call-1',
      {
        agentId: 'agent-1',
        baseBranch: 'main',
        body: '### Why?\n\nApproved intent.\n\n### How?\n\nHigh-level approach.',
        title: 'Review gate',
        workstreamId: 'ws-1',
      },
      signal,
      onUpdate,
      ctx,
    );
    expect(result.content[0]?.text).toBe(
      'Created PR #42: https://github.test/acme/project/pull/42. Local tracking: local/pardes/review-gate -> origin/remote/pardes/review-gate. Browser handoff: none.',
    );
  });

  test('registers explicit read-only hosted drill-down tools with metadata-first and excerpt-only results', async () => {
    const secretLogExcerpt = 'redacted log excerpt';
    const secretDiscussionExcerpt = 'redacted discussion excerpt';
    const manager = {
      getPullRequestCiLogExcerpt: () =>
        Effect.succeed({
          exactHeadSha: 'a'.repeat(40),
          excerpt: secretLogExcerpt,
          excerptChars: secretLogExcerpt.length,
          hasMore: true,
          jobId: 8001,
          maxChars: 2_000,
          observation: 'opt_in_read_only_redacted_ci_log_excerpt' as const,
          page: 1,
          pullRequestId: 'pr-42',
          pullRequestNumber: 42,
          runId: 7001,
          trust: GITHUB_CI_LOG_EXCERPT_TRUST_LABEL,
          url: 'https://github.com/acme/project/actions/runs/7001/job/8001',
        }),
      getPullRequestDiscussionBodyExcerpts: () =>
        Effect.succeed({
          bounds: { itemsPerPage: 10, maxExcerptCharsPerItem: 1_000 },
          hasMore: false,
          items: [
            {
              author: 'alice',
              bodyChars: secretDiscussionExcerpt.length,
              excerpt: secretDiscussionExcerpt,
              excerptChars: secretDiscussionExcerpt.length,
              hasMore: false,
              id: 101,
            },
          ],
          observation: 'opt_in_read_only_redacted_discussion_body_excerpts' as const,
          page: 1,
          provenance: {
            auditedHeadSha: 'a'.repeat(40),
            repositoryRoute: 'fixed_github_com_repository' as const,
            reviewGate: 'state_known' as const,
            scope: 'pull_request_level_not_commit_bound' as const,
          },
          pullRequestId: 'pr-42',
          pullRequestNumber: 42,
          surface: 'issue_comment' as const,
          trust: GITHUB_DISCUSSION_EXCERPT_TRUST_LABEL,
        }),
      inspectPullRequestFailingChecks: () =>
        Effect.succeed({
          bounds: { maxChecks: 50 },
          exactHeadSha: 'a'.repeat(40),
          failingChecks: [
            {
              conclusion: 'FAILURE',
              jobId: 8001,
              name: 'lint',
              runId: 7001,
              status: 'COMPLETED',
              url: 'https://github.com/acme/project/actions/runs/7001/job/8001',
            },
          ],
          observation: 'opt_in_read_only_hosted_check_metadata' as const,
          observedCheckCount: 1,
          omittedCheckCountAccuracy: 'exact' as const,
          pullRequestId: 'pr-42',
          pullRequestNumber: 42,
          trust: GITHUB_CHECK_METADATA_TRUST_LABEL,
          unmappedFailingCheckCount: 0,
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerHostedDrilldownTools(pi, manager);

    expect([...tools.keys()]).toEqual([
      'pull_request_ci_inspect',
      'pull_request_ci_log_excerpt_get',
      'pull_request_discussion_excerpt_get',
    ]);
    expect(
      [...tools.keys()].some((name) => /(rerun|cancel|approve|merge|mutation)/.test(name)),
    ).toBe(false);
    const logTool = requiredValue(tools.get('pull_request_ci_log_excerpt_get'));
    expect(logTool.parameters.properties.page).toMatchObject({
      maximum: GITHUB_HOSTED_DRILLDOWN_MAX_PAGE,
      minimum: 1,
    });
    expect(logTool.parameters.properties.maxChars).toMatchObject({
      maximum: GITHUB_HOSTED_DRILLDOWN_EXCERPT_MAX_CHARS,
      minimum: 1,
    });
    const checks = await requiredValue(tools.get('pull_request_ci_inspect')).execute(
      'call-1',
      { pullRequestId: 'pr-42' },
      signal,
      onUpdate,
      ctx,
    );
    expect(checks.content[0]?.text).toContain(`[${GITHUB_CHECK_METADATA_TRUST_LABEL}]`);
    expect(checks.content[0]?.text).toContain(`exactHeadSha:${'a'.repeat(40)}`);
    expect(checks.content[0]?.text).toContain('runId:7001 · jobId:8001');
    expect(checks.content[0]?.text).toContain('no logs or bodies loaded');
    const log = await logTool.execute(
      'call-2',
      { jobId: 8001, pullRequestId: 'pr-42', runId: 7001 },
      signal,
      onUpdate,
      ctx,
    );
    expect(log.content[0]?.text).toContain(`[${GITHUB_CI_LOG_EXCERPT_TRUST_LABEL}]`);
    expect(log.content[0]?.text).toContain(
      `excerpt(JSON string): ${JSON.stringify(secretLogExcerpt)}`,
    );
    expect(JSON.stringify(log.details)).not.toContain(secretLogExcerpt);
    const discussion = await requiredValue(
      tools.get('pull_request_discussion_excerpt_get'),
    ).execute(
      'call-3',
      { pullRequestId: 'pr-42', surface: 'issue_comment' },
      signal,
      onUpdate,
      ctx,
    );
    expect(discussion.content[0]?.text).toContain(`[${GITHUB_DISCUSSION_EXCERPT_TRUST_LABEL}]`);
    expect(discussion.content[0]?.text).toContain(
      `provenance: repository-route:fixed_github_com_repository · scope:pull_request_level_not_commit_bound · auditedHeadSha:${'a'.repeat(40)} · discussion bodies are PR-level, not commit-bound`,
    );
    expect(discussion.content[0]?.text).toContain(
      `excerpt(JSON string): ${JSON.stringify(secretDiscussionExcerpt)}`,
    );
    expect(JSON.stringify(discussion.details)).not.toContain(secretDiscussionExcerpt);
  });

  test('keeps malformed hosted check status diagnostics out of model-visible content and details', async () => {
    const unsafeStatus = `FUTURE_\u202e_ghp_abcdefghijklmnop`;
    const manager = {
      inspectPullRequestFailingChecks: () =>
        Effect.fail(
          new GitHubResponseError({
            cause: { status: unsafeStatus },
            operation: 'inspect hosted drill-down checks',
          }),
        ),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerHostedDrilldownTools(pi, manager);

    const result = await requiredValue(tools.get('pull_request_ci_inspect')).execute(
      'call-1',
      { pullRequestId: 'pr-42' },
      signal,
      onUpdate,
      ctx,
    );

    expect(result.content[0]?.text).toBe(
      'Error: Invalid GitHub CLI response: inspect hosted drill-down checks',
    );
    expect(result.details).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('ghp_');
    expect(JSON.stringify(result)).not.toContain('\u202e');
  });

  test('surfaces a safe non-fatal pull_request_create browser handoff failure', async () => {
    const { pi, tools } = registry();
    const manager = {
      createPullRequest: () =>
        Effect.succeed({
          action: 'created' as const,
          browserHandoff: {
            attemptedMode: 'background' as const,
            failure: { code: 'ENOENT' as const, kind: 'browser_open_failed' as const },
            requestedMode: 'background' as const,
            status: 'failed' as const,
          },
          localTracking: {
            reason: 'local_tracking_failed' as const,
            remote: 'origin' as const,
            remoteBranch: 'remote/pardes/review-gate',
            status: 'failed' as const,
          },
          openedInBrowser: false,
          pullRequest: { number: 42, url: 'https://github.test/acme/project/pull/42' },
        }),
    } as unknown as ManagerController;
    registerPullRequestTools(pi, manager);

    const result = await requiredValue(tools.get('pull_request_create')).execute(
      'call-1',
      {
        agentId: 'agent-1',
        baseBranch: 'main',
        body: 'Summary.',
        browserMode: 'background',
        title: 'Review gate',
        workstreamId: 'ws-1',
      },
      signal,
      onUpdate,
      ctx,
    );

    expect(result.content[0]?.text).toBe(
      'Created PR #42: https://github.test/acme/project/pull/42. Local tracking: origin/remote/pardes/review-gate failed safely; remote publication remains verified. Browser handoff: background failed safely.',
    );
    expect(result.details).toMatchObject({
      browserHandoff: {
        attemptedMode: 'background',
        failure: { code: 'ENOENT', kind: 'browser_open_failed' },
        requestedMode: 'background',
        status: 'failed',
      },
    });
  });

  test('redacts failed pull_request_create body content from bounded tool output', async () => {
    const { pi, tools } = registry();
    const body = 'private PR body marker '.repeat(500);
    const token = 'ghp_private-token-marker';
    const manager = {
      createPullRequest: () =>
        Effect.fail(
          new GitHubCommandError({
            args: ['pr', 'create', '--title', token, '--body', body, '--base', 'main'],
            cause: new Error('external stderr secret marker'),
            command: 'gh',
            cwd: '/tmp/repo',
          }),
        ),
    } as unknown as ManagerController;
    registerPullRequestTools(pi, manager);

    const result = await requiredValue(tools.get('pull_request_create')).execute(
      'call-1',
      {
        agentId: 'agent-1',
        baseBranch: 'main',
        body,
        title: 'Review gate',
        workstreamId: 'ws-1',
      },
      signal,
      onUpdate,
      ctx,
    );
    const text = result.content[0]?.text;

    expect(text).toBe('Error: GitHub publication command failed: gh pr create');
    expect(text.length).toBeLessThan(80);
    expect(text).not.toContain(body);
    expect(text).not.toContain(token);
    expect(text).not.toContain('external stderr secret marker');
  });

  test('does not expose a scope-warning resolution workflow', () => {
    const { pi, tools } = registry();
    registerAgentTools(pi, {} as ManagerController);

    expect(tools.has('agent_warning_resolve')).toBe(false);
  });

  test('renders structural inbox report pointers with explicit truncation state and a bounded retrieval hint', async () => {
    const base = managerState();
    const inbox: ReadonlyArray<ManagerEvent> = [
      {
        agentId: 'agent-one',
        createdAt,
        id: 'event-report',
        reportId: 'report-123',
        reportPreviewTruncated: true,
        summary: `agent-one: ${'worker summary '.repeat(30)}`,
        type: 'agent_report_completed',
      },
      {
        agentId: 'verifier-one',
        createdAt,
        id: 'event-verifier-report',
        reportId: 'report-verifier',
        reportPreviewTruncated: false,
        summary: 'verifier-one: Consolidated advisory pass complete.',
        type: 'agent_report_completed',
        verificationId: 'verify-one',
      },
    ];
    const manager = {
      runtimeSnapshots: () => new Map(),
      snapshot: () => ({ ...base, inbox }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);

    const result = await requiredValue(tools.get('pardes_status')).execute(
      'call-1',
      { view: 'inbox' },
      signal,
      onUpdate,
      ctx,
    );
    const text = result.content[0]?.text;

    expect(text).toContain(
      'reportId:report-123 · previewTruncated:true · artifact: report_get({ reportId })',
    );
    expect(text).toContain(
      'event-report [agent_report_completed] · child-authored · drill-down: inbox_get({ eventId:event-report })',
    );
    expect(text).toContain(
      'event-verifier-report [agent_report_completed] · advisory-verifier-authored · drill-down: inbox_get({ eventId:event-verifier-report })',
    );
    expect(text).not.toContain('worker summary '.repeat(30));
  });

  test('exposes latest durable report pointers in bounded agent summary and audit projections', async () => {
    const reported = {
      ...worker(),
      latestReport: {
        createdAt,
        reportId: 'report-123',
        status: 'completed' as const,
        summaryTruncated: true,
      },
    };
    const status: AgentStatus = { agent: reported, runtime: undefined };
    const manager = { agentStatus: () => Effect.succeed(status) } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerAgentTools(pi, manager);

    for (const mode of ['summary', 'audit'] as const) {
      const result = await requiredValue(tools.get('agent_status')).execute(
        'call-1',
        { agentId: reported.id, mode },
        signal,
        onUpdate,
        ctx,
      );
      expect(result.content[0]?.text).toContain(
        'latest report: reportId:report-123 [completed] · previewTruncated:true',
      );
      expect(result.content[0]?.text).toContain('retrieve: report_get({ reportId: "report-123" })');
      expect(result.content[0]?.text).not.toContain('Worker recommendation preview.');
      expect(result.details).toBeUndefined();
    }
  });

  test('registers report_get as reportId-only canonical full retrieval with metadata-only results', async () => {
    const canonical = {
      agentId: 'agent-one',
      content: 'private\n"detail"',
      field: 'details' as const,
      reportId: 'report-123',
      status: 'completed' as const,
      totalChars: 16,
    };
    const manager = { getReport: () => Effect.succeed(canonical) } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const reportGet = requiredValue(tools.get('report_get'));

    expect(reportGet.description).toContain(
      'one known manager-scoped durable worker or advisory-verifier report by reportId',
    );
    expect(reportGet.description).toContain('details when present, otherwise summary');
    expect(reportGet.description).toContain(
      'never choose fields, offsets, page sizes, or continuation calls',
    );
    expect(Object.keys(reportGet.parameters.properties)).toEqual(['reportId']);
    expect(reportGet.parameters.required).toEqual(['reportId']);
    expect(
      reportGet.prepareArguments?.({
        field: 'summary',
        maxChars: 12,
        offset: 4,
        reportId: 'report-123',
      }),
    ).toEqual({ reportId: 'report-123' });
    expect(reportGet.prepareArguments?.({ reportId: 'report-123', unexpected: true })).toEqual({
      reportId: 'report-123',
      unexpected: true,
    });
    const result = await reportGet.execute(
      'call-1',
      { reportId: 'report-123' },
      signal,
      onUpdate,
      ctx,
    );

    expect(result.content[0]?.text).toContain('[Pardes canonical report delivery scheduled]');
    expect(result.content[0]?.text).toContain('after this agent run settles');
    expect(result.content[0]?.text).not.toContain('private');
    expect(result.details).toEqual({
      agentId: 'agent-one',
      automaticContinuation: true,
      deliveryId: expect.stringMatching(/^report-delivery-[a-f0-9]{24}$/),
      field: 'details',
      parts: 1,
      reportId: 'report-123',
      status: 'completed',
      totalChars: 16,
    });
    expect(JSON.stringify(result.details)).not.toContain('private');
  });

  test('rejects a delayed report read that resolves after delivery deactivation', async () => {
    const resolvers: Array<() => void> = [];
    const canonical = {
      agentId: 'agent-one',
      content: 'late report body',
      field: 'details' as const,
      reportId: 'report-late',
      status: 'completed' as const,
      totalChars: 16,
    };
    const manager = {
      deactivate: () => Effect.sync(() => undefined),
      getReport: () =>
        Effect.promise(
          () =>
            new Promise<typeof canonical>((resolve) => {
              resolvers.push(() => resolve(canonical));
            }),
        ),
      snapshot: () => managerState(),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    const delivery = registerWorkstreamTools(pi, manager);
    const command = createPardesCommandHandler(pi, manager, {} as ManagerPresentation, delivery);
    const commandCtx = {
      ...ctx,
      ui: { notify() {} },
    } as unknown as ExtensionCommandContext;
    const pending = requiredValue(tools.get('report_get')).execute(
      'call-late',
      { reportId: 'report-late' },
      signal,
      onUpdate,
      ctx,
    );
    while (resolvers.length < 1) await Promise.resolve();

    await command('stop', commandCtx);
    requiredValue(resolvers[0])();
    const result = await pending;
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('canceled by a manager lifecycle change');
    expect(text.length).toBeLessThan(300);
    expect(delivery.isActive).toBe(false);
  });

  test('keeps an old delayed read stale across restart while a fresh retrieval enters compaction', async () => {
    const resolvers = new Map<string, () => void>();
    let active = true;
    const manager = {
      activate: () =>
        Effect.sync(() => {
          active = true;
          return managerState();
        }),
      deactivate: () =>
        Effect.sync(() => {
          active = false;
        }),
      getReport: (input: { readonly reportId: string }) => {
        const canonical = {
          agentId: 'agent-one',
          content: `${input.reportId} body`,
          field: 'details' as const,
          reportId: input.reportId,
          status: 'completed' as const,
          totalChars: input.reportId.length + 5,
        };
        return Effect.promise(
          () =>
            new Promise<typeof canonical>((resolve) => {
              resolvers.set(input.reportId, () => resolve(canonical));
            }),
        );
      },
      runtimeSnapshots: () => new Map(),
      snapshot: () => (active ? managerState() : undefined),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    const delivery = registerWorkstreamTools(pi, manager);
    const command = createPardesCommandHandler(pi, manager, {} as ManagerPresentation, delivery);
    const commandCtx = {
      ...ctx,
      ui: { notify() {} },
    } as unknown as ExtensionCommandContext;
    const reportGet = requiredValue(tools.get('report_get'));
    const oldPending = reportGet.execute(
      'call-old',
      { reportId: 'report-old' },
      signal,
      onUpdate,
      ctx,
    );
    while (!resolvers.has('report-old')) await Promise.resolve();

    await command('stop', commandCtx);
    await command('start', commandCtx);
    const freshPending = reportGet.execute(
      'call-fresh',
      { reportId: 'report-fresh' },
      signal,
      onUpdate,
      ctx,
    );
    while (!resolvers.has('report-fresh')) await Promise.resolve();
    requiredValue(resolvers.get('report-fresh'))();
    const fresh = await freshPending;
    delivery.observeCompactionStart();
    requiredValue(resolvers.get('report-old'))();
    const old = await oldPending;

    expect(fresh.details).toMatchObject({ reportId: 'report-fresh' });
    expect(old.content[0]?.text).toContain('canceled by a manager lifecycle change');
    expect(delivery.activeReportId).toBe('report-fresh');
    delivery.clear();
  });

  test('automatically serializes every oversized canonical report part without model pagination calls', async () => {
    const content = 'report-body\n'.repeat(10_000);
    const canonical = {
      agentId: 'agent-one',
      content,
      field: 'details' as const,
      reportId: 'report-large',
      status: 'completed' as const,
      totalChars: content.length,
    };
    const manager = { getReport: () => Effect.succeed(canonical) } as unknown as ManagerController;
    const { emit, messages, pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const reportGet = requiredValue(tools.get('report_get'));

    const result = await reportGet.execute(
      'call-large',
      { reportId: 'report-large' },
      signal,
      onUpdate,
      ctx,
    );
    const metadata = result.details as { readonly deliveryId: string; readonly parts: number };
    expect(metadata.parts).toBeGreaterThan(1);
    expect(messages).toEqual([]);

    emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let part = 1; part <= metadata.parts; part += 1) {
      const dispatched = requiredValue(messages[part - 1]);
      expect(dispatched.options).toEqual({ triggerTurn: true });
      expect(dispatched.message).toMatchObject({
        details: {
          deliveryId: metadata.deliveryId,
          part,
          parts: metadata.parts,
          reportId: 'report-large',
        },
        display: false,
      });
      const message = { ...(dispatched.message as object), role: 'custom' };
      emit('message_start', { message });
      emit('message_end', { message });
      emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] });
      if (part < metadata.parts) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const repeated = await reportGet.execute(
      'call-repeat',
      { reportId: 'report-large' },
      signal,
      onUpdate,
      ctx,
    );
    expect(repeated.content[0]?.text).not.toContain('still being delivered');
  });

  test('registers agent_send_report as one intentional bounded manager-controlled handoff with metadata-only output', async () => {
    const handoff = {
      behavior: 'prompt' as const,
      field: 'details' as const,
      hasMore: true,
      nextOffset: 36,
      offset: 12,
      reportId: 'report-123',
      returnedChars: 24,
      sourceAgentId: 'verifier-source',
      sourceRole: 'verifier' as const,
      status: 'completed' as const,
      targetAgentId: 'agent-target',
      totalChars: 100,
    };
    const inputs: unknown[] = [];
    const manager = {
      sendReportToAgent: (input: unknown) =>
        Effect.sync(() => {
          inputs.push(input);
          return handoff;
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const sendReport = requiredValue(tools.get('agent_send_report'));

    expect(sendReport.description).toContain(
      'state-known manager-scoped durable worker or advisory-verifier report',
    );
    expect(sendReport.description).toContain(
      'children receive no arbitrary report retrieval capability',
    );
    const result = await sendReport.execute(
      'call-1',
      {
        agentId: 'agent-target',
        field: 'details',
        maxChars: 24,
        message: 'Review critically.',
        offset: 12,
        reportId: 'report-123',
      },
      signal,
      onUpdate,
      ctx,
    );

    expect(inputs).toEqual([
      {
        agentId: 'agent-target',
        field: 'details',
        maxChars: 24,
        message: 'Review critically.',
        offset: 12,
        reportId: 'report-123',
      },
    ]);
    expect(result.content[0]?.text).toBe(
      'Sent prompt handoff of verifier report report-123 details excerpt at offset 12 to agent-target; truncated:true.',
    );
    expect(result.details).toEqual(handoff);
    expect(JSON.stringify(result)).not.toContain('Review critically.');
  });

  test('registers inbox_get as a pending-row-only trust-labelled bounded read with allowlisted metadata', async () => {
    const externalSummary =
      '[external GitHub feedback] #42 observed a preview.\n"quoted external preview"';
    const events: Record<string, ManagerEvent> = {
      'event-external': {
        agentId: 'agent-1',
        createdAt,
        id: 'event-external',
        pullRequestId: 'pr-42',
        summary: externalSummary,
        type: 'discussion_feedback',
        workstreamId: 'ws-1',
      },
      'event-global-metadata': {
        createdAt,
        id: 'event-global-metadata',
        summary: 'GitHub.com watcher rate metadata is unavailable or invalid.',
        type: 'github_rate_metadata_unavailable',
      },
      'event-hostile': {
        createdAt,
        id: 'event-hostile',
        reportId: '\u0000'.repeat(5_000),
        summary: '\u0000'.repeat(5_000),
        type: 'forward_compatible_event',
      },
      'event-merged': {
        createdAt,
        id: 'event-merged',
        pullRequestId: 'pr-42',
        summary:
          '#42 merge observed; owner:stopped; stream:complete; follow-up:0. External GitHub merge metadata was observed only; Pardes did not merge. Owner agent-1 was already stopped; managed worktree was cleaned or is absent (removed_clean); retained Pi session metadata is history-only.',
        type: 'merged',
      },
      'event-merged-blocked': {
        createdAt,
        id: 'event-merged-blocked',
        presentationBlocked: true,
        pullRequestId: 'pr-43',
        summary: '#43 was merged externally; Pardes observed only and did not merge.',
        type: 'merged',
      },
      'event-metadata': {
        createdAt,
        id: 'event-metadata',
        pullRequestId: 'pr-42',
        summary: '#42 has changes-requested review metadata.',
        type: 'review_feedback',
      },
      'event-question-detail': {
        agentId: 'agent-1',
        createdAt,
        details: 'question-context-tail',
        id: 'event-question-detail',
        summary: 'agent-1 asks a blocking question; inspect the durable inbox detail.',
        type: 'agent_question',
      },
      'event-report': {
        agentId: 'agent-1',
        createdAt,
        id: 'event-report',
        reportId: 'report-123',
        reportPreviewTruncated: false,
        summary: 'Worker completed the focused slice.',
        type: 'agent_report_completed',
      },
      'event-verifier-missing-report': {
        agentId: 'verifier-1',
        createdAt,
        id: 'event-verifier-missing-report',
        summary:
          'verifier-1: terminal report missing; follow up; do not poll. Retained advisory verifier remains attached idle.',
        type: 'verification_terminal_report_missing',
        verificationId: 'verify-1',
      },
      'event-verifier-question': {
        agentId: 'verifier-1',
        createdAt,
        id: 'event-verifier-question',
        summary: 'verifier-1 asks: Is the omitted fixture available?',
        type: 'agent_question',
        verificationId: 'verify-1',
      },
      'event-verifier-report': {
        agentId: 'verifier-1',
        createdAt,
        id: 'event-verifier-report',
        reportId: 'report-verifier',
        reportPreviewTruncated: false,
        summary: 'Verifier completed a consolidated advisory pass.',
        type: 'agent_report_completed',
        verificationId: 'verify-1',
      },
      'event-watcher': {
        createdAt,
        id: 'event-watcher',
        pullRequestId: 'pr-42',
        summary:
          '#42 watcher failed [authentication_likely]: GitHub CLI authentication likely failed; run gh auth status. Raw CLI diagnostics omitted.',
        type: 'watcher_failed',
      },
    };
    const manager = {
      getInboxEvent: ({ eventId }: { readonly eventId: string }) =>
        Effect.succeed(requiredValue(events[eventId])),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const inboxGet = requiredValue(tools.get('inbox_get'));

    expect(inboxGet.description).toContain(
      'one known currently-pending durable Pardes inbox row by eventId',
    );
    expect(inboxGet.description).toContain(
      'never lists audit history, fetches external bodies, or routes external feedback',
    );
    const external = await inboxGet.execute(
      'call-1',
      { eventId: 'event-external' },
      signal,
      onUpdate,
      ctx,
    );
    expect(external.content[0]?.text).toContain(`[${INBOX_EVENT_EXTERNAL_FEEDBACK_TRUST_LABEL}]`);
    expect(external.content[0]?.text).toContain(
      'excerpt(JSON string): "[external GitHub feedback] #42 observed a preview.\\n\\"quoted external preview\\""',
    );
    expect(external.content[0]?.text).toContain(
      'external GitHub feedback remains observation-only: persisted bounded metadata only; retrieve bodies only through explicit hosted drill-down; no worker message was sent.',
    );
    expect(external.content[0]?.text).toContain(
      'path autonomous: Autonomous rows may be acknowledged once handled.',
    );
    expect(external.content[0]?.text).toContain(
      'path judgment: When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first; surface it.',
    );
    expect(external.content[0]?.text).toContain(
      'judgment handoff: Use `question` with choices or `options: []` for free-form feedback (4000-char max); it binds the current cursor and consumes only it after a valid non-blank answer.',
    );
    expect(external.details).toEqual({
      agentId: 'agent-1',
      createdAt,
      eventId: 'event-external',
      excerptSource: 'summary',
      hasMore: false,
      maxChars: 4_000,
      offset: 0,
      pullRequestId: 'pr-42',
      returnedChars: externalSummary.length,
      returnedSummaryChars: externalSummary.length,
      summaryChars: externalSummary.length,
      summaryTruncated: false,
      totalChars: externalSummary.length,
      trust: 'external_feedback',
      type: 'discussion_feedback',
      workstreamId: 'ws-1',
    });
    expect(JSON.stringify(external.details)).not.toContain('quoted external preview');

    const metadata = await inboxGet.execute(
      'call-2',
      { eventId: 'event-metadata' },
      signal,
      onUpdate,
      ctx,
    );
    expect(metadata.content[0]?.text).toContain(`[${INBOX_EVENT_EXTERNAL_METADATA_TRUST_LABEL}]`);
    expect(metadata.content[0]?.text).toContain(
      'external GitHub metadata remains observation-only; no worker message was sent.',
    );
    expect(metadata.details).toMatchObject({
      eventId: 'event-metadata',
      pullRequestId: 'pr-42',
      trust: 'external_metadata',
    });

    const globalMetadata = await inboxGet.execute(
      'call-global-metadata',
      { eventId: 'event-global-metadata' },
      signal,
      onUpdate,
      ctx,
    );
    expect(globalMetadata.content[0]?.text).toContain(
      `[${INBOX_EVENT_EXTERNAL_METADATA_TRUST_LABEL}]`,
    );
    expect(globalMetadata.details).toMatchObject({
      eventId: 'event-global-metadata',
      trust: 'external_metadata',
    });

    const watcher = await inboxGet.execute(
      'call-watcher',
      { eventId: 'event-watcher' },
      signal,
      onUpdate,
      ctx,
    );
    expect(watcher.content[0]?.text).toContain(`[${INBOX_EVENT_EXTERNAL_METADATA_TRUST_LABEL}]`);
    expect(watcher.content[0]?.text).toContain(
      'GitHub CLI authentication likely failed; run gh auth status. Raw CLI diagnostics omitted.',
    );
    expect(watcher.content[0]?.text).not.toContain('stderr');
    expect(watcher.details).toMatchObject({
      eventId: 'event-watcher',
      pullRequestId: 'pr-42',
      trust: 'external_metadata',
      type: 'watcher_failed',
    });

    const merged = await inboxGet.execute(
      'call-merged',
      { eventId: 'event-merged' },
      signal,
      onUpdate,
      ctx,
    );
    expect(merged.content[0]?.text).toContain(`[${INBOX_EVENT_EXTERNAL_METADATA_TRUST_LABEL}]`);
    expect(merged.content[0]?.text).toContain(
      '#42 merge observed; owner:stopped; stream:complete; follow-up:0.',
    );
    expect(merged.content[0]?.text).toContain(
      'managed worktree was cleaned or is absent (removed_clean); retained Pi session metadata is history-only.',
    );
    expect(merged.content[0]?.text).not.toContain('managed worktree and session remain preserved');
    expect(merged.content[0]?.text).toContain(
      'external GitHub merge metadata remains observation-only and user-controlled; bounded Pardes retirement outcome is included above; no worker message was sent.',
    );
    expect(merged.content[0]?.text).toContain(
      'path autonomous: Autonomous rows may be acknowledged once handled.',
    );
    expect(merged.content[0]?.text).not.toContain('after handling: inbox_acknowledge()');

    const blockedMerged = await inboxGet.execute(
      'call-merged-blocked',
      { eventId: 'event-merged-blocked' },
      signal,
      onUpdate,
      ctx,
    );
    expect(blockedMerged.content[0]?.text).toContain(
      'external GitHub merge metadata remains observation-only and user-controlled; bounded Pardes retirement outcome is pending software refinement; no worker message was sent.',
    );
    expect(blockedMerged.content[0]?.text).toContain(
      'next: wait for software refinement; do not acknowledge this row or any later suffix cursor yet.',
    );
    expect(blockedMerged.content[0]?.text).not.toContain(
      'bounded Pardes retirement outcome is included above',
    );
    expect(blockedMerged.content[0]?.text).not.toContain('after handling: inbox_acknowledge()');
    expect(blockedMerged.details).toMatchObject({
      eventId: 'event-merged-blocked',
      presentationBlocked: true,
      pullRequestId: 'pr-43',
      trust: 'external_metadata',
    });

    const report = await inboxGet.execute(
      'call-3',
      { eventId: 'event-report' },
      signal,
      onUpdate,
      ctx,
    );
    expect(report.content[0]?.text).toContain(`[${INBOX_EVENT_CHILD_TRUST_LABEL}]`);
    expect(report.content[0]?.text).toContain(
      'durable child artifact: report_get({ reportId: "report-123" })',
    );
    expect(report.details).toMatchObject({
      eventId: 'event-report',
      reportId: 'report-123',
      reportPreviewTruncated: false,
      sourceRole: 'child',
      trust: 'child_authored',
    });

    const questionExcerpt = await inboxGet.execute(
      'call-question-detail',
      { eventId: 'event-question-detail', maxChars: 8, offset: 9 },
      signal,
      onUpdate,
      ctx,
    );
    expect(questionExcerpt.content[0]?.text).toContain(
      'excerptSource: details · offset: 9 · maxChars: 8 · returnedChars: 8 · totalChars: 21 · hasMore: true',
    );
    expect(questionExcerpt.content[0]?.text).toContain('excerpt(JSON string): "context-"');
    expect(questionExcerpt.content[0]?.text).toContain(
      'next: inbox_get({ eventId: "event-question-detail", offset: 17, maxChars: 8 })',
    );
    expect(questionExcerpt.details).toMatchObject({
      excerptSource: 'details',
      hasMore: true,
      maxChars: 8,
      offset: 9,
      returnedChars: 8,
      totalChars: 21,
    });

    const verifierReport = await inboxGet.execute(
      'call-verifier-report',
      { eventId: 'event-verifier-report' },
      signal,
      onUpdate,
      ctx,
    );
    expect(verifierReport.content[0]?.text).toContain(`[${INBOX_EVENT_VERIFIER_TRUST_LABEL}]`);
    expect(verifierReport.content[0]?.text).toContain(
      'associations: agentId:"verifier-1" · verificationId:"verify-1"',
    );
    expect(verifierReport.content[0]?.text).not.toContain('worker-authored');
    expect(verifierReport.details).toMatchObject({
      agentId: 'verifier-1',
      eventId: 'event-verifier-report',
      reportId: 'report-verifier',
      sourceRole: 'verifier',
      trust: 'child_authored',
      verificationId: 'verify-1',
    });

    const verifierMissingReport = await inboxGet.execute(
      'call-verifier-missing-report',
      { eventId: 'event-verifier-missing-report' },
      signal,
      onUpdate,
      ctx,
    );
    expect(verifierMissingReport.content[0]?.text).toContain(
      '[Pardes-authored durable inbox summary]',
    );
    expect(verifierMissingReport.details).toMatchObject({
      agentId: 'verifier-1',
      eventId: 'event-verifier-missing-report',
      trust: 'pardes',
      type: 'verification_terminal_report_missing',
      verificationId: 'verify-1',
    });

    const verifierQuestion = await inboxGet.execute(
      'call-verifier-question',
      { eventId: 'event-verifier-question' },
      signal,
      onUpdate,
      ctx,
    );
    expect(verifierQuestion.content[0]?.text).toContain(`[${INBOX_EVENT_VERIFIER_TRUST_LABEL}]`);
    expect(verifierQuestion.content[0]?.text).not.toContain('worker-authored');
    expect(verifierQuestion.details).toMatchObject({
      agentId: 'verifier-1',
      eventId: 'event-verifier-question',
      sourceRole: 'verifier',
      trust: 'child_authored',
      verificationId: 'verify-1',
    });

    const hostile = await inboxGet.execute(
      'call-4',
      { eventId: 'event-hostile' },
      signal,
      onUpdate,
      ctx,
    );
    expect(hostile.content[0]?.text.length).toBeLessThanOrEqual(
      INBOX_EVENT_DETAIL_RENDER_MAX_CHARS,
    );
    expect(hostile.content[0]?.text).toContain(
      'durable child artifact: report_get({ reportId: "<redacted-invalid-metadata>" })',
    );
    expect(hostile.content[0]?.text).toContain(
      'path autonomous: Autonomous rows may be acknowledged once handled.',
    );
    expect(hostile.content[0]?.text).toContain(
      'path judgment: When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first; surface it.',
    );
    expect(hostile.content[0]?.text).toContain(
      'judgment handoff: Use `question` with choices or `options: []` for free-form feedback (4000-char max); it binds the current cursor and consumes only it after a valid non-blank answer.',
    );
    expect(hostile.details).toMatchObject({
      eventId: 'event-hostile',
      reportId: '<redacted-invalid-metadata>',
      returnedSummaryChars: 900,
      summaryChars: 5_000,
      summaryTruncated: true,
    });
  });

  test('traverses every decodable continuation for a restored legacy summary-only row beyond the detail cap', async () => {
    const summary = `legacy summary ${'x'.repeat(MANAGER_EVENT_DETAILS_MAX_CHARS + 2 * REPORT_EXCERPT_MAX_CHARS)} tail`;
    const event: ManagerEvent = {
      createdAt,
      id: 'event-legacy-large-summary',
      summary,
      type: 'legacy_attention',
    };
    let maximumRequestedOffset = 0;
    const manager = {
      getInboxEvent: (params: { readonly offset?: number }) =>
        Effect.sync(() => {
          maximumRequestedOffset = Math.max(maximumRequestedOffset, params.offset ?? 0);
          if ((params.offset ?? 0) > INBOX_EVENT_EXCERPT_MAX_OFFSET)
            throw new Error('Continuation pointer was not decodable.');
          return event;
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const inboxGet = requiredValue(tools.get('inbox_get'));
    let offset = 0;
    let returnedTotal = 0;

    while (true) {
      const result = await inboxGet.execute(
        'call-legacy-summary',
        { eventId: event.id, maxChars: REPORT_EXCERPT_MAX_CHARS, offset },
        signal,
        onUpdate,
        ctx,
      );
      const details = result.details as {
        readonly hasMore: boolean;
        readonly offset: number;
        readonly returnedChars: number;
        readonly totalChars: number;
      };
      expect(details).toMatchObject({ offset, totalChars: summary.length });
      returnedTotal += details.returnedChars;
      if (!details.hasMore) break;
      offset += details.returnedChars;
      expect(offset).toBeLessThanOrEqual(INBOX_EVENT_EXCERPT_MAX_OFFSET);
      expect(result.content[0]?.text).toContain(
        `next: inbox_get({ eventId: "${event.id}", offset: ${offset}, maxChars: ${REPORT_EXCERPT_MAX_CHARS} })`,
      );
    }

    expect(returnedTotal).toBe(summary.length);
    expect(maximumRequestedOffset).toBeGreaterThan(MANAGER_EVENT_DETAILS_MAX_CHARS);
  });

  test('registers bounded lifecycle workflows for completion and inbox acknowledgement', async () => {
    const { pi, tools } = registry();
    const manager = {
      acknowledgeInbox: () =>
        Effect.succeed({
          acknowledgedCount: 2,
          deliveredCursorAgeMs: 1_234,
          pendingCount: 1,
          queuedSuffixCount: 1,
        }),
      completeWorkstream: (workstreamId: string) =>
        Effect.succeed(
          workstreamId === 'ws-deferred'
            ? {
                completionIntent: {
                  pendingAgents: [
                    {
                      agentId: 'agent-one',
                      lifecycleGeneration: 1,
                      reportId: 'report-one',
                    },
                  ],
                  requestedAt: '2026-01-01T00:00:00.000Z',
                  workstreamId,
                },
                id: workstreamId,
                status: 'active',
              }
            : { id: workstreamId, status: 'complete' },
        ),
    } as unknown as ManagerController;
    registerWorkstreamTools(pi, manager);

    const completed = await requiredValue(tools.get('workstream_complete')).execute(
      'call-1',
      { workstreamId: 'ws-1' },
      signal,
      onUpdate,
      ctx,
    );
    expect(completed.content[0]?.text).toBe('Completed workstream ws-1.');

    const deferred = await requiredValue(tools.get('workstream_complete')).execute(
      'call-deferred',
      { workstreamId: 'ws-deferred' },
      signal,
      onUpdate,
      ctx,
    );
    expect(deferred.content[0]?.text).toBe(
      'Deferred workstream ws-deferred completion until 1 generation-owned terminal child reaches an authoritative idle edge.',
    );

    const acknowledged = await requiredValue(tools.get('inbox_acknowledge')).execute(
      'call-2',
      {},
      signal,
      onUpdate,
      ctx,
    );
    expect(acknowledged.content[0]?.text).toBe(
      'Acknowledged 2 inbox events; 1 pending; queued suffix:1. Delivered cursor age:1234ms.',
    );
    expect(acknowledged.details).toMatchObject({
      deliveredCursorAgeMs: 1_234,
      queuedSuffixCount: 1,
    });
  });
});
