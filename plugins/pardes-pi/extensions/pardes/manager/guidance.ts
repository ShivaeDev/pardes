import type { ExtensionAPI, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import { effectiveAgentStatus, hasAgentWarning, pullRequestNeedsAttention } from './attention.ts';
import type { ManagerState } from './domain.ts';

export const MANAGER_GUIDANCE_MESSAGE_TYPE = 'pardes-manager-guidance';
export type ManagerGuidanceReason = 'activated' | 'restored' | 'reloaded' | 'compacted';

interface ManagerGuidanceBounds {
  readonly maxLines: number;
  readonly maxLineChars: number;
  readonly maxChars: number;
}

export const MANAGER_GUIDANCE_BOUNDS: Readonly<
  Record<ManagerGuidanceReason, ManagerGuidanceBounds>
> = {
  activated: { maxChars: 1_500, maxLineChars: 240, maxLines: 7 },
  compacted: { maxChars: 1_700, maxLineChars: 240, maxLines: 8 },
  reloaded: { maxChars: 1_100, maxLineChars: 240, maxLines: 5 },
  restored: { maxChars: 1_500, maxLineChars: 240, maxLines: 7 },
};

export const MANAGER_GUIDANCE_MAX_LINES = Math.max(
  ...Object.values(MANAGER_GUIDANCE_BOUNDS).map((bounds) => bounds.maxLines),
);
export const MANAGER_GUIDANCE_MAX_LINE_CHARS = Math.max(
  ...Object.values(MANAGER_GUIDANCE_BOUNDS).map((bounds) => bounds.maxLineChars),
);
export const MANAGER_GUIDANCE_MAX_CHARS = Math.max(
  ...Object.values(MANAGER_GUIDANCE_BOUNDS).map((bounds) => bounds.maxChars),
);

interface ManagerGuidanceProjection {
  readonly workstreams: {
    readonly total: number;
    readonly active: number;
    readonly planned: number;
    readonly complete: number;
    readonly cancelled: number;
  };
  readonly workers: {
    readonly total: number;
    readonly attached: number;
    readonly detached: number;
    readonly revivable: number;
    readonly statuses: Readonly<Record<WorkerStatus, number>>;
    readonly compacting: number;
    readonly pendingMessages: number;
    readonly warnings: number;
  };
  readonly reviews: {
    readonly open: number;
    readonly draftOpen: number;
    readonly warnings: number;
  };
  readonly inbox: number;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** Hard-bound reminder text even if future guidance lines acquire dynamic content. */
export function boundManagerGuidance(
  lines: ReadonlyArray<string>,
  bounds: ManagerGuidanceBounds = MANAGER_GUIDANCE_BOUNDS.activated,
): string {
  const boundedLines = lines
    .flatMap((line) => line.replace(/\r/g, '').split('\n'))
    .slice(0, bounds.maxLines)
    .map((line) => truncate(line, bounds.maxLineChars));
  return truncate(boundedLines.join('\n'), bounds.maxChars);
}

function projectManagerGuidance(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): ManagerGuidanceProjection {
  const workstreams = { active: 0, cancelled: 0, complete: 0, planned: 0, total: 0 };
  const statuses: Record<WorkerStatus, number> = {
    crashed: 0,
    idle: 0,
    running: 0,
    starting: 0,
    stopped: 0,
  };
  let attached = 0;
  let detached = 0;
  let revivable = 0;
  let compacting = 0;
  let pendingMessages = 0;
  let workerWarnings = 0;
  let openReviews = 0;
  let draftOpenReviews = 0;
  let reviewWarnings = 0;

  for (const workstream of Object.values(state.workstreams)) {
    workstreams.total += 1;
    workstreams[workstream.status] += 1;
  }
  for (const agent of Object.values(state.agents)) {
    const runtime = runtimes.get(agent.id);
    const status = effectiveAgentStatus(agent, runtime);
    statuses[status] += 1;
    if (runtime) {
      attached += 1;
      if (runtime.isCompacting) compacting += 1;
      pendingMessages += runtime.pendingMessageCount ?? 0;
    } else {
      detached += 1;
      if (agent.sessionFile) revivable += 1;
    }
    if (hasAgentWarning(agent, status)) workerWarnings += 1;
  }
  for (const pullRequest of Object.values(state.pullRequests)) {
    if (pullRequest.status === 'open') {
      openReviews += 1;
      if (pullRequest.draft === true) draftOpenReviews += 1;
    }
    if (pullRequestNeedsAttention(pullRequest)) reviewWarnings += 1;
  }

  return {
    inbox: state.inbox.length,
    reviews: { draftOpen: draftOpenReviews, open: openReviews, warnings: reviewWarnings },
    workers: {
      attached,
      compacting,
      detached,
      pendingMessages,
      revivable,
      statuses,
      total: Object.keys(state.agents).length,
      warnings: workerWarnings,
    },
    workstreams,
  };
}

function currentSnapshotLines(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  const { workstreams, workers, reviews, inbox } = projection;
  return [
    `State: streams ${workstreams.total} total (${workstreams.active} active/${workstreams.planned} planned/${workstreams.complete} complete); workers ${workers.total} total (${workers.attached} attached/${workers.detached} detached, ${workers.revivable} revivable).`,
    `Attention: ${workers.statuses.running} running/${workers.statuses.idle} idle; ${workers.warnings + reviews.warnings} warnings; inbox ${inbox}; ${reviews.open} open review gates (${reviews.draftOpen} draft).`,
  ];
}

function operationalSnapshotLines(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  const { workstreams, workers, reviews, inbox } = projection;
  return [
    `State: streams ${workstreams.total} total; ${workstreams.active} active/${workstreams.planned} planned/${workstreams.complete} complete/${workstreams.cancelled} cancelled.`,
    `Workers: ${workers.total} total; ${workers.attached} attached/${workers.detached} detached/${workers.revivable} revivable; states ${workers.statuses.starting} starting/${workers.statuses.running} running/${workers.statuses.idle} idle/${workers.statuses.stopped} stopped/${workers.statuses.crashed} crashed; compacting ${workers.compacting}; queued ${workers.pendingMessages}.`,
    `Attention: ${workers.warnings} worker warnings; ${reviews.warnings} review warnings; inbox ${inbox}; ${reviews.open} open review gates (${reviews.draftOpen} draft).`,
  ];
}

function guidanceLines(text: string): ReadonlyArray<string> {
  return text.trim().split('\n');
}

const communicationLine =
  'Communication: state only facts, decision needed, blockers, and next action. Skip fluff, repeated narration, excess headings, pseudo-diagrams, gratuitous code fences, and vertical whitespace.';
const safetyLine =
  'Safety: surface correctness bugs; request advisory `verification_request({ sourceAgentId })` before meaningful publication; inspect consolidated durable report without polling; manager judges. Skip trivial docs/tests unless risk justifies.';
const durableAttentionLine =
  'Inbox: trust durable state, not tokenized presentation cursors; use `await_user_feedback` only for user judgment and leave its cursor open until response; acknowledge autonomous rows once after handling.';

function renderActivatedGuidance(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes manager activated.
Next: inspect compact \`pardes_status\`; delegate coherent end-to-end outcomes; keep owners attached for feedback; use parallel lanes only when independent; user controls merges.
${communicationLine}
${safetyLine}
${durableAttentionLine}
${currentSnapshotLines(projection).join('\n')}
`);
}

function renderRestoredGuidance(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes manager restored.
Fact: persisted state restored. Next: inspect compact \`pardes_status\`, account for open review gates, and revive only detached workers that should continue. Use \`pardes_status(view="cleanup")\` only for explicit resolved artifact guidance.
${communicationLine}
${safetyLine}
${durableAttentionLine}
${currentSnapshotLines(projection).join('\n')}
`);
}

