import type {
  ManagerState,
  PluginActivationStatus,
  PullRequestRecord,
  Workstream,
} from '../manager/index.ts';
import { currentVerificationAttempt, pullRequestNeedsAttention } from '../manager/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import { agentWarnings, effectiveAgentStatus } from './agent-projections.ts';
import { inboxDeliveryLine } from './inbox-projections.ts';
import {
  boundedRows,
  CONTROL_PLANE_MAX_ROWS,
  plural,
  summaryAttentionToken,
} from './projections.ts';
import { reviewWarningMetadata } from './review-projections.ts';

const SUMMARY_ATTENTION_MAX_ROWS = 5;

type WorkstreamFilter = Workstream['status'] | 'all';

export function workstreamLines(
  workstreams: ReadonlyArray<Workstream>,
  filter: WorkstreamFilter,
  maxRows?: number,
): string {
  const matching = workstreams.filter(
    (workstream) => filter === 'all' || workstream.status === filter,
  );
  const lines = [
    `workstreams: ${matching.length} ${filter === 'all' ? 'matching all statuses' : filter} · ${workstreams.length} total`,
    ...matching.map((workstream) => `${workstream.id} [${workstream.status}] ${workstream.title}`),
  ];
  return boundedRows(lines, maxRows);
}

function activationSummaryWarning(status: PluginActivationStatus | undefined): string[] {
  if (!status) return [];
  if (status.lifecycle === 'blocked')
    return [
      `activation safety: pinned child runtime unavailable · launch lifecycle blocked · inspect: pardes_status(view="activation")`,
    ];
  return status.status === 'aligned'
    ? []
    : [
        `activation advisory: shared child runtime inputs ${status.status} · pinned snapshot lifecycle allowed · inspect: pardes_status(view="activation")`,
      ];
}

type SummaryAttentionKind = 'inbox' | 'review' | 'worker';

interface SummaryAttentionRow {
  readonly kind: SummaryAttentionKind;
  readonly line: string;
}

function compareRecordIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function summaryReviewLabel(pullRequest: PullRequestRecord): string {
  return pullRequest.number !== undefined &&
    Number.isInteger(pullRequest.number) &&
    pullRequest.number > 0
    ? `#${pullRequest.number}`
    : summaryAttentionToken(pullRequest.id, 'redacted-review');
}

function summaryReviewWarnings(pullRequest: PullRequestRecord): string {
  const warnings = [...reviewWarningMetadata(pullRequest)];
  if (pullRequest.observation?.ci === 'failing') warnings.push('ci:failing');
  if (pullRequest.observation?.reviewDecision === 'changes_requested')
    warnings.push('review:changes_requested');
  if (pullRequest.observation?.mergeable === 'conflicting') warnings.push('merge:conflicting');
  return warnings.join(',');
}

/** Default orientation stays structural: never copy inbox summaries, diagnostic text, URLs, or paths into it. */
function summaryAttentionRows(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): ReadonlyArray<SummaryAttentionRow> {
  const inbox: ReadonlyArray<SummaryAttentionRow> = state.inbox.map((event) => ({
    kind: 'inbox',
    line: `! inbox ${summaryAttentionToken(event.id, 'redacted-event')} [${summaryAttentionToken(event.type, 'redacted-type')}] · read: inbox_get({ eventId })`,
  }));
  const reviews: ReadonlyArray<SummaryAttentionRow> = Object.values(state.pullRequests)
    .filter(pullRequestNeedsAttention)
    .sort(compareRecordIds)
    .map((pullRequest) => ({
      kind: 'review',
      line: `! review ${summaryReviewLabel(pullRequest)} [open] · ${summaryAttentionToken(pullRequest.workstreamId, 'redacted-workstream')} · ${summaryAttentionToken(pullRequest.agentId, 'redacted-worker')} · ⚠ ${summaryReviewWarnings(pullRequest)}`,
    }));
  const workers: ReadonlyArray<SummaryAttentionRow> = Object.values(state.agents)
    .filter((agent) => agentWarnings(agent, runtimes.get(agent.id)).length > 0)
    .sort(compareRecordIds)
    .map((agent) => {
      const runtime = runtimes.get(agent.id);
      return {
        kind: 'worker',
        line: `! worker ${summaryAttentionToken(agent.id, 'redacted-worker')} [${effectiveAgentStatus(agent, runtime)}] · ${summaryAttentionToken(agent.workstreamId, 'redacted-workstream')} · ⚠ ${agentWarnings(agent, runtime).join(',')}`,
      };
    });
  return [...inbox, ...reviews, ...workers];
}

