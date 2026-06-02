import {
  type CompactionResult,
  compact as compactPiConversation,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import type { GitHubDiscussionSurface } from '../github/index.ts';
import type { ReportTextCounts } from '../reporting/index.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import { effectiveAgentStatus, hasAgentWarning, pullRequestNeedsAttention } from './attention.ts';
import type { ManagerState, PullRequestRecord, WorkstreamStatus } from './domain.ts';
import { MANAGER_COMPACTION_COORDINATING_GUIDANCE } from './guidance/lifecycle.ts';

export const MANAGER_COMPACTION_PROJECTION_SCHEMA_VERSION = 2;
export const MANAGER_COMPACTION_PROJECTION_MAX_CHARS = 24_000;
export const MANAGER_COMPACTION_FALLBACK_MAX_CHARS = 1_200;
export const MANAGER_COMPACTION_FALLBACK_REASON_MAX_CHARS = 640;
export const MANAGER_COMPACTION_PROJECTION_CAPS = {
  activeWorkstreams: 8,
  openReviewGates: 8,
  plannedWorkstreams: 4,
  recentCompleteWorkstreams: 4,
  workerReviewGates: 3,
  workers: 10,
} as const;

const PROJECTION_TAG = 'pardes-coordinating-state';
const PROJECTION_OPEN = `<${PROJECTION_TAG} schemaVersion="${MANAGER_COMPACTION_PROJECTION_SCHEMA_VERSION}">`;
const PROJECTION_CLOSE = `</${PROJECTION_TAG}>`;
const COORDINATION_AGENT_STATUSES = new Set(['starting', 'running', 'idle']);
const MAX_ID_CHARS = 100;
const MAX_TITLE_CHARS = 120;
const MAX_OBJECTIVE_CHARS = 240;

type ManagerThinkingLevel = ReturnType<ExtensionAPI['getThinkingLevel']>;
type ManagerModel = NonNullable<ExtensionContext['model']>;
type CompactionPreparation = SessionBeforeCompactEvent['preparation'];

export type ManagerCompactionFallbackStage =
  | 'register_strategy'
  | 'resolve_model'
  | 'resolve_auth'
  | 'prepare_summary'
  | 'summarize'
  | 'validate_summary'
  | 'project_state'
  | 'render_projection'
  | 'cancelled';

export interface ManagerCompactionWorkstreamProjection {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly status: WorkstreamStatus;
}

export interface ManagerCompactionWorkerProjection {
  readonly id: string;
  readonly workstreamId: string;
  readonly status: string;
  readonly attached: boolean;
  readonly warning: boolean;
  readonly title?: string;
  readonly openReviewGateIds?: ReadonlyArray<string>;
  readonly omittedOpenReviewGateCount?: number;
  readonly latestResult?: {
    readonly reportId: string;
    readonly status: string;
    readonly summaryTruncated: boolean;
    readonly summaryChars?: ReportTextCounts;
    readonly summaryOmissionReason?: 'report_summary_preview_limit';
  };
}

export interface ManagerCompactionReviewGateProjection {
  readonly id: string;
  readonly workstreamId: string;
  readonly agentId: string;
  readonly status: 'open';
  readonly draft: boolean;
  readonly watcherFailed: boolean;
  readonly headDiverged: boolean;
  readonly discussionPaginationGapCount?: number;
  readonly discussionPaginationGapSurfaces?: ReadonlyArray<GitHubDiscussionSurface>;
  readonly number?: number;
  readonly title?: string;
  readonly ci?: string;
  readonly reviewDecision?: string;
  readonly mergeable?: string;
}

export interface ManagerCompactionProjection {
  readonly schemaVersion: typeof MANAGER_COMPACTION_PROJECTION_SCHEMA_VERSION;
  readonly managerId: string;
  readonly revision: number;
  readonly repository: { readonly key: string };
  readonly operatingGuidance: ReadonlyArray<string>;
  readonly workstreams: {
    readonly counts: Readonly<Record<WorkstreamStatus, number>>;
    readonly active: ReadonlyArray<ManagerCompactionWorkstreamProjection>;
    readonly omittedActiveCount: number;
    readonly planned: ReadonlyArray<ManagerCompactionWorkstreamProjection>;
    readonly omittedPlannedCount: number;
    readonly recentComplete: ReadonlyArray<ManagerCompactionWorkstreamProjection>;
    readonly omittedRecentCompleteCount: number;
  };
  readonly workers: {
    readonly totalCount: number;
    readonly relevantCount: number;
    readonly omittedRelevantCount: number;
    readonly items: ReadonlyArray<ManagerCompactionWorkerProjection>;
  };
  readonly openReviewGates: {
    readonly totalCount: number;
    readonly attentionCount: number;
    readonly omittedCount: number;
    readonly items: ReadonlyArray<ManagerCompactionReviewGateProjection>;
  };
  readonly inbox: { readonly pendingCount: number };
}

export interface ManagerCompactionDetails {
  readonly schemaVersion: typeof MANAGER_COMPACTION_PROJECTION_SCHEMA_VERSION;
  readonly coordinatingState: ManagerCompactionProjection;
}

export type CompactPiConversation = (
  preparation: CompactionPreparation,
  model: ManagerModel,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ManagerThinkingLevel,
) => Promise<CompactionResult>;

export interface ManagerCompactionOverrideInput {
  readonly state: ManagerState;
  readonly runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>;
  readonly event: SessionBeforeCompactEvent;
  readonly ctx: ExtensionContext;
  readonly thinkingLevel: ManagerThinkingLevel;
  readonly compactConversation?: CompactPiConversation;
  readonly projectState?: typeof projectManagerCompactionState;
  readonly appendProjection?: typeof appendManagerCompactionProjection;
  readonly reportFallback?: (diagnostic: string) => void;
}

export interface ManagerCompactionRegistrationOwner {
  readonly isActive: () => boolean;
  readonly snapshot: () => ManagerState | undefined;
  readonly runtimeSnapshots: () => ReadonlyMap<string, WorkerRuntimeSnapshot>;
  readonly observeCompactionStart: (signal: AbortSignal, ctx?: ExtensionContext) => boolean;
}

export interface ManagerCompactionRegistrationOptions {
  readonly compactConversation?: CompactPiConversation;
  readonly projectState?: typeof projectManagerCompactionState;
  readonly appendProjection?: typeof appendManagerCompactionProjection;
  readonly reportFallback?: (diagnostic: string) => void;
}

function boundInline(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return omissionAwareDiagnosticText(normalized, maxChars, 'projection_field_limit');
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function newestFirst(
  left: { readonly updatedAt: string; readonly id: string },
  right: { readonly updatedAt: string; readonly id: string },
): number {
  return compareText(right.updatedAt, left.updatedAt) || compareText(left.id, right.id);
}

function projectWorkstream(
  workstream: ManagerState['workstreams'][string],
): ManagerCompactionWorkstreamProjection {
  return {
    id: boundInline(workstream.id, MAX_ID_CHARS),
    objective: boundInline(workstream.objective, MAX_OBJECTIVE_CHARS),
    status: workstream.status,
    title: boundInline(workstream.title, MAX_TITLE_CHARS),
  };
}

function cappedWorkstreams(
  state: ManagerState,
  status: WorkstreamStatus,
  cap: number,
): {
  readonly items: ReadonlyArray<ManagerCompactionWorkstreamProjection>;
  readonly omittedCount: number;
} {
  const matching = Object.values(state.workstreams)
    .filter((workstream) => workstream.status === status)
    .sort(newestFirst);
  return {
    items: matching.slice(0, cap).map(projectWorkstream),
    omittedCount: Math.max(0, matching.length - cap),
  };
}

function openReviewGatesByAgent(
  openReviewGates: ReadonlyArray<PullRequestRecord>,
): ReadonlyMap<string, ReadonlyArray<PullRequestRecord>> {
  const byAgent = new Map<string, PullRequestRecord[]>();
  for (const gate of openReviewGates) {
    const current = byAgent.get(gate.agentId) ?? [];
    current.push(gate);
    byAgent.set(gate.agentId, current);
  }
  for (const gates of byAgent.values()) gates.sort(newestFirst);
  return byAgent;
}

function projectWorker(
  agent: ManagerState['agents'][string],
  runtime: WorkerRuntimeSnapshot | undefined,
  openReviewGates: ReadonlyArray<PullRequestRecord>,
): ManagerCompactionWorkerProjection {
  const visibleReviewGates = openReviewGates.slice(
    0,
    MANAGER_COMPACTION_PROJECTION_CAPS.workerReviewGates,
  );
  const latestResult = agent.latestReport;
  const status = effectiveAgentStatus(agent, runtime);
  return {
    attached: runtime !== undefined,
    id: boundInline(agent.id, MAX_ID_CHARS),
    status,
    warning: hasAgentWarning(agent, status),
    workstreamId: boundInline(agent.workstreamId, MAX_ID_CHARS),
    ...(agent.title === undefined ? {} : { title: boundInline(agent.title, MAX_TITLE_CHARS) }),
    ...(visibleReviewGates.length === 0
      ? {}
      : {
          openReviewGateIds: visibleReviewGates.map((gate) => boundInline(gate.id, MAX_ID_CHARS)),
        }),
    ...(openReviewGates.length <= visibleReviewGates.length
      ? {}
      : { omittedOpenReviewGateCount: openReviewGates.length - visibleReviewGates.length }),
    ...(latestResult === undefined
      ? {}
      : {
          latestResult: {
            reportId: boundInline(latestResult.reportId, MAX_ID_CHARS),
            status: latestResult.status,
            summaryTruncated: latestResult.summaryTruncated,
            ...(latestResult.summaryChars === undefined
              ? {}
              : { summaryChars: latestResult.summaryChars }),
            ...(latestResult.summaryOmissionReason === undefined
              ? {}
              : { summaryOmissionReason: latestResult.summaryOmissionReason }),
          },
        }),
  };
}

function projectReviewGate(gate: PullRequestRecord): ManagerCompactionReviewGateProjection {
  const paginationGaps = gate.discussionPaginationGaps ?? [];
  return {
    agentId: boundInline(gate.agentId, MAX_ID_CHARS),
    draft: gate.draft === true,
    headDiverged: gate.headDivergedAt !== undefined,
    id: boundInline(gate.id, MAX_ID_CHARS),
    status: 'open',
    watcherFailed: gate.watcherFailedAt !== undefined || gate.watcherFailure !== undefined,
    workstreamId: boundInline(gate.workstreamId, MAX_ID_CHARS),
    ...(paginationGaps.length === 0
      ? {}
      : {
          discussionPaginationGapCount: paginationGaps.length,
          discussionPaginationGapSurfaces: [...paginationGaps],
        }),
    ...(gate.number === undefined ? {} : { number: gate.number }),
    ...(gate.title === undefined ? {} : { title: boundInline(gate.title, MAX_TITLE_CHARS) }),
    ...(gate.observation === undefined
      ? {}
      : {
          ci: gate.observation.ci,
          mergeable: gate.observation.mergeable,
          reviewDecision: gate.observation.reviewDecision,
        }),
  };
}

/** Deterministic bounded snapshot: recompute current coordination state, never append a ledger. */
export function projectManagerCompactionState(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
): ManagerCompactionProjection {
  const workstreams = Object.values(state.workstreams);
  const counts: Record<WorkstreamStatus, number> = {
    active: 0,
    cancelled: 0,
    complete: 0,
    planned: 0,
  };
  for (const workstream of workstreams) counts[workstream.status] += 1;
  const active = cappedWorkstreams(
    state,
    'active',
    MANAGER_COMPACTION_PROJECTION_CAPS.activeWorkstreams,
  );
  const planned = cappedWorkstreams(
    state,
    'planned',
    MANAGER_COMPACTION_PROJECTION_CAPS.plannedWorkstreams,
  );
  const recentComplete = cappedWorkstreams(
    state,
    'complete',
    MANAGER_COMPACTION_PROJECTION_CAPS.recentCompleteWorkstreams,
  );

  const openReviewGates = Object.values(state.pullRequests)
    .filter((gate) => gate.status === 'open')
    .sort(newestFirst);
  const gatesByAgent = openReviewGatesByAgent(openReviewGates);
  const relevantWorkers = Object.values(state.agents)
    .map((agent) => {
      const runtime = runtimes.get(agent.id);
      const status = effectiveAgentStatus(agent, runtime);
      const reviewGates = gatesByAgent.get(agent.id) ?? [];
      const warning = hasAgentWarning(agent, status);
      const relevant =
        runtime !== undefined ||
        reviewGates.length > 0 ||
        warning ||
        COORDINATION_AGENT_STATUSES.has(status) ||
        agent.latestReport !== undefined;
      const priority =
        runtime !== undefined
          ? 0
          : reviewGates.length > 0
            ? 1
            : warning
              ? 2
              : COORDINATION_AGENT_STATUSES.has(status)
                ? 3
                : 4;
      return { agent, priority, relevant, reviewGates, runtime };
    })
    .filter(({ relevant }) => relevant)
    .sort((left, right) => left.priority - right.priority || newestFirst(left.agent, right.agent));
  const visibleWorkers = relevantWorkers.slice(0, MANAGER_COMPACTION_PROJECTION_CAPS.workers);
  const visibleReviewGates = openReviewGates.slice(
    0,
    MANAGER_COMPACTION_PROJECTION_CAPS.openReviewGates,
  );

  return {
    inbox: { pendingCount: state.inbox.length },
    managerId: boundInline(state.managerId, MAX_ID_CHARS),
    openReviewGates: {
      attentionCount: openReviewGates.filter(pullRequestNeedsAttention).length,
      items: visibleReviewGates.map(projectReviewGate),
      omittedCount: Math.max(0, openReviewGates.length - visibleReviewGates.length),
      totalCount: openReviewGates.length,
    },
    operatingGuidance: MANAGER_COMPACTION_COORDINATING_GUIDANCE,
    repository: { key: boundInline(state.repo.key, MAX_ID_CHARS) },
    revision: state.revision,
    schemaVersion: MANAGER_COMPACTION_PROJECTION_SCHEMA_VERSION,
    workers: {
      items: visibleWorkers.map(({ agent, runtime, reviewGates }) =>
        projectWorker(agent, runtime, reviewGates),
      ),
      omittedRelevantCount: Math.max(0, relevantWorkers.length - visibleWorkers.length),
      relevantCount: relevantWorkers.length,
      totalCount: Object.keys(state.agents).length,
    },
    workstreams: {
      active: active.items,
      counts,
      omittedActiveCount: active.omittedCount,
      omittedPlannedCount: planned.omittedCount,
      omittedRecentCompleteCount: recentComplete.omittedCount,
      planned: planned.items,
      recentComplete: recentComplete.items,
    },
  };
}

/** Drop only the final Pardes snapshot so narrative lookalikes survive schema upgrades. */
export function stripPardesCompactionProjection(summary: string): string {
  const suffixStart = summary.lastIndexOf(`\n\n<${PROJECTION_TAG} schemaVersion="`);
  if (suffixStart === -1) return summary;
  const suffix = summary.slice(suffixStart);
  return /^\n\n<pardes-coordinating-state schemaVersion="\d+">\n[\s\S]*\n<\/pardes-coordinating-state>$/.test(
    suffix,
  )
    ? summary.slice(0, suffixStart).trimEnd()
    : summary;
}

/** Drop Pi's default trailing cumulative file XML; manager coordination uses authoritative Pardes state instead. */
export function stripPiFileOperationSuffix(summary: string): string {
  const suffix =
    summary.match(
      /(?:\n\n<read-files>\n[\s\S]*?\n<\/read-files>)?(?:\n\n<modified-files>\n[\s\S]*?\n<\/modified-files>)?$/,
    )?.[0] ?? '';
  return suffix.includes('-files>') ? summary.slice(0, -suffix.length).trimEnd() : summary;
}

export function stripManagerCompactionArtifacts(summary: string): string {
  let stripped = summary;
  while (true) {
    const next = stripPiFileOperationSuffix(stripPardesCompactionProjection(stripped));
    if (next === stripped) return stripped;
    stripped = next;
  }
}

export function appendManagerCompactionProjection(
  summary: string,
  projection: ManagerCompactionProjection,
): string {
  const serialized = JSON.stringify(projection, null, 2);
  if (serialized.length > MANAGER_COMPACTION_PROJECTION_MAX_CHARS) {
    throw new Error(
      `Pardes coordinating-state projection exceeded ${MANAGER_COMPACTION_PROJECTION_MAX_CHARS} characters`,
    );
  }
  return `${stripManagerCompactionArtifacts(summary).trimEnd()}\n\n${PROJECTION_OPEN}\n${serialized}\n${PROJECTION_CLOSE}`;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unrenderable diagnostic>';
  }
}

function terminalInertManagerCompactionText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return (code <= 31 && code !== 10) || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('');
}

