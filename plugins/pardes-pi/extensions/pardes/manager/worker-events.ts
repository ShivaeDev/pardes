import type { WorktreeInspection } from '../git/index.ts';
import type { AgentReportReference } from '../reporting/index.ts';
import type { WorkerSupervisorEvent } from '../worker-runtime/index.ts';
import type { AgentGitAudit, AgentGitAuditTrigger, AgentRecord, ManagerEvent } from './domain.ts';
import { formatPardesError } from './errors.ts';

const MODEL_FACING_EVENT_TEXT_LIMIT = 240;
const BOUNDED_EVENT_SUMMARY_LIMIT = 900;

export type ReportArtifactPersistence =
  | {
      readonly status: 'persisted';
      readonly reportId: string;
      readonly reference?: AgentReportReference;
    }
  | { readonly status: 'failed'; readonly failureSummary: string };

export type HandoffAuditOutcome =
  | {
      readonly status: 'succeeded';
      readonly gitAudit: Extract<AgentGitAudit, { readonly status: 'succeeded' }>;
      readonly changedPaths: ReadonlyArray<string>;
    }
  | {
      readonly status: 'failed';
      readonly gitAudit: Extract<AgentGitAudit, { readonly status: 'failed' }>;
    };

export interface WorkerEventSummary {
  readonly type: string;
  readonly summary: string;
  readonly actionable: boolean;
  readonly reportPreviewTruncated?: boolean;
}

function normalizeModelFacingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function isModelFacingTextTruncated(text: string): boolean {
  return normalizeModelFacingText(text).length > MODEL_FACING_EVENT_TEXT_LIMIT;
}

export function truncateModelFacingText(text: string): string {
  const normalized = normalizeModelFacingText(text);
  return normalized.length <= MODEL_FACING_EVENT_TEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, MODEL_FACING_EVENT_TEXT_LIMIT - 1)}…`;
}

export function boundedFailureSummary(error: unknown): string {
  return truncateModelFacingText(formatPardesError(error));
}

export function boundedEventSummary(parts: ReadonlyArray<string>): string {
  const summary = normalizeModelFacingText(parts.filter(Boolean).join(' '));
  return summary.length <= BOUNDED_EVENT_SUMMARY_LIMIT
    ? summary
    : `${summary.slice(0, BOUNDED_EVENT_SUMMARY_LIMIT - 1)}…`;
}

export function successfulHandoffAudit(
  trigger: AgentGitAuditTrigger,
  checkedAt: string,
  inspection: WorktreeInspection,
): HandoffAuditOutcome {
  return {
    changedPaths: inspection.changedPaths,
    gitAudit: { checkedAt, dirty: inspection.dirty, status: 'succeeded', trigger },
    status: 'succeeded',
  };
}

export function failedHandoffAudit(
  trigger: AgentGitAuditTrigger,
  checkedAt: string,
  error: unknown,
): HandoffAuditOutcome {
  return {
    gitAudit: {
      checkedAt,
      failureSummary: boundedFailureSummary(error),
      status: 'failed',
      trigger,
    },
    status: 'failed',
  };
}

export function applyHandoffAudit(
  agent: AgentRecord,
  audit: HandoffAuditOutcome | undefined,
): AgentRecord {
  if (!audit) return agent;
  if (audit.status === 'succeeded') {
    return {
      ...agent,
      changedPaths: audit.changedPaths,
      gitAudit: audit.gitAudit,
      updatedAt: audit.gitAudit.checkedAt,
    };
  }
  const { changedPaths: _changedPaths, ...withoutStalePaths } = agent;
  return { ...withoutStalePaths, gitAudit: audit.gitAudit, updatedAt: audit.gitAudit.checkedAt };
}

export function handoffAuditSuffix(audit: HandoffAuditOutcome | undefined): string {
  if (!audit) return '';
  if (audit.status === 'failed') return `Git audit failed: ${audit.gitAudit.failureSummary}.`;
  const count = audit.changedPaths.length;
  return `Git audit: ${count} changed path${count === 1 ? '' : 's'}.${audit.gitAudit.dirty ? ' Worktree is dirty.' : ''}`;
}

export function reportPersistenceSuffix(
  persistence: ReportArtifactPersistence | undefined,
): string {
  if (!persistence || persistence.status === 'persisted') return '';
  return `Report artifact persistence failed: ${persistence.failureSummary.replace(/\.+$/, '')}.`;
}

export function workerEventSummary(
  event: WorkerSupervisorEvent,
  reportPersistence?: ReportArtifactPersistence,
  audit?: HandoffAuditOutcome,
  options?: { readonly suppressIdleWakeup?: boolean },
): WorkerEventSummary | undefined {
  if (event.type === 'report') {
    const type =
      audit?.status === 'failed'
        ? 'agent_git_audit_failed'
        : reportPersistence?.status === 'failed'
          ? 'agent_report_persist_failed'
          : `agent_report_${event.status}`;
    return {
      actionable:
        event.status !== 'progress' ||
        reportPersistence?.status === 'failed' ||
        audit?.status === 'failed',
      summary: boundedEventSummary([
        `${event.agentId}: ${truncateModelFacingText(event.summary)}`,
        reportPersistenceSuffix(reportPersistence),
        handoffAuditSuffix(audit),
      ]),
      type,
      ...(reportPersistence?.status === 'persisted'
        ? { reportPreviewTruncated: isModelFacingTextTruncated(event.summary) }
        : {}),
    };
  }
  if (event.type === 'question')
    return {
      actionable: true,
      summary: `${event.agentId} asks: ${truncateModelFacingText(event.question)}`,
      type: 'agent_question',
    };
  if (event.type === 'unexpected_exit')
    return {
      actionable: true,
      summary: `${event.agentId} exited unexpectedly.`,
      type: 'agent_crashed',
    };
  if (event.type === 'protocol_error')
    return {
      actionable: true,
      summary: `${event.agentId} emitted invalid RPC JSON: ${truncateModelFacingText(event.message)}`,
      type: 'agent_protocol_error',
    };
  if (event.type === 'status' && event.status === 'idle') {
    if (options?.suppressIdleWakeup) return undefined;
    return {
      actionable: true,
      summary: `${event.agentId} is idle and ready for follow-up.`,
      type: 'agent_idle',
    };
  }
  return undefined;
}

export function hasPendingAgentAttention(
  inbox: ReadonlyArray<ManagerEvent>,
  candidate: Pick<ManagerEvent, 'type' | 'agentId'>,
): boolean {
  return inbox.some(
    (event) => event.type === candidate.type && event.agentId === candidate.agentId,
  );
}

export function isDuplicateWorkerAttention(
  inbox: ReadonlyArray<ManagerEvent>,
  workerEvent: WorkerSupervisorEvent,
  event: WorkerEventSummary | undefined,
  reportPersistence: ReportArtifactPersistence | undefined,
): boolean {
  const dedupePendingProgressReportFailure =
    workerEvent.type === 'report' &&
    workerEvent.status === 'progress' &&
    reportPersistence?.status === 'failed' &&
    hasPendingAgentAttention(inbox, {
      agentId: workerEvent.agentId,
      type: 'agent_report_persist_failed',
    });
  const dedupePendingGitAuditFailure =
    event?.type === 'agent_git_audit_failed' &&
    hasPendingAgentAttention(inbox, { agentId: workerEvent.agentId, type: event.type });
  return dedupePendingProgressReportFailure || dedupePendingGitAuditFailure;
}
