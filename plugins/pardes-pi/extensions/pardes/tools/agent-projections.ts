import type {
  AgentLeaseCleanupProjection,
  AgentRecord,
  AgentStatus,
  ManagerState,
} from '../manager/index.ts';
import { projectIdleWorkerDisposition } from '../manager/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import {
  boundedRows,
  CONTROL_PLANE_MAX_ROWS,
  compactText,
  elapsed,
  plural,
} from './projections.ts';

const COLLECTION_PREVIEW_ITEMS = 4;
const ATTACHED_AGENT_STATUSES = new Set<WorkerStatus>(['starting', 'running', 'idle']);

type AgentFilter = 'active' | 'warnings' | 'all';

export function effectiveAgentStatus(
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
): WorkerStatus {
  return runtime?.status ?? agent.status;
}

export function agentWarnings(
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
): ReadonlyArray<string> {
  const warnings: string[] = [];
  if (agent.lastError) warnings.push('error');
  if (effectiveAgentStatus(agent, runtime) === 'crashed') warnings.push('crashed');
  if (agent.gitAudit?.status === 'failed') warnings.push('git audit failed');
  if (agent.gitAudit?.status === 'succeeded' && agent.gitAudit.dirty)
    warnings.push('dirty worktree');
  return warnings;
}

function runtimeHints(runtime: WorkerRuntimeSnapshot | undefined): string {
  if (!runtime) return 'runtime:detached';
  const hints: string[] = [];
  const percent = runtime.stats?.contextUsage?.percent;
  if (percent !== null && percent !== undefined) hints.push(`ctx:${Math.round(percent)}%`);
  if (runtime.totalActiveMs !== undefined) hints.push(`active:${elapsed(runtime.totalActiveMs)}`);
  if (runtime.currentAskElapsedMs !== undefined)
    hints.push(`ask:${elapsed(runtime.currentAskElapsedMs)}`);
  if (runtime.isStreaming) hints.push('streaming');
  if (runtime.isCompacting) hints.push('compacting');
  const queued =
    runtime.pendingMessageCount ??
    (runtime.steeringQueueCount ?? 0) + (runtime.followUpQueueCount ?? 0);
  if (queued > 0) hints.push(`queued:${queued}`);
  return hints.length > 0 ? hints.join(' · ') : 'runtime:live';
}

function collectionPreview(label: string, items: ReadonlyArray<string> | undefined): string {
  if (!items?.length) return `${label}: none`;
  const visible = items
    .slice(0, COLLECTION_PREVIEW_ITEMS)
    .map((item) => compactText(item, 42))
    .join(', ');
  return `${label} (${items.length}): ${visible}${items.length > COLLECTION_PREVIEW_ITEMS ? `, … +${items.length - COLLECTION_PREVIEW_ITEMS}` : ''}`;
}

export function agentLines(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  filter: AgentFilter,
  maxRows?: number,
): string {
  const agents = Object.values(state.agents);
  const matching = agents.filter((agent) => {
    const runtime = runtimes.get(agent.id);
    if (filter === 'all') return true;
    if (filter === 'warnings') return agentWarnings(agent, runtime).length > 0;
    return ATTACHED_AGENT_STATUSES.has(effectiveAgentStatus(agent, runtime));
  });
  const warningCount = agents.filter(
    (agent) => agentWarnings(agent, runtimes.get(agent.id)).length > 0,
  ).length;
  const lines = [
    `workers: ${matching.length} ${filter} · ${agents.length} total · ${plural(warningCount, 'warning')}`,
    ...matching.map((agent) => {
      const runtime = runtimes.get(agent.id);
      const title = agent.title ? ` “${agent.title}”` : '';
      const warnings = agentWarnings(agent, runtime);
      const status = effectiveAgentStatus(agent, runtime);
      const disposition = projectIdleWorkerDisposition(state, agent, runtime);
      return `${agent.id} [${status}]${disposition ? ` [disposition:${disposition}]` : ''} ${agent.workstreamId}${title} · ${runtimeHints(runtime)}${warnings.length ? ` · ⚠ ${warnings.join(',')}` : ''}`;
    }),
  ];
  return boundedRows(lines, maxRows);
}

