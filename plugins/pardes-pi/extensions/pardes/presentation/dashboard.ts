import type {
  AgentRecord,
  ManagerState,
  PullRequestRecord,
  WorkstreamStatus,
} from '../manager/index.ts';
import { projectIdleWorkerDisposition, projectInboxAttention } from '../manager/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import { managerContextSummary } from './manager-context.ts';
import { type DashboardPalette, PLAIN_DASHBOARD_PALETTE } from './palette.ts';
import {
  ATTACHED_AGENT_STATUSES,
  agentLabel,
  agentStatus,
  optionalNumber,
  optionalTimestamp,
} from './worker-projections.ts';

const MAX_COMPACT_WORKSTREAMS = 3;
const DASHBOARD_SEPARATOR = '─'.repeat(64);
const CONTEXT_BAR_WIDTH = 10;

function summarize(state: ManagerState): {
  readonly workstreams: number;
  readonly agents: number;
  readonly prs: number;
} {
  return {
    agents: Object.keys(state.agents).length,
    prs: Object.keys(state.pullRequests).length,
    workstreams: Object.keys(state.workstreams).length,
  };
}

function compactNumber(value: number): string {
  return Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: 'compact' }).format(value);
}

function elapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function preview(text: string, limit = 110): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function agentTiming(
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
  now: number,
): string {
  const totalActiveMs =
    optionalNumber(runtime, 'totalActiveMs') ?? optionalNumber(agent, 'totalActiveMs');
  if (totalActiveMs !== undefined) {
    const currentAskElapsedMs =
      optionalNumber(runtime, 'currentAskElapsedMs') ??
      optionalNumber(agent, 'currentAskElapsedMs');
    return `${currentAskElapsedMs === undefined ? '' : `ask ${elapsed(currentAskElapsedMs)} · `}active ${elapsed(totalActiveMs)}`;
  }
  const explicitDuration =
    optionalNumber(runtime, 'elapsedMs') ??
    optionalNumber(runtime, 'durationMs') ??
    optionalNumber(agent, 'elapsedMs') ??
    optionalNumber(agent, 'durationMs');
  if (explicitDuration !== undefined) return elapsed(explicitDuration);
  const startedAt =
    optionalTimestamp(runtime, 'startedAt') ??
    optionalTimestamp(agent, 'startedAt') ??
    optionalTimestamp(agent, 'createdAt') ??
    now;
  return elapsed(now - startedAt);
}

function autoCompactionDisabled(runtime: WorkerRuntimeSnapshot | undefined): boolean {
  return runtime?.autoCompactionEnabled === false && ATTACHED_AGENT_STATUSES.has(runtime.status);
}

function hasAgentWarning(agent: AgentRecord, runtime: WorkerRuntimeSnapshot | undefined): boolean {
  return Boolean(
    agent.lastError ||
      agentStatus(agent, runtime) === 'crashed' ||
      autoCompactionDisabled(runtime) ||
      agent.gitAudit?.status === 'failed' ||
      (agent.gitAudit?.status === 'succeeded' && agent.gitAudit.dirty),
  );
}

function statusSummary(
  agents: ReadonlyArray<AgentRecord>,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): {
  readonly running: number;
  readonly idle: number;
  readonly starting: number;
  readonly crashed: number;
  readonly warnings: number;
} {
  let running = 0;
  let idle = 0;
  let starting = 0;
  let crashed = 0;
  let warnings = 0;
  for (const agent of agents) {
    const runtime = runtimes.get(agent.id);
    const status = agentStatus(agent, runtime);
    if (status === 'running') running += 1;
    else if (status === 'idle') idle += 1;
    else if (status === 'starting') starting += 1;
    else if (status === 'crashed') crashed += 1;
    if (hasAgentWarning(agent, runtime)) warnings += 1;
  }
  return { crashed, idle, running, starting, warnings };
}

function contextProgressBar(percent: number | null | undefined): string {
  const normalized =
    percent === null || percent === undefined || !Number.isFinite(percent)
      ? 0
      : Math.min(100, Math.max(0, percent));
  const filled = Math.round((normalized / 100) * CONTEXT_BAR_WIDTH);
  return `[${'█'.repeat(filled)}${'░'.repeat(CONTEXT_BAR_WIDTH - filled)}]`;
}