function summaryAttentionHint(rows: ReadonlyArray<SummaryAttentionRow>): string {
  const kinds = new Set(rows.map((row) => row.kind));
  return [
    ...(kinds.has('inbox') ? ['inbox'] : []),
    ...(kinds.has('review') ? ['reviews(attention)'] : []),
    ...(kinds.has('worker') ? ['agents(warnings)'] : []),
  ].join(' | ');
}

function summaryAttentionOmittedLine(rows: ReadonlyArray<SummaryAttentionRow>): string {
  const inbox = rows.filter((row) => row.kind === 'inbox').length;
  const reviews = rows.filter((row) => row.kind === 'review').length;
  const workers = rows.filter((row) => row.kind === 'worker').length;
  const counts = [
    ...(inbox > 0 ? [plural(inbox, 'inbox row')] : []),
    ...(reviews > 0 ? [plural(reviews, 'review gate')] : []),
    ...(workers > 0 ? [plural(workers, 'worker')] : []),
  ].join(' · ');
  return `… +${rows.length} more attention ${rows.length === 1 ? 'signal' : 'signals'} omitted (${counts})`;
}

export function summaryLines(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  activation?: PluginActivationStatus,
): string {
  const workstreams = Object.values(state.workstreams);
  const agents = Object.values(state.agents);
  const pullRequests = Object.values(state.pullRequests);
  const workstreamCount = (status: Workstream['status']) =>
    workstreams.filter((workstream) => workstream.status === status).length;
  const agentCount = (status: WorkerStatus) =>
    agents.filter((agent) => effectiveAgentStatus(agent, runtimes.get(agent.id)) === status).length;
  const warnings = agents.filter(
    (agent) => agentWarnings(agent, runtimes.get(agent.id)).length > 0,
  ).length;
  const openReviews = pullRequests.filter((pullRequest) => pullRequest.status === 'open').length;
  const attention = pullRequests.filter(pullRequestNeedsAttention).length;
  const attentionRows = summaryAttentionRows(state, runtimes);
  const visibleAttentionRows = attentionRows.slice(0, SUMMARY_ATTENTION_MAX_ROWS);
  const omittedAttentionRows = attentionRows.slice(visibleAttentionRows.length);
  return boundedRows(
    [
      `pardes ${state.managerId} · revision ${state.revision}`,
      `workstreams: ${workstreamCount('active')} active · ${workstreamCount('planned')} planned · ${workstreamCount('complete')} complete · ${workstreamCount('cancelled')} cancelled`,
      `workers: ${agentCount('running')} running · ${agentCount('idle')} idle · ${agentCount('starting')} starting · ${agentCount('crashed')} crashed · ${warnings} warnings`,
      `review gates: ${openReviews} open · ${attention} attention · advisory verifications: ${Object.values(state.verifications).filter((verification) => currentVerificationAttempt(verification).evidenceStatus === 'current').length} current · ${Object.values(state.verifications).filter((verification) => currentVerificationAttempt(verification).evidenceStatus === 'stale').length} stale · inbox: ${state.inbox.length} pending`,
      ...(state.inboxWake || state.inboxHandoff ? [inboxDeliveryLine(state)] : []),
      ...activationSummaryWarning(activation),
      ...(attentionRows.length === 0
        ? []
        : [
            `attention index: ${plural(attentionRows.length, 'signal')} · first ${visibleAttentionRows.length} shown · drill down: ${summaryAttentionHint(attentionRows)}`,
            ...visibleAttentionRows.map((row) => row.line),
            ...(omittedAttentionRows.length === 0
              ? []
              : [summaryAttentionOmittedLine(omittedAttentionRows)]),
          ]),
    ],
    CONTROL_PLANE_MAX_ROWS,
  );
}
