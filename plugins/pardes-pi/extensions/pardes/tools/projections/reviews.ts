import type { ManagerState, PullRequestRecord } from '../../manager/index.ts';
import { pullRequestNeedsAttention } from '../../manager/index.ts';
import { boundedRows, CONTROL_PLANE_MAX_ROWS, compactText, summaryAttentionToken } from './core.ts';

export const COMPOSITION_MAX_CLUSTERS = 4;
export const COMPOSITION_MAX_UNCERTAIN_GATES = 3;
export const COMPOSITION_MAX_GATES_PER_CLUSTER = 4;
export const COMPOSITION_MAX_PATHS_PER_ROW = 4;

type ReviewFilter = 'open' | 'attention' | 'all';

function discussionPaginationGapMetadata(pullRequest: PullRequestRecord): string | undefined {
  const surfaces = pullRequest.discussionPaginationGaps;
  return !surfaces?.length ? undefined : `discussion-gap:${surfaces.length}(${surfaces.join(',')})`;
}

export function reviewWarningMetadata(pullRequest: PullRequestRecord): ReadonlyArray<string> {
  const warnings: string[] = [];
  if (pullRequest.watcherFailure) warnings.push(`watcher:${pullRequest.watcherFailure.kind}`);
  else if (pullRequest.watcherFailedAt) warnings.push('watcher');
  if (pullRequest.headDivergedAt) warnings.push('remote-head');
  const paginationGap = discussionPaginationGapMetadata(pullRequest);
  if (paginationGap) warnings.push(paginationGap);
  return warnings;
}

export function reviewLines(state: ManagerState, filter: ReviewFilter, maxRows?: number): string {
  const pullRequests = Object.values(state.pullRequests);
  const openCount = pullRequests.filter((pullRequest) => pullRequest.status === 'open').length;
  const attentionCount = pullRequests.filter(pullRequestNeedsAttention).length;
  const matching = pullRequests.filter((pullRequest) => {
    if (filter === 'all') return true;
    if (filter === 'attention') return pullRequestNeedsAttention(pullRequest);
    return pullRequest.status === 'open';
  });
  const lines = [
    `review gates: ${openCount} open · ${attentionCount} attention · ${pullRequests.length} total (${matching.length} ${filter})`,
    ...(state.githubRateMetadataUnavailableAt === undefined
      ? []
      : [
          'global GitHub warning [external-metadata]: rate metadata unavailable or invalid · watcher polling deferred',
        ]),
    ...matching.flatMap((pullRequest) => {
      const label = pullRequest.number === undefined ? pullRequest.id : `#${pullRequest.number}`;
      const draft = pullRequest.draft ? 'draft' : pullRequest.status;
      const observation = pullRequest.observation;
      const hints = observation
        ? `ci:${observation.ci} · review:${observation.reviewDecision} · merge:${observation.mergeable}`
        : 'observation:none';
      const warnings = reviewWarningMetadata(pullRequest);
      return [
        `${label} [${draft}] ${pullRequest.workstreamId} · ${pullRequest.agentId} · ${hints}${warnings.length === 0 ? '' : ` · ⚠ ${warnings.join(',')}`}`,
        ...(pullRequest.watcherFailure === undefined
          ? []
          : [
              `↳ ${label} watcher diagnosis [${pullRequest.watcherFailure.kind}]: ${pullRequest.watcherFailure.summary}`,
            ]),
      ];
    }),
  ];
  return boundedRows(lines, maxRows);
}

type CompositionEvidence =
  | {
      readonly status: 'known';
      readonly pullRequest: PullRequestRecord;
      readonly paths: ReadonlyArray<string>;
    }
  | {
      readonly status: 'stale';
      readonly pullRequest: PullRequestRecord;
      readonly paths: ReadonlyArray<string>;
      readonly reasons: ReadonlyArray<string>;
    }
  | {
      readonly status: 'unavailable';
      readonly pullRequest: PullRequestRecord;
      readonly reason: string;
    };

type KnownCompositionEvidence = Extract<CompositionEvidence, { readonly status: 'known' }>;
type UncertainCompositionEvidence = Exclude<CompositionEvidence, KnownCompositionEvidence>;

interface CompositionCluster {
  readonly gates: ReadonlyArray<KnownCompositionEvidence>;
  readonly paths: ReadonlyArray<string>;
}

function compositionGateLabel(pullRequest: PullRequestRecord): string {
  return pullRequest.number !== undefined &&
    Number.isInteger(pullRequest.number) &&
    pullRequest.number > 0
    ? `#${pullRequest.number}`
    : summaryAttentionToken(pullRequest.id, 'redacted-review');
}

function uniqueSortedPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths)].sort();
}

function compositionEvidence(pullRequest: PullRequestRecord): CompositionEvidence {
  if (
    pullRequest.lastPushedHeadSha === undefined ||
    pullRequest.publishedChangedPaths === undefined
  ) {
    return { pullRequest, reason: 'exact-push paths absent', status: 'unavailable' };
  }
  const paths = uniqueSortedPaths(pullRequest.publishedChangedPaths);
  const reasons = [
    ...(pullRequest.headDivergedAt === undefined ? [] : ['remote-head']),
    ...(pullRequest.watcherFailedAt === undefined && pullRequest.watcherFailure === undefined
      ? []
      : ['watcher']),
  ];
  return reasons.length === 0
    ? { paths, pullRequest, status: 'known' }
    : { paths, pullRequest, reasons, status: 'stale' };
}