function inboxSummary(state: ManagerState, now: number): string {
  const delivery = projectInboxAttention(state.inbox, state.inboxWake, state.inboxHandoff, now);
  if (delivery.deliveredCursor === undefined) return `inbox ${state.inbox.length}`;
  return `inbox ${state.inbox.length} · delivered age:${delivery.deliveredCursorAgeMs === undefined ? 'unknown' : elapsed(delivery.deliveredCursorAgeMs)} · suffix:${delivery.queuedSuffixCount}`;
}

function contextSummary(runtime: WorkerRuntimeSnapshot | undefined, separator = ' · '): string {
  const stats = runtime?.stats;
  const usage = stats?.contextUsage;
  const context = !usage
    ? `${contextProgressBar(undefined)} ctx …`
    : usage.percent === null || usage.tokens === null
      ? `${contextProgressBar(undefined)} ctx recalibrating`
      : `${contextProgressBar(usage.percent)} ctx ${Math.round(usage.percent)}% ${compactNumber(usage.tokens)}/${compactNumber(usage.contextWindow)}`;
  const tokens = stats ? `tok ${compactNumber(stats.tokens.total)}` : 'tok …';
  const cost = stats ? `$${stats.cost.toFixed(3)}` : '$…';
  return `${context}${separator}${tokens}${separator}${cost}`;
}

function runtimeSignals(runtime: WorkerRuntimeSnapshot | undefined, separator = ' · '): string {
  if (!runtime || !ATTACHED_AGENT_STATUSES.has(runtime.status)) return '';
  const queued =
    runtime.pendingMessageCount ??
    (runtime.steeringQueueCount ?? 0) + (runtime.followUpQueueCount ?? 0);
  const signals: string[] = [];
  if (queued > 0) signals.push(`queued:${queued}`);
  if (runtime.isCompacting)
    signals.push(
      runtime.compactionReason ? `compacting:${runtime.compactionReason}` : 'compacting',
    );
  return signals.length > 0 ? `${separator}${signals.join(separator)}` : '';
}

function statusLabel(status: WorkerStatus, palette: DashboardPalette): string {
  if (status === 'running') return palette.success('● running');
  if (status === 'idle') return palette.muted('○ idle');
  if (status === 'starting') return palette.warning('◐ starting');
  if (status === 'crashed') return palette.error('⚠ crashed');
  return palette.dim('■ stopped');
}

function workstreamStatus(status: WorkstreamStatus, palette: DashboardPalette): string {
  if (status === 'active') return palette.success(`[${status}]`);
  if (status === 'complete') return palette.muted(`[${status}]`);
  if (status === 'cancelled') return palette.warning(`[${status}]`);
  return palette.dim(`[${status}]`);
}

function pullRequestLine(pullRequest: PullRequestRecord, palette: DashboardPalette): string {
  const identifier = pullRequest.number === undefined ? pullRequest.id : `#${pullRequest.number}`;
  const state = pullRequest.draft === true ? 'draft' : pullRequest.status;
  const title = pullRequest.title ? ` ${preview(pullRequest.title, 60)}` : '';
  return `    ${palette.accent(`↗ PR ${identifier}`)} ${palette.muted(`[${state}]`)}${title} · ${palette.dim(pullRequest.url)}`;
}

function warningLabel(
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
  palette: DashboardPalette,
  separator = ' · ',
): string {
  const warnings: string[] = [];
  if (agent.lastError) warnings.push('error');
  if (autoCompactionDisabled(runtime)) warnings.push('auto-compact off');
  if (agent.gitAudit?.status === 'failed') warnings.push('git audit failed');
  if (agent.gitAudit?.status === 'succeeded' && agent.gitAudit.dirty)
    warnings.push('dirty worktree');
  return warnings.length > 0 ? `${separator}${palette.warning(`⚠ ${warnings.join(',')}`)}` : '';
}

function idleDispositionSuffix(
  state: ManagerState,
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
  palette: DashboardPalette,
  separator = ' · ',
): string {
  const disposition = projectIdleWorkerDisposition(state, agent, runtime);
  if (disposition === 'needs_attention') return `${separator}${palette.warning('needs attention')}`;
  if (disposition === 'review_gate_open') return `${separator}${palette.accent('review gate')}`;
  if (
    disposition === 'verification_retirement_pending' ||
    disposition === 'merged_retirement_pending'
  )
    return `${separator}${palette.warning('retire pending')}`;
  return disposition === 'idle_unclassified' ? `${separator}${palette.dim('unclassified')}` : '';
}

