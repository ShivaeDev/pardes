import type {
  ResolvedWorkCleanupIdPreview,
  ResolvedWorkCleanupProjection,
} from '../../manager/index.ts';
import { boundedRows, compactText, plural } from './core.ts';

export const RESOLVED_WORK_CLEANUP_DEFAULT_ROWS = 8;

function cleanupIdPreview(preview: ResolvedWorkCleanupIdPreview): string {
  const ids = preview.ids.map((id) => compactText(id, 56)).join(', ');
  return `${ids}${preview.count > preview.ids.length ? `${ids ? ', ' : ''}… +${preview.count - preview.ids.length}` : ''}`;
}

/** Render state-only cleanup orientation; artifact inspection and mutation stay explicit per-record tool calls. */
export function resolvedWorkCleanupLines(
  projection: ResolvedWorkCleanupProjection,
  maxRows?: number,
): string {
  const {
    resolvedMergedLoops,
    historyOnlyVerifiers,
    detachedRetainedWorkers,
    disposableScratchMetadata,
  } = projection;
  const workerCandidates = detachedRetainedWorkers.resolvedLeaseInspectionCandidates;
  const scratchRetries = disposableScratchMetadata.cleanupRetryPending;
  const domainPending = resolvedMergedLoops.domainCompletionPending;
  return boundedRows(
    [
      `resolved merged loops: ${plural(resolvedMergedLoops.reviewGateCount, 'merged review gate')} · ${plural(resolvedMergedLoops.workstreamCount, 'workstream')} · ${plural(domainPending.count, 'domain completion')} pending`,
      `history-only verifiers: ${plural(historyOnlyVerifiers.count, 'retained record')} · ${plural(historyOnlyVerifiers.retirementPendingCount, 'retirement')} pending · retain advisory records as history`,
      `detached retained workers: ${detachedRetainedWorkers.count} total · ${plural(workerCandidates.count, 'resolved lease inspect candidate')} · ${plural(detachedRetainedWorkers.openReviewOwnerCount, 'open-review owner')} retained`,
      `disposable verifier scratch metadata: ${plural(disposableScratchMetadata.terminalLeaseCount, 'terminal lease')} retained by default · ${plural(scratchRetries.count, 'cleanup retry')} pending`,
      ...(workerCandidates.count === 0
        ? []
        : [
            `worker lease next: agent_lease_cleanup({ agentId, action:"inspect" }) one at a time; clean explicitly only after review · candidates: ${cleanupIdPreview(workerCandidates)}`,
          ]),
      ...(scratchRetries.count === 0
        ? []
        : [
            `scratch retry next: verification_refresh({ verificationId }) only for listed disposable verifier scratch · pending: ${cleanupIdPreview(scratchRetries)}`,
          ]),
      ...(domainPending.count === 0
        ? []
        : [
            `domain next: inspect blockers; workstream_complete({ workstreamId }) only when actually resolved · pending: ${cleanupIdPreview(domainPending)}`,
          ]),
      'safety: artifact cleanup is not a domain transition; never auto-delete or manually remove paths; never infer force flags, discard dirty worker content, or delete unmerged history',
    ],
    maxRows ?? RESOLVED_WORK_CLEANUP_DEFAULT_ROWS,
  );
}
