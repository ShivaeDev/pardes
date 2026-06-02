import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { requiredValue } from '../test-support.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import {
  appendManagerCompactionProjection,
  type CompactPiConversation,
  MANAGER_COMPACTION_FALLBACK_MAX_CHARS,
  MANAGER_COMPACTION_PROJECTION_CAPS,
  MANAGER_COMPACTION_PROJECTION_MAX_CHARS,
  type ManagerCompactionFallbackStage,
  type ManagerCompactionRegistrationOptions,
  type ManagerCompactionRegistrationOwner,
  managerCompactionOverride,
  projectManagerCompactionState,
  registerManagerCompactionStrategy,
  renderManagerCompactionFallbackDiagnostic,
  reportManagerCompactionFallback,
  stripManagerCompactionArtifacts,
  stripPardesCompactionProjection,
  stripPiFileOperationSuffix,
} from './compaction.ts';
import {
  type AgentRecord,
  initialManagerState,
  type ManagerState,
  type PullRequestRecord,
  type Workstream,
} from './domain.ts';

const createdAt = '2026-06-01T00:00:00.000Z';
const longText = 'projection text '.repeat(200);

function timestamp(index: number): string {
  return `2026-06-01T00:00:${String(index).padStart(2, '0')}.000Z`;
}

function fixtureState(): ManagerState {
  return initialManagerState('manager-compaction', {
    currentCheckout: '/private/current-checkout',
    gitCommonDir: '/private/git-common-dir',
    key: 'repo-compaction',
    primaryCheckout: '/private/primary-checkout',
  });
}

function workstream(id: string, status: Workstream['status'], index = 0): Workstream {
  return {
    createdAt,
    id,
    objective: `Objective ${id} ${longText}`,
    status,
    title: `Title ${id} ${longText}`,
    updatedAt: timestamp(index),
  };
}

function agent(
  id: string,
  status: WorkerStatus,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    changedPaths: [`/private/path/${id}.ts`],
    createdAt,
    id,
    model: 'fixture/model',
    role: 'worker',
    sessionDir: `/private/session/${id}`,
    status,
    task: `/private/task/${id}/${longText}`,
    thinkingLevel: 'high',
    updatedAt: overrides.updatedAt ?? createdAt,
    workstreamId: 'ws-active-9',
    ...overrides,
  };
}

function runtime(agentId: string, status: WorkerStatus): WorkerRuntimeSnapshot {
  return {
    agentId,
    completedCompactionCount: 0,
    model: 'fixture/model',
    pid: 123,
    sampledAt: 2,
    sessionFile: `/private/session/${agentId}.jsonl`,
    startedAt: 1,
    stats: undefined,
    status,
    stderr: { omittedChars: 0, originalChars: 0, shownChars: 0, tail: '' },
    task: `Runtime task ${agentId}`,
    thinkingLevel: 'high',
  };
}

function reviewGate(
  id: string,
  agentId: string,
  index: number,
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    agentId,
    createdAt,
    draft: index % 2 === 0,
    id,
    number: index,
    status: 'open',
    title: `Review ${id} ${longText}`,
    updatedAt: timestamp(index),
    url: `https://private.example.test/${id}`,
    workstreamId: 'ws-active-9',
    ...overrides,
  };
}

function preparation(previousSummary?: string): SessionBeforeCompactEvent['preparation'] {
  return {
    fileOps: {
      edited: new Set(['old-edit.ts']),
      read: new Set(['old-read.ts']),
      written: new Set(),
    },
    firstKeptEntryId: 'entry-kept',
    isSplitTurn: true,
    messagesToSummarize: [
      { content: [{ text: 'history', type: 'text' }], role: 'user', timestamp: 1 },
    ],
    previousSummary,
    settings: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 },
    tokensBefore: 12_345,
    turnPrefixMessages: [
      { content: [{ text: 'split prefix', type: 'text' }], role: 'user', timestamp: 2 },
    ],
  };
}

