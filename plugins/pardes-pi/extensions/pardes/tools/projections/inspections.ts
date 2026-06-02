import type {
  GitHubHostedChecksObservation,
  GitHubIntegrationHealthInspection,
} from '../../github/index.ts';
import type { PluginActivationStatus, PluginSourceObservation } from '../../manager/index.ts';
import type {
  StorageInspection,
  StorageLeafObservation,
  StorageMetricAccuracy,
} from '../../storage/index.ts';
import { boundedRows, compactText, plural } from './core.ts';

function storageLeafLabel(
  leaf: StorageLeafObservation,
  expected: 'regular_file' | 'directory',
): string {
  if (leaf.kind === 'regular_file')
    return expected === 'regular_file' ? 'regular file' : 'regular file (expected directory)';
  if (leaf.kind === 'directory')
    return expected === 'directory' ? 'directory' : 'directory (expected regular file)';
  if (leaf.kind === 'redirected') return 'redirected leaf (not followed)';
  if (leaf.kind === 'unusual') return 'unusual leaf';
  if (leaf.kind === 'unavailable') return `unavailable (${leaf.issue ?? 'io_error'})`;
  if (leaf.kind === 'blocked') return `not inspected (${leaf.blockedReason ?? 'root_unusual'})`;
  return 'missing';
}

function storageBytes(leaf: StorageLeafObservation): string {
  if (leaf.kind === 'regular_file') return `${leaf.bytes ?? 0} bytes`;
  if (leaf.kind === 'missing') return '0 bytes';
  return 'bytes unavailable';
}

function storageMetric(value: number, accuracy: StorageMetricAccuracy): string {
  if (accuracy === 'unavailable') return 'unavailable';
  return `${accuracy === 'lower_bound' ? '≥' : ''}${value}`;
}

function shortSha(sha: string | undefined): string {
  return sha === undefined ? 'unavailable' : sha.slice(0, 12);
}

function hostedChecksLabel(hostedChecks: GitHubHostedChecksObservation): string {
  if (hostedChecks.availability === 'unavailable') return `unavailable (${hostedChecks.issue})`;
  if (hostedChecks.availability === 'none') return 'none observed';
  const countPrefix = hostedChecks.countAccuracy === 'lower_bound' ? '≥' : '';
  return `${shortSha(hostedChecks.headSha)} [${hostedChecks.relation}/${hostedChecks.completeness}] · ci:${hostedChecks.ci} · checks:${countPrefix}${hostedChecks.observedCheckCount} · fail:${countPrefix}${hostedChecks.observedFailingCheckCount}`;
}

function canRenderSharedFailureHint(
  inspection: GitHubIntegrationHealthInspection,
  pullRequest: GitHubIntegrationHealthInspection['pullRequests'][number],
): boolean {
  const defaultChecks =
    inspection.defaultBranch.availability === 'available'
      ? inspection.defaultBranch.hostedChecks
      : undefined;
  return (
    pullRequest.sharedFailingWorkflowCount > 0 &&
    defaultChecks?.availability === 'available' &&
    defaultChecks.relation === 'current' &&
    defaultChecks.completeness === 'complete' &&
    pullRequest.pullRequestHead === 'current' &&
    pullRequest.hostedChecks.availability === 'available' &&
    pullRequest.hostedChecks.relation === 'current' &&
    pullRequest.hostedChecks.completeness === 'complete'
  );
}

