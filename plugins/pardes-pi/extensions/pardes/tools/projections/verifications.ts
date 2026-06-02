import type { ManagerState, VerificationRecord } from '../../manager/index.ts';
import {
  currentVerificationAttempt,
  projectVerificationReviewLoopDisposition,
} from '../../manager/index.ts';
import { structuralRows, structuralValue } from './core.ts';

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
  return structuralRows(
    {
      authoredLines: [
        `advisory verifications: ${current} current · ${stale} stale · ${verifications.length} total`,
      ],
      itemLines: verifications.map((verification) => {
        const attempt = currentVerificationAttempt(verification);
        return `${structuralValue(verification.id)} [${attempt.status}] attempt:${attempt.attempt} · evidence:${attempt.evidenceStatus} · review-loop:${projectVerificationReviewLoopDisposition(state, verification)} · source:${structuralValue(verification.sourceAgentId)} · verifier:${structuralValue(verification.verifierAgentId)} · head:${structuralValue(attempt.reviewedHeadSha)}${attempt.latestReport ? ` · report:${structuralValue(attempt.latestReport.reportId)}` : ''}`;
      }),
    },
    maxRows,
  );
}

export function verificationStatusLines(
  verification: VerificationRecord,
  state?: Pick<ManagerState, 'pullRequests'>,
): string {
  const attempt = currentVerificationAttempt(verification);
  return structuralRows(
    {
      authoredLines: [
        `${structuralValue(verification.id)} [${attempt.status}] advisory attempt:${attempt.attempt} · retained lineage:${verification.attempts.length} · archived attempts omitted:${verification.archivedAttemptCount ?? 0} · evidence:${attempt.evidenceStatus}`,
        `source:${structuralValue(verification.sourceAgentId)} · verifier:${structuralValue(verification.verifierAgentId)} · workstream:${structuralValue(verification.workstreamId)}`,
        ...(state ? [verificationReviewLoopLine(state, verification)] : []),
        `reviewed immutable head:${structuralValue(attempt.reviewedHeadSha)} · baseline:${structuralValue(attempt.sourceBranchPointSha)}`,
        ...(attempt.staleReason ? [`stale reason: ${attempt.staleReason}`] : []),
        ...(attempt.latestReport
          ? [
              `latest report:${structuralValue(attempt.latestReport.reportId)} [${attempt.latestReport.status}]`,
            ]
          : ['latest report: none']),
      ],
      retrievalHintLines: attempt.latestReport
        ? ['retrieve latest artifact: report_get({ reportId })']
        : [],
    },
    7,
  );
}