function agentLines(
  state: ManagerState,
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
  now: number,
  palette: DashboardPalette,
): string[] {
  const model = (runtime?.model ?? agent.model).split('/').at(-1) ?? agent.model;
  return [
    `    ${statusLabel(agentStatus(agent, runtime), palette)} ${palette.accent(agentLabel(agent, runtime))} · ${palette.dim(`${agentTiming(agent, runtime, now)} · ${model} · ${contextSummary(runtime)}${runtimeSignals(runtime)}`)}${warningLabel(agent, runtime, palette)}${idleDispositionSuffix(state, agent, runtime, palette)}`,
    `      ${palette.dim('task:')} ${palette.muted(preview(runtime?.task ?? agent.task))}`,
  ];
}

function compactAgentLine(
  state: ManagerState,
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
  now: number,
  palette: DashboardPalette,
): string {
  const separator = ' ';
  const completedCompactions = runtime?.completedCompactionCount;
  const compactionCount =
    completedCompactions !== undefined && completedCompactions > 0
      ? `${separator}cmp:${completedCompactions}`
      : '';
  return `    ${statusLabel(agentStatus(agent, runtime), palette)} ${palette.dim(`${contextSummary(runtime, separator)}${compactionCount}${runtimeSignals(runtime, separator)}${separator}${agentTiming(agent, runtime, now)}`)}${warningLabel(agent, runtime, palette, separator)}${idleDispositionSuffix(state, agent, runtime, palette, separator)}${separator}${palette.accent(agentLabel(agent, runtime))}`;
}

function visibleWidgetAgents(
  agents: ReadonlyArray<AgentRecord>,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): AgentRecord[] {
  return agents.filter((agent) => {
    const runtime = runtimes.get(agent.id);
    return (
      ATTACHED_AGENT_STATUSES.has(agentStatus(agent, runtime)) || hasAgentWarning(agent, runtime)
    );
  });
}

export function renderCompactWidgetLines(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  now: number,
  palette: DashboardPalette,
  managerContext = managerContextSummary(undefined),
): string[] {
  const counts = summarize(state);
  const agents = Object.values(state.agents);
  const statuses = statusSummary(agents, runtimes);
  const lines = [
    palette.accent(`pardes ${state.managerId.slice(0, 8)}`) +
      palette.dim(
        ` · ${managerContext} · ${statuses.running} running · ${statuses.idle} idle${statuses.warnings > 0 ? ` · ${statuses.warnings} warning${statuses.warnings === 1 ? '' : 's'}` : ''} · ${inboxSummary(state, now)}`,
      ),
    palette.separator(DASHBOARD_SEPARATOR),
  ];
  const visibleAgents = visibleWidgetAgents(agents, runtimes);
  const workstreams = Object.values(state.workstreams);
  const pullRequests = Object.values(state.pullRequests).filter(
    (pullRequest) => pullRequest.status === 'open',
  );
  const prioritizedWorkstreams = [
    ...workstreams.filter((workstream) => workstream.status === 'active'),
    ...workstreams.filter((workstream) => workstream.status !== 'active'),
  ];
  const selectedIds = new Set(
    [
      ...visibleAgents.map((agent) => agent.workstreamId),
      ...pullRequests.map((pullRequest) => pullRequest.workstreamId),
    ].filter((workstreamId) => workstreamId in state.workstreams),
  );
  for (const workstream of prioritizedWorkstreams) {
    if (workstream.status !== 'active') continue;
    if (selectedIds.size >= MAX_COMPACT_WORKSTREAMS) break;
    selectedIds.add(workstream.id);
  }
  const selectedWorkstreams = prioritizedWorkstreams.filter((workstream) =>
    selectedIds.has(workstream.id),
  );
  for (const workstream of selectedWorkstreams) {
    lines.push(
      `  ${palette.accent(workstream.id)} ${workstreamStatus(workstream.status, palette)} ${workstream.title}`,
    );
    for (const agent of visibleAgents.filter(
      (candidate) => candidate.workstreamId === workstream.id,
    )) {
      lines.push(compactAgentLine(state, agent, runtimes.get(agent.id), now, palette));
    }
    for (const pullRequest of pullRequests.filter(
      (candidate) => candidate.workstreamId === workstream.id,
    )) {
      lines.push(pullRequestLine(pullRequest, palette));
    }
  }
  const unassignedAgents = visibleAgents.filter(
    (agent) => !(agent.workstreamId in state.workstreams),
  );
  if (unassignedAgents.length > 0) {
    lines.push(palette.warning('  ⚠ unassigned workstream'));
    for (const agent of unassignedAgents)
      lines.push(compactAgentLine(state, agent, runtimes.get(agent.id), now, palette));
  }
  const hiddenWorkstreams = workstreams.filter(
    (workstream) => !selectedIds.has(workstream.id) && workstream.status === 'active',
  );
  if (hiddenWorkstreams.length > 0) {
    lines.push(
      palette.dim(
        `  … ${hiddenWorkstreams.length} active workstream${hiddenWorkstreams.length === 1 ? '' : 's'} hidden`,
      ),
    );
  }
  if (counts.workstreams === 0 && unassignedAgents.length === 0)
    lines.push(palette.dim('  no workstreams'));
  return lines;
}

