import type { WorktreeInspection } from '../git/index.ts';
import type { AgentReportReference } from '../reporting/index.ts';
import type { WorkerSupervisorEvent } from '../worker-runtime/index.ts';
import {
  type AgentGitAudit,
  type AgentGitAuditTrigger,
  type AgentRecord,
  currentVerificationTerminalReportStatus,
  MANAGER_EVENT_DETAILS_MAX_CHARS,
  type ManagerEvent,
  type VerificationRecord,
} from './domain.ts';
import { formatPardesError } from './errors.ts';

const MODEL_FACING_EVENT_TEXT_LIMIT = 240;
const BOUNDED_EVENT_SUMMARY_LIMIT = 900;

export type ReportArtifactPersistence =
  | {
      readonly status: 'persisted';
      readonly reportId: string;
      readonly reference?: AgentReportReference;
    }
  | {
      readonly status: 'failed';
      readonly failureSummary: string;
      readonly failureDetails?: string;
    };

export type HandoffAuditOutcome =
  | {
      readonly status: 'succeeded';
      readonly gitAudit: Extract<AgentGitAudit, { readonly status: 'succeeded' }>;
      readonly changedPaths: ReadonlyArray<string>;
    }
  | {
      readonly status: 'failed';
      readonly gitAudit: Extract<AgentGitAudit, { readonly status: 'failed' }>;
      readonly failureDetails: string;
    };

export interface WorkerEventSummary {
  readonly type: string;
  readonly summary: string;
  readonly actionable: boolean;
  /** Lossless non-report prose retrieved only through explicit inbox_get pagination. */
  readonly details?: string;
  readonly reportPreviewTruncated?: boolean;
}

export type VerifierIdleDisposition =
  | 'report_complete'
  | 'handoff_settling'
  | 'stopped_or_crashed'
  | 'attached_idle_without_terminal_report';

/**
 * Classify verifier settlement without a timer. Pi RPC emits finalized tool
 * results before its final idle edge, and the supervisor preserves that FIFO
 * order. The ephemeral marker still names the in-process handoff explicitly.
 */
export function verifierIdleDisposition(
  event: WorkerSupervisorEvent,
  agent: AgentRecord,
  verification: VerificationRecord | undefined,
  terminalReportHandoffSettling = false,
): VerifierIdleDisposition | undefined {
  if (agent.role !== 'verifier' || verification === undefined) return;
  if (
    agent.status === 'stopped' ||
    agent.status === 'crashed' ||
    event.type === 'unexpected_exit' ||
    (event.type === 'status' && (event.status === 'stopped' || event.status === 'crashed'))
  )
    return 'stopped_or_crashed';
  if (event.type !== 'status' || event.status !== 'idle') return;
  if (terminalReportHandoffSettling) return 'handoff_settling';
  if (currentVerificationTerminalReportStatus(verification) !== undefined) return 'report_complete';
  return 'attached_idle_without_terminal_report';
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

/** Preserve accepted prose exactly; replace rejected bulk input with one structural diagnostic. */
export function acceptedDurableEventDetails(details: string, source: string): string {
  return details.length <= MANAGER_EVENT_DETAILS_MAX_CHARS
    ? details
    : `${source} rejected before durable persistence: ${details.length} chars exceeds the ${MANAGER_EVENT_DETAILS_MAX_CHARS}-char inbox detail cap.`;
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
    failureDetails: acceptedDurableEventDetails(
      formatPardesError(error),
      'managed-worktree Git audit diagnostic',
    ),
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
  options?: {
    readonly suppressIdleWakeup?: boolean;
    readonly verifierIdleDisposition?: VerifierIdleDisposition;
  },
): WorkerEventSummary | undefined {
  if (event.type === 'report') {
    const type =
      audit?.status === 'failed'
        ? 'agent_git_audit_failed'
        : reportPersistence?.status === 'failed'
          ? 'agent_report_persist_failed'
          : `agent_report_${event.status}`;
    const details = acceptedDurableEventDetails(
      [
        ...(reportPersistence?.status === 'failed'
          ? [
              `report summary(JSON string): ${JSON.stringify(event.summary)}`,
              `report artifact persistence diagnostic(JSON string): ${JSON.stringify(reportPersistence.failureDetails ?? reportPersistence.failureSummary)}`,
            ]
          : []),
        ...(audit?.status === 'failed'
          ? [
              `managed-worktree Git audit diagnostic(JSON string): ${JSON.stringify(audit.failureDetails)}`,
            ]
          : []),
      ].join('\n'),
      'worker report diagnostic',
    );
    return {
      actionable:
        event.status !== 'progress' ||
        reportPersistence?.status === 'failed' ||
        audit?.status === 'failed',
      ...(details.length === 0 ? {} : { details }),
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
      details: acceptedDurableEventDetails(
        JSON.stringify({
          question: event.question,
          ...(event.context === undefined ? {} : { context: event.context }),
        }),
        'child question detail',
      ),
      summary: `${event.agentId} asks a blocking question; inspect the durable inbox detail.`,
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
      details: acceptedDurableEventDetails(event.message, 'child RPC protocol diagnostic'),
      summary: `${event.agentId} emitted invalid RPC JSON; inspect the durable inbox diagnostic.`,
      type: 'agent_protocol_error',
    };
  if (event.type === 'status' && event.status === 'idle') {
    if (
      options?.suppressIdleWakeup ||
      options?.verifierIdleDisposition === 'report_complete' ||
      options?.verifierIdleDisposition === 'handoff_settling' ||
      options?.verifierIdleDisposition === 'stopped_or_crashed'
    )
      return undefined;
    if (options?.verifierIdleDisposition === 'attached_idle_without_terminal_report')
      return {
        actionable: true,
        summary: `${event.agentId}: terminal report missing; follow up; do not poll. Retained advisory verifier remains attached idle.`,
        type: 'verification_terminal_report_missing',
      };
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

/** Suppress only an equivalent pending row; acknowledgement or a changed canonical outcome rearms it. */
export function hasPendingCanonicalAttention(
  inbox: ReadonlyArray<ManagerEvent>,
  candidate: ManagerEvent,
): boolean {
  return inbox.some(
    (event) =>
      event.type === candidate.type &&
      event.agentId === candidate.agentId &&
      event.pullRequestId === candidate.pullRequestId &&
      event.verificationId === candidate.verificationId &&
      event.workstreamId === candidate.workstreamId &&
      event.summary === candidate.summary &&
      (event.details === candidate.details ||
        (candidate.type === 'pull_request_auto_sync_attention' &&
          ((event.details === undefined && candidate.details === candidate.summary) ||
            (candidate.details === undefined && event.details === event.summary)))),
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
  const dedupePendingVerifierMissingReport =
    event?.type === 'verification_terminal_report_missing' &&
    hasPendingAgentAttention(inbox, { agentId: workerEvent.agentId, type: event.type });
  return (
    dedupePendingProgressReportFailure ||
    dedupePendingGitAuditFailure ||
    dedupePendingVerifierMissingReport
  );
}