function pathsOverlap(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const rightPaths = new Set(right);
  return left.some((path) => rightPaths.has(path));
}

function comparePullRequestIds(
  left: { readonly pullRequest: PullRequestRecord },
  right: { readonly pullRequest: PullRequestRecord },
): number {
  return left.pullRequest.id < right.pullRequest.id
    ? -1
    : left.pullRequest.id > right.pullRequest.id
      ? 1
      : 0;
}

function clusterKnownCompositionEvidence(
  gates: ReadonlyArray<KnownCompositionEvidence>,
): ReadonlyArray<CompositionCluster> {
  let clusters: ReadonlyArray<CompositionCluster> = [];
  for (const gate of [...gates].sort(comparePullRequestIds)) {
    const overlapping = clusters.filter((cluster) => pathsOverlap(cluster.paths, gate.paths));
    const retained = clusters.filter((cluster) => !overlapping.includes(cluster));
    clusters = [
      ...retained,
      {
        gates: [...overlapping.flatMap((cluster) => cluster.gates), gate].sort(
          comparePullRequestIds,
        ),
        paths: uniqueSortedPaths([
          ...overlapping.flatMap((cluster) => cluster.paths),
          ...gate.paths,
        ]),
      },
    ];
  }
  return [...clusters].sort((left, right) => {
    const leftGate = left.gates[0];
    const rightGate = right.gates[0];
    if (!leftGate || !rightGate) throw new Error('Composition cluster has no review gates');
    return comparePullRequestIds(leftGate, rightGate);
  });
}

function compositionGateLabels(gates: ReadonlyArray<KnownCompositionEvidence>): string {
  const labels = gates
    .slice(0, COMPOSITION_MAX_GATES_PER_CLUSTER)
    .map(({ pullRequest }) => compositionGateLabel(pullRequest));
  return `${labels.join(',')}${gates.length > labels.length ? `,…+${gates.length - labels.length}` : ''}`;
}

function compositionPathPreview(label: string, paths: ReadonlyArray<string>): string {
  if (paths.length === 0) return `${label}:none`;
  const visible = paths
    .slice(0, COMPOSITION_MAX_PATHS_PER_ROW)
    .map((path) => compactText(path, 42));
  return `${label}(${paths.length}):${visible.join(',')}${paths.length > visible.length ? `,…+${paths.length - visible.length}` : ''}`;
}

function uncertainCompositionLine(evidence: UncertainCompositionEvidence): string {
  const label = compositionGateLabel(evidence.pullRequest);
  if (evidence.status === 'unavailable')
    return `uncertain ${label} [unavailable:${evidence.reason}] · independence:not established`;
  return `uncertain ${label} [stale:${evidence.reasons.join(',')}] · independence:not established · ${compositionPathPreview('last-known paths', evidence.paths)}`;
}

/** Read-only bounded merge-wave orientation from exact successful-publication path snapshots. */
export function compositionLines(state: ManagerState, maxRows?: number): string {
  const evidence = Object.values(state.pullRequests)
    .filter((pullRequest) => pullRequest.status === 'open')
    .map(compositionEvidence);
  const known = evidence.filter(
    (item): item is KnownCompositionEvidence => item.status === 'known',
  );
  const uncertain = evidence
    .filter((item): item is UncertainCompositionEvidence => item.status !== 'known')
    .sort(comparePullRequestIds);
  const clusters = clusterKnownCompositionEvidence(known);
  const overlapClusters = clusters.filter((cluster) => cluster.gates.length > 1).length;
  const independentClusters = clusters.length - overlapClusters;
  const visibleUncertain = uncertain.slice(0, COMPOSITION_MAX_UNCERTAIN_GATES);
  const visibleClusters = clusters.slice(0, COMPOSITION_MAX_CLUSTERS);
  const omittedUncertain = uncertain.length - visibleUncertain.length;
  const omittedClusters = clusters.length - visibleClusters.length;
  return boundedRows(
    [
      `composition plan: ${evidence.length} open gates · ${clusters.length} software-known clusters (${independentClusters} independent/${overlapClusters} overlap) · ${uncertain.length} uncertain`,
      'merge-wave hint: user controls merges; pair independent clusters only; serialize overlaps; after each merge refresh/re-audit remainder; inspect uncertain gates first',
      ...visibleUncertain.map(uncertainCompositionLine),
      ...visibleClusters.map((cluster, index) =>
        cluster.gates.length === 1
          ? `cluster ${index + 1} [independent] ${compositionGateLabels(cluster.gates)} · wave:may pair · ${compositionPathPreview('paths', cluster.paths)}`
          : `cluster ${index + 1} [overlap:${cluster.gates.length}] ${compositionGateLabels(cluster.gates)} · sequence:merge one then refresh/re-audit remainder · ${compositionPathPreview('paths', cluster.paths)}`,
      ),
      ...(omittedUncertain === 0 && omittedClusters === 0
        ? []
        : [
            `… omitted by composition caps: ${omittedClusters} software-known clusters · ${omittedUncertain} uncertain gates`,
          ]),
      `bounds: first ${COMPOSITION_MAX_CLUSTERS} software-known clusters · first ${COMPOSITION_MAX_UNCERTAIN_GATES} uncertain gates · first ${COMPOSITION_MAX_GATES_PER_CLUSTER} gates/cluster · first ${COMPOSITION_MAX_PATHS_PER_ROW} paths/row`,
    ],
    maxRows ?? CONTROL_PLANE_MAX_ROWS,
  );
}
