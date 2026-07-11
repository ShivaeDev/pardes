import { randomUUID } from 'node:crypto';
import { Cause, Clock, Context, Effect, Exit, Semaphore } from 'effect';
import {
  classifyGitHubWatcherFailure,
  derivePullRequestTransitions,
  type GitHubDiscussionCursor,
  type GitHubDiscussionSurface,
  type GitHubWatcherCallbacks,
  type GitHubWatcherThrottleDiagnostic,
  type PullRequestDiscussionFeedback,
  type PullRequestDiscussionPageCap,
  type PullRequestDiscussionSnapshot,
  type PullRequestWatcherTransition,
} from '../github/index.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import type {
  AgentRecord,
  ManagerEvent,
  ManagerState,
  PullRequestConflictAttention,
  PullRequestObservation,
  PullRequestRecord,
} from './domain.ts';
import { formatPardesError } from './errors.ts';
import { withInbox } from './inbox.ts';
import {
  type PullRequestPublicationNamespace,
  pullRequestEventAssociation,
  pullRequestLabel,
} from './publication-coordinator.ts';
import {
  acceptedDurableEventDetails,
  applyHandoffAudit,
  boundedEventSummary,
  boundedFailureSummary,
  type HandoffAuditOutcome,
  handoffAuditSuffix,
  hasPendingAgentAttention,
  hasPendingCanonicalAttention,
  truncateModelFacingText,
} from './worker-events.ts';

const ATTACHED_STATUSES = new Set(['starting', 'running', 'idle']);
// A merge observation does not block safe mechanical retirement, but remains
// durable user attention until acknowledgement. A prior remote-head divergence
// also remains visible while no longer blocking once every gate resolved terminal.
// Only routine worker lifecycle noise is consumed.
const MERGED_WORKFLOW_NON_BLOCKING_EVENT_TYPES = new Set([
  'merged',
  'pull_request_head_diverged',
  'agent_report_completed',
  'agent_idle',
  'agent_detached',
]);
const MERGED_WORKFLOW_CONSUMABLE_EVENT_TYPES = new Set([
  'agent_report_completed',
  'agent_idle',
  'agent_detached',
]);

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

type ManagerEventAssociation = Pick<ManagerEvent, 'workstreamId' | 'agentId' | 'pullRequestId'>;

function makeEvent(
  type: string,
  summary: string,
  createdAt: string,
  association: ManagerEventAssociation = {},
): ManagerEvent {
  return { createdAt, id: randomUUID(), summary, type, ...association };
}

function hasPendingWatcherFailureAttention(
  inbox: ReadonlyArray<ManagerEvent>,
  attention: ManagerEvent,
): boolean {
  return inbox.some(
    (event) =>
      event.type === 'watcher_failed' &&
      event.pullRequestId === attention.pullRequestId &&
      event.summary === attention.summary,
  );
}

function pullRequestObservationsEqual(
  left: PullRequestObservation | undefined,
  right: PullRequestObservation,
): boolean {
  return (
    left?.number === right.number &&
    left.status === right.status &&
    left.ci === right.ci &&
    left.reviewDecision === right.reviewDecision &&
    left.mergeable === right.mergeable
  );
}

function monotonicPullRequestStatus(
  previous: PullRequestRecord['status'],
  observed: PullRequestObservation['status'],
): PullRequestRecord['status'] {
  if (previous === 'merged' || observed === 'merged') return 'merged';
  if (previous === 'closed' || observed === 'closed') return 'closed';
  return 'open';
}

function monotonicPullRequestObservation(
  pullRequest: PullRequestRecord,
  observed: PullRequestObservation,
): PullRequestObservation {
  const status = monotonicPullRequestStatus(pullRequest.status, observed.status);
  return status === observed.status ? observed : { ...observed, status };
}

interface ConflictAttentionTransition {
  readonly attention: boolean;
  readonly next: PullRequestConflictAttention | undefined;
}

/** Keep one conflict generation sticky across transient hosted mergeability projections. */
export function conflictAttentionTransition(
  pullRequest: PullRequestRecord,
  owner: AgentRecord | undefined,
  observation: PullRequestObservation,
  complete: boolean,
): ConflictAttentionTransition {
  const previous = pullRequest.conflictAttention;
  const sameGeneration =
    previous !== undefined &&
    previous.auditedHeadSha === pullRequest.lastPushedHeadSha &&
    previous.ownerLifecycleGeneration === owner?.lifecycleGeneration;
  if (observation.mergeable === 'conflicting') {
    const materiallyNew =
      !sameGeneration ||
      previous?.phase === 'resolved' ||
      previous?.attentionObservedForKey === false;
    return {
      attention: materiallyNew,
      next: {
        attentionObservedForKey: true,
        ...(pullRequest.lastPushedHeadSha === undefined
          ? {}
          : { auditedHeadSha: pullRequest.lastPushedHeadSha }),
        generation: materiallyNew ? (previous?.generation ?? 0) + 1 : (previous?.generation ?? 1),
        ...(owner?.lifecycleGeneration === undefined
          ? {}
          : { ownerLifecycleGeneration: owner.lifecycleGeneration }),
        phase: 'conflicting',
      },
    };
  }
  if (previous === undefined) return { attention: false, next: previous };
  if (!sameGeneration) {
    if (observation.mergeable !== 'mergeable' || !complete)
      return { attention: false, next: previous };
    return {
      attention: false,
      next: {
        attentionObservedForKey: false,
        ...(pullRequest.lastPushedHeadSha === undefined
          ? {}
          : { auditedHeadSha: pullRequest.lastPushedHeadSha }),
        generation: previous.generation,
        ...(owner?.lifecycleGeneration === undefined
          ? {}
          : { ownerLifecycleGeneration: owner.lifecycleGeneration }),
        phase: 'resolution_candidate',
      },
    };
  }
  if (observation.mergeable === 'unknown')
    return {
      attention: false,
      next:
        previous.phase === 'resolution_candidate'
          ? { ...previous, phase: 'conflicting' }
          : previous,
    };
  if (!complete) return { attention: false, next: previous };
  if (previous.phase === 'conflicting')
    return { attention: false, next: { ...previous, phase: 'resolution_candidate' } };
  if (previous.phase === 'resolution_candidate')
    return { attention: false, next: { ...previous, phase: 'resolved' } };
  return { attention: false, next: previous };
}

function conflictAttentionEqual(
  left: PullRequestConflictAttention | undefined,
  right: PullRequestConflictAttention | undefined,
): boolean {
  return (
    left?.attentionObservedForKey === right?.attentionObservedForKey &&
    left?.auditedHeadSha === right?.auditedHeadSha &&
    left?.generation === right?.generation &&
    left?.ownerLifecycleGeneration === right?.ownerLifecycleGeneration &&
    left?.phase === right?.phase
  );
}

