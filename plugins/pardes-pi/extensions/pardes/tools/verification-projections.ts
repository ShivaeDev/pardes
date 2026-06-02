import type { ManagerState, VerificationRecord } from '../manager/index.ts';
import {
  currentVerificationAttempt,
  projectVerificationReviewLoopDisposition,
} from '../manager/index.ts';
import { boundedRows } from './projections.ts';

function verificationReviewLoopLine(
  state: Pick<ManagerState, 'pullRequests'>,
  verification: VerificationRecord,
): string {
  const disposition = projectVerificationReviewLoopDisposition(state, verification);
  if (disposition === 'resolved_terminal')
    return 'review-loop:resolved_terminal · refresh:new verification request required';
  if (disposition === 'open') return 'review-loop:open · refresh:retained verifier allowed';
  return 'review-loop:unassociated · refresh:retained verifier allowed';
}

export function verificationLines(state: ManagerState, maxRows?: number): string {
  const verifications = Object.values(state.verifications);
  const current = verifications.filter(
    (verification) => currentVerificationAttempt(verification).evidenceStatus === 'current',
  ).length;
  const stale = verifications.length - current;
  return boundedRows(
    [
      `advisory verifications: ${current} current · ${stale} stale · ${verifications.length} total`,
      ...verifications.map((verification) => {
        const attempt = currentVerificationAttempt(verification);
        return `${verification.id} [${attempt.status}] attempt:${attempt.attempt} · evidence:${attempt.evidenceStatus} · review-loop:${projectVerificationReviewLoopDisposition(state, verification)} · source:${verification.sourceAgentId} · verifier:${verification.verifierAgentId} · head:${attempt.reviewedHeadSha.slice(0, 12)}${attempt.latestReport ? ` · report:${attempt.latestReport.reportId}` : ''}`;
      }),
    ],
    maxRows,
  );
}

export function verificationStatusLines(
  verification: VerificationRecord,
  state?: Pick<ManagerState, 'pullRequests'>,
): string {
  const attempt = currentVerificationAttempt(verification);
  return boundedRows(
    [
      `${verification.id} [${attempt.status}] advisory attempt:${attempt.attempt} · retained lineage:${verification.attempts.length} · evidence:${attempt.evidenceStatus}`,
      `source:${verification.sourceAgentId} · verifier:${verification.verifierAgentId} · workstream:${verification.workstreamId}`,
      ...(state ? [verificationReviewLoopLine(state, verification)] : []),
      `reviewed immutable head:${attempt.reviewedHeadSha} · baseline:${attempt.sourceBranchPointSha}`,
      ...(attempt.staleReason ? [`stale reason: ${attempt.staleReason}`] : []),
      ...(attempt.latestReport
        ? [
            `latest report:${attempt.latestReport.reportId} [${attempt.latestReport.status}] · retrieve: report_get({ reportId })`,
          ]
        : ['latest report: none']),
    ],
    7,
  );
}
