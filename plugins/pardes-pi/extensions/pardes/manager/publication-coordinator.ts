import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Cause, Clock, Context, Effect, Exit, Semaphore } from 'effect';
import {
  DirtyWorktreeError,
  type ManagedWorktreeShape,
  type WorktreeServiceError,
} from '../git/index.ts';
import {
  type GitHubPublicationError,
  type GitHubPublicationShape,
  isManagedPublishedReviewBranch,
  READABLE_PUBLISHED_REVIEW_BRANCH_PREFIX,
} from '../github/index.ts';
import type { StateStoreShape, StoreError } from '../storage/index.ts';
import type { AgentRecord, ManagerEvent, ManagerState, PullRequestRecord } from './domain.ts';
import {
  AgentNotFoundError,
  InvalidManagedStateError,
  PullRequestPublicationValidationError,
  WorkstreamNotFoundError,
} from './errors.ts';
import type { PullRequestCreateInput } from './inputs.ts';
import {
  type ManagerNamespaceContext,
  managedLeaseOwner,
  validateRetainedAgentState,
} from './namespace.ts';
import {
  applyHandoffAudit,
  boundedEventSummary,
  boundedFailureSummary,
  failedHandoffAudit,
  type HandoffAuditOutcome,
  handoffAuditSuffix,
  hasPendingAgentAttention,
  successfulHandoffAudit,
} from './worker-events.ts';

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

export interface PullRequestCreateResult {
  readonly pullRequest: PullRequestRecord;
  readonly action: 'created' | 'updated';
  readonly openedInBrowser: boolean;
}

export type PullRequestPublicationCoordinatorError =
  | StoreError
  | InvalidManagedStateError
  | WorkstreamNotFoundError
  | AgentNotFoundError
  | PullRequestPublicationValidationError
  | WorktreeServiceError
  | GitHubPublicationError;

export interface PullRequestPublicationCoordinatorShape {
  readonly publish: (
    input: PullRequestCreateInput,
    ctx?: ExtensionContext,
  ) => Effect.Effect<PullRequestCreateResult, PullRequestPublicationCoordinatorError>;
  readonly syncCompletedReport: (
    agentId: string,
  ) => Effect.Effect<void, StoreError | InvalidManagedStateError>;
}

export class PullRequestPublicationCoordinator extends Context.Service<
  PullRequestPublicationCoordinator,
  PullRequestPublicationCoordinatorShape
>()('pardes/PullRequestPublicationCoordinator') {}

export interface PullRequestPublicationNamespace extends ManagerNamespaceContext {
  readonly store: StateStoreShape;
  state: ManagerState;
}

export interface PullRequestPublicationCoordinatorCallbacks {
  readonly refresh: (
    ctx?: ExtensionContext,
  ) => Effect.Effect<void, StoreError | InvalidManagedStateError>;
  readonly appendEventSafely: (event: ManagerEvent) => Effect.Effect<void>;
  readonly observePublishedTerminal: (event: {
    readonly pullRequestId: string;
    readonly expectedHeadSha: string;
    readonly number: number;
    readonly status: 'merged' | 'closed';
  }) => Effect.Effect<void>;
  readonly reconcilePullRequestsSafely: () => Effect.Effect<void>;
  readonly releaseInboxWake: () => Effect.Effect<boolean, StoreError | InvalidManagedStateError>;
}

export interface PullRequestPublicationCoordinatorOptions {
  readonly namespace: PullRequestPublicationNamespace;
  readonly worktrees: ManagedWorktreeShape;
  readonly github: GitHubPublicationShape;
  readonly callbacks: PullRequestPublicationCoordinatorCallbacks;
}

interface AutoSyncAttentionProjection {
  readonly enqueued: boolean;
}

interface PublishedReviewBranchReservation {
  readonly branch: string;
  readonly changed: boolean;
}

type ManagerEventAssociation = Pick<ManagerEvent, 'workstreamId' | 'agentId' | 'pullRequestId'>;

function makeEvent(
  type: string,
  summary: string,
  createdAt: string,
  association: ManagerEventAssociation = {},
): ManagerEvent {
  return { createdAt, id: randomUUID(), summary, type, ...association };
}

export function pullRequestLabel(pullRequest: PullRequestRecord): string {
  return pullRequest.number === undefined ? pullRequest.id : `#${pullRequest.number}`;
}