/** Render only bounded content-free hosted metadata from one explicit network inspection. */
export function githubIntegrationHealthLines(
  inspection: GitHubIntegrationHealthInspection,
  maxRows?: number,
): string {
  const defaultBranch =
    inspection.defaultBranch.availability === 'available'
      ? `default branch ${compactText(inspection.defaultBranch.defaultBranch, 42)} · advertised:${shortSha(inspection.defaultBranch.advertisedHeadSha)} · hosted:${hostedChecksLabel(inspection.defaultBranch.hostedChecks)}`
      : `default branch unavailable (${inspection.defaultBranch.issue})`;
  return boundedRows(
    [
      `github integration health: opt-in read-only hosted metadata · ${plural(inspection.inspectedPullRequestCount, 'review gate')} inspected${inspection.omittedPullRequestCount === 0 ? '' : ` · ${inspection.omittedPullRequestCount} omitted`}`,
      defaultBranch,
      ...inspection.pullRequests.map((pullRequest) => {
        const label =
          pullRequest.number === undefined
            ? compactText(pullRequest.id, 42)
            : `#${pullRequest.number}`;
        const sharedFailure = canRenderSharedFailureHint(inspection, pullRequest)
          ? ` · likely-main-shared-failures:${pullRequest.sharedFailingWorkflowCount}`
          : '';
        return `${label} · audited:${shortSha(pullRequest.auditedHeadSha)} · observed:${shortSha(pullRequest.observedHeadSha)} [${pullRequest.pullRequestHead}] · hosted:${hostedChecksLabel(pullRequest.hostedChecks)}${sharedFailure}`;
      }),
      `bounds: first ${inspection.bounds.maxPullRequests} open review gates · first ${inspection.bounds.maxHostedChecksPerRef} server-selected hosted checks per ref · no logs, bodies, fetch, or pull`,
    ],
    maxRows,
  );
}

export function storageLines(storage: StorageInspection, maxRows?: number): string {
  const eventScan =
    storage.events.eventLinesAccuracy === 'lower_bound'
      ? ` · scan limited after ${storage.events.scannedBytes} bytes`
      : '';
  const reportScan =
    storage.reports.metricsAccuracy === 'lower_bound'
      ? ` · scan limited after ${storage.reports.scannedEntries} direct entries`
      : '';
  const otherReports =
    storage.reports.otherEntries > 0
      ? ` · ${storage.reports.otherEntries} other direct entries observed`
      : '';
  const eventIssue =
    storage.events.kind === 'regular_file' &&
    storage.events.eventLinesAccuracy === 'unavailable' &&
    storage.events.issue
      ? ` (${storage.events.issue})`
      : '';
  const reportIssue =
    storage.reports.kind === 'directory' &&
    storage.reports.metricsAccuracy === 'unavailable' &&
    storage.reports.issue
      ? ` (${storage.reports.issue})`
      : '';
  return boundedRows(
    [
      `storage: read-only bounded inspection · root ${storageLeafLabel(storage.root, 'directory')}`,
      `state: ${storageLeafLabel(storage.state, 'regular_file')} · ${storageBytes(storage.state)}`,
      `events: ${storageLeafLabel(storage.events, 'regular_file')} · ${storageBytes(storage.events)} · ${storageMetric(storage.events.eventLines, storage.events.eventLinesAccuracy)} event lines${eventIssue}${eventScan}`,
      `reports: ${storageLeafLabel(storage.reports, 'directory')} · ${storageMetric(storage.reports.reports, storage.reports.metricsAccuracy)} reports · ${storageMetric(storage.reports.reportBytes, storage.reports.metricsAccuracy)} bytes${reportIssue}${otherReports}${reportScan}`,
      `bounds: events first ${storage.bounds.eventScanMaxBytes} bytes · reports first ${storage.bounds.reportScanMaxEntries} direct entries · no artifact contents returned`,
    ],
    maxRows,
  );
}

function pluginTreeLabel(observation: PluginSourceObservation): string {
  return observation.tree.kind === 'known'
    ? `${observation.tree.fingerprint.slice(0, 12)} (${plural(observation.tree.sourceFileCount, 'source file')})`
    : `unknown (${observation.tree.issue})`;
}

export function activationLines(status: PluginActivationStatus): string {
  const lifecycle =
    status.lifecycle === 'allowed'
      ? 'fresh spawn, revive, verifier launch, and child reload allowed'
      : 'fresh spawn, revive, verifier launch, and child reload blocked';
  const pinned =
    status.snapshot.state === 'ready'
      ? `${status.snapshot.identity.slice(0, 12)} (${plural(status.snapshot.inputFileCount, 'input file')})`
      : `unavailable (${status.snapshot.issue})`;
  return boundedRows(
    [
      `activation safety: shared inputs ${status.status} · ${lifecycle}`,
      `pinned child runtime: ${pinned}`,
      `shared child inputs: loaded ${pluginTreeLabel(status.loaded)} · current ${pluginTreeLabel(status.current)}`,
      `source control: loaded ${status.loaded.sourceControl} · current ${status.current.sourceControl}`,
      'operator boundary: coordinate pull/reload manually; Pardes does not fetch, pull, or reload plugin sources automatically',
    ],
    5,
  );
}
