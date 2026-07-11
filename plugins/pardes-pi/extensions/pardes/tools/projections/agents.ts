import type {
  AgentLeaseCleanupProjection,
  AgentRecord,
  AgentStatus,
  ManagerState,
} from '../../manager/index.ts';
import { projectIdleWorkerDisposition } from '../../manager/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../../worker-runtime/index.ts';
import {
  boundedRows,
  CONTROL_PLANE_MAX_ROWS,
  completeOrOmittedText,
  elapsed,
  plural,
  structuralRows,
  structuralValue,
} from './core.ts';

const AUDIT_PATH_PREVIEW_ITEMS = 4;
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
      const title = agent.title ? ` “${completeOrOmittedText(agent.title, 80)}”` : '';
      const warnings = agentWarnings(agent, runtime);
      const status = effectiveAgentStatus(agent, runtime);
      const disposition = projectIdleWorkerDisposition(state, agent, runtime);
      return `${structuralValue(agent.id)} [${status}]${disposition ? ` [disposition:${disposition}]` : ''} ${structuralValue(agent.workstreamId)}${title} · ${runtimeHints(runtime)}${warnings.length ? ` · ⚠ ${warnings.join(',')}` : ''}`;
    }),
  ];
  return boundedRows(lines, maxRows);
}

function latestReportLines(agent: AgentRecord): ReadonlyArray<string> {
  const report = agent.latestReport;
  if (!report) return [];
  return [
    `latest report: reportId:${structuralValue(report.reportId)} [${report.status}] · previewTruncated:${report.summaryTruncated}`,
    `retrieve: report_get({ reportId: ${JSON.stringify(report.reportId)} })`,
  ];
}

function latestGitAuditLine(agent: AgentRecord): string {
  const audit = agent.gitAudit;
  if (!audit) return 'latest git audit: none';
  if (audit.status === 'failed')
    return `latest git audit: failed · ${audit.trigger} · ${completeOrOmittedText(audit.failureSummary, 120)}`;
  return `latest git audit: succeeded · ${audit.trigger} · ${audit.dirty ? 'dirty worktree' : 'clean worktree'}`;
}

export function agentLeaseCleanupLines(projection: AgentLeaseCleanupProjection): string {
  const mutation =
    projection.action === 'cleanup'
      ? `outcome: worktree ${projection.worktreeOutcome} · branch ${projection.branchOutcome}`
      : 'outcome: inspection only · no artifacts mutated';
  return structuralRows(
    {
      authoredLines: [
        `${structuralValue(projection.agentId)} retained lease ${projection.action}: worktree ${projection.worktree} · branch ${projection.branch} · ${plural(projection.changedPathCount, 'changed path')}`,
        mutation,
        `session: ${projection.session} · revival: ${projection.revival}`,
      ],
    },
    3,
  );
}

export function stopAuditWarning(agent: AgentRecord): string {
  const audit = agent.gitAudit;
  if (audit?.trigger !== 'stop') return '';
  if (audit.status === 'failed')
    return ` Warning: Git audit failed: ${completeOrOmittedText(audit.failureSummary, 120)}.`;
  return audit.dirty ? ' Warning: Git audit found a dirty worktree.' : '';
}

function conciseAgentHeader(status: AgentStatus): string {
  const agent = status.agent;
  const effectiveStatus = status.runtime?.status ?? agent.status;
  const title = agent.title ? ` “${completeOrOmittedText(agent.title, 80)}”` : '';
  return `Worker ${structuralValue(agent.id)}${title} is ${effectiveStatus}. Workstream ${structuralValue(agent.workstreamId)}.`;
}

function auditProvenance(status: AgentStatus) {
  if (status.gitProvenance !== undefined) return status.gitProvenance;
  const audit = status.agent.gitAudit;
  return audit?.status === 'succeeded' ? audit.provenance : undefined;
}

function auditPathProjection(status: AgentStatus): {
  readonly label: string;
  readonly paths: ReadonlyArray<string>;
} {
  const provenance = auditProvenance(status);
  if (provenance?.status === 'available')
    return {
      label: 'worker-branch non-merge candidate paths',
      paths: provenance.firstParentNonMergePaths,
    };
  if (provenance?.status === 'unavailable' && provenance.reason === 'dirty_worktree')
    return { label: 'dirty paths', paths: provenance.dirtyPaths };
  return { label: 'total audited changed paths', paths: status.agent.changedPaths ?? [] };
}