function latestReportLines(agent: AgentRecord): ReadonlyArray<string> {
  const report = agent.latestReport;
  if (!report) return [];
  return [
    `latest report: reportId:${report.reportId} [${report.status}] · previewTruncated:${report.summaryTruncated}`,
    `retrieve: report_get({ reportId: ${JSON.stringify(report.reportId)} })`,
  ];
}

function latestGitAuditLine(agent: AgentRecord): string {
  const audit = agent.gitAudit;
  if (!audit) return 'latest git audit: none';
  if (audit.status === 'failed')
    return `latest git audit: failed · ${audit.trigger} · ${compactText(audit.failureSummary, 120)}`;
  return `latest git audit: succeeded · ${audit.trigger} · ${audit.dirty ? 'dirty worktree' : 'clean worktree'}`;
}

export function agentLeaseCleanupLines(projection: AgentLeaseCleanupProjection): string {
  const mutation =
    projection.action === 'cleanup'
      ? `outcome: worktree ${projection.worktreeOutcome} · branch ${projection.branchOutcome}`
      : 'outcome: inspection only · no artifacts mutated';
  return boundedRows(
    [
      `${projection.agentId} retained lease ${projection.action}: worktree ${projection.worktree} · branch ${projection.branch} · ${plural(projection.changedPathCount, 'changed path')}`,
      mutation,
      `session: ${projection.session} · revival: ${projection.revival}`,
    ],
    3,
  );
}

export function stopAuditWarning(agent: AgentRecord): string {
  const audit = agent.gitAudit;
  if (audit?.trigger !== 'stop') return '';
  if (audit.status === 'failed')
    return ` Warning: Git audit failed: ${compactText(audit.failureSummary, 120)}.`;
  return audit.dirty ? ' Warning: Git audit found a dirty worktree.' : '';
}

function conciseAgentHeader(status: AgentStatus): string {
  const agent = status.agent;
  const effectiveStatus = status.runtime?.status ?? agent.status;
  const title = agent.title ? ` “${agent.title}”` : '';
  return `Worker ${agent.id}${title} is ${effectiveStatus}. Workstream ${agent.workstreamId}.`;
}

export function auditAgentStatus(status: AgentStatus): string {
  const { agent, runtime } = status;
  return boundedRows(
    [
      conciseAgentHeader(status),
      ...latestReportLines(agent),
      latestGitAuditLine(agent),
      collectionPreview('changed paths', agent.changedPaths),
      `last error: ${agent.lastError ? compactText(agent.lastError, 140) : 'none'}`,
      `worktree: ${agent.worktree ? compactText(agent.worktree.branch, 120) : 'none'} · runtime:${runtime ? 'attached' : 'detached'}`,
    ],
    CONTROL_PLANE_MAX_ROWS,
  );
}

export function runtimeAgentStatus(status: AgentStatus): string {
  const { agent, runtime } = status;
  if (!runtime) return boundedRows([`${agent.id} [${agent.status}]`, 'runtime: detached']);
  const stats = runtime.stats;
  return boundedRows(
    [
      `${agent.id} [${effectiveAgentStatus(agent, runtime)}] · ${runtimeHints(runtime)}`,
      `process: pid ${runtime.pid ?? 'unknown'} · model ${runtime.model} · thinking ${runtime.thinkingLevel}`,
      `usage: ${stats ? `${stats.tokens.total} tokens · ${stats.toolCalls} tool calls · $${stats.cost.toFixed(3)}` : 'unavailable'}`,
      `queues: pending ${runtime.pendingMessageCount ?? 0} · steer ${runtime.steeringQueueCount ?? 0} (${runtime.steeringMode ?? 'unknown'}) · follow-up ${runtime.followUpQueueCount ?? 0} (${runtime.followUpMode ?? 'unknown'})`,
      `compaction: ${runtime.isCompacting ? `active (${runtime.compactionReason ?? 'unknown'})` : 'inactive'} · auto ${runtime.autoCompactionEnabled === undefined ? 'unknown' : runtime.autoCompactionEnabled ? 'on' : 'off'} · completed ${runtime.completedCompactionCount}`,
      ...(runtime.recentActivityLines?.length
        ? [`recent: ${runtime.recentActivityLines.slice(-2).join(' | ')}`]
        : []),
    ],
    CONTROL_PLANE_MAX_ROWS,
  );
}

export function conciseAgentStatus(status: AgentStatus): string {
  return boundedRows([conciseAgentHeader(status), ...latestReportLines(status.agent)], 4);
}