function watcherEventMatchesAssociation(
  pullRequest: PullRequestRecord,
  expectedHeadSha: string | undefined,
): boolean {
  return pullRequest.lastPushedHeadSha === expectedHeadSha;
}

const DISCUSSION_SURFACES = [
  'issue_comment',
  'review',
  'inline_review_comment',
] as const satisfies ReadonlyArray<GitHubDiscussionSurface>;

function discussionSurfaceCursor(surface: GitHubDiscussionSurface): keyof GitHubDiscussionCursor {
  if (surface === 'issue_comment') return 'issueCommentId';
  if (surface === 'review') return 'reviewId';
  return 'inlineReviewCommentId';
}

function githubDiscussionCursorsEqual(
  left: GitHubDiscussionCursor | undefined,
  right: GitHubDiscussionCursor,
): boolean {
  return (
    left !== undefined &&
    left.issueCommentId === right.issueCommentId &&
    left.reviewId === right.reviewId &&
    left.inlineReviewCommentId === right.inlineReviewCommentId
  );
}

function githubDiscussionPaginationGapsEqual(
  left: ReadonlyArray<GitHubDiscussionSurface> | undefined,
  right: ReadonlyArray<GitHubDiscussionSurface>,
): boolean {
  const previous = left ?? [];
  return (
    previous.length === right.length && previous.every((surface, index) => surface === right[index])
  );
}

function detectGithubDiscussionPaginationGaps(
  previous: GitHubDiscussionCursor | undefined,
  pageCaps: ReadonlyArray<PullRequestDiscussionPageCap>,
): ReadonlyArray<GitHubDiscussionSurface> {
  return DISCUSSION_SURFACES.filter((surface) =>
    pageCaps.some((cap) => {
      if (cap.surface !== surface) return false;
      const previousId = previous?.[discussionSurfaceCursor(surface)];
      return (
        cap.requiresCursorHold === true ||
        previousId === undefined ||
        cap.oldestFetchedId === undefined ||
        cap.oldestFetchedId > previousId
      );
    }),
  );
}

function advanceGithubDiscussionCursor(
  previous: GitHubDiscussionCursor | undefined,
  current: GitHubDiscussionCursor,
  paginationGaps: ReadonlyArray<GitHubDiscussionSurface> = [],
): GitHubDiscussionCursor {
  const maximum = (left: number | undefined, right: number | undefined) =>
    left === undefined ? right : right === undefined ? left : Math.max(left, right);
  const advance = (
    surface: GitHubDiscussionSurface,
    left: number | undefined,
    right: number | undefined,
  ) => (paginationGaps.includes(surface) ? left : maximum(left, right));
  const issueCommentId = advance('issue_comment', previous?.issueCommentId, current.issueCommentId);
  const reviewId = advance('review', previous?.reviewId, current.reviewId);
  const inlineReviewCommentId = advance(
    'inline_review_comment',
    previous?.inlineReviewCommentId,
    current.inlineReviewCommentId,
  );
  return {
    ...(issueCommentId === undefined ? {} : { issueCommentId }),
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(inlineReviewCommentId === undefined ? {} : { inlineReviewCommentId }),
  };
}

function newlyObservedDiscussionFeedback(
  previous: GitHubDiscussionCursor,
  feedback: ReadonlyArray<PullRequestDiscussionFeedback>,
  paginationGaps: ReadonlyArray<GitHubDiscussionSurface>,
): ReadonlyArray<PullRequestDiscussionFeedback> {
  return feedback.filter(
    (item) =>
      !paginationGaps.includes(item.kind) &&
      item.id > (previous[discussionSurfaceCursor(item.kind)] ?? 0),
  );
}

function discussionFeedbackSummary(
  pullRequest: PullRequestRecord,
  feedback: ReadonlyArray<PullRequestDiscussionFeedback>,
): string {
  const label = pullRequestLabel(pullRequest);
  const itemLabel = (item: PullRequestDiscussionFeedback) =>
    item.kind === 'issue_comment'
      ? 'issue comment'
      : item.kind === 'review'
        ? 'submitted review'
        : 'inline review comment';
  const visible = feedback
    .slice(0, 3)
    .map(
      (item) =>
        `${itemLabel(item)} id:${item.id} by ${JSON.stringify(`@${truncateModelFacingText(item.author)}`)}`,
    );
  return boundedEventSummary([
    `[external GitHub feedback] ${label} for ${pullRequest.agentId} observed ${feedback.length} new discussion item${feedback.length === 1 ? '' : 's'}.`,
    visible.join(' | '),
    feedback.length > visible.length
      ? `+${feedback.length - visible.length} more metadata item${feedback.length - visible.length === 1 ? '' : 's'} omitted.`
      : '',
    'Observation only; no worker message was sent.',
  ]);
}

function discussionPaginationGapSummary(
  pullRequest: PullRequestRecord,
  paginationGaps: ReadonlyArray<GitHubDiscussionSurface>,
): string {
  const surfaceLabel = (surface: GitHubDiscussionSurface) =>
    surface === 'issue_comment'
      ? 'issue comments'
      : surface === 'review'
        ? 'submitted reviews'
        : 'inline review comments';
  return boundedEventSummary([
    `${pullRequestLabel(pullRequest)} for ${pullRequest.agentId} has a bounded GitHub discussion pagination gap on ${paginationGaps.map(surfaceLabel).join(', ')}.`,
    'Affected cursors were held because unseen feedback may exist beyond the API page cap.',
    'Inspect GitHub discussion manually; no omitted external text was ingested or routed.',
  ]);
}

function eventRelatedToWorkstream(
  event: ManagerEvent,
  state: ManagerState,
  workstreamId: string,
): boolean {
  return (
    event.workstreamId === workstreamId ||
    (event.agentId !== undefined && state.agents[event.agentId]?.workstreamId === workstreamId) ||
    (event.pullRequestId !== undefined &&
      state.pullRequests[event.pullRequestId]?.workstreamId === workstreamId)
  );
}

function isMergedWorkflowConsumableEvent(
  event: ManagerEvent,
  pullRequest: PullRequestRecord,
): boolean {
  return (
    MERGED_WORKFLOW_CONSUMABLE_EVENT_TYPES.has(event.type) && event.agentId === pullRequest.agentId
  );
}

function isMergedWorkflowConsumableEventForWorkstream(
  event: ManagerEvent,
  state: ManagerState,
  workstreamId: string,
): boolean {
  return (
    MERGED_WORKFLOW_CONSUMABLE_EVENT_TYPES.has(event.type) &&
    eventRelatedToWorkstream(event, state, workstreamId)
  );
}

function hasAttachedWorker(
  state: ManagerState,
  workstreamId: string,
  liveRuntimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): boolean {
  return Object.values(state.agents).some((agent) => {
    if (agent.workstreamId !== workstreamId) return false;
    const runtime = liveRuntimes.get(agent.id);
    return (
      ATTACHED_STATUSES.has(agent.status) ||
      (runtime !== undefined && ATTACHED_STATUSES.has(runtime.status))
    );
  });
}

