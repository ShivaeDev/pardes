import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import { GitHubCommandError, type GitHubIntegrationHealthInspection } from '../github/index.ts';
import {
  type AgentRecord,
  type AgentStatus,
  AUTONOMOUS_INBOX_PATH,
  INBOX_TWO_PATH_GUIDANCE,
  initialManagerState,
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
import {
  REPORT_EXCERPT_MAX_CHARS,
  REPORT_EXCERPT_TRUST_LABEL,
  REPORT_HANDOFF_NOTE_MAX_CHARS,
} from '../reporting/index.ts';
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
  const pi = {
    registerTool(tool: unknown) {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

const ctx = {} as ExtensionContext;
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
    stderr: 'diagnostic stderr',
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
    registerQuestionTool(pi);
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
      'await_user_feedback',
      'pull_request_create',
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
    expect(tools.get('report_get')?.parameters.properties.offset).toMatchObject({ minimum: 0 });
    expect(tools.get('report_get')?.parameters.properties.maxChars).toMatchObject({
      maximum: REPORT_EXCERPT_MAX_CHARS,
      minimum: 1,
    });
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
    assertLexicalId('inbox_acknowledge', 'cursor');
    expect(tools.get('await_user_feedback')?.parameters.properties.prompt).toMatchObject({
      maxLength: 256,
      minLength: 1,
    });

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
    registerQuestionTool(pi);
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
    for (const name of ['inbox_get', 'inbox_acknowledge', 'await_user_feedback', 'question']) {
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
    expect(requiredValue(tools.get('await_user_feedback')).promptSnippet).toBe(
      'Surface the active delivered Pardes attention cursor for free-form user feedback without acknowledging it first',
    );
    expect(requiredValue(tools.get('question')).promptSnippet).toBe(
      'Ask a structured user-judgment question while leaving any active Pardes attention cursor open until response',
    );
    expect(requiredValue(tools.get('inbox_acknowledge')).description).toContain(
      'Use only for the autonomous path after rows are handled',
    );
    expect(requiredValue(tools.get('await_user_feedback')).description).toContain(
      'Do not acknowledge the active cursor first',
    );
    expect(requiredValue(tools.get('question')).description).toContain(
      'this tool does not consume that cursor',
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

    expect(lines.slice(0, 5)).toEqual([
      'pardes manager-12345678 · revision 0',
      'workstreams: 1 active · 0 planned · 0 complete · 0 cancelled',
      'workers: 2 running · 0 idle · 0 starting · 0 crashed · 2 warnings',
      'review gates: 2 open · 2 attention · advisory verifications: 0 current · 0 stale · inbox: 2 pending',
      'attention index: 6 signals · first 5 shown · drill down: inbox | reviews(attention) | agents(warnings)',
    ]);
    expect(lines.slice(5, 10)).toEqual([
      '! inbox event-z [discussion_feedback] · judge first: inbox_get({ eventId })',
      '! inbox redacted-event [agent_question] · judge first: inbox_get({ eventId })',
      '! review #41 [open] · ws-active · agent-a · ⚠ ci:failing',
      '! review #42 [open] · ws-active · agent-z · ⚠ merge:conflicting',
      '! worker agent-a [running] · ws-active · ⚠ dirty worktree',
    ]);
    expect(lines[10]).toBe('… +1 more attention signal omitted (1 worker)');
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
        'pinned child runtime: cccccccccccc (2 input files)',
        'shared child inputs: loaded aaaaaaaaaaaa (2 source files) · current bbbbbbbbbbbb (2 source files)',
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
        },
      ],
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
        'default branch main · advertised:aaaaaaaaaaaa · hosted:aaaaaaaaaaaa [current/complete] · ci:failing · checks:2 · fail:1',
        '#42 · audited:bbbbbbbbbbbb · observed:bbbbbbbbbbbb [current] · hosted:cccccccccccc [current/complete] · ci:failing · checks:1 · fail:1 · likely-main-shared-failures:1',
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
        scannedBytes: STORAGE_EVENT_SCAN_MAX_BYTES,
      },
      reports: {
        kind: 'directory',
        metricsAccuracy: 'lower_bound',
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
      'events: regular file · 131072 bytes · ≥73 event lines · scan limited after 65536 bytes',
    );
    expect(text).toContain(
      'reports: directory · ≥128 reports · ≥4096 bytes · 2 other direct entries observed · scan limited after 128 direct entries',
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
      inbox,
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
    expect(reviews.content[0]?.text).toContain('#42 [open]');
    expect(reviews.content[0]?.text).not.toContain('#41 [open]');

    const pending = await status.execute('call-2', { view: 'inbox' }, signal, onUpdate, ctx);
    expect(pending.content[0]?.text).toContain(
      'inbox: 1 pending event · read and judge one: inbox_get({ eventId })',
    );
    expect(pending.content[0]?.text).toContain('delivery: cursor event-1 · delivered age:');
    expect(pending.content[0]?.text).toContain(
      '· queued suffix:0 · awaiting-user:no · wake wake-fixture',
    );
    expect(pending.content[0]?.text).toContain(`path autonomous: ${AUTONOMOUS_INBOX_PATH}`);
    expect(pending.content[0]?.text).toContain(`path judgment: ${USER_JUDGMENT_INBOX_PATH}`);
    expect(pending.content[0]?.text).toContain(`judgment handoff: ${USER_JUDGMENT_HANDOFF_PATH}`);
    expect(pending.content[0]?.text).toContain(
      'event-1 [review_feedback] Review gate needs a follow-up.',
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
      'Retrieve durable report details separately with report_get',
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
            runtime: runtime(),
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
    const manager = { agentStatus: () => Effect.succeed(status) } as unknown as ManagerController;
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
      'changed paths (2): extensions/pardes/tools/index.ts, extensions/pardes/tools/tools.test.ts',
    );
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
          openedInBrowser: false,
          pullRequest: { number: 42, url: 'https://github.test/acme/project/pull/42' },
        }),
    } as unknown as ManagerController;
    registerPullRequestTools(pi, manager);

    const publish = requiredValue(tools.get('pull_request_create'));
    expect(publish.description).toBe(
      "Audit a managed worker's committed changes, push its managed branch to origin, and create or update a GitHub review gate. Never merges.",
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
    expect(publish.parameters.properties.baseBranch?.maxLength).toBe(255);
    expect(publish.parameters.required).not.toContain('openInBrowser');
    expect([...tools.keys()].some((name) => name.includes('merge'))).toBe(false);
    const result = await publish.execute(
      'call-1',
      {
        agentId: 'agent-1',
        baseBranch: 'main',
        body: 'Summary and validation.',
        title: 'Review gate',
        workstreamId: 'ws-1',
      },
      signal,
      onUpdate,
      ctx,
    );
    expect(result.content[0]?.text).toBe(
      'Created PR #42: https://github.test/acme/project/pull/42.',
    );
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
    expect(text).toContain('event-report [agent_report_completed] child-authored preview:');
    expect(text).toContain(
      'event-verifier-report [agent_report_completed] advisory-verifier-authored preview:',
    );
    expect(text).toContain('child-authored preview:');
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

  test('registers report_get as one bounded trust-labelled excerpt retrieval with metadata but no raw structured artifact content', async () => {
    const excerpt = {
      agentId: 'agent-one',
      excerpt: 'private\n"detail"',
      field: 'details' as const,
      hasMore: true,
      offset: 0,
      reportId: 'report-123',
      returnedChars: 16,
      status: 'completed' as const,
      totalChars: 32,
    };
    const manager = { getReport: () => Effect.succeed(excerpt) } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const reportGet = requiredValue(tools.get('report_get'));

    expect(reportGet.description).toContain(
      'one known manager-scoped durable worker or advisory-verifier report by reportId',
    );
    expect(reportGet.description).toContain('never lists, guesses, or bulk-loads artifacts');
    const result = await reportGet.execute(
      'call-1',
      { reportId: 'report-123' },
      signal,
      onUpdate,
      ctx,
    );

    expect(result.content[0]?.text).toContain(`[${REPORT_EXCERPT_TRUST_LABEL}]`);
    expect(result.content[0]?.text).toContain('excerpt(JSON string): "private\\n\\"detail\\""');
    expect(result.details).toEqual({
      agentId: 'agent-one',
      field: 'details',
      hasMore: true,
      offset: 0,
      reportId: 'report-123',
      returnedChars: 16,
      status: 'completed',
      totalChars: 32,
    });
    expect(JSON.stringify(result.details)).not.toContain('private');
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
      'event-hostile': {
        createdAt,
        id: 'event-hostile',
        reportId: '\u0000'.repeat(5_000),
        summary: '\u0000'.repeat(5_000),
        type: 'forward_compatible_event',
      },
      'event-metadata': {
        createdAt,
        id: 'event-metadata',
        pullRequestId: 'pr-42',
        summary: '#42 has changes-requested review metadata.',
        type: 'review_feedback',
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
      'summary(JSON string): "[external GitHub feedback] #42 observed a preview.\\n\\"quoted external preview\\""',
    );
    expect(external.content[0]?.text).toContain(
      'external GitHub feedback remains observation-only: persisted bounded previews only; no worker message was sent.',
    );
    expect(external.content[0]?.text).toContain(
      'path autonomous: Autonomous rows may be acknowledged once handled.',
    );
    expect(external.content[0]?.text).toContain(
      'path judgment: When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first; surface it.',
    );
    expect(external.content[0]?.text).toContain(
      'judgment handoff: Use `question` for structured options or `await_user_feedback` for free-form feedback, and leave the cursor open until response.',
    );
    expect(external.details).toEqual({
      agentId: 'agent-1',
      createdAt,
      eventId: 'event-external',
      pullRequestId: 'pr-42',
      returnedSummaryChars: externalSummary.length,
      summaryChars: externalSummary.length,
      summaryTruncated: false,
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
      'judgment handoff: Use `question` for structured options or `await_user_feedback` for free-form feedback, and leave the cursor open until response.',
    );
    expect(hostile.details).toMatchObject({
      eventId: 'event-hostile',
      reportId: '<redacted-invalid-metadata>',
      returnedSummaryChars: 900,
      summaryChars: 5_000,
      summaryTruncated: true,
    });
  });

  test('submits valid feedback but disarms cancelled, blank, and oversized handoffs without consuming unseen rows', async () => {
    const submittedTokens: string[] = [];
    const disarmedTokens: string[] = [];
    let begins = 0;
    const manager = {
      beginInboxHandoff: () =>
        Effect.sync(() => {
          begins += 1;
          return {
            cursor: 'event-presented',
            surfacedAt: '2026-06-01T00:00:00.000Z',
            token: `handoff-${begins}`,
            wakeToken: 'wake-presented',
          };
        }),
      disarmInboxHandoff: (started: { readonly token: string }) =>
        Effect.sync(() => {
          disarmedTokens.push(started.token);
          return true;
        }),
      submitInboxHandoff: (started: { readonly cursor: string; readonly token: string }) =>
        Effect.sync(() => {
          submittedTokens.push(started.token);
          return {
            acknowledgedCount: 1,
            cursor: started.cursor,
            pendingCount: 2,
            reason: 'feedback_tool_submitted' as const,
            staleCursor: false,
          };
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const handoff = requiredValue(tools.get('await_user_feedback'));
    const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
    const interactiveContext = (keys: string[]) =>
      ({
        hasUI: true,
        ui: {
          custom: async (
            factory: (
              tui: { requestRender: () => void },
              theme: unknown,
              keybindings: unknown,
              done: (value: unknown) => void,
            ) => { handleInput?: (data: string) => void },
          ) =>
            await new Promise((resolve) => {
              const component = factory({ requestRender: () => {} }, theme, {}, resolve);
              for (const key of keys) component.handleInput?.(key);
            }),
        },
      }) as unknown as ExtensionContext;

    const submitted = await handoff.execute(
      'call-submit',
      { prompt: 'How should this proceed?' },
      signal,
      onUpdate,
      interactiveContext(['Proceed', '\r']),
    );
    expect(submitted.content[0]?.text).toBe('User feedback: Proceed');
    expect(submitted.details).toMatchObject({
      acknowledgedCount: 1,
      cursor: 'event-presented',
      pendingCount: 2,
      reason: 'feedback_tool_submitted',
      submitted: true,
    });
    expect(submittedTokens).toEqual(['handoff-1']);

    const cancelled = await handoff.execute(
      'call-cancel',
      { prompt: 'Still proceed?' },
      signal,
      onUpdate,
      interactiveContext(['\x1b']),
    );
    expect(cancelled.content[0]?.text).toContain('cursor remains pending');
    expect(cancelled.details).toEqual({
      cursor: 'event-presented',
      cursorPreserved: true,
      handoffDisarmed: true,
      submitted: false,
    });

    const blank = await handoff.execute(
      'call-blank',
      { prompt: 'Still proceed?' },
      signal,
      onUpdate,
      interactiveContext(['  ', '\r']),
    );
    expect(blank.content[0]?.text).toContain('submitted no feedback');
    expect(blank.details).toEqual({
      cursor: 'event-presented',
      cursorPreserved: true,
      handoffDisarmed: true,
      submitted: false,
    });

    const oversized = await handoff.execute(
      'call-oversized',
      { prompt: 'Still proceed?' },
      signal,
      onUpdate,
      interactiveContext(['x'.repeat(4_001), '\r']),
    );
    expect(oversized.content[0]?.text).toContain('exceeded the 4000-character handoff bound');
    expect(oversized.details).toEqual({
      cursor: 'event-presented',
      cursorPreserved: true,
      handoffDisarmed: true,
      submitted: false,
    });

    expect(submittedTokens).toEqual(['handoff-1']);
    expect(disarmedTokens).toEqual(['handoff-2', 'handoff-3', 'handoff-4']);
    expect(begins).toBe(4);
  });

  test('disarms rejected, thrown-input, and aborted dialogs before unrelated normal input can consume their surfaced cursor', async () => {
    interface Handoff {
      readonly cursor: string;
      readonly wakeToken: string;
      readonly surfacedAt: string;
      readonly token: string;
    }

    let marker: Handoff | undefined;
    let begins = 0;
    let unrelatedAcknowledgements = 0;
    const disarmedTokens: string[] = [];
    const manager = {
      acknowledgeInboxAfterHandoff: () =>
        Effect.sync(() => {
          if (!marker) return undefined;
          unrelatedAcknowledgements += 1;
          marker = undefined;
          return { acknowledgedCount: 1 };
        }),
      beginInboxHandoff: () =>
        Effect.sync(() => {
          begins += 1;
          marker = {
            cursor: 'event-presented',
            surfacedAt: '2026-06-01T00:00:00.000Z',
            token: `handoff-${begins}`,
            wakeToken: 'wake-presented',
          };
          return marker;
        }),
      disarmInboxHandoff: (started: Handoff) =>
        Effect.sync(() => {
          if (marker?.token !== started.token) return false;
          disarmedTokens.push(started.token);
          marker = undefined;
          return true;
        }),
    } as unknown as ManagerController;
    const { pi, tools } = registry();
    registerWorkstreamTools(pi, manager);
    const handoff = requiredValue(tools.get('await_user_feedback'));
    const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
    const context = (ui: Record<string, unknown>) =>
      ({ hasUI: true, ui }) as unknown as ExtensionContext;
    const expectUnrelatedInputPreserved = async () => {
      expect(await Effect.runPromise(manager.acknowledgeInboxAfterHandoff())).toBeUndefined();
      expect(marker).toBeUndefined();
      expect(unrelatedAcknowledgements).toBe(0);
    };

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const alreadyAbortedResult = await handoff.execute(
      'call-already-aborted',
      { prompt: 'Do not surface this dialog' },
      alreadyAborted.signal,
      onUpdate,
      context({}),
    );
    expect(alreadyAbortedResult.details).toEqual({ aborted: true, submitted: false });
    expect(begins).toBe(0);

    await expect(
      handoff.execute(
        'call-rejected',
        { prompt: 'Reject this dialog' },
        signal,
        onUpdate,
        context({
          custom: async () => {
            throw new Error('dialog rejected');
          },
        }),
      ),
    ).rejects.toThrow('dialog rejected');
    await expectUnrelatedInputPreserved();

    await expect(
      handoff.execute(
        'call-input-threw',
        { prompt: 'Throw from fallback input' },
        signal,
        onUpdate,
        context({
          custom: async () => undefined,
          input: async () => {
            throw new Error('input threw');
          },
        }),
      ),
    ).rejects.toThrow('input threw');
    await expectUnrelatedInputPreserved();

    const aborted = new AbortController();
    const abortedResult = await handoff.execute(
      'call-aborted',
      { prompt: 'Abort this dialog' },
      aborted.signal,
      onUpdate,
      context({
        custom: async (
          factory: (
            tui: { requestRender: () => void },
            theme: unknown,
            keybindings: unknown,
            done: (value: unknown) => void,
          ) => unknown,
        ) =>
          await new Promise((resolve) => {
            factory({ requestRender: () => {} }, theme, {}, resolve);
            queueMicrotask(() => aborted.abort());
          }),
      }),
    );
    expect(abortedResult.content[0]?.text).toContain('cursor remains pending');
    await expectUnrelatedInputPreserved();
    expect(disarmedTokens).toEqual(['handoff-1', 'handoff-2', 'handoff-3']);
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
        Effect.succeed({ id: workstreamId, status: 'complete' }),
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
