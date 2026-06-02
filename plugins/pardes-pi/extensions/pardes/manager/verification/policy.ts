import { randomUUID } from 'node:crypto';
import { Clock, Effect } from 'effect';
import {
  currentVerificationAttempt,
  type ManagerEvent,
  type ManagerState,
  type VerificationAttempt,
  type VerificationRecord,
  type VerificationStaleReasonCode,
  type VerificationStatus,
} from '../domain.ts';
import type { VerificationLifecycleNamespace } from './contracts.ts';

export const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString()),
);
export const DEFAULT_VERIFICATION_TASK =
  'Independently review the complete captured worker diff and its relevant context adversarially for correctness issues, regressions, scope drift, generated artifacts, unnecessary complexity, and missing validation.';
const VERIFIER_REVIEW_COMPLETENESS_PROTOCOL = [
  'Review-completeness protocol:',
  '- Inspect the whole requested risk surface and relevant diff context before a terminal report; do not stop after the first finding.',
  '- Prefer one comprehensive pass. In one completed or blocked report, consolidate every currently known blocker, concern, and non-blocking note instead of serially drip-feeding findings that the same pass could discover.',
  '- For each concern, include bounded reproduction reasoning: inspected evidence, triggering condition or minimal reproduction, expected versus actual impact, and whether the concern was reproduced or is static reasoning. Summarize; do not dump bulk logs.',
  '- Separately state confidence and completeness limitations: areas inspected, validation run or not run, areas not inspected, and remaining uncertainty.',
  '- Use progress reports only for genuine interim checkpoints. Ask the manager only when a question truly blocks continued review.',
  '- This review is advisory evidence only. The owning manager retains judgment over action, publication, and merge decisions.',
].join('\n');

type ManagerEventAssociation = Pick<ManagerEvent, 'workstreamId' | 'agentId' | 'verificationId'>;

export function makeVerificationEvent(
  type: string,
  summary: string,
  createdAt: string,
  association: ManagerEventAssociation = {},
): ManagerEvent {
  return { createdAt, id: randomUUID(), summary, type, ...association };
}

const VERIFICATION_STALE_REASON_LABELS: Readonly<Record<VerificationStaleReasonCode, string>> = {
  provisioning_failed: 'verifier provisioning failed',
  refresh_superseded: 'evidence superseded',
  review_checkout_dirty: 'detached review checkout became dirty',
  review_checkout_head_changed: 'detached review checkout head changed',
  source_dirty: 'source managed worktree became dirty',
  source_head_changed: 'source head changed',
  source_unverifiable: 'source managed worktree state is no longer verifiable',
};

export function verificationStaleReason(
  code: VerificationStaleReasonCode,
  detail?: string,
): string {
  const safeDetail = detail?.replace(/\s+/g, ' ').trim();
  const label = `[${code}] ${VERIFICATION_STALE_REASON_LABELS[code]}`;
  return safeDetail ? `${label} ${safeDetail}` : label;
}

export type VerificationReviewLoopDisposition = 'unassociated' | 'open' | 'resolved_terminal';

/** Pure conservative policy: any associated open writer gate keeps retained refresh available. */
export function projectVerificationReviewLoopDisposition(
  state: Pick<ManagerState, 'pullRequests'>,
  verification: Pick<VerificationRecord, 'sourceAgentId' | 'workstreamId'>,
): VerificationReviewLoopDisposition {
  const associations = Object.values(state.pullRequests).filter(
    (pullRequest) =>
      pullRequest.agentId === verification.sourceAgentId &&
      pullRequest.workstreamId === verification.workstreamId,
  );
  if (associations.some((pullRequest) => pullRequest.status === 'open')) return 'open';
  if (
    associations.some(
      (pullRequest) => pullRequest.status === 'merged' || pullRequest.status === 'closed',
    )
  )
    return 'resolved_terminal';
  return 'unassociated';
}

export function updateCurrentVerificationAttempt(
  verification: VerificationRecord,
  update: (attempt: VerificationAttempt) => VerificationAttempt,
): VerificationRecord {
  return {
    ...verification,
    attempts: [
      ...verification.attempts.slice(0, -1),
      update(currentVerificationAttempt(verification)),
    ],
  };
}

export function withVerificationStatus(
  verification: VerificationRecord,
  status: VerificationStatus,
  updatedAt: string,
): VerificationRecord {
  return updateCurrentVerificationAttempt({ ...verification, updatedAt }, (attempt) => ({
    ...attempt,
    status,
    updatedAt,
  }));
}

export function withStaleCurrentEvidence(
  verification: VerificationRecord,
  reasonCode: VerificationStaleReasonCode,
  timestamp: string,
  detail?: string,
): VerificationRecord {
  const staleReason = verificationStaleReason(reasonCode, detail);
  return updateCurrentVerificationAttempt({ ...verification, updatedAt: timestamp }, (attempt) => ({
    ...attempt,
    evidenceStatus: 'stale',
    staleAt: timestamp,
    staleReason,
    staleReasonCode: reasonCode,
    updatedAt: timestamp,
  }));
}

export function verificationAttemptFor(
  attempt: number,
  reviewedHeadSha: string,
  sourceBranchPointSha: string,
  reviewCheckout: VerificationAttempt['reviewCheckout'],
  timestamp: string,
): VerificationAttempt {
  return {
    attempt,
    createdAt: timestamp,
    evidenceStatus: 'current',
    reviewCheckout,
    reviewedHeadSha,
    sourceBranchPointSha,
    status: 'starting',
    updatedAt: timestamp,
  };
}

export function verifierPrompt(
  task: string,
  attempt: number,
  reviewedHeadSha: string,
  sourceBranchPointSha: string,
): string {
  return `Requested review risk surface:\n${task}\n\nVerification attempt ${attempt}. Captured reviewed head: ${reviewedHeadSha}. Baseline: ${sourceBranchPointSha}. Bash is available for efficient rg, Git inspection, targeted queries, and disposable review scratch work. Bash can mutate files and same-user filesystem access is not isolation. Do not publish verifier commits; Pardes never uses this checkout as a publication source. Use verification_evidence for software-owned captured-head evidence and report_to_manager for bounded durable findings.\n\n${VERIFIER_REVIEW_COMPLETENESS_PROTOCOL}`;
}

export function reviewCheckoutOwner(
  namespace: VerificationLifecycleNamespace,
  verificationId: string,
) {
  return { managerId: namespace.managerId, repo: namespace.repo, verificationId };
}