export function pullRequestEventAssociation(
  pullRequest: PullRequestRecord,
): ManagerEventAssociation {
  return {
    agentId: pullRequest.agentId,
    pullRequestId: pullRequest.id,
    workstreamId: pullRequest.workstreamId,
  };
}

export const PUBLISHED_REVIEW_BRANCH_SLUG_MAX_LENGTH = 64;
const PUBLISHED_REVIEW_BRANCH_RESERVATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readablePublishedReviewBranchSlug(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PUBLISHED_REVIEW_BRANCH_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug || fallback;
}

export function readablePublishedReviewBranch(
  workstreamName: string,
  taskName: string,
  reservationId: string,
): string {
  if (!PUBLISHED_REVIEW_BRANCH_RESERVATION_ID_PATTERN.test(reservationId))
    throw new Error('Published review branch reservation ID must be a UUID.');
  const workstream = readablePublishedReviewBranchSlug(workstreamName, 'workstream');
  const task = readablePublishedReviewBranchSlug(taskName, 'task');
  return `${READABLE_PUBLISHED_REVIEW_BRANCH_PREFIX}${workstream}-${task}-${reservationId}`;
}

function allocateReadablePublishedReviewBranch(workstreamName: string, taskName: string): string {
  return readablePublishedReviewBranch(workstreamName, taskName, randomUUID());
}