function event(
  previousSummary?: string,
  signal = new AbortController().signal,
): SessionBeforeCompactEvent {
  return {
    branchEntries: [],
    customInstructions: 'Preserve the manager decision.',
    preparation: preparation(previousSummary),
    signal,
    type: 'session_before_compact',
  };
}

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  const model = {
    api: 'fixture-api',
    baseUrl: 'https://fixture.example.test',
    contextWindow: 200_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'selected-manager-model',
    input: ['text'],
    maxTokens: 16_384,
    name: 'Selected manager model',
    provider: 'fixture-provider',
    reasoning: true,
  };
  return {
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        apiKey: 'fixture-key',
        headers: { 'x-fixture': 'yes' },
        ok: true,
      }),
    },
    ui: { notify: () => {} },
    ...overrides,
  } as unknown as ExtensionContext;
}

type BeforeCompactHandler = (
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

function registeredStrategy(
  ownerOverrides: Partial<ManagerCompactionRegistrationOwner> = {},
  options: ManagerCompactionRegistrationOptions = {},
): { readonly handler: BeforeCompactHandler; readonly observedSignals: AbortSignal[] } {
  let handler: BeforeCompactHandler | undefined;
  const observedSignals: AbortSignal[] = [];
  const owner: ManagerCompactionRegistrationOwner = {
    isActive: () => true,
    observeCompactionStart: (signal) => {
      observedSignals.push(signal);
      return true;
    },
    runtimeSnapshots: () => new Map(),
    snapshot: () => fixtureState(),
    ...ownerOverrides,
  };
  const pi = {
    getThinkingLevel: () => 'high' as const,
    on(name: string, candidate: BeforeCompactHandler) {
      if (name === 'session_before_compact') handler = candidate;
    },
  } as unknown as ExtensionAPI;
  registerManagerCompactionStrategy(pi, owner, options);
  if (!handler) throw new Error('Expected manager compaction registration.');
  return { handler, observedSignals };
}

async function selectCompactionLikePi(
  handler: BeforeCompactHandler,
  currentEvent: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  builtIn: () => Promise<CompactionResult>,
): Promise<CompactionResult> {
  const result = (await handler(currentEvent, ctx)) as
    | { readonly compaction?: CompactionResult }
    | undefined;
  return result?.compaction ?? builtIn();
}

describe('Pardes coordinating-manager compaction', () => {
  test('projects a deterministic bounded coordination snapshot from authoritative state', () => {
    const state: ManagerState = {
      ...fixtureState(),
      agents: Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => [
          `agent-${index}`,
          agent(`agent-${index}`, index === 2 ? 'crashed' : 'stopped', {
            latestReport: {
              createdAt,
              reportId: `report-${index}`,
              status: index === 3 ? 'blocked' : 'completed',
              summaryTruncated: index % 2 === 0,
            },
            updatedAt: timestamp(index),
          }),
        ]),
      ),
      inbox: Array.from({ length: 15 }, (_, index) => ({
        createdAt,
        id: `event-${index}`,
        summary: `Event ${index}`,
        type: 'fixture',
      })),
      pullRequests: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `pr-${index}`,
          reviewGate(
            `pr-${index}`,
            index === 9 ? 'agent-13' : `agent-${index}`,
            index,
            index === 9 ? { watcherFailedAt: createdAt } : {},
          ),
        ]),
      ),
      workstreams: {
        ...Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [
            `ws-active-${index}`,
            workstream(`ws-active-${index}`, 'active', index),
          ]),
        ),
        ...Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [
            `ws-planned-${index}`,
            workstream(`ws-planned-${index}`, 'planned', index),
          ]),
        ),
        ...Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [
            `ws-complete-${index}`,
            workstream(`ws-complete-${index}`, 'complete', index),
          ]),
        ),
        'ws-cancelled': workstream('ws-cancelled', 'cancelled', 1),
      },
    };
    const runtimes = new Map([
      ['agent-0', runtime('agent-0', 'running')],
      ['agent-1', runtime('agent-1', 'idle')],
    ]);

    const projection = projectManagerCompactionState(state, runtimes);
    const second = projectManagerCompactionState(state, runtimes);
    const rendered = appendManagerCompactionProjection('Narrative checkpoint', projection);

    expect(second).toEqual(projection);
    expect(projection).toMatchObject({
      inbox: { pendingCount: 15 },
      managerId: 'manager-compaction',
      openReviewGates: { attentionCount: 1, omittedCount: 2, totalCount: 10 },
      repository: { key: 'repo-compaction' },
      revision: 0,
      schemaVersion: 2,
      workers: { omittedRelevantCount: 4, relevantCount: 14, totalCount: 14 },
      workstreams: {
        counts: { active: 10, cancelled: 1, complete: 6, planned: 6 },
        omittedActiveCount: 2,
        omittedPlannedCount: 2,
        omittedRecentCompleteCount: 2,
      },
    });
    expect(projection.workstreams.active.map(({ id }) => id)).toEqual([
      'ws-active-9',
      'ws-active-8',
      'ws-active-7',
      'ws-active-6',
      'ws-active-5',
      'ws-active-4',
      'ws-active-3',
      'ws-active-2',
    ]);
    expect(projection.workstreams.planned).toHaveLength(
      MANAGER_COMPACTION_PROJECTION_CAPS.plannedWorkstreams,
    );
    expect(projection.workstreams.recentComplete).toHaveLength(
      MANAGER_COMPACTION_PROJECTION_CAPS.recentCompleteWorkstreams,
    );
    expect(projection.workers.items).toHaveLength(MANAGER_COMPACTION_PROJECTION_CAPS.workers);
    expect(
      projection.workers.items.slice(0, 2).map(({ id, attached }) => ({ attached, id })),
    ).toEqual([
      { attached: true, id: 'agent-1' },
      { attached: true, id: 'agent-0' },
    ]);
    expect(
      projection.workers.items.some(
        ({ id, openReviewGateIds }) => id === 'agent-13' && openReviewGateIds?.includes('pr-9'),
      ),
    ).toBe(true);
    expect(projection.openReviewGates.items.map(({ id }) => id)).toEqual([
      'pr-9',
      'pr-8',
      'pr-7',
      'pr-6',
      'pr-5',
      'pr-4',
      'pr-3',
      'pr-2',
    ]);
    expect(rendered).toContain('<pardes-coordinating-state schemaVersion="2">');
    const operatingGuidance = projection.operatingGuidance.join('\n');
    expect(operatingGuidance).toContain('Autonomous rows may be acknowledged once handled.');
    expect(operatingGuidance).toContain(
      'When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first; surface it.',
    );
    expect(operatingGuidance).toContain(
      'Use `question` for structured options or `await_user_feedback` for free-form feedback, and leave the cursor open until response.',
    );
    expect(operatingGuidance).toContain(
      'Published review feedback: tell the retained worker to make additive descendant commits only; do not amend, rebase, or rewrite published branch history. Pardes exact-SHA publication intentionally never force-pushes.',
    );
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MANAGER_COMPACTION_PROJECTION_MAX_CHARS,
    );
    expect(rendered).not.toContain('/private/');
    expect(rendered).not.toContain('https://private.example.test');
    expect(rendered).not.toContain('<read-files>');
  });

  test('keeps acknowledged discussion pagination-gap surfaces in the bounded coordination snapshot', () => {
    const gap = reviewGate('pr-gap', 'agent-gap', 42, {
      discussionPaginationGaps: ['review', 'inline_review_comment'],
      observation: {
        ci: 'passing',
        mergeable: 'mergeable',
        number: 42,
        reviewDecision: 'approved',
        status: 'open',
      },
    });
    // The durable review-gate reason must survive after its actionable inbox row was acknowledged.
    const state: ManagerState = { ...fixtureState(), inbox: [], pullRequests: { [gap.id]: gap } };

    const projection = projectManagerCompactionState(state);
    const rendered = appendManagerCompactionProjection('Narrative checkpoint', projection);

    expect(projection.inbox).toEqual({ pendingCount: 0 });
    expect(projection.openReviewGates).toMatchObject({
      attentionCount: 1,
      omittedCount: 0,
      totalCount: 1,
    });
    expect(projection.openReviewGates.items).toEqual([
      {
        agentId: 'agent-gap',
        ci: 'passing',
        discussionPaginationGapCount: 2,
        discussionPaginationGapSurfaces: ['review', 'inline_review_comment'],
        draft: true,
        headDiverged: false,
        id: 'pr-gap',
        mergeable: 'mergeable',
        number: 42,
        reviewDecision: 'approved',
        status: 'open',
        title: expect.any(String),
        watcherFailed: false,
        workstreamId: 'ws-active-9',
      },
    ]);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MANAGER_COMPACTION_PROJECTION_MAX_CHARS,
    );
    expect(rendered).not.toContain('https://private.example.test');
  });

  test('reuses Pi compact with the exact selected manager model while preserving preparation semantics and replacing file XML', async () => {
    const state: ManagerState = {
      ...fixtureState(),
      workstreams: { 'ws-active': workstream('ws-active', 'active', 1) },
    };
    const projection = projectManagerCompactionState(state);
    const previousSummary = `Prior narrative\n\n<read-files>\nprior.ts\n</read-files>\n\n${appendManagerCompactionProjection('Former narrative', projection).slice('Former narrative\n\n'.length)}`;
    const currentEvent = event(previousSummary);
    const ctx = context();
    const calls: unknown[][] = [];
    const compactConversation: CompactPiConversation = async (...args) => {
      calls.push(args);
      return {
        details: { modifiedFiles: ['current-edit.ts'], readFiles: ['current-read.ts'] },
        firstKeptEntryId: 'unexpected-generated-boundary',
        summary:
          'Fresh Pi narrative\n\n<read-files>\ncurrent-read.ts\n</read-files>\n\n<modified-files>\ncurrent-edit.ts\n</modified-files>',
        tokensBefore: 999_999,
      };
    };

    const result = await managerCompactionOverride({
      compactConversation,
      ctx,
      event: currentEvent,
      runtimes: new Map(),
      state,
      thinkingLevel: 'high',
    });

    expect(calls).toHaveLength(1);
    const [
      passedPreparation,
      passedModel,
      passedApiKey,
      passedHeaders,
      passedInstructions,
      passedSignal,
      passedThinking,
    ] = requiredValue(calls[0]);
    expect(passedModel).toBe(ctx.model);
    expect(passedApiKey).toBe('fixture-key');
    expect(passedHeaders).toEqual({ 'x-fixture': 'yes' });
    expect(passedInstructions).toBe(currentEvent.customInstructions);
    expect(passedSignal).toBe(currentEvent.signal);
    expect(passedThinking).toBe('high');
    expect(passedPreparation).toMatchObject({
      firstKeptEntryId: currentEvent.preparation.firstKeptEntryId,
      isSplitTurn: true,
      previousSummary: 'Prior narrative',
      tokensBefore: currentEvent.preparation.tokensBefore,
    });
    expect((passedPreparation as typeof currentEvent.preparation).messagesToSummarize).toBe(
      currentEvent.preparation.messagesToSummarize,
    );
    expect((passedPreparation as typeof currentEvent.preparation).turnPrefixMessages).toBe(
      currentEvent.preparation.turnPrefixMessages,
    );
    expect((passedPreparation as typeof currentEvent.preparation).fileOps).toBe(
      currentEvent.preparation.fileOps,
    );
    expect(result?.compaction).toMatchObject({
      details: {
        coordinatingState: { managerId: 'manager-compaction', schemaVersion: 2 },
        schemaVersion: 2,
      },
      firstKeptEntryId: 'entry-kept',
      tokensBefore: 12_345,
    });
    expect(result?.compaction.summary).toContain('Fresh Pi narrative');
    expect(result?.compaction.summary).toContain('<pardes-coordinating-state schemaVersion="2">');
    expect(result?.compaction.summary).not.toContain('current-read.ts');
    expect(result?.compaction.summary).not.toContain('current-edit.ts');
    expect(result?.compaction.summary).not.toContain('<read-files>');
    expect(result?.compaction.summary).not.toContain('<modified-files>');
  });

  test('strips only trailing generated artifacts so iterative updates cannot grow a snapshot ledger', () => {
    const projection = projectManagerCompactionState(fixtureState());
    const withProjection = appendManagerCompactionProjection(
      'Narrative with <read-files> inline mention',
      projection,
    );
    const withFilesAndProjection = `Checkpoint\n\n<read-files>\none.ts\n</read-files>\n\n<modified-files>\ntwo.ts\n</modified-files>\n\n${withProjection.slice('Narrative with <read-files> inline mention\n\n'.length)}`;
    const earlierLiteralProjection =
      'KEEP A\n\n<pardes-coordinating-state schemaVersion="1">\n{}\n</pardes-coordinating-state>\n\nKEEP B';
    const withEarlierLiteralAndTrailingProjection = appendManagerCompactionProjection(
      earlierLiteralProjection,
      projection,
    );

    expect(stripPardesCompactionProjection(withProjection)).toBe(
      'Narrative with <read-files> inline mention',
    );
    expect(
      stripPardesCompactionProjection(
        'Legacy narrative\n\n<pardes-coordinating-state schemaVersion="1">\n{}\n</pardes-coordinating-state>',
      ),
    ).toBe('Legacy narrative');
    expect(stripPardesCompactionProjection(withEarlierLiteralAndTrailingProjection)).toBe(
      earlierLiteralProjection,
    );
    expect(stripPardesCompactionProjection(withEarlierLiteralAndTrailingProjection)).toContain(
      'KEEP B',
    );
    expect(stripPiFileOperationSuffix('Checkpoint\n\n<read-files>\none.ts\n</read-files>')).toBe(
      'Checkpoint',
    );
    expect(stripManagerCompactionArtifacts(withFilesAndProjection)).toBe('Checkpoint');
    expect(stripPiFileOperationSuffix('Narrative with <read-files> inline mention')).toBe(
      'Narrative with <read-files> inline mention',
    );
  });

  test('registers the custom strategy only for an explicitly active coordinating manager', async () => {
    let compactCalls = 0;
    const reportFallback = (_diagnostic: string) => {
      throw new Error('Inactive manager must not report fallback.');
    };
    const compactConversation: CompactPiConversation = async () => {
      compactCalls += 1;
      return { firstKeptEntryId: 'entry-kept', summary: 'Manager narrative', tokensBefore: 12_345 };
    };
    const inactive = registeredStrategy(
      { isActive: () => false },
      { compactConversation, reportFallback },
    );

    expect(await inactive.handler(event(), context())).toBeUndefined();
    expect(compactCalls).toBe(0);
    expect(inactive.observedSignals).toHaveLength(1);

    const active = registeredStrategy({}, { compactConversation, reportFallback });
    const result = (await active.handler(event(), context())) as {
      readonly compaction?: CompactionResult;
    };
    expect(compactCalls).toBe(1);
    expect(result.compaction?.summary).toContain('<pardes-coordinating-state schemaVersion="2">');
  });

  test('declines the registered override so Pi selects built-in compaction after a custom crash', async () => {
    const diagnostics: string[] = [];
    const sensitive = `Authorization: Bearer ${'private-token-'.repeat(20)} api_key=sk-${'x'.repeat(100)} ${'verbose-detail '.repeat(200)}`;
    const strategy = registeredStrategy(
      {},
      {
        compactConversation: async () => {
          throw new Error(`fixture summarizer outage ${sensitive}`);
        },
        reportFallback: (diagnostic) => diagnostics.push(diagnostic),
      },
    );
    let builtInCalls = 0;

    const selected = await selectCompactionLikePi(
      strategy.handler,
      event(),
      context(),
      async () => {
        builtInCalls += 1;
        return {
          firstKeptEntryId: 'entry-kept',
          summary: 'Pi built-in fallback summary',
          tokensBefore: 12_345,
        };
      },
    );

    expect(selected.summary).toBe('Pi built-in fallback summary');
    expect(builtInCalls).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('[Pardes manager compaction fallback]');
    expect(diagnostics[0]).toContain('stage: summarize');
    expect(diagnostics[0]).toContain('selectedModel: fixture-provider/selected-manager-model');
    expect(diagnostics[0]).toContain('Pi built-in default compaction remains owner');
    expect(diagnostics[0]).toContain('Authorization=[redacted]');
    expect(diagnostics[0]).toContain('api_key=[redacted]');
    expect(diagnostics[0]).not.toContain('private-token-');
    expect(diagnostics[0]).not.toContain(`sk-${'x'.repeat(100)}`);
    expect(diagnostics[0].length).toBeLessThanOrEqual(MANAGER_COMPACTION_FALLBACK_MAX_CHARS);
  });

  test('declines registration-path crashes so Pi still selects its built-in fallback', async () => {
    const diagnostics: string[] = [];
    const strategy = registeredStrategy(
      {
        snapshot: () => {
          throw new Error('token=private-registration-token');
        },
      },
      { reportFallback: (diagnostic) => diagnostics.push(diagnostic) },
    );
    let builtInCalls = 0;

    const selected = await selectCompactionLikePi(
      strategy.handler,
      event(),
      context(),
      async () => {
        builtInCalls += 1;
        return {
          firstKeptEntryId: 'entry-kept',
          summary: 'Pi fallback after registration crash',
          tokensBefore: 12_345,
        };
      },
    );

    expect(selected.summary).toBe('Pi fallback after registration crash');
    expect(builtInCalls).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('stage: register_strategy');
    expect(diagnostics[0]).toContain('token=[redacted]');
    expect(diagnostics[0]).not.toContain('private-registration-token');
  });

  test('loudly declines every relevant custom failure stage with bounded diagnostics', async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    const cancelledWhileSummarizing = new AbortController();
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly stage: ManagerCompactionFallbackStage;
      readonly ctx?: ExtensionContext;
      readonly currentEvent?: SessionBeforeCompactEvent;
      readonly compactConversation?: CompactPiConversation;
      readonly projectState?: typeof projectManagerCompactionState;
      readonly appendProjection?: typeof appendManagerCompactionProjection;
    }> = [
      { ctx: context({ model: undefined }), name: 'missing model', stage: 'resolve_model' },
      {
        ctx: context({
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({
              error: 'token=private-auth-token unavailable',
              ok: false,
            }),
          } as never,
        }),
        name: 'auth unavailable',
        stage: 'resolve_auth',
      },
      {
        ctx: context({
          modelRegistry: {
            getApiKeyAndHeaders: () => {
              throw new Error('password=private-auth-password');
            },
          } as never,
        }),
        name: 'auth synchronous throw',
        stage: 'resolve_auth',
      },
      {
        ctx: context({
          modelRegistry: {
            getApiKeyAndHeaders: async () => {
              throw new Error('secret=private-auth-secret');
            },
          } as never,
        }),
        name: 'auth async rejection',
        stage: 'resolve_auth',
      },
      {
        compactConversation: (() => {
          throw new Error('apiKey=private-summary-key');
        }) as CompactPiConversation,
        name: 'summarizer synchronous throw',
        stage: 'summarize',
      },
      {
        compactConversation: async () => {
          throw new Error('Bearer private-summary-bearer');
        },
        name: 'summarizer async rejection',
        stage: 'summarize',
      },
      {
        compactConversation: async () => ({
          firstKeptEntryId: 'entry-kept',
          summary: '',
          tokensBefore: 12_345,
        }),
        name: 'empty output',
        stage: 'validate_summary',
      },
      {
        currentEvent: event(undefined, alreadyCancelled.signal),
        name: 'already cancelled',
        stage: 'cancelled',
      },
      {
        compactConversation: async () => {
          cancelledWhileSummarizing.abort();
          return { firstKeptEntryId: 'entry-kept', summary: 'Narrative', tokensBefore: 12_345 };
        },
        currentEvent: event(undefined, cancelledWhileSummarizing.signal),
        name: 'cancelled while summarizing',
        stage: 'cancelled',
      },
      {
        name: 'projection crash',
        projectState: () => {
          throw new Error('cookie=private-projection-cookie');
        },
        stage: 'project_state',
      },
      {
        appendProjection: () => {
          throw new Error('Authorization=private-render-auth');
        },
        name: 'render crash',
        stage: 'render_projection',
      },
    ];

    for (const fixture of cases) {
      const diagnostics: string[] = [];
      const result = await managerCompactionOverride({
        appendProjection: fixture.appendProjection,
        compactConversation:
          fixture.compactConversation ??
          (async () => ({
            firstKeptEntryId: 'entry-kept',
            summary: 'Narrative',
            tokensBefore: 12_345,
          })),
        ctx: fixture.ctx ?? context(),
        event: fixture.currentEvent ?? event(),
        projectState: fixture.projectState,
        reportFallback: (diagnostic) => diagnostics.push(diagnostic),
        runtimes: new Map(),
        state: fixtureState(),
        thinkingLevel: 'high',
      });
      expect(result, fixture.name).toBeUndefined();
      expect(diagnostics, fixture.name).toHaveLength(1);
      expect(diagnostics[0], fixture.name).toContain(`stage: ${fixture.stage}`);
      expect(diagnostics[0].length, fixture.name).toBeLessThanOrEqual(
        MANAGER_COMPACTION_FALLBACK_MAX_CHARS,
      );
      expect(diagnostics[0], fixture.name).not.toContain('private-');
    }
  });

  test('makes fallback cause diagnostics terminal-inert before rendering or operator delivery', () => {
    const diagnostic = renderManagerCompactionFallbackDiagnostic(
      'summarize',
      new Error('\u001b]0;private-title\u0007 token=private-control-token'),
    );
    const delivered: string[] = [];
    const ctx = context({
      ui: { notify: (message: string) => delivered.push(message) } as never,
    });

    reportManagerCompactionFallback(ctx, `${diagnostic}\u001b\u0007`, (message) =>
      delivered.push(message),
    );

    expect(diagnostic).not.toContain('\u001b');
    expect(diagnostic).not.toContain('\u0007');
    expect(diagnostic).toContain('token=[redacted]');
    expect(diagnostic).not.toContain('private-control-token');
    expect(delivered).toHaveLength(2);
    expect(
      delivered.every((message) => !message.includes('\u001b') && !message.includes('\u0007')),
    ).toBe(true);
  });

  test('accounts for redacted fallback diagnostic field omissions without midpoint ellipses', () => {
    const diagnostic = renderManagerCompactionFallbackDiagnostic(
      'summarize',
      new Error(`token=private-long-token ${'x'.repeat(2_000)}`),
    );

    expect(diagnostic).toContain('token=[redacted]');
    expect(diagnostic).toContain('omitted reason=diagnostic_field_limit');
    expect(diagnostic).toMatch(/originalChars=\d+ shownChars=\d+ omittedChars=\d+/);
    expect(diagnostic).not.toContain('private-long-token');
    expect(diagnostic.length).toBeLessThanOrEqual(MANAGER_COMPACTION_FALLBACK_MAX_CHARS);
  });

  test('keeps fallback safe when the UI diagnostic surface itself throws', () => {
    const logs: string[] = [];
    const diagnostic = renderManagerCompactionFallbackDiagnostic(
      'summarize',
      new Error('token=private-ui-token'),
    );
    const ctx = context({
      ui: {
        notify: () => {
          throw new Error('fixture UI outage');
        },
      } as never,
    });

    expect(() =>
      reportManagerCompactionFallback(ctx, diagnostic, (message) => logs.push(message)),
    ).not.toThrow();
    expect(logs).toEqual([diagnostic]);
    expect(diagnostic).toContain('token=[redacted]');
    expect(diagnostic).not.toContain('private-ui-token');
  });
});
