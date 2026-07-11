import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Cause, Clock, Context, Effect, Exit, Semaphore } from 'effect';
import {
  DirtyWorktreeError,
  type ManagedWorktreeShape,
  type PublishedReviewBranchTrackingOutcome,
  type WorktreeServiceError,
} from '../git/index.ts';
import {
  type BrowserHandoffShape,
  type GitHubPublicationError,
  type GitHubPublicationShape,
  isManagedPublishedReviewBranch,
  type PullRequestBrowserHandoff,
  resolvePullRequestBrowserMode,
} from '../github/index.ts';
import type { StateStoreShape, StoreError } from '../storage/index.ts';
import type { AgentRecord, ManagerEvent, ManagerState, PullRequestRecord } from './domain.ts';
import {
  AgentNotFoundError,
  formatPardesError,
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
  acceptedDurableEventDetails,
  applyHandoffAudit,
  boundedEventSummary,
  boundedFailureSummary,
  failedHandoffAudit,
  type HandoffAuditOutcome,
  handoffAuditSuffix,
  hasPendingCanonicalAttention,
  successfulHandoffAudit,
} from './worker-events.ts';

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

export interface PullRequestCreateResult {
  readonly pullRequest: PullRequestRecord;
  readonly action: 'created' | 'updated';
  readonly localTracking: PublishedReviewBranchTrackingOutcome;
  readonly browserHandoff: PullRequestBrowserHandoff;
  /** Compatibility projection for callers predating explicit browser handoff outcomes. */
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
  readonly browserHandoff: BrowserHandoffShape;
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

interface PublishedReviewGatePersistence {
  readonly reopenedWorkstream: boolean;
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

/** Allocate one coordinator per active manager namespace so both publication paths share one permit. */
export const makePullRequestPublicationCoordinator = Effect.fnUntraced(function* (
  options: PullRequestPublicationCoordinatorOptions,
) {
  const { namespace, worktrees, browserHandoff, github, callbacks } = options;
  const semaphore = yield* Semaphore.make(1);

  const trackVerifiedPublishedReviewBranch = Effect.fnUntraced(function* (
    agentId: string,
    worktree: NonNullable<AgentRecord['worktree']>,
    headBranch: string,
    headSha: string,
  ) {
    return yield* worktrees
      .trackPublishedReviewBranch(managedLeaseOwner(namespace, agentId), worktree, {
        headBranch,
        headSha,
      })
      .pipe(
        Effect.catch(() =>
          Effect.succeed({
            reason: 'local_tracking_failed' as const,
            remote: 'origin' as const,
            remoteBranch: headBranch,
            status: 'failed' as const,
          }),
        ),
      );
  });

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

  const releasePublishedReviewBranchClaimSafely = (
    agentId: string,
    cwd: string,
    headBranch: string,
    claimSha: string,
    ctx?: ExtensionContext,
  ) =>
    github
      .releasePublishedReviewBranchClaim({
        cwd,
        headBranch,
        headSha: claimSha,
        ownershipId: `${namespace.managerId}-${agentId}`,
      })
      .pipe(
        Effect.flatMap(() =>
          namespace.store.mutate((state) => {
            const agent = state.agents[agentId];
            if (!agent || agent.publishedReviewBranchClaimSha !== claimSha)
              return Effect.succeed([false, state] as const);
            const { publishedReviewBranchClaimSha: _claimSha, ...withoutClaim } = agent;
            return Effect.succeed([
              true,
              {
                ...state,
                agents: { ...state.agents, [agentId]: withoutClaim },
              },
            ] as const);
          }),
        ),
        Effect.flatMap((changed) => (changed ? callbacks.refresh(ctx) : Effect.void)),
        Effect.catch(() => Effect.void),
      );

  const reservePublishedReviewBranch = Effect.fnUntraced(function* (
    agentId: string,
    workstreamTitle: string,
    cwd: string,
    headSha: string,
    ctx?: ExtensionContext,
  ) {
    const ownershipId = `${namespace.managerId}-${agentId}`;

    const finalize = Effect.fnUntraced(function* (branch: string) {
      const timestamp = yield* nowIso;
      yield* namespace.store.mutate<void, InvalidManagedStateError>((state) => {
        const agent = state.agents[agentId];
        if (!agent)
          return Effect.fail(
            new InvalidManagedStateError({
              reason: `cannot finalize a published review branch for missing agent ${agentId}`,
            }),
          );
        if (agent.publishedReviewBranch !== branch)
          return Effect.fail(
            new InvalidManagedStateError({
              reason: `published review branch reservation changed while finalizing ${agentId}`,
            }),
          );
        const { publishedReviewBranchPending: _pending, ...withoutPending } = agent;
        return Effect.succeed([
          undefined,
          {
            ...state,
            agents: { ...state.agents, [agentId]: { ...withoutPending, updatedAt: timestamp } },
          },
        ] as const);
      });
      yield* callbacks.refresh(ctx);
      return branch;
    });

    const clearPending = Effect.fnUntraced(function* (branch: string) {
      const timestamp = yield* nowIso;
      const cleared = yield* namespace.store.mutate<boolean, never>((state) => {
        const agent = state.agents[agentId];
        if (!agent || agent.publishedReviewBranch !== branch) return Effect.succeed([false, state]);
        const {
          publishedReviewBranch: _branch,
          publishedReviewBranchClaimSha: _claimSha,
          publishedReviewBranchPending: _pending,
          ...withoutReservation
        } = agent;
        return Effect.succeed([
          true,
          {
            ...state,
            agents: {
              ...state.agents,
              [agentId]: { ...withoutReservation, updatedAt: timestamp },
            },
          },
        ] as const);
      });
      if (cleared) yield* callbacks.refresh(ctx);
    });

    const claim = Effect.fnUntraced(function* (branch: string, claimSha: string) {
      const result = yield* github.reservePublishedReviewBranch({
        cwd,
        headBranch: branch,
        headSha: claimSha,
        ownershipId,
      });
      if (result !== 'reserved') {
        yield* clearPending(branch);
        return result;
      }
      yield* finalize(branch);
      return result;
    });

    const known = namespace.state.agents[agentId];
    if (known?.publishedReviewBranch !== undefined) {
      if (known.publishedReviewBranchPending === true) {
        const claimSha = known.publishedReviewBranchClaimSha;
        if (!claimSha)
          return yield* new InvalidManagedStateError({
            reason: `pending published review branch for ${agentId} has no claim SHA`,
          });
        const recovered = yield* claim(known.publishedReviewBranch, claimSha);
        if (recovered === 'reserved') return known.publishedReviewBranch;
      } else {
        return known.publishedReviewBranch;
      }
    }

    const attempted = new Set<string>();
    for (let plan = 0; plan < 2; plan++) {
      const candidates = yield* github.publishedReviewBranchCandidates({
        cwd,
        disambiguator: agentId,
        fallbackDisambiguator: namespace.managerId,
        workstreamTitle,
      });
      let replan = false;
      for (const branch of candidates) {
        if (attempted.has(branch)) continue;
        attempted.add(branch);
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
            { branch, changed: true },
            {
              ...state,
              agents: {
                ...state.agents,
                [agentId]: {
                  ...agent,
                  publishedReviewBranch: branch,
                  publishedReviewBranchClaimSha: headSha,
                  publishedReviewBranchPending: true,
                  updatedAt: timestamp,
                },
              },
            },
          ] as const);
        });
        if (reservation.changed) yield* callbacks.refresh(ctx);
        if (reservation.branch !== branch) return reservation.branch;
        const reserved = yield* claim(branch, headSha);
        if (reserved === 'reserved') return branch;
        if (reserved === 'hierarchy_collision') {
          replan = true;
          break;
        }
      }
      if (!replan) break;
    }
    return yield* new PullRequestPublicationValidationError({
      reason: `could not allocate a unique published review branch for ${agentId}`,
    });
  });

  const enqueueAutoSyncAttention = Effect.fnUntraced(function* (
    agent: AgentRecord,
    summary: string,
    pullRequest?: PullRequestRecord,
    details = summary,
  ) {
    const timestamp = yield* nowIso;
    const association = pullRequest
      ? pullRequestEventAssociation(pullRequest)
      : { agentId: agent.id, workstreamId: agent.workstreamId };
    const boundedSummary = boundedEventSummary([summary]);
    const acceptedDetails = acceptedDurableEventDetails(
      details,
      'pull-request auto-sync diagnostic',
    );
    const event = {
      ...makeEvent('pull_request_auto_sync_attention', boundedSummary, timestamp, association),
      ...(acceptedDetails === boundedSummary ? {} : { details: acceptedDetails }),
    };
    const projection = yield* namespace.store.mutate<AutoSyncAttentionProjection, never>(
      (state) => {
        const alreadyPending = hasPendingCanonicalAttention(state.inbox, event);
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
    if (workstream.status !== 'active') {
      return yield* new PullRequestPublicationValidationError({
        reason: `workstream ${workstream.id} is ${workstream.status}; review-gate publication requires an active workstream`,
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
    const associationHasManagedReservation =
      existingAssociation?.headBranch !== undefined &&
      agent.publishedReviewBranch === existingAssociation.headBranch &&
      isManagedPublishedReviewBranch(existingAssociation.headBranch);
    if (
      existingAssociation?.headBranch !== undefined &&
      !associationHasManagedReservation &&
      existingAssociation.number === undefined
    ) {
      return yield* new PullRequestPublicationValidationError({
        reason: `persisted compatibility review gate ${pullRequestLabel(existingAssociation)} has no pull-request number for update-only publication`,
      });
    }
    const headBranch =
      existingAssociation?.headBranch ??
      (yield* reservePublishedReviewBranch(
        agent.id,
        workstream.title,
        worktree.path,
        inspection.headSha,
        ctx,
      ));
    const persistedAgent = namespace.state.agents[agent.id];
    const claimSha = persistedAgent?.publishedReviewBranchClaimSha;
    const publication = yield* github.publish({
      baseBranch: input.baseBranch,
      body: input.body,
      cwd: worktree.path,
      headBranch,
      headSha: inspection.headSha,
      title: input.title,
      ...(claimSha === undefined
        ? {}
        : {
            humanHeadBranchReservation: {
              claimSha,
              ownershipId: `${namespace.managerId}-${agent.id}`,
            },
          }),
      ...(existingAssociation?.number === undefined
        ? {}
        : { legacyExistingPullRequestNumber: existingAssociation.number }),
    });
    // The Git adapter runs only after GitHub returned the exact hosted head it
    // verified. Local tracking is a non-publication convenience: its bounded
    // failure must not erase or misreport an already successful publication.
    const localTracking = yield* trackVerifiedPublishedReviewBranch(
      agent.id,
      worktree,
      publication.headBranch,
      inspection.headSha,
    );
    const timestamp = yield* nowIso;
    const id = `pr-${publication.number}`;
    const persistence = yield* namespace.store.mutate<
      PublishedReviewGatePersistence,
      InvalidManagedStateError
    >((current) => {
      const currentAgent = current.agents[agent.id] ?? agent;
      const currentPullRequest = current.pullRequests[id];
      const currentWorkstream = current.workstreams[workstream.id];
      if (!currentWorkstream) {
        return Effect.fail(
          new InvalidManagedStateError({
            reason: `published review gate ${id} lost its owning workstream ${workstream.id} before durable association`,
          }),
        );
      }
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
        ...(currentPullRequest?.watcherFailure === undefined
          ? {}
          : { watcherFailure: currentPullRequest.watcherFailure }),
        createdAt: currentPullRequest?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const reopenWorkstream =
        pullRequest.status === 'open' && currentWorkstream.status !== 'active';
      return Effect.succeed([
        { reopenedWorkstream: reopenWorkstream },
        {
          ...current,
          agents: {
            ...current.agents,
            [agent.id]: { ...applyHandoffAudit(currentAgent, audit), updatedAt: timestamp },
          },
          pullRequests: { ...current.pullRequests, [pullRequest.id]: pullRequest },
          workstreams: reopenWorkstream
            ? {
                ...current.workstreams,
                [currentWorkstream.id]: {
                  ...currentWorkstream,
                  status: 'active',
                  updatedAt: timestamp,
                },
              }
            : current.workstreams,
        },
      ] as const);
    });
    if (claimSha !== undefined)
      yield* releasePublishedReviewBranchClaimSafely(
        agent.id,
        worktree.path,
        headBranch,
        claimSha,
        ctx,
      );
    yield* callbacks.appendEventSafely(
      makeEvent(
        'pull_request_published',
        `${publication.action === 'created' ? 'Created' : 'Updated'} ${publication.draft ? 'draft ' : ''}review gate #${publication.number} for ${agent.id}: ${publication.url}`,
        timestamp,
      ),
    );
    if (localTracking.status === 'failed') {
      yield* callbacks.appendEventSafely(
        makeEvent(
          'pull_request_local_tracking_failed',
          `Published review gate #${publication.number} at audited SHA ${inspection.headSha}, but local tracking of origin/${publication.headBranch} failed safely; remote publication remains verified.`,
          timestamp,
          { agentId: agent.id, pullRequestId: id, workstreamId: workstream.id },
        ),
      );
    }
    if (persistence.reopenedWorkstream) {
      yield* callbacks.appendEventSafely(
        makeEvent(
          'workstream_reopened_for_published_review_gate',
          `Reopened ${workstream.id} because newly published remote review gate #${publication.number} remains open; retained review ownership was preserved.`,
          timestamp,
          { agentId: agent.id, pullRequestId: id, workstreamId: workstream.id },
        ),
      );
    }
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
    // Browser launch is deliberately last: a slow or failing desktop opener must
    // never delay durable association, claim release, event recording, terminal
    // observation, or watcher reconciliation for an already verified remote PR.
    // Consume the exact verified hosted URL, not reloaded same-user mutable state.
    const handoff = yield* browserHandoff.handoff(
      publication.url,
      resolvePullRequestBrowserMode(input),
    );
    return {
      action: publication.action,
      browserHandoff: handoff,
      localTracking,
      openedInBrowser: handoff.status === 'opened',
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
        audit.status === 'failed' ? audit.failureDetails : handoffAuditSuffix(audit),
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
      const failure = Cause.squash(syncResult.cause);
      yield* enqueueAutoSyncAttention(
        agent,
        boundedEventSummary([
          `Could not auto-sync ${pullRequestLabel(pullRequest)} for ${agent.id}; review gate and managed worktree were preserved.`,
          boundedFailureSummary(failure),
        ]),
        pullRequest,
        formatPardesError(failure),
      );
      return;
    }
    if (syncResult.value.status === 'terminal') {
      yield* callbacks.reconcilePullRequestsSafely();
      return;
    }
    const localTracking = yield* trackVerifiedPublishedReviewBranch(
      agent.id,
      worktree,
      pullRequest.headBranch,
      inspection.headSha,
    );
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
    if (localTracking.status === 'failed') {
      yield* enqueueAutoSyncAttention(
        agent,
        `Auto-synced ${pullRequestLabel(pullRequest)} to audited SHA ${inspection.headSha}, but local tracking of origin/${pullRequest.headBranch} failed safely; remote publication remains verified.`,
        pullRequest,
      );
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