/** Allocate one coordinator per active manager namespace so both publication paths share one permit. */
export const makePullRequestPublicationCoordinator = Effect.fnUntraced(function* (
  options: PullRequestPublicationCoordinatorOptions,
) {
  const { namespace, worktrees, github, callbacks } = options;
  const semaphore = yield* Semaphore.make(1);

  const persistAgentAudit = Effect.fnUntraced(function* (
    agentId: string,
    audit: HandoffAuditOutcome,
    ctx?: ExtensionContext,
  ) {
    const persisted = yield* namespace.store.mutate((state) => {
      const agent = state.agents[agentId];
      if (!agent) return Effect.succeed([false, state] as const);
      return Effect.succeed([
        true,
        { ...state, agents: { ...state.agents, [agentId]: applyHandoffAudit(agent, audit) } },
      ] as const);
    });
    if (persisted) yield* callbacks.refresh(ctx);
  });

  const reservePublishedReviewBranch = Effect.fnUntraced(function* (
    agentId: string,
    workstreamName: string,
    ctx?: ExtensionContext,
  ) {
    const agent = namespace.state.agents[agentId];
    const allocated = allocateReadablePublishedReviewBranch(
      workstreamName,
      agent?.title ?? agent?.task ?? 'task',
    );
    const timestamp = yield* nowIso;
    const reservation = yield* namespace.store.mutate<
      PublishedReviewBranchReservation,
      InvalidManagedStateError
    >((state) => {
      const agent = state.agents[agentId];
      if (!agent)
        return Effect.fail(
          new InvalidManagedStateError({
            reason: `cannot reserve a published review branch for missing agent ${agentId}`,
          }),
        );
      if (agent.publishedReviewBranch !== undefined) {
        return Effect.succeed([
          { branch: agent.publishedReviewBranch, changed: false },
          state,
        ] as const);
      }
      return Effect.succeed([
        { branch: allocated, changed: true },
        {
          ...state,
          agents: {
            ...state.agents,
            [agentId]: { ...agent, publishedReviewBranch: allocated, updatedAt: timestamp },
          },
        },
      ] as const);
    });
    if (reservation.changed) yield* callbacks.refresh(ctx);
    return reservation.branch;
  });

  const enqueueAutoSyncAttention = Effect.fnUntraced(function* (
    agent: AgentRecord,
    summary: string,
    pullRequest?: PullRequestRecord,
  ) {
    const timestamp = yield* nowIso;
    const association = pullRequest
      ? pullRequestEventAssociation(pullRequest)
      : { agentId: agent.id, workstreamId: agent.workstreamId };
    const event = makeEvent(
      'pull_request_auto_sync_attention',
      boundedEventSummary([summary]),
      timestamp,
      association,
    );
    const projection = yield* namespace.store.mutate<AutoSyncAttentionProjection, never>(
      (state) => {
        const alreadyPending = hasPendingAgentAttention(state.inbox, event);
        return Effect.succeed([
          { enqueued: !alreadyPending },
          alreadyPending ? state : { ...state, inbox: [...state.inbox, event] },
        ] as const);
      },
    );
    if (!projection.enqueued) return;
    yield* callbacks.appendEventSafely(event);
    yield* callbacks.refresh();
    yield* callbacks.releaseInboxWake();
  });

  const publishUnlocked = Effect.fnUntraced(function* (
    input: PullRequestCreateInput,
    ctx?: ExtensionContext,
  ) {
    yield* callbacks.refresh(ctx);
    const state = namespace.state;
    const workstream = state.workstreams[input.workstreamId];
    if (!workstream)
      return yield* new WorkstreamNotFoundError({ workstreamId: input.workstreamId });
    const agent = state.agents[input.agentId];
    if (!agent) return yield* new AgentNotFoundError({ agentId: input.agentId });
    if (agent.workstreamId !== workstream.id) {
      return yield* new PullRequestPublicationValidationError({
        reason: `agent ${agent.id} belongs to ${agent.workstreamId}, not ${workstream.id}`,
      });
    }
    if (agent.role !== 'worker' || !agent.worktree) {
      return yield* new PullRequestPublicationValidationError({
        reason: `agent ${agent.id} has no managed worker worktree`,
      });
    }
    const worktree = agent.worktree;
    const inspectionResult = yield* validateRetainedAgentState(
      namespace,
      input.agentId,
      agent,
    ).pipe(
      Effect.flatMap(() =>
        worktrees.inspect(managedLeaseOwner(namespace, input.agentId), worktree),
      ),
      Effect.exit,
    );
    const auditedAt = yield* nowIso;
    const audit = Exit.isSuccess(inspectionResult)
      ? successfulHandoffAudit('publication', auditedAt, inspectionResult.value)
      : failedHandoffAudit('publication', auditedAt, Cause.squash(inspectionResult.cause));
    yield* persistAgentAudit(agent.id, audit, ctx);
    if (Exit.isFailure(inspectionResult)) return yield* Effect.failCause(inspectionResult.cause);
    const inspection = inspectionResult.value;
    if (inspection.dirty)
      return yield* new DirtyWorktreeError({
        changedPaths: inspection.changedPaths,
        path: inspection.path,
      });
    const existingAssociations = Object.values(namespace.state.pullRequests).filter(
      (pullRequest) => pullRequest.agentId === agent.id && pullRequest.status === 'open',
    );
    if (existingAssociations.length > 1) {
      return yield* new PullRequestPublicationValidationError({
        reason: `agent ${agent.id} has ${existingAssociations.length} persisted open review-gate associations; expected at most one`,
      });
    }
    const existingAssociation = existingAssociations[0];
    if (
      existingAssociation?.baseBranch !== undefined &&
      existingAssociation.baseBranch !== input.baseBranch
    ) {
      return yield* new PullRequestPublicationValidationError({
        reason: `persisted open review gate ${pullRequestLabel(existingAssociation)} targets base ${existingAssociation.baseBranch}; close it before publishing to ${input.baseBranch}`,
      });
    }
    if (existingAssociation !== undefined && existingAssociation.headBranch === undefined) {
      return yield* new PullRequestPublicationValidationError({
        reason: `persisted open review gate ${pullRequestLabel(existingAssociation)} has no published head branch`,
      });
    }
    if (
      existingAssociation?.headBranch !== undefined &&
      !isManagedPublishedReviewBranch(existingAssociation.headBranch) &&
      existingAssociation.number === undefined
    ) {
      return yield* new PullRequestPublicationValidationError({
        reason: `persisted legacy review gate ${pullRequestLabel(existingAssociation)} has no pull-request number for update-only publication`,
      });
    }
    const headBranch =
      existingAssociation?.headBranch ??
      (yield* reservePublishedReviewBranch(agent.id, workstream.title, ctx));
    const publication = yield* github.publish({
      baseBranch: input.baseBranch,
      body: input.body,
      cwd: worktree.path,
      headBranch,
      headSha: inspection.headSha,
      title: input.title,
      ...(input.openInBrowser === undefined ? {} : { openInBrowser: input.openInBrowser }),
      ...(existingAssociation?.number !== undefined && !isManagedPublishedReviewBranch(headBranch)
        ? { legacyExistingPullRequestNumber: existingAssociation.number }
        : {}),
    });
    const timestamp = yield* nowIso;
    const id = `pr-${publication.number}`;
    yield* namespace.store.mutate((current) => {
      const currentAgent = current.agents[agent.id] ?? agent;
      const currentPullRequest = current.pullRequests[id];
      const pullRequest: PullRequestRecord = {
        agentId: agent.id,
        baseBranch: publication.baseBranch,
        draft: publication.draft,
        headBranch: publication.headBranch,
        id,
        lastPushedHeadSha: inspection.headSha,
        number: publication.number,
        publishedChangedPaths: inspection.changedPaths,
        // Final publication metadata enters terminal lifecycle only after this
        // audited association generation is durable. The review-gate lifecycle
        // owns monotonic terminal projection, attention, and merged retirement.
        status: currentPullRequest?.status ?? 'open',
        title: publication.title,
        url: publication.url,
        workstreamId: workstream.id,
        ...(currentPullRequest?.status === 'open' || currentPullRequest?.observation === undefined
          ? {}
          : { observation: currentPullRequest.observation }),
        ...(currentPullRequest?.discussionCursor !== undefined
          ? { discussionCursor: currentPullRequest.discussionCursor }
          : currentPullRequest === undefined && publication.action === 'created'
            ? { discussionCursor: {} }
            : {}),
        ...(currentPullRequest?.discussionPaginationGaps === undefined
          ? {}
          : { discussionPaginationGaps: currentPullRequest.discussionPaginationGaps }),
        ...(currentPullRequest?.watcherFailedAt === undefined
          ? {}
          : { watcherFailedAt: currentPullRequest.watcherFailedAt }),
        createdAt: currentPullRequest?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      return Effect.succeed([
        undefined,
        {
          ...current,
          agents: {
            ...current.agents,
            [agent.id]: { ...applyHandoffAudit(currentAgent, audit), updatedAt: timestamp },
          },
          pullRequests: { ...current.pullRequests, [pullRequest.id]: pullRequest },
        },
      ] as const);
    });
    yield* callbacks.appendEventSafely(
      makeEvent(
        'pull_request_published',
        `${publication.action === 'created' ? 'Created' : 'Updated'} ${publication.draft ? 'draft ' : ''}review gate #${publication.number} for ${agent.id}: ${publication.url}`,
        timestamp,
      ),
    );
    yield* callbacks.refresh(ctx);
    if (publication.status !== 'open') {
      yield* callbacks.observePublishedTerminal({
        expectedHeadSha: inspection.headSha,
        number: publication.number,
        pullRequestId: id,
        status: publication.status,
      });
    }
    yield* callbacks.reconcilePullRequestsSafely();
    const persistedPullRequest = namespace.state.pullRequests[id];
    if (!persistedPullRequest) {
      return yield* new PullRequestPublicationValidationError({
        reason: `published review gate ${id} disappeared from durable manager state`,
      });
    }
    return {
      action: publication.action,
      openedInBrowser: publication.openedInBrowser,
      pullRequest: persistedPullRequest,
    } satisfies PullRequestCreateResult;
  });

  const syncCompletedReportUnlocked = Effect.fnUntraced(function* (agentId: string) {
    yield* callbacks.refresh();
    const agent = namespace.state.agents[agentId];
    if (!agent) return;
    const associations = Object.values(namespace.state.pullRequests).filter(
      (pullRequest) => pullRequest.agentId === agent.id && pullRequest.status === 'open',
    );
    if (associations.length === 0) return;
    if (associations.length !== 1) {
      yield* enqueueAutoSyncAttention(
        agent,
        `Did not auto-sync ${agent.id}: found ${associations.length} persisted open review-gate associations; expected exactly one.`,
      );
      return;
    }
    const pullRequest = associations[0];
    if (!pullRequest) return;
    if (agent.role !== 'worker' || !agent.worktree) {
      yield* enqueueAutoSyncAttention(
        agent,
        `Did not auto-sync ${pullRequestLabel(pullRequest)} for ${agent.id}: retained agent has no managed worker worktree.`,
        pullRequest,
      );
      return;
    }
    const worktree = agent.worktree;
    const checkedAt = yield* nowIso;
    const inspectionResult = yield* validateRetainedAgentState(namespace, agent.id, agent).pipe(
      Effect.flatMap(() => worktrees.inspect(managedLeaseOwner(namespace, agent.id), worktree)),
      Effect.exit,
    );
    const audit = Exit.isSuccess(inspectionResult)
      ? successfulHandoffAudit('auto_sync', checkedAt, inspectionResult.value)
      : failedHandoffAudit('auto_sync', checkedAt, Cause.squash(inspectionResult.cause));
    if (Exit.isFailure(inspectionResult)) {
      yield* persistAgentAudit(agent.id, audit);
      yield* enqueueAutoSyncAttention(
        agent,
        boundedEventSummary([
          `Did not auto-sync ${pullRequestLabel(pullRequest)} for ${agent.id}: fresh managed-worktree audit failed.`,
          handoffAuditSuffix(audit),
        ]),
        pullRequest,
      );
      return;
    }
    const inspection = inspectionResult.value;
    if (inspection.dirty) {
      yield* persistAgentAudit(agent.id, audit);
      yield* enqueueAutoSyncAttention(
        agent,
        boundedEventSummary([
          `Did not auto-sync ${pullRequestLabel(pullRequest)} for ${agent.id}: managed worktree is dirty.`,
          handoffAuditSuffix(audit),
        ]),
        pullRequest,
      );
      return;
    }
    if (inspection.headSha === pullRequest.lastPushedHeadSha) return;
    yield* persistAgentAudit(agent.id, audit);
    if (pullRequest.number === undefined) {
      yield* enqueueAutoSyncAttention(
        agent,
        `Did not auto-sync ${pullRequestLabel(pullRequest)} for ${agent.id}: persisted review-gate association has no pull-request number.`,
        pullRequest,
      );
      return;
    }
    if (pullRequest.headBranch === undefined) {
      yield* enqueueAutoSyncAttention(
        agent,
        `Did not auto-sync ${pullRequestLabel(pullRequest)} for ${agent.id}: persisted review-gate association has no published head branch.`,
        pullRequest,
      );
      return;
    }
    const syncResult = yield* github
      .syncExisting({
        cwd: worktree.path,
        headBranch: pullRequest.headBranch,
        headSha: inspection.headSha,
        pullRequestNumber: pullRequest.number,
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(syncResult)) {
      yield* enqueueAutoSyncAttention(
        agent,
        boundedEventSummary([
          `Could not auto-sync ${pullRequestLabel(pullRequest)} for ${agent.id}; review gate and managed worktree were preserved.`,
          boundedFailureSummary(Cause.squash(syncResult.cause)),
        ]),
        pullRequest,
      );
      return;
    }
    if (syncResult.value.status === 'terminal') {
      yield* callbacks.reconcilePullRequestsSafely();
      return;
    }
    const timestamp = yield* nowIso;
    const persisted = yield* namespace.store.mutate((state) => {
      const currentPullRequest = state.pullRequests[pullRequest.id];
      if (!currentPullRequest) return Effect.succeed([false, state] as const);
      const {
        observation: _observation,
        headDivergedAt: _headDivergedAt,
        ...withoutStaleWatcherProjection
      } = currentPullRequest;
      const nextPullRequest: PullRequestRecord = {
        ...(currentPullRequest.status === 'open'
          ? withoutStaleWatcherProjection
          : currentPullRequest),
        lastPushedHeadSha: inspection.headSha,
        publishedChangedPaths: inspection.changedPaths,
        updatedAt: timestamp,
      };
      return Effect.succeed([
        true,
        {
          ...state,
          pullRequests: { ...state.pullRequests, [currentPullRequest.id]: nextPullRequest },
        },
      ] as const);
    });
    if (persisted) {
      yield* callbacks.appendEventSafely(
        makeEvent(
          'pull_request_auto_synced',
          `Auto-synced ${pullRequestLabel(pullRequest)} for ${agent.id} to audited SHA ${inspection.headSha}.`,
          timestamp,
          pullRequestEventAssociation(pullRequest),
        ),
      );
      yield* callbacks.refresh();
    }
    yield* callbacks.reconcilePullRequestsSafely();
  });

  const publish: PullRequestPublicationCoordinatorShape['publish'] = (input, ctx) =>
    semaphore.withPermit(publishUnlocked(input, ctx));
  const syncCompletedReport: PullRequestPublicationCoordinatorShape['syncCompletedReport'] = (
    agentId,
  ) => semaphore.withPermit(syncCompletedReportUnlocked(agentId));

  return PullRequestPublicationCoordinator.of({ publish, syncCompletedReport });
});