function auditProvenanceLines(status: AgentStatus): ReadonlyArray<string> {
  const provenance = auditProvenance(status);
  if (provenance === undefined)
    return [
      'worker-branch non-merge candidate provenance: unavailable · reason:not_captured_or_unsupported_adapter',
    ];
  if (provenance.status === 'unavailable')
    return [
      `worker-branch non-merge candidate provenance: unavailable · reason:${provenance.reason}${provenance.observedBranch === undefined ? '' : ` · observed branch:${structuralValue(provenance.observedBranch)}`} · bounds:first ${provenance.bounds.maxFirstParentCommits} first-parent commits/${provenance.bounds.maxPaths} paths/category`,
      'merge context: unavailable · exact conflict-resolution ownership is never inferred from parent diffs',
    ];
  const latest = provenance.latestDelta;
  return [
    `worker-branch non-merge change candidates: ${plural(provenance.firstParentNonMergeCommitCount, 'commit')} · ${plural(provenance.firstParentNonMergePaths.length, 'path')} · cooperative first-parent evidence`,
    `merge context: ${plural(provenance.mergeCommitCount, 'merge commit')} · ${plural(provenance.mergePaths.length, 'first-parent-diff path')} · exact conflict-resolution ownership not inferred`,
    `total branch-point delta: ${plural(provenance.totalBranchCommitCount, 'first-parent commit')} · ${plural(provenance.totalBranchDeltaPaths.length, 'path')} · ${structuralValue(provenance.branchPointSha)}..${structuralValue(provenance.headSha)}`,
    latest === undefined
      ? 'latest delta: none · branch still at immutable baseline'
      : `latest delta: ${latest.kind} commit:${structuralValue(latest.commitSha)} · ${plural(latest.changedPaths.length, 'path')}`,
  ];
}

export function auditAgentStatus(status: AgentStatus): string {
  const { agent, runtime } = status;
  const reportLines = latestReportLines(agent);
  const pathProjection = auditPathProjection(status);
  return structuralRows(
    {
      authoredLines: [
        conciseAgentHeader(status),
        ...(reportLines[0] === undefined ? [] : [reportLines[0]]),
        latestGitAuditLine(agent),
        ...auditProvenanceLines(status),
        `${pathProjection.label}: ${plural(pathProjection.paths.length, 'path')} · complete first-N rows follow · omitted:see suffix row if present; otherwise 0`,
        `last error: ${agent.lastError ? completeOrOmittedText(agent.lastError, 140) : 'none'} · worktree branch:${agent.worktree ? structuralValue(agent.worktree.branch) : 'none'} · runtime:${runtime ? 'attached' : 'detached'}`,
      ],
      itemLines: pathProjection.paths.map((path) => `↳ ${structuralValue(path)}`),
      maxItems: AUDIT_PATH_PREVIEW_ITEMS,
      omissionLine: (omitted) =>
        `… +${omitted} more ${pathProjection.label} omitted from this bounded audit projection`,
      retrievalHintLines: reportLines[1] === undefined ? [] : [reportLines[1]],
    },
    CONTROL_PLANE_MAX_ROWS,
  );
}

export function runtimeAgentStatus(status: AgentStatus): string {
  const { agent, runtime } = status;
  if (!runtime)
    return structuralRows({
      authoredLines: [`${structuralValue(agent.id)} [${agent.status}]`, 'runtime: detached'],
    });
  const stats = runtime.stats;
  return structuralRows(
    {
      authoredLines: [
        `${structuralValue(agent.id)} [${effectiveAgentStatus(agent, runtime)}] · ${runtimeHints(runtime)}`,
        `process: pid ${runtime.pid ?? 'unknown'} · model ${completeOrOmittedText(runtime.model, 256)} · thinking ${runtime.thinkingLevel}`,
        `usage: ${stats ? `${stats.tokens.total} tokens · ${stats.toolCalls} tool calls · $${stats.cost.toFixed(3)}` : 'unavailable'}`,
        `queues: pending ${runtime.pendingMessageCount ?? 0} · steer ${runtime.steeringQueueCount ?? 0} (${runtime.steeringMode ?? 'unknown'}) · follow-up ${runtime.followUpQueueCount ?? 0} (${runtime.followUpMode ?? 'unknown'})`,
        `compaction: ${runtime.isCompacting ? `active (${runtime.compactionReason ?? 'unknown'})` : 'inactive'} · auto ${runtime.autoCompactionEnabled === undefined ? 'unknown' : runtime.autoCompactionEnabled ? 'on' : 'off'} · completed ${runtime.completedCompactionCount}`,
        ...(runtime.recentActivityLines?.length
          ? [`recent: ${runtime.recentActivityLines.slice(-2).join(' | ')}`]
          : []),
      ],
    },
    CONTROL_PLANE_MAX_ROWS,
  );
}

export function conciseAgentStatus(status: AgentStatus): string {
  const reportLines = latestReportLines(status.agent);
  return structuralRows(
    {
      authoredLines: [
        conciseAgentHeader(status),
        ...(reportLines[0] === undefined ? [] : [reportLines[0]]),
      ],
      retrievalHintLines: reportLines[1] === undefined ? [] : [reportLines[1]],
    },
    4,
  );
}