function hasUnresolvedAgentHandoffAudit(state: ManagerState, workstreamId: string): boolean {
  return Object.values(state.agents).some(
    (agent) =>
      agent.workstreamId === workstreamId &&
      (agent.gitAudit?.status === 'failed' ||
        (agent.gitAudit?.status === 'succeeded' && agent.gitAudit.dirty)),
  );
}

interface MergedRetirementProjection {
  readonly compact: string;
  readonly detail: string;
}

interface MergedWorkstreamPreservationReason {
  readonly compact: string;
  readonly detail: string;
}

function mergedWorkflowBlockingAttention(
  state: ManagerState,
  workstreamId: string,
): ReadonlyArray<ManagerEvent> {
  return state.inbox.filter(
    (event) =>
      !MERGED_WORKFLOW_NON_BLOCKING_EVENT_TYPES.has(event.type) &&
      eventRelatedToWorkstream(event, state, workstreamId),
  );
}

function mergedWorkstreamPreservationReasons(
  state: ManagerState,
  workstreamId: string,
  liveRuntimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): ReadonlyArray<MergedWorkstreamPreservationReason> {
  return [
    ...(hasUnresolvedAgentHandoffAudit(state, workstreamId)
      ? [{ compact: 'audit', detail: 'an unresolved handoff Git audit' }]
      : []),
    ...(Object.values(state.pullRequests).some(
      (pullRequest) => pullRequest.workstreamId === workstreamId && pullRequest.status === 'open',
    )
      ? [{ compact: 'open-PR', detail: 'an open review gate' }]
      : []),
    ...(hasAttachedWorker(state, workstreamId, liveRuntimes)
      ? [{ compact: 'worker', detail: 'an attached worker' }]
      : []),
    ...(mergedWorkflowBlockingAttention(state, workstreamId).length > 0
      ? [{ compact: 'attention', detail: 'unresolved blocking attention' }]
      : []),
  ];
}

function canAutoCompleteMergedWorkstream(
  state: ManagerState,
  workstreamId: string,
  liveRuntimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): boolean {
  return mergedWorkstreamPreservationReasons(state, workstreamId, liveRuntimes).length === 0;
}

function compactMergedReasons(reasons: ReadonlyArray<MergedWorkstreamPreservationReason>): string {
  const visible = reasons.slice(0, 1).map((reason) => reason.compact);
  return `${visible.join('+')}${reasons.length > visible.length ? `+${reasons.length - visible.length}` : ''}`;
}

function projectMergedWorkstreamRetirement(
  state: ManagerState,
  workstreamId: string,
  liveRuntimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): MergedRetirementProjection {
  const workstream = state.workstreams[workstreamId];
  if (!workstream)
    return {
      compact: 'stream:preserved(unavailable)',
      detail: `Workstream ${workstreamId} was preserved because its durable projection is unavailable.`,
    };
  if (workstream.status === 'complete')
    return {
      compact: 'stream:complete',
      detail: `Workstream ${workstreamId} is complete.`,
    };
  if (workstream.status === 'cancelled')
    return {
      compact: 'stream:preserved(cancelled)',
      detail: `Workstream ${workstreamId} remained cancelled.`,
    };
  const reasons = mergedWorkstreamPreservationReasons(state, workstreamId, liveRuntimes);
  return {
    compact: `stream:preserved(${reasons.length === 0 ? 'guard' : compactMergedReasons(reasons)})`,
    detail:
      reasons.length === 0
        ? `Workstream ${workstreamId} was conservatively preserved because completion was not confirmed.`
        : `Workstream ${workstreamId} was preserved because of ${reasons.map((reason) => reason.detail).join(', ')}.`,
  };
}

function mergedRetirementSummary(
  pullRequest: PullRequestRecord,
  owner: MergedRetirementProjection,
  state: ManagerState,
  liveRuntimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): string {
  const workstream = projectMergedWorkstreamRetirement(
    state,
    pullRequest.workstreamId,
    liveRuntimes,
  );
  const followUp = mergedWorkflowBlockingAttention(state, pullRequest.workstreamId);
  const followUpTypes = [...new Set(followUp.map((event) => truncateModelFacingText(event.type)))];
  return boundedEventSummary([
    `${pullRequestLabel(pullRequest)} merge observed; ${owner.compact}; ${workstream.compact}; follow-up:${followUp.length}.`,
    'External GitHub merge metadata was observed only; Pardes did not merge.',
    owner.detail,
    workstream.detail,
    followUp.length === 0
      ? 'No follow-up attention remains.'
      : `Follow-up attention remains: ${followUpTypes.slice(0, 3).join(', ')}${followUpTypes.length > 3 ? `, +${followUpTypes.length - 3} more types` : ''}.`,
  ]);
}

function hasMergedRetirementSummary(state: ManagerState, pullRequestId: string): boolean {
  return state.inbox.some(
    (event) =>
      event.type === 'merged' &&
      event.pullRequestId === pullRequestId &&
      event.summary.includes(
        'External GitHub merge metadata was observed only; Pardes did not merge.',
      ),
  );
}

function withMergedRetirementSummary(
  state: ManagerState,
  pullRequest: PullRequestRecord,
  owner: MergedRetirementProjection,
  liveRuntimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): ManagerState {
  const summary = mergedRetirementSummary(pullRequest, owner, state, liveRuntimes);
  let changed = false;
  const inbox = state.inbox.map((event) => {
    if (event.type !== 'merged' || event.pullRequestId !== pullRequest.id) return event;
    const {
      presentationBlocked: _presentationBlocked,
      presentationBlockedReason: _presentationBlockedReason,
      ...readyEvent
    } = event;
    if (event.presentationBlocked !== true && event.summary === summary) return event;
    changed = true;
    return { ...readyEvent, summary };
  });
  return changed ? withInbox(state, inbox) : state;
}

function pullRequestTransitionSummary(
  pullRequest: PullRequestRecord,
  transition: PullRequestWatcherTransition,
): string {
  const label = pullRequestLabel(pullRequest);
  if (transition === 'ci_failed')
    return `${label} for ${pullRequest.agentId} has failing CI metadata.`;
  if (transition === 'review_feedback')
    return `${label} for ${pullRequest.agentId} has changes-requested review metadata.`;
  if (transition === 'conflict') return `${label} for ${pullRequest.agentId} has merge conflicts.`;
  if (transition === 'merged')
    return `${label} for ${pullRequest.agentId} was merged externally; Pardes observed only and did not merge.`;
  return `${label} for ${pullRequest.agentId} was closed without merge (observation only).`;
}

interface AutoStopAuditPersistence {
  readonly persisted: boolean;
  readonly enqueued: boolean;
}

interface WatcherFailurePersistence {
  readonly changed: boolean;
  readonly enqueued: boolean;
}