function redactManagerCompactionDiagnostic(value: unknown): string {
  return terminalInertManagerCompactionText(safeString(value))
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(
      /\b(api[-_ ]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/\b(sk|gh[opusr])[-_][a-zA-Z0-9_-]{8,}\b/g, '$1-[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\s+/g, ' ')
    .trim();
}

function omissionAwareDiagnosticText(
  text: string,
  maxChars: number,
  reason: 'diagnostic_field_limit' | 'projection_field_limit',
): string {
  if (text.length <= maxChars) return text;
  let shownChars = Math.max(0, maxChars - 120);
  let suffix = '';
  for (let iteration = 0; iteration < 3; iteration += 1) {
    suffix = ` [omitted reason=${reason} originalChars=${text.length} shownChars=${shownChars} omittedChars=${text.length - shownChars}]`;
    shownChars = Math.max(0, maxChars - suffix.length);
  }
  suffix = ` [omitted reason=${reason} originalChars=${text.length} shownChars=${shownChars} omittedChars=${text.length - shownChars}]`;
  return `${text.slice(0, shownChars)}${suffix}`;
}

/** Bound one terminal-inert redacted utility value; fallback cause delivery remains body-free. */
export function sanitizeManagerCompactionDiagnostic(
  value: unknown,
  maxChars = MANAGER_COMPACTION_FALLBACK_REASON_MAX_CHARS,
): string {
  return omissionAwareDiagnosticText(
    redactManagerCompactionDiagnostic(value),
    maxChars,
    'diagnostic_field_limit',
  );
}

function causeOmissionMetadata(cause: unknown): string {
  try {
    const text = cause instanceof Error ? cause.message : String(cause);
    return `chars(original=${text.length}, shown=0, omitted=${text.length})`;
  } catch {
    return 'chars(original=unknown, shown=0, omitted=unknown)';
  }
}

/** Render one bounded body-free operator diagnostic for safe Pi fallback. */
export function renderManagerCompactionFallbackDiagnostic(
  stage: ManagerCompactionFallbackStage,
  cause: unknown,
  _model?: ManagerModel,
): string {
  const diagnostic = [
    '[Pardes manager compaction fallback]',
    `stage: ${stage}`,
    'action: declining custom manager override; Pi built-in default compaction remains owner',
    `reason: [custom_override_cause_omitted] Arbitrary custom manager-compaction failure text omitted. ${causeOmissionMetadata(cause)}`,
  ].join('\n');
  if (diagnostic.length <= MANAGER_COMPACTION_FALLBACK_MAX_CHARS) return diagnostic;
  return [
    '[Pardes manager compaction fallback]',
    `stage: ${stage}`,
    'action: declining custom manager override; Pi built-in default compaction remains owner',
    'reason: [custom_override_cause_omitted] Arbitrary custom manager-compaction failure text omitted. chars(original=unknown, shown=0, omitted=unknown)',
  ].join('\n');
}

/** UI notification plus stderr logging; neither surface may prevent safe fallback. */
export function reportManagerCompactionFallback(
  ctx: ExtensionContext,
  diagnostic: string,
  log: (message: string) => void = (message) => console.error(message),
): void {
  const inertDiagnostic = terminalInertManagerCompactionText(diagnostic);
  try {
    ctx.ui.notify(inertDiagnostic, 'warning');
  } catch {
    // stderr remains a useful operator surface when a presentation adapter fails.
  }
  try {
    log(inertDiagnostic);
  } catch {
    // Diagnostics are best-effort; declining the override is the safety property.
  }
}

function reportFallback(
  input: Pick<ManagerCompactionOverrideInput, 'ctx' | 'reportFallback'>,
  stage: ManagerCompactionFallbackStage,
  cause: unknown,
  model?: ManagerModel,
): void {
  const diagnostic = renderManagerCompactionFallbackDiagnostic(stage, cause, model);
  if (!input.reportFallback) {
    reportManagerCompactionFallback(input.ctx, diagnostic);
    return;
  }
  try {
    input.reportFallback(diagnostic);
  } catch {
    reportManagerCompactionFallback(input.ctx, diagnostic);
  }
}

/**
 * Reuse Pi's public compact() implementation with the exact selected manager model.
 * Pi does not expose the active Agent stream wrapper or manager sessionId through
 * ExtensionContext, so this can share model/provider scope but not claim reuse of
 * the manager thread's provider cache key. Returning undefined intentionally
 * delegates to Pi's built-in fallback path.
 */
export async function managerCompactionOverride(
  input: ManagerCompactionOverrideInput,
): Promise<{ readonly compaction: CompactionResult<ManagerCompactionDetails> } | undefined> {
  let stage: ManagerCompactionFallbackStage = 'resolve_model';
  let model: ManagerModel | undefined;
  try {
    model = input.ctx.model;
    if (!model) {
      reportFallback(input, stage, 'No selected manager model is available.');
      return undefined;
    }
    if (input.event.signal.aborted) {
      reportFallback(input, 'cancelled', 'The compaction abort signal was already set.', model);
      return undefined;
    }
    stage = 'resolve_auth';
    const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      reportFallback(input, stage, auth.error, model);
      return undefined;
    }
    stage = 'prepare_summary';
    const preparation: CompactionPreparation = {
      ...input.event.preparation,
      previousSummary:
        input.event.preparation.previousSummary === undefined
          ? undefined
          : stripManagerCompactionArtifacts(input.event.preparation.previousSummary),
    };
    stage = 'summarize';
    const compacted = await (input.compactConversation ?? compactPiConversation)(
      preparation,
      model,
      auth.apiKey,
      auth.headers,
      input.event.customInstructions,
      input.event.signal,
      input.thinkingLevel,
    );
    if (input.event.signal.aborted) {
      reportFallback(
        input,
        'cancelled',
        'The compaction abort signal was set while summarization was running.',
        model,
      );
      return undefined;
    }
    stage = 'validate_summary';
    if (!compacted.summary.trim()) {
      reportFallback(input, stage, 'The custom manager summary was empty.', model);
      return undefined;
    }
    stage = 'project_state';
    const coordinatingState = (input.projectState ?? projectManagerCompactionState)(
      input.state,
      input.runtimes,
    );
    stage = 'render_projection';
    return {
      compaction: {
        details: { coordinatingState, schemaVersion: MANAGER_COMPACTION_PROJECTION_SCHEMA_VERSION },
        firstKeptEntryId: input.event.preparation.firstKeptEntryId,
        summary: (input.appendProjection ?? appendManagerCompactionProjection)(
          compacted.summary,
          coordinatingState,
        ),
        tokensBefore: input.event.preparation.tokensBefore,
      },
    };
  } catch (error) {
    reportFallback(input, input.event.signal.aborted ? 'cancelled' : stage, error, model);
    return undefined;
  }
}

/** Register the override only in the coordinating-manager package extension. */
export function registerManagerCompactionStrategy(
  pi: ExtensionAPI,
  manager: ManagerCompactionRegistrationOwner,
  options: ManagerCompactionRegistrationOptions = {},
): void {
  pi.on('session_before_compact', async (event, ctx) => {
    let model: ManagerModel | undefined;
    try {
      manager.observeCompactionStart(event.signal, ctx);
      if (!manager.isActive()) return;
      const state = manager.snapshot();
      if (!state) {
        reportFallback(
          { ctx, reportFallback: options.reportFallback },
          'register_strategy',
          'The active manager snapshot is unavailable.',
        );
        return;
      }
      model = ctx.model;
      return await managerCompactionOverride({
        ctx,
        event,
        runtimes: manager.runtimeSnapshots(),
        state,
        thinkingLevel: pi.getThinkingLevel(),
        ...options,
      });
    } catch (error) {
      reportFallback(
        { ctx, reportFallback: options.reportFallback },
        event.signal.aborted ? 'cancelled' : 'register_strategy',
        error,
        model,
      );
      return;
    }
  });
}