function renderReloadedGuidance(_projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes plugin reloaded.
Fact: children intentionally disconnected; worktrees and conversations preserved. Next: inspect compact \`pardes_status\`; revive selectively.
${communicationLine}
${safetyLine}
${durableAttentionLine}
`);
}

function renderCompactedGuidance(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes manager compacted.
Fact: persisted state authoritative. Next: inspect compact \`pardes_status\` before lifecycle actions; keep open-review owners attached for feedback. Use \`pardes_status(view="cleanup")\` only for explicit resolved artifact guidance.
${communicationLine}
${safetyLine}
${durableAttentionLine}
${operationalSnapshotLines(projection).join('\n')}
`);
}

const renderers: Readonly<
  Record<ManagerGuidanceReason, (projection: ManagerGuidanceProjection) => ReadonlyArray<string>>
> = {
  activated: renderActivatedGuidance,
  compacted: renderCompactedGuidance,
  reloaded: renderReloadedGuidance,
  restored: renderRestoredGuidance,
};

export function managerGuidanceReasonForSessionStart(
  reason: SessionStartEvent['reason'],
): Extract<ManagerGuidanceReason, 'restored' | 'reloaded'> {
  return reason === 'reload' ? 'reloaded' : 'restored';
}

/** Render one lifecycle-specific, hard-bounded reminder from durable state and ephemeral runtimes. */
export function renderManagerGuidance(
  state: ManagerState | undefined,
  reason: ManagerGuidanceReason,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
): string | undefined {
  if (!state) return undefined;
  return boundManagerGuidance(
    renderers[reason](projectManagerGuidance(state, runtimes)),
    MANAGER_GUIDANCE_BOUNDS[reason],
  );
}

export function queueManagerGuidance(
  pi: Pick<ExtensionAPI, 'sendMessage'>,
  state: ManagerState | undefined,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
  reason: ManagerGuidanceReason,
): boolean {
  const content = renderManagerGuidance(state, reason, runtimes);
  if (!content) return false;
  pi.sendMessage(
    { content, customType: MANAGER_GUIDANCE_MESSAGE_TYPE, details: { reason }, display: true },
    { deliverAs: 'nextTurn' },
  );
  return true;
}