export interface GitHubRateLimitSymptom {
  readonly pullRequestId: string;
  readonly expectedHeadSha?: string;
}

/** Optional manager-composition seam for rate-budget ownership landing on a separate branch. */
export interface GitHubRateLimitSymptomOwnershipPort {
  readonly consume: (symptom: GitHubRateLimitSymptom) => Effect.Effect<boolean, unknown>;
}

interface TerminalObservationFollowUp {
  readonly sourceAgentId: string;
  readonly mergedWorkstreamId?: string;
}

type WorkstreamCompletionAdmission = 'already_serialized' | 'try_serialize';

export interface ReviewGateLifecycleCoordinatorShape {
  readonly watcherCallbacks: GitHubWatcherCallbacks;
  readonly observePublishedTerminal: (event: {
    readonly pullRequestId: string;
    readonly expectedHeadSha: string;
    readonly number: number;
    readonly status: 'merged' | 'closed';
  }) => Effect.Effect<void, unknown>;
  readonly retirePersistedMergedPullRequests: () => Effect.Effect<void, unknown>;
  readonly retryMergedRetirementForIdleAgent: (
    agentId: string,
    workstreamId: string,
  ) => Effect.Effect<void, unknown>;
  readonly retryMergedRetirementForWorkstream: (
    workstreamId: string,
    options?: { readonly alreadySerialized?: boolean },
  ) => Effect.Effect<void, unknown>;
}

export class ReviewGateLifecycleCoordinator extends Context.Service<
  ReviewGateLifecycleCoordinator,
  ReviewGateLifecycleCoordinatorShape
>()('pardes/ReviewGateLifecycleCoordinator') {}

export interface ReviewGateLifecycleCoordinatorCallbacks {
  readonly refresh: () => Effect.Effect<void, unknown>;
  readonly appendEventSafely: (event: ManagerEvent) => Effect.Effect<void>;
  readonly releaseInboxWake: () => Effect.Effect<boolean, unknown>;
  readonly auditAutoStop: (
    agent: AgentRecord,
  ) => Effect.Effect<HandoffAuditOutcome | undefined, unknown>;
  readonly stopIdleWorker: (
    agentId: string,
  ) => Effect.Effect<WorkerRuntimeSnapshot | undefined, unknown>;
  readonly recordStoppedRuntime: (agentId: string, runtime: WorkerRuntimeSnapshot) => void;
  readonly liveRuntimes: () => ReadonlyMap<string, WorkerRuntimeSnapshot>;
  readonly retireResolvedVerificationsForSource: (
    sourceAgentId: string,
  ) => Effect.Effect<void, unknown>;
  readonly trySerializeWorkstreamCompletion: <A, E, R>(
    retryKey: string,
    effect: Effect.Effect<A, E, R>,
    retry: Effect.Effect<void, unknown>,
  ) => Effect.Effect<boolean, E, R>;
  readonly githubRateLimitSymptomOwnership?: GitHubRateLimitSymptomOwnershipPort;
}

export interface ReviewGateLifecycleCoordinatorOptions {
  readonly namespace: PullRequestPublicationNamespace;
  readonly callbacks: ReviewGateLifecycleCoordinatorCallbacks;
}