export function compactWidgetLines(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
  now = Date.now(),
): string[] {
  return renderCompactWidgetLines(state, runtimes, now, PLAIN_DASHBOARD_PALETTE);
}

export function dashboardSummary(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): {
  readonly counts: { readonly workstreams: number; readonly agents: number; readonly prs: number };
  readonly statuses: {
    readonly running: number;
    readonly idle: number;
    readonly starting: number;
    readonly crashed: number;
    readonly warnings: number;
  };
} {
  return {
    counts: summarize(state),
    statuses: statusSummary(Object.values(state.agents), runtimes),
  };
}

export function renderDashboardLines(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  now: number,
  palette: DashboardPalette,
): string[] {
  const counts = summarize(state);
  const agents = Object.values(state.agents);
  const statuses = statusSummary(agents, runtimes);
  const statusParts = [`${statuses.running} running`, `${statuses.idle} idle`];
  if (statuses.starting > 0) statusParts.push(`${statuses.starting} starting`);
  if (statuses.crashed > 0) statusParts.push(`${statuses.crashed} crashed`);
  if (statuses.warnings > 0)
    statusParts.push(`${statuses.warnings} warning${statuses.warnings === 1 ? '' : 's'}`);
  const lines = [
    palette.accent(`pardes ${state.managerId.slice(0, 8)}`) +
      palette.dim(
        ` · ${counts.workstreams} workstream${counts.workstreams === 1 ? '' : 's'} · ${counts.agents} agent${counts.agents === 1 ? '' : 's'} (${statusParts.join(' · ')}) · ${counts.prs} PR${counts.prs === 1 ? '' : 's'} · ${inboxSummary(state, now)}`,
      ),
    palette.separator(DASHBOARD_SEPARATOR),
  ];
  const visibleAgents = agents.filter((agent) => {
    const runtime = runtimes.get(agent.id);
    return (
      ATTACHED_AGENT_STATUSES.has(agentStatus(agent, runtime)) || hasAgentWarning(agent, runtime)
    );
  });
  const workstreams = Object.values(state.workstreams);
  for (const workstream of workstreams) {
    lines.push(
      `  ${palette.accent(workstream.id)} ${workstreamStatus(workstream.status, palette)} ${workstream.title}`,
    );
    for (const agent of visibleAgents.filter(
      (candidate) => candidate.workstreamId === workstream.id,
    )) {
      lines.push(...agentLines(state, agent, runtimes.get(agent.id), now, palette));
    }
    for (const pullRequest of Object.values(state.pullRequests).filter(
      (candidate) => candidate.workstreamId === workstream.id,
    )) {
      lines.push(pullRequestLine(pullRequest, palette));
    }
  }
  const unassignedAgents = visibleAgents.filter(
    (agent) => !(agent.workstreamId in state.workstreams),
  );
  if (unassignedAgents.length > 0) {
    lines.push(palette.warning('  ⚠ unassigned workstream'));
    for (const agent of unassignedAgents)
      lines.push(...agentLines(state, agent, runtimes.get(agent.id), now, palette));
  }
  if (workstreams.length === 0 && unassignedAgents.length === 0)
    lines.push(palette.dim('  no workstreams'));
  return lines;
}

export function dashboardLines(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
  now = Date.now(),
): string[] {
  return renderDashboardLines(state, runtimes, now, PLAIN_DASHBOARD_PALETTE);
}
