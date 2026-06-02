import { randomUUID } from 'node:crypto';
import { Cause, Clock, Context, Effect, Exit, Semaphore } from 'effect';
import {
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
  PullRequestObservation,
  PullRequestRecord,
} from './domain.ts';
import { withInbox } from './inbox.ts';
import {
  type PullRequestPublicationNamespace,
  pullRequestEventAssociation,
  pullRequestLabel,
} from './publication-coordinator.ts';
import {
  applyHandoffAudit,
  boundedEventSummary,
  boundedFailureSummary,
  type HandoffAuditOutcome,
  handoffAuditSuffix,
  hasPendingAgentAttention,
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
      return previousId === undefined || cap.oldestFetchedId > previousId;
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
        `${itemLabel(item)} by ${JSON.stringify(`@${truncateModelFacingText(item.author)}`)}: ${JSON.stringify(truncateModelFacingText(item.preview))}`,
    );
  return boundedEventSummary([
    `[external GitHub feedback] ${label} for ${pullRequest.agentId} observed ${feedback.length} new discussion item${feedback.length === 1 ? '' : 's'}.`,
    visible.join(' | '),
    feedback.length > visible.length
      ? `+${feedback.length - visible.length} more bounded item${feedback.length - visible.length === 1 ? '' : 's'} omitted.`
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

function canAutoCompleteMergedWorkstream(
  state: ManagerState,
  workstreamId: string,
  liveRuntimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): boolean {
  return (
    !hasAttachedWorker(state, workstreamId, liveRuntimes) &&
    !hasUnresolvedAgentHandoffAudit(state, workstreamId) &&
    !Object.values(state.pullRequests).some(
      (pullRequest) => pullRequest.workstreamId === workstreamId && pullRequest.status === 'open',
    ) &&
    !state.inbox.some(
      (event) =>
        !MERGED_WORKFLOW_NON_BLOCKING_EVENT_TYPES.has(event.type) &&
        eventRelatedToWorkstream(event, state, workstreamId),
    )
  );
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
    return `${label} for ${pullRequest.agentId} was merged (observation only).`;
  return `${label} for ${pullRequest.agentId} was closed without merge (observation only).`;
}

interface AutoStopAuditPersistence {
  readonly persisted: boolean;
  readonly enqueued: boolean;
}

interface TerminalObservationFollowUp {
  readonly sourceAgentId: string;
  readonly mergedWorkstreamId?: string;
}

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
    if (outcome.enqueued) yield* callbacks.releaseInboxWake();
  });

  const stopMergedPullRequestIdleWorker = Effect.fnUntraced(function* (
    pullRequest: PullRequestRecord,
  ) {
    const agent = namespace.state.agents[pullRequest.agentId];
    if (!agent || agent.workstreamId !== pullRequest.workstreamId || agent.status !== 'idle')
      return;
    const audit = yield* callbacks.auditAutoStop(agent);
    if (audit?.status === 'failed') {
      const summary = boundedEventSummary([
        `Could not auto-stop idle ${agent.id} after merge.`,
        handoffAuditSuffix(audit),
      ]);
      yield* persistAutoStopAudit(
        agent.id,
        audit,
        makeEvent(
          'agent_git_audit_failed',
          summary,
          audit.gitAudit.checkedAt,
          pullRequestEventAssociation(pullRequest),
        ),
      );
      return;
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
      return;
    }
    const stoppedResult = yield* callbacks.stopIdleWorker(agent.id).pipe(Effect.exit);
    if (Exit.isFailure(stoppedResult)) {
      const timestamp = yield* nowIso;
      const summary = boundedEventSummary([
        `Could not auto-stop idle ${agent.id} after merge; worker and worktree were preserved.`,
        boundedFailureSummary(Cause.squash(stoppedResult.cause)),
      ]);
      yield* persistAutoStopAudit(
        agent.id,
        audit,
        makeEvent(
          'agent_auto_stop_failed',
          summary,
          timestamp,
          pullRequestEventAssociation(pullRequest),
        ),
      );
      return;
    }
    const stopped = stoppedResult.value;
    if (!stopped || stopped.status !== 'stopped') {
      yield* persistAutoStopAudit(agent.id, audit);
      return;
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
    if (!persisted) return;
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
  });

  const retireMergedPullRequest = Effect.fnUntraced(function* (pullRequestId: string) {
    const known = namespace.state.pullRequests[pullRequestId];
    if (!known || known.status !== 'merged') return;
    yield* stopMergedPullRequestIdleWorker(known);
    const pullRequest = namespace.state.pullRequests[pullRequestId];
    if (!pullRequest || pullRequest.status !== 'merged') return;
    const inbox = namespace.state.inbox.filter(
      (event) => !isMergedWorkflowConsumableEvent(event, pullRequest),
    );
    const workstream = namespace.state.workstreams[pullRequest.workstreamId];
    const stateWithoutRoutineWorkerAttention =
      inbox.length === namespace.state.inbox.length
        ? namespace.state
        : withInbox(namespace.state, inbox);
    const shouldComplete =
      workstream !== undefined &&
      workstream.status !== 'complete' &&
      workstream.status !== 'cancelled' &&
      canAutoCompleteMergedWorkstream(
        stateWithoutRoutineWorkerAttention,
        workstream.id,
        callbacks.liveRuntimes(),
      );
    if (
      stateWithoutRoutineWorkerAttention === namespace.state &&
      !shouldComplete &&
      workstream?.status !== 'complete'
    )
      return;
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
      const nextState = complete
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
      return Effect.succeed([
        { changed: nextState !== state, completed: complete },
        nextState,
      ] as const);
    });
    if (!outcome.changed) return;
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
    yield* callbacks.refresh();
    yield* callbacks.releaseInboxWake();
  });

  const handlePullRequestObservation = Effect.fnUntraced(function* (event: {
    readonly pullRequestId: string;
    readonly expectedHeadSha?: string;
    readonly observation: PullRequestObservation;
    readonly discussion?: PullRequestDiscussionSnapshot;
    readonly complete?: boolean;
  }) {
    const known = namespace.state.pullRequests[event.pullRequestId];
    if (!known || !watcherEventMatchesAssociation(known, event.expectedHeadSha)) return;
    // Older watcher callbacks are complete by construction. The explicit false
    // path lets newer watcher adapters persist lifecycle metadata before their
    // bounded discussion surfaces finish without clearing an outage warning.
    const complete = event.complete !== false;
    const nextObservation = monotonicPullRequestObservation(known, event.observation);
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
      (discussionCursor !== undefined &&
        !githubDiscussionCursorsEqual(known.discussionCursor, discussionCursor)) ||
      !githubDiscussionPaginationGapsEqual(
        known.discussionPaginationGaps,
        discussionPaginationGaps,
      ) ||
      known.number !== nextObservation.number ||
      known.status !== nextObservation.status ||
      ((complete || nextObservation.status !== 'open') && known.watcherFailedAt !== undefined) ||
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
      const nextTransitions = derivePullRequestTransitions(
        pullRequest.observation,
        nextObservation,
      ).filter(
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
      const { watcherFailedAt: _watcherFailedAt, ...withoutWatcherFailure } = withoutHeadDivergence;
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
        number: nextObservation.number,
        observation: nextObservation,
        status: nextObservation.status,
        ...(nextDiscussionCursor === undefined ? {} : { discussionCursor: nextDiscussionCursor }),
        ...(nextDiscussionPaginationGaps.length === 0
          ? {}
          : { discussionPaginationGaps: nextDiscussionPaginationGaps }),
        updatedAt: timestamp,
      };
      const attention = [
        ...nextTransitions.map((transition) =>
          makeEvent(
            transition,
            pullRequestTransitionSummary(nextPullRequest, transition),
            timestamp,
            pullRequestEventAssociation(nextPullRequest),
          ),
        ),
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
    if (merged) yield* retireMergedPullRequest(event.pullRequestId);
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
  }) {
    const known = namespace.state.pullRequests[event.pullRequestId];
    if (
      !known ||
      !watcherEventMatchesAssociation(known, event.expectedHeadSha) ||
      known.status !== 'open' ||
      known.watcherFailedAt !== undefined
    )
      return;
    const timestamp = yield* nowIso;
    const attention = makeEvent(
      'watcher_failed',
      `${pullRequestLabel(known)} watcher failed; inspect GitHub CLI connectivity and authentication.`,
      timestamp,
      pullRequestEventAssociation(known),
    );
    const changed = yield* namespace.store.mutate((state) => {
      const pullRequest = state.pullRequests[event.pullRequestId];
      if (
        !pullRequest ||
        !watcherEventMatchesAssociation(pullRequest, event.expectedHeadSha) ||
        pullRequest.status !== 'open' ||
        pullRequest.watcherFailedAt !== undefined
      )
        return Effect.succeed([false, state] as const);
      return Effect.succeed([
        true,
        {
          ...state,
          inbox: [...state.inbox, attention],
          pullRequests: {
            ...state.pullRequests,
            [pullRequest.id]: { ...pullRequest, updatedAt: timestamp, watcherFailedAt: timestamp },
          },
        },
      ] as const);
    });
    if (!changed) return;
    yield* callbacks.appendEventSafely(attention);
    yield* callbacks.refresh();
    yield* callbacks.releaseInboxWake();
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
    const changed = yield* namespace.store.mutate((state) => {
      const pullRequest = state.pullRequests[event.pullRequestId];
      if (
        !pullRequest ||
        !watcherEventMatchesAssociation(pullRequest, event.expectedHeadSha) ||
        pullRequest.status !== 'open' ||
        pullRequest.headDivergedAt !== undefined
      )
        return Effect.succeed([false, state] as const);
      return Effect.succeed([
        true,
        {
          ...state,
          inbox: [...state.inbox, attention],
          pullRequests: {
            ...state.pullRequests,
            [pullRequest.id]: { ...pullRequest, headDivergedAt: timestamp, updatedAt: timestamp },
          },
        },
      ] as const);
    });
    if (!changed) return;
    yield* callbacks.appendEventSafely(attention);
    yield* callbacks.refresh();
    yield* callbacks.releaseInboxWake();
  });

  const retryMergedRetirementForWorkstreamUnlocked = Effect.fnUntraced(function* (
    workstreamId: string,
  ) {
    const pullRequestIds = Object.values(namespace.state.pullRequests)
      .filter(
        (pullRequest) =>
          pullRequest.status === 'merged' && pullRequest.workstreamId === workstreamId,
      )
      .map((pullRequest) => pullRequest.id);
    for (const pullRequestId of pullRequestIds) yield* retireMergedPullRequest(pullRequestId);
  });

  const runTerminalObservationFollowUp = Effect.fnUntraced(function* (
    followUp: TerminalObservationFollowUp | undefined,
  ) {
    if (!followUp) return;
    yield* callbacks.retireResolvedVerificationsForSource(followUp.sourceAgentId);
    if (followUp.mergedWorkstreamId)
      yield* semaphore.withPermit(
        retryMergedRetirementForWorkstreamUnlocked(followUp.mergedWorkstreamId),
      );
  });

  const observePullRequest = (event: Parameters<GitHubWatcherCallbacks['onObservation']>[0]) =>
    semaphore
      .withPermit(handlePullRequestObservation(event))
      .pipe(Effect.flatMap(runTerminalObservationFollowUp));

  const watcherCallbacks: GitHubWatcherCallbacks = {
    cwd: () => namespace.state.repo.primaryCheckout,
    onFailure: (event) => semaphore.withPermit(handlePullRequestWatcherFailure(event)),
    onHeadDivergence: (event) => semaphore.withPermit(handlePullRequestHeadDivergence(event)),
    onObservation: observePullRequest,
    onThrottleDiagnostic: (event) => semaphore.withPermit(handleWatcherThrottleDiagnostic(event)),
    persistedAssociations: () =>
      Object.values(namespace.state.pullRequests).filter(
        (pullRequest) => pullRequest.status === 'open',
      ),
  };

  const observePublishedTerminal: ReviewGateLifecycleCoordinatorShape['observePublishedTerminal'] =
    (event) =>
      observePullRequest({
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
      });

  const retirePersistedMergedPullRequests: ReviewGateLifecycleCoordinatorShape['retirePersistedMergedPullRequests'] =
    () =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const pullRequestIds = Object.values(namespace.state.pullRequests)
            .filter((pullRequest) => pullRequest.status === 'merged')
            .map((pullRequest) => pullRequest.id);
          for (const pullRequestId of pullRequestIds) yield* retireMergedPullRequest(pullRequestId);
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
          for (const pullRequestId of pullRequestIds) yield* retireMergedPullRequest(pullRequestId);
        }),
      );

  const retryMergedRetirementForWorkstream: ReviewGateLifecycleCoordinatorShape['retryMergedRetirementForWorkstream'] =
    (workstreamId) =>
      semaphore.withPermit(retryMergedRetirementForWorkstreamUnlocked(workstreamId));

  return ReviewGateLifecycleCoordinator.of({
    observePublishedTerminal,
    retirePersistedMergedPullRequests,
    retryMergedRetirementForIdleAgent,
    retryMergedRetirementForWorkstream,
    watcherCallbacks,
  });
});