/** Allocate one coordinator per active manager namespace so all review-gate lifecycle entry paths share one permit. */
export const makeReviewGateLifecycleCoordinator = Effect.fnUntraced(function* (
  options: ReviewGateLifecycleCoordinatorOptions,
) {
  const { namespace, callbacks } = options;
  const semaphore = yield* Semaphore.make(1);

  const persistAutoStopAudit = Effect.fnUntraced(function* (
    agentId: string,
    audit: HandoffAuditOutcome | undefined,
    attention?: ManagerEvent,
  ) {
    const outcome = yield* namespace.store.mutate<AutoStopAuditPersistence, never>((state) => {
      const agent = state.agents[agentId];
      if (!agent) return Effect.succeed([{ enqueued: false, persisted: false }, state] as const);
      const alreadyPending =
        attention !== undefined && hasPendingAgentAttention(state.inbox, attention);
      return Effect.succeed([
        { enqueued: attention !== undefined && !alreadyPending, persisted: true },
        {
          ...state,
          agents: { ...state.agents, [agentId]: applyHandoffAudit(agent, audit) },
          inbox:
            attention !== undefined && !alreadyPending ? [...state.inbox, attention] : state.inbox,
        },
      ] as const);
    });
    if (!outcome.persisted) return;
    if (outcome.enqueued && attention) yield* callbacks.appendEventSafely(attention);
    yield* callbacks.refresh();
  });

  const stopMergedPullRequestIdleWorker = Effect.fnUntraced(function* (
    pullRequest: PullRequestRecord,
  ) {
    const agent = namespace.state.agents[pullRequest.agentId];
    if (!agent)
      return {
        compact: 'owner:preserved(unavailable)',
        detail: `Owner ${pullRequest.agentId} was preserved because its durable projection is unavailable.`,
      };
    if (agent.workstreamId !== pullRequest.workstreamId)
      return {
        compact: 'owner:preserved(reassociated)',
        detail: `Owner ${agent.id} was preserved because its workstream association changed.`,
      };
    if (agent.status === 'stopped')
      return {
        compact: 'owner:stopped',
        detail:
          agent.worktree === undefined && agent.leaseCleanup !== undefined
            ? `Owner ${agent.id} was already stopped; managed worktree was cleaned or is absent (${agent.leaseCleanup.worktreeOutcome}); retained Pi session metadata is history-only.`
            : `Owner ${agent.id} was already stopped; managed worktree and session remain preserved.`,
      };
    if (agent.status !== 'idle')
      return {
        compact: `owner:preserved(${agent.status})`,
        detail: `Owner ${agent.id} was preserved because its status is ${agent.status}, not idle.`,
      };
    const audit = yield* callbacks.auditAutoStop(agent);
    if (audit?.status === 'failed') {
      const summary = boundedEventSummary([
        `Could not auto-stop idle ${agent.id} after merge.`,
        handoffAuditSuffix(audit),
      ]);
      yield* persistAutoStopAudit(agent.id, audit, {
        ...makeEvent(
          'agent_git_audit_failed',
          summary,
          audit.gitAudit.checkedAt,
          pullRequestEventAssociation(pullRequest),
        ),
        details: audit.failureDetails,
      });
      return {
        compact: 'idle-owner:preserved(audit)',
        detail: `Idle owner ${agent.id} was preserved because its managed-worktree Git audit failed.`,
      };
    }
    if (audit?.status === 'succeeded' && audit.gitAudit.dirty) {
      const summary = boundedEventSummary([
        `Did not auto-stop idle ${agent.id} after merge because its worktree is dirty.`,
        handoffAuditSuffix(audit),
      ]);
      yield* persistAutoStopAudit(
        agent.id,
        audit,
        makeEvent(
          'agent_git_audit_dirty',
          summary,
          audit.gitAudit.checkedAt,
          pullRequestEventAssociation(pullRequest),
        ),
      );
      return {
        compact: 'idle-owner:preserved(dirty)',
        detail: `Idle owner ${agent.id} was preserved because its managed worktree is dirty.`,
      };
    }
    const stoppedResult = yield* callbacks.stopIdleWorker(agent.id).pipe(Effect.exit);
    if (Exit.isFailure(stoppedResult)) {
      const timestamp = yield* nowIso;
      const failure = Cause.squash(stoppedResult.cause);
      const summary = boundedEventSummary([
        `Could not auto-stop idle ${agent.id} after merge; worker and worktree were preserved.`,
        boundedFailureSummary(failure),
      ]);
      yield* persistAutoStopAudit(agent.id, audit, {
        ...makeEvent(
          'agent_auto_stop_failed',
          summary,
          timestamp,
          pullRequestEventAssociation(pullRequest),
        ),
        details: acceptedDurableEventDetails(
          formatPardesError(failure),
          'idle-worker auto-stop diagnostic',
        ),
      });
      return {
        compact: 'idle-owner:preserved(stop)',
        detail: `Idle owner ${agent.id} was preserved because guarded auto-stop failed.`,
      };
    }
    const stopped = stoppedResult.value;
    if (!stopped || stopped.status !== 'stopped') {
      yield* persistAutoStopAudit(agent.id, audit);
      return {
        compact: 'idle-owner:preserved(guard)',
        detail: `Idle owner ${agent.id} was preserved because guarded auto-stop did not confirm a stopped runtime.`,
      };
    }
    callbacks.recordStoppedRuntime(agent.id, stopped);
    const timestamp = yield* nowIso;
    const persisted = yield* namespace.store.mutate((state) => {
      const currentAgent = state.agents[agent.id];
      if (!currentAgent || currentAgent.status !== 'idle')
        return Effect.succeed([false, state] as const);
      return Effect.succeed([
        true,
        {
          ...state,
          agents: {
            ...state.agents,
            [agent.id]: {
              ...applyHandoffAudit(currentAgent, audit),
              status: 'stopped',
              updatedAt: timestamp,
            },
          },
        },
      ] as const);
    });
    if (!persisted) {
      yield* callbacks.refresh();
      return {
        compact: 'idle-owner:preserved(raced)',
        detail: `Idle owner ${agent.id} was conservatively preserved because its durable lifecycle changed during auto-stop.`,
      };
    }
    yield* callbacks.appendEventSafely(
      makeEvent(
        'agent_auto_stopped',
        boundedEventSummary([
          `Stopped idle ${agent.id} after externally observed merge; managed worktree and session preserved.`,
          handoffAuditSuffix(audit),
        ]),
        timestamp,
        pullRequestEventAssociation(pullRequest),
      ),
    );
    yield* callbacks.refresh();
    return {
      compact: 'idle-owner:stopped',
      detail: `Stopped idle owner ${agent.id}; managed worktree and session remain preserved.`,
    };
  });

  const retireMergedPullRequestDisposition = Effect.fnUntraced(function* (
    pullRequestId: string,
    ownerRetirement: MergedRetirementProjection,
  ) {
    const pullRequest = namespace.state.pullRequests[pullRequestId];
    if (!pullRequest || pullRequest.status !== 'merged') return;
    const timestamp = yield* nowIso;
    const outcome = yield* namespace.store.mutate((state) => {
      const currentPullRequest = state.pullRequests[pullRequestId];
      if (!currentPullRequest || currentPullRequest.status !== 'merged')
        return Effect.succeed([{ changed: false, completed: false }, state] as const);
      const currentWorkstream = state.workstreams[currentPullRequest.workstreamId];
      const withoutRoutineWorkerAttention = state.inbox.filter(
        (event) => !isMergedWorkflowConsumableEvent(event, currentPullRequest),
      );
      const stateWithoutRoutineWorkerAttention =
        withoutRoutineWorkerAttention.length === state.inbox.length
          ? state
          : withInbox(state, withoutRoutineWorkerAttention);
      const complete =
        currentWorkstream !== undefined &&
        currentWorkstream.status !== 'complete' &&
        currentWorkstream.status !== 'cancelled' &&
        canAutoCompleteMergedWorkstream(
          stateWithoutRoutineWorkerAttention,
          currentWorkstream.id,
          callbacks.liveRuntimes(),
        );
      const consumeAllRoutineAttention = currentWorkstream?.status === 'complete' || complete;
      const nextInbox =
        consumeAllRoutineAttention && currentWorkstream
          ? stateWithoutRoutineWorkerAttention.inbox.filter(
              (event) =>
                !isMergedWorkflowConsumableEventForWorkstream(
                  event,
                  stateWithoutRoutineWorkerAttention,
                  currentWorkstream.id,
                ),
            )
          : stateWithoutRoutineWorkerAttention.inbox;
      const stateWithConsumedInbox =
        nextInbox.length === stateWithoutRoutineWorkerAttention.inbox.length
          ? stateWithoutRoutineWorkerAttention
          : withInbox(stateWithoutRoutineWorkerAttention, nextInbox);
      const stateWithWorkstream = complete
        ? {
            ...stateWithConsumedInbox,
            workstreams: {
              ...stateWithConsumedInbox.workstreams,
              [currentWorkstream.id]: {
                ...currentWorkstream,
                status: 'complete' as const,
                updatedAt: timestamp,
              },
            },
          }
        : stateWithConsumedInbox;
      const nextState = withMergedRetirementSummary(
        stateWithWorkstream,
        currentPullRequest,
        ownerRetirement,
        callbacks.liveRuntimes(),
      );
      return Effect.succeed([
        { changed: nextState !== state, completed: complete },
        nextState,
      ] as const);
    });
    if (outcome.completed) {
      yield* callbacks.appendEventSafely(
        makeEvent(
          'workstream_auto_completed',
          `Completed ${pullRequest.workstreamId} after externally observed merge with no attached active workers, open review gates, unresolved handoff Git audits, blockers, or unresolved blocking attention events.`,
          timestamp,
          pullRequestEventAssociation(pullRequest),
        ),
      );
    }
    if (outcome.changed) yield* callbacks.refresh();
    yield* callbacks.releaseInboxWake();
  });

  const retireMergedPullRequest: (
    pullRequestId: string,
    completionAdmission: WorkstreamCompletionAdmission,
  ) => Effect.Effect<void, unknown> = Effect.fnUntraced(
    function* (pullRequestId, completionAdmission) {
      const known = namespace.state.pullRequests[pullRequestId];
      if (!known || known.status !== 'merged') return;
      if (
        namespace.state.workstreams[known.workstreamId]?.status === 'complete' &&
        hasMergedRetirementSummary(namespace.state, pullRequestId)
      ) {
        yield* callbacks.releaseInboxWake();
        return;
      }
      const ownerRetirement = yield* stopMergedPullRequestIdleWorker(known);
      if (completionAdmission === 'already_serialized')
        return yield* retireMergedPullRequestDisposition(pullRequestId, ownerRetirement);
      // A miss is queued once by manager/workstream/pull-request and drained
      // after the unrelated lifecycle holder settles; watcher callbacks never wait.
      yield* callbacks.trySerializeWorkstreamCompletion(
        `${known.workstreamId}/${known.id}`,
        retireMergedPullRequestDisposition(pullRequestId, ownerRetirement),
        semaphore.withPermit(retireMergedPullRequest(pullRequestId, 'already_serialized')),
      );
    },
  );

  const handlePullRequestObservation = Effect.fnUntraced(function* (
    event: {
      readonly pullRequestId: string;
      readonly expectedHeadSha?: string;
      readonly observation: PullRequestObservation;
      readonly discussion?: PullRequestDiscussionSnapshot;
      readonly complete?: boolean;
    },
    completionAdmission: 'already_serialized' | 'try_serialize',
  ) {
    const known = namespace.state.pullRequests[event.pullRequestId];
    if (!known || !watcherEventMatchesAssociation(known, event.expectedHeadSha)) return;
    // Older watcher callbacks are complete by construction. The explicit false
    // path lets newer watcher adapters persist lifecycle metadata before their
    // bounded discussion surfaces finish without clearing an outage warning.
    const complete = event.complete !== false;
    const nextObservation = monotonicPullRequestObservation(known, event.observation);
    const nextConflictAttention = conflictAttentionTransition(
      known,
      namespace.state.agents[known.agentId],
      nextObservation,
      complete,
    );
    const discussionPaginationGaps =
      event.discussion === undefined
        ? (known.discussionPaginationGaps ?? [])
        : detectGithubDiscussionPaginationGaps(
            known.discussionCursor,
            event.discussion.pageCaps ?? [],
          );
    const discussionCursor =
      event.discussion === undefined
        ? known.discussionCursor
        : advanceGithubDiscussionCursor(
            known.discussionCursor,
            event.discussion.cursor,
            discussionPaginationGaps,
          );
    const changed =
      !pullRequestObservationsEqual(known.observation, nextObservation) ||
      !conflictAttentionEqual(known.conflictAttention, nextConflictAttention.next) ||
      (discussionCursor !== undefined &&
        !githubDiscussionCursorsEqual(known.discussionCursor, discussionCursor)) ||
      !githubDiscussionPaginationGapsEqual(
        known.discussionPaginationGaps,
        discussionPaginationGaps,
      ) ||
      known.number !== nextObservation.number ||
      known.status !== nextObservation.status ||
      ((complete || nextObservation.status !== 'open') &&
        (known.watcherFailedAt !== undefined || known.watcherFailure !== undefined)) ||
      known.headDivergedAt !== undefined;
    if (!changed) {
      // A repeated terminal observation is also a bounded recovery edge. The
      // first merge may have raced a still-attached owner that has since stopped
      // or detached, so retry stream retirement without replaying attention.
      return event.observation.status === 'merged'
        ? ({
            mergedWorkstreamId: known.workstreamId,
            sourceAgentId: known.agentId,
          } satisfies TerminalObservationFollowUp)
        : undefined;
    }
    const timestamp = yield* nowIso;
    const transitions = yield* namespace.store.mutate((state) => {
      const pullRequest = state.pullRequests[event.pullRequestId];
      if (!pullRequest || !watcherEventMatchesAssociation(pullRequest, event.expectedHeadSha))
        return Effect.succeed([[] as ReadonlyArray<ManagerEvent>, state] as const);
      const nextObservation = monotonicPullRequestObservation(pullRequest, event.observation);
      const conflictTransition = conflictAttentionTransition(
        pullRequest,
        state.agents[pullRequest.agentId],
        nextObservation,
        complete,
      );
      const derivedTransitions = derivePullRequestTransitions(
        pullRequest.observation,
        nextObservation,
      );
      const conflictPosition = derivedTransitions.indexOf('conflict');
      const terminalPosition = derivedTransitions.findIndex(
        (transition) => transition === 'merged' || transition === 'closed_unmerged',
      );
      const transitionsWithConflict =
        conflictPosition >= 0
          ? derivedTransitions.flatMap((transition) =>
              transition === 'conflict'
                ? conflictTransition.attention
                  ? (['conflict'] as const)
                  : []
                : [transition],
            )
          : conflictTransition.attention
            ? [
                ...(terminalPosition < 0
                  ? derivedTransitions
                  : derivedTransitions.slice(0, terminalPosition)),
                'conflict' as const,
                ...(terminalPosition < 0 ? [] : derivedTransitions.slice(terminalPosition)),
              ]
            : derivedTransitions;
      const nextTransitions = transitionsWithConflict.filter(
        (transition) =>
          (transition !== 'merged' && transition !== 'closed_unmerged') ||
          pullRequest.status !== nextObservation.status,
      );
      const nextDiscussionPaginationGaps =
        event.discussion === undefined
          ? (pullRequest.discussionPaginationGaps ?? [])
          : detectGithubDiscussionPaginationGaps(
              pullRequest.discussionCursor,
              event.discussion.pageCaps ?? [],
            );
      const nextDiscussionCursor =
        event.discussion === undefined
          ? pullRequest.discussionCursor
          : advanceGithubDiscussionCursor(
              pullRequest.discussionCursor,
              event.discussion.cursor,
              nextDiscussionPaginationGaps,
            );
      const newlyObserved =
        event.discussion === undefined || pullRequest.discussionCursor === undefined
          ? []
          : newlyObservedDiscussionFeedback(
              pullRequest.discussionCursor,
              event.discussion.feedback,
              nextDiscussionPaginationGaps,
            );
      const newlyDetectedPaginationGap =
        nextDiscussionPaginationGaps.length > 0 &&
        !githubDiscussionPaginationGapsEqual(
          pullRequest.discussionPaginationGaps,
          nextDiscussionPaginationGaps,
        );
      const { headDivergedAt: _headDivergedAt, ...withoutHeadDivergence } = pullRequest;
      const {
        watcherFailedAt: _watcherFailedAt,
        watcherFailure: _watcherFailure,
        ...withoutWatcherFailure
      } = withoutHeadDivergence;
      const watcherCleared =
        complete || nextObservation.status !== 'open'
          ? withoutWatcherFailure
          : withoutHeadDivergence;
      const {
        discussionPaginationGaps: _discussionPaginationGaps,
        ...withoutDiscussionPaginationGaps
      } = watcherCleared;
      const nextPullRequest: PullRequestRecord = {
        ...withoutDiscussionPaginationGaps,
        ...(conflictTransition.next === undefined
          ? {}
          : { conflictAttention: conflictTransition.next }),
        number: nextObservation.number,
        observation: nextObservation,
        status: nextObservation.status,
        ...(nextDiscussionCursor === undefined ? {} : { discussionCursor: nextDiscussionCursor }),
        ...(nextDiscussionPaginationGaps.length === 0
          ? {}
          : { discussionPaginationGaps: nextDiscussionPaginationGaps }),
        updatedAt: timestamp,
      };
      const candidateAttention = [
        ...nextTransitions.map((transition) => ({
          ...makeEvent(
            transition,
            pullRequestTransitionSummary(nextPullRequest, transition),
            timestamp,
            pullRequestEventAssociation(nextPullRequest),
          ),
          ...(transition === 'merged'
            ? {
                presentationBlocked: true,
                presentationBlockedReason: 'merge_retirement_refinement',
              }
            : {}),
        })),
        ...(newlyDetectedPaginationGap
          ? [
              makeEvent(
                'discussion_pagination_gap',
                discussionPaginationGapSummary(nextPullRequest, nextDiscussionPaginationGaps),
                timestamp,
                pullRequestEventAssociation(nextPullRequest),
              ),
            ]
          : []),
        ...(newlyObserved.length === 0
          ? []
          : [
              makeEvent(
                'discussion_feedback',
                discussionFeedbackSummary(nextPullRequest, newlyObserved),
                timestamp,
                pullRequestEventAssociation(nextPullRequest),
              ),
            ]),
      ];
      const attention = candidateAttention.filter(
        (candidate) => !hasPendingCanonicalAttention(state.inbox, candidate),
      );
      return Effect.succeed([
        attention,
        {
          ...state,
          inbox: [...state.inbox, ...attention],
          pullRequests: { ...state.pullRequests, [pullRequest.id]: nextPullRequest },
        },
      ] as const);
    });
    for (const transition of transitions) yield* callbacks.appendEventSafely(transition);
    yield* callbacks.refresh();
    // Every association-matching merged projection is a bounded retry edge,
    // including callbacks that changed only metadata and therefore did not
    // create a fresh merged attention row.
    const merged = nextObservation.status === 'merged';
    const terminal =
      merged || transitions.some((transition) => transition.type === 'closed_unmerged');
    if (merged) yield* retireMergedPullRequest(event.pullRequestId, completionAdmission);
    if (transitions.length > 0) yield* callbacks.releaseInboxWake();
    return terminal
      ? ({
          sourceAgentId: known.agentId,
          ...(merged ? { mergedWorkstreamId: known.workstreamId } : {}),
        } satisfies TerminalObservationFollowUp)
      : undefined;
  });

  const handlePullRequestWatcherFailure = Effect.fnUntraced(function* (event: {
    readonly pullRequestId: string;
    readonly expectedHeadSha?: string;
    readonly error: unknown;
  }) {
    const known = namespace.state.pullRequests[event.pullRequestId];
    if (
      !known ||
      !watcherEventMatchesAssociation(known, event.expectedHeadSha) ||
      known.status !== 'open'
    )
      return;
    const diagnostic = classifyGitHubWatcherFailure(event.error);
    // Rate-budget software owns quiet throttling, recovery, and budget-health
    // projection when its separately integrated controller-lifetime port confirms
    // ownership. Until then fail safe with one bounded PR-attention fallback.
    if (diagnostic.kind === 'rate_limit_likely' && callbacks.githubRateLimitSymptomOwnership) {
      const ownership = yield* Effect.suspend(
        () =>
          callbacks.githubRateLimitSymptomOwnership?.consume({
            pullRequestId: event.pullRequestId,
            ...(event.expectedHeadSha === undefined
              ? {}
              : { expectedHeadSha: event.expectedHeadSha }),
          }) ?? Effect.succeed(false),
      ).pipe(Effect.exit);
      if (Exit.isSuccess(ownership) && ownership.value) return;
    }
    const timestamp = yield* nowIso;
    const attention = makeEvent(
      'watcher_failed',
      `${pullRequestLabel(known)} watcher failed [${diagnostic.kind}]: ${diagnostic.summary} Raw CLI diagnostics omitted.`,
      timestamp,
      pullRequestEventAssociation(known),
    );
    const outcome = yield* namespace.store.mutate<WatcherFailurePersistence, never>((state) => {
      const pullRequest = state.pullRequests[event.pullRequestId];
      if (
        !pullRequest ||
        !watcherEventMatchesAssociation(pullRequest, event.expectedHeadSha) ||
        pullRequest.status !== 'open'
      )
        return Effect.succeed([{ changed: false, enqueued: false }, state] as const);
      const enqueued = !hasPendingWatcherFailureAttention(state.inbox, attention);
      // Keep current diagnosis stable while its equivalent canonical warning is
      // already pending. Returning the authoritative state object exactly also
      // avoids a filesystem rewrite and durable revision bump. New diagnosis rows
      // may update current/onset projection.
      if (!enqueued) return Effect.succeed([{ changed: false, enqueued: false }, state] as const);
      return Effect.succeed([
        { changed: true, enqueued },
        {
          ...state,
          inbox: enqueued ? [...state.inbox, attention] : state.inbox,
          pullRequests: {
            ...state.pullRequests,
            [pullRequest.id]: {
              ...pullRequest,
              updatedAt: timestamp,
              watcherFailedAt: pullRequest.watcherFailedAt ?? timestamp,
              watcherFailure: diagnostic,
            },
          },
        },
      ] as const);
    });
    if (!outcome.changed) return;
    if (outcome.enqueued) yield* callbacks.appendEventSafely(attention);
    yield* callbacks.refresh();
    if (outcome.enqueued) yield* callbacks.releaseInboxWake();
  });

  const handleWatcherThrottleDiagnostic = Effect.fnUntraced(function* (
    event: GitHubWatcherThrottleDiagnostic,
  ) {
    if (event.status !== 'rate_metadata_unavailable') {
      if (namespace.state.githubRateMetadataUnavailableAt === undefined) {
        yield* callbacks.refresh();
        return;
      }
      const timestamp = yield* nowIso;
      const changed = yield* namespace.store.mutate((state) => {
        if (state.githubRateMetadataUnavailableAt === undefined)
          return Effect.succeed([false, state] as const);
        const {
          githubRateMetadataUnavailableAt: _githubRateMetadataUnavailableAt,
          ...withoutWarning
        } = state;
        return Effect.succeed([true, withoutWarning] as const);
      });
      if (!changed) return;
      yield* callbacks.appendEventSafely(
        makeEvent(
          'github_rate_metadata_recovered',
          'GitHub.com watcher rate metadata recovered; deferred polling may resume.',
          timestamp,
        ),
      );
      yield* callbacks.refresh();
      return;
    }
    if (namespace.state.githubRateMetadataUnavailableAt !== undefined) return;
    const timestamp = yield* nowIso;
    const attention = makeEvent(
      'github_rate_metadata_unavailable',
      'GitHub.com watcher rate metadata is unavailable or invalid; polling is deferred until bounded metadata recovers.',
      timestamp,
    );
    const changed = yield* namespace.store.mutate((state) => {
      if (state.githubRateMetadataUnavailableAt !== undefined)
        return Effect.succeed([false, state] as const);
      return Effect.succeed([
        true,
        {
          ...state,
          githubRateMetadataUnavailableAt: timestamp,
          inbox: [...state.inbox, attention],
        },
      ] as const);
    });
    if (!changed) return;
    yield* callbacks.appendEventSafely(attention);
    yield* callbacks.refresh();
    yield* callbacks.releaseInboxWake();
  });

  const handlePullRequestHeadDivergence = Effect.fnUntraced(function* (event: {
    readonly pullRequestId: string;
    readonly expectedHeadSha: string;
  }) {
    const known = namespace.state.pullRequests[event.pullRequestId];
    if (
      !known ||
      !watcherEventMatchesAssociation(known, event.expectedHeadSha) ||
      known.status !== 'open' ||
      known.headDivergedAt !== undefined
    )
      return;
    const timestamp = yield* nowIso;
    const attention = makeEvent(
      'pull_request_head_diverged',
      `${pullRequestLabel(known)} watched remote head differs from its last audited pushed SHA; inspect remote branch ownership before retrying publication.`,
      timestamp,
      pullRequestEventAssociation(known),
    );
    const outcome = yield* namespace.store.mutate<
      { readonly changed: boolean; readonly enqueued: boolean },
      never
    >((state) => {
      const pullRequest = state.pullRequests[event.pullRequestId];
      if (
        !pullRequest ||
        !watcherEventMatchesAssociation(pullRequest, event.expectedHeadSha) ||
        pullRequest.status !== 'open' ||
        pullRequest.headDivergedAt !== undefined
      )
        return Effect.succeed([{ changed: false, enqueued: false }, state] as const);
      const enqueued = !hasPendingCanonicalAttention(state.inbox, attention);
      return Effect.succeed([
        { changed: true, enqueued },
        {
          ...state,
          inbox: enqueued ? [...state.inbox, attention] : state.inbox,
          pullRequests: {
            ...state.pullRequests,
            [pullRequest.id]: { ...pullRequest, headDivergedAt: timestamp, updatedAt: timestamp },
          },
        },
      ] as const);
    });
    if (!outcome.changed) return;
    if (outcome.enqueued) yield* callbacks.appendEventSafely(attention);
    yield* callbacks.refresh();
    if (outcome.enqueued) yield* callbacks.releaseInboxWake();
  });

  const retryMergedRetirementForWorkstreamUnlocked = Effect.fnUntraced(function* (
    workstreamId: string,
    completionAdmission: 'already_serialized' | 'try_serialize',
  ) {
    const pullRequestIds = Object.values(namespace.state.pullRequests)
      .filter(
        (pullRequest) =>
          pullRequest.status === 'merged' && pullRequest.workstreamId === workstreamId,
      )
      .map((pullRequest) => pullRequest.id);
    for (const pullRequestId of pullRequestIds)
      yield* retireMergedPullRequest(pullRequestId, completionAdmission);
  });

  const runTerminalObservationFollowUp = Effect.fnUntraced(function* (
    followUp: TerminalObservationFollowUp | undefined,
    completionAdmission: 'already_serialized' | 'try_serialize',
  ) {
    if (!followUp) return;
    yield* callbacks.retireResolvedVerificationsForSource(followUp.sourceAgentId);
    if (followUp.mergedWorkstreamId)
      yield* semaphore.withPermit(
        retryMergedRetirementForWorkstreamUnlocked(
          followUp.mergedWorkstreamId,
          completionAdmission,
        ),
      );
  });

  const observePullRequest = (
    event: Parameters<GitHubWatcherCallbacks['onObservation']>[0],
    completionAdmission: 'already_serialized' | 'try_serialize',
  ) =>
    semaphore
      .withPermit(handlePullRequestObservation(event, completionAdmission))
      .pipe(
        Effect.flatMap((followUp) => runTerminalObservationFollowUp(followUp, completionAdmission)),
      );

  const watcherCallbacks: GitHubWatcherCallbacks = {
    cwd: () => namespace.state.repo.primaryCheckout,
    onFailure: (event) => semaphore.withPermit(handlePullRequestWatcherFailure(event)),
    onHeadDivergence: (event) => semaphore.withPermit(handlePullRequestHeadDivergence(event)),
    onObservation: (event) => observePullRequest(event, 'try_serialize'),
    onThrottleDiagnostic: (event) => semaphore.withPermit(handleWatcherThrottleDiagnostic(event)),
    persistedAssociations: () =>
      Object.values(namespace.state.pullRequests).filter(
        (pullRequest) => pullRequest.status === 'open',
      ),
  };

  const observePublishedTerminal: ReviewGateLifecycleCoordinatorShape['observePublishedTerminal'] =
    (event) =>
      observePullRequest(
        {
          complete: false,
          expectedHeadSha: event.expectedHeadSha,
          observation: {
            ci: 'unknown',
            mergeable: 'unknown',
            number: event.number,
            reviewDecision: 'unknown',
            status: event.status,
          },
          pullRequestId: event.pullRequestId,
        },
        'already_serialized',
      );

  const retirePersistedMergedPullRequests: ReviewGateLifecycleCoordinatorShape['retirePersistedMergedPullRequests'] =
    () =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const pullRequestIds = Object.values(namespace.state.pullRequests)
            .filter((pullRequest) => pullRequest.status === 'merged')
            .map((pullRequest) => pullRequest.id);
          for (const pullRequestId of pullRequestIds)
            yield* retireMergedPullRequest(pullRequestId, 'already_serialized');
        }),
      );

  const retryMergedRetirementForIdleAgent: ReviewGateLifecycleCoordinatorShape['retryMergedRetirementForIdleAgent'] =
    (agentId, workstreamId) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const pullRequestIds = Object.values(namespace.state.pullRequests)
            .filter(
              (pullRequest) =>
                pullRequest.status === 'merged' &&
                pullRequest.agentId === agentId &&
                pullRequest.workstreamId === workstreamId,
            )
            .map((pullRequest) => pullRequest.id);
          for (const pullRequestId of pullRequestIds)
            yield* retireMergedPullRequest(pullRequestId, 'try_serialize');
        }),
      );

  const retryMergedRetirementForWorkstream: ReviewGateLifecycleCoordinatorShape['retryMergedRetirementForWorkstream'] =
    (workstreamId, options) =>
      semaphore.withPermit(
        retryMergedRetirementForWorkstreamUnlocked(
          workstreamId,
          options?.alreadySerialized === true ? 'already_serialized' : 'try_serialize',
        ),
      );

  return ReviewGateLifecycleCoordinator.of({
    observePublishedTerminal,
    retirePersistedMergedPullRequests,
    retryMergedRetirementForIdleAgent,
    retryMergedRetirementForWorkstream,
    watcherCallbacks,
  });
});
