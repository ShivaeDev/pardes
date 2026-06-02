import {
  Context,
  type Duration,
  Effect,
  Exit,
  Layer,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from 'effect';
import { decodeGitHubJson } from './codecs.ts';
import { type GitHubCommandError, GitHubResponseError, GitHubWatcherInputError } from './errors.ts';
import {
  type GitHubHostedMetadataShape,
  makeGitHubHostedMetadataAdapter,
} from './hosted-metadata.ts';
import {
  GITHUB_DISCUSSION_PREVIEW_MAX_LENGTH,
  type GitHubDiscussionCursor,
  type GitHubDiscussionSurface,
  GitHubInlineReviewCommentsSchema,
  GitHubPullRequestDiscussionGraphQLSchema,
  type GitHubPullRequestObservation,
  GitHubPullRequestObservationSchema,
  MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE,
  PullRequestAssociationSchema,
} from './schemas.ts';
import {
  type GitHubCommandRunnerShape,
  makeExecFileGitHubCommandRunner,
  makeGitHubCli,
} from './transport.ts';

export const DEFAULT_GITHUB_WATCHER_CADENCE: Duration.Input = '15 seconds';
const WATCHER_JSON_FIELDS = 'number,headRefOid,state,mergeable,reviewDecision,statusCheckRollup';
const DISCUSSION_GRAPHQL_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$limit:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){comments(last:$limit){nodes{databaseId author{login} body} pageInfo{hasPreviousPage}} reviews(last:$limit){nodes{databaseId author{login} body submittedAt} pageInfo{hasPreviousPage}}}} rateLimit{cost limit remaining resetAt}}`;

export type PullRequestWatcherTransition =
  | 'ci_failed'
  | 'review_feedback'
  | 'conflict'
  | 'merged'
  | 'closed_unmerged';
export type GitHubWatcherError = GitHubWatcherInputError | GitHubResponseError | GitHubCommandError;

/** Content-free projection emitted from the GitHub adapter into manager state. */
export interface PullRequestObservation {
  readonly number: number;
  readonly status: 'open' | 'merged' | 'closed';
  readonly ci: 'unknown' | 'pending' | 'passing' | 'failing';
  readonly reviewDecision: 'unknown' | 'approved' | 'changes_requested' | 'review_required';
  readonly mergeable: 'unknown' | 'mergeable' | 'conflicting';
}

/** Minimal persisted association required by the watcher adapter. */
export interface PullRequestWatcherAssociation {
  readonly id: string;
  readonly url: string;
  readonly number?: number;
  readonly lastPushedHeadSha?: string;
}

export type PullRequestDiscussionFeedbackKind = GitHubDiscussionSurface;

/** Content-free signal that a bounded API page may omit older items on one surface. */
export interface PullRequestDiscussionPageCap {
  readonly surface: GitHubDiscussionSurface;
  readonly oldestFetchedId: number;
}

/** Bounded, provenance-labelled projection of one untrusted external feedback item. */
export interface PullRequestDiscussionFeedback {
  readonly kind: PullRequestDiscussionFeedbackKind;
  readonly id: number;
  readonly author: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
}

/** Transient bounded snapshot. Only its content-free cursor and detected gap surfaces are durable. */
export interface PullRequestDiscussionSnapshot {
  readonly cursor: GitHubDiscussionCursor;
  readonly feedback: ReadonlyArray<PullRequestDiscussionFeedback>;
  readonly pageCaps?: ReadonlyArray<PullRequestDiscussionPageCap>;
}

export interface PullRequestWatcherObservation {
  readonly pullRequestId: string;
  /** Audited association head captured before remote inspection began. */
  readonly expectedHeadSha?: string;
  readonly observation: PullRequestObservation;
  /** Present after every bounded discussion surface has also been inspected. */
  readonly discussion?: PullRequestDiscussionSnapshot;
  /** Only complete observations clear a previously reported watcher failure. */
  readonly complete: boolean;
}

export interface PullRequestWatcherFailure {
  readonly pullRequestId: string;
  /** Audited association head captured before remote inspection began. */
  readonly expectedHeadSha?: string;
  readonly error: GitHubWatcherError;
}

export interface PullRequestWatcherHeadDivergence {
  readonly pullRequestId: string;
  readonly expectedHeadSha: string;
  readonly observedHeadSha: string;
}

export interface GitHubWatcherCallbacks {
  readonly cwd: () => string;
  readonly persistedAssociations: () => ReadonlyArray<PullRequestWatcherAssociation>;
  readonly onObservation: (event: PullRequestWatcherObservation) => Effect.Effect<void, unknown>;
  readonly onFailure: (event: PullRequestWatcherFailure) => Effect.Effect<void, unknown>;
  readonly onHeadDivergence: (
    event: PullRequestWatcherHeadDivergence,
  ) => Effect.Effect<void, unknown>;
}

export interface GitHubWatcherShape {
  readonly start: (callbacks: GitHubWatcherCallbacks) => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
  readonly reconcile: () => Effect.Effect<void, unknown>;
  readonly poll: (callbacks: GitHubWatcherCallbacks) => Effect.Effect<void, unknown>;
}

/** Caller-facing watcher port. The active polling fiber belongs to start/stop scope ownership. */
export class GitHubWatcher extends Context.Service<GitHubWatcher, GitHubWatcherShape>()(
  'pardes/github/GitHubWatcher',
) {
  static readonly layer = Layer.effect(
    GitHubWatcher,
    Effect.acquireRelease(
      Effect.sync(() => makeGitHubWatcherService()),
      (watcher) => watcher.stop(),
    ),
  );
}

interface ActiveWatcher {
  readonly callbacks: GitHubWatcherCallbacks;
  readonly scope: Scope.Closeable;
}

function watcherInputError(cause: unknown): GitHubWatcherInputError {
  return new GitHubWatcherInputError({ cause });
}

function status(state: GitHubPullRequestObservation['state']): PullRequestObservation['status'] {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

function reviewDecision(
  decision: GitHubPullRequestObservation['reviewDecision'],
): PullRequestObservation['reviewDecision'] {
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (decision === 'REVIEW_REQUIRED') return 'review_required';
  return 'unknown';
}

function mergeable(
  value: GitHubPullRequestObservation['mergeable'],
): PullRequestObservation['mergeable'] {
  if (value === 'MERGEABLE') return 'mergeable';
  if (value === 'CONFLICTING') return 'conflicting';
  return 'unknown';
}

const FAILED_CHECK_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);

function ci(
  statusChecks: GitHubPullRequestObservation['statusCheckRollup'],
): PullRequestObservation['ci'] {
  if (statusChecks.length === 0) return 'unknown';
  let pending = false;
  for (const statusCheck of statusChecks) {
    if ('state' in statusCheck) {
      if (statusCheck.state === 'ERROR' || statusCheck.state === 'FAILURE') return 'failing';
      if (statusCheck.state === 'EXPECTED' || statusCheck.state === 'PENDING') pending = true;
      continue;
    }
    if (statusCheck.conclusion !== null && FAILED_CHECK_CONCLUSIONS.has(statusCheck.conclusion))
      return 'failing';
    if (
      statusCheck.status !== 'COMPLETED' ||
      statusCheck.conclusion === null ||
      statusCheck.conclusion === ''
    )
      pending = true;
  }
  return pending ? 'pending' : 'passing';
}

function toObservation(input: GitHubPullRequestObservation): PullRequestObservation {
  return {
    ci: ci(input.statusCheckRollup),
    mergeable: mergeable(input.mergeable),
    number: input.number,
    reviewDecision: reviewDecision(input.reviewDecision),
    status: status(input.state),
  };
}

/** Trust terminal lifecycle state from GitHub without replaying metadata from an unexpected remote head. */
function terminalLifecycleObservation(
  input: GitHubPullRequestObservation,
): PullRequestObservation | undefined {
  const terminalStatus = status(input.state);
  return terminalStatus === 'open'
    ? undefined
    : {
        ci: 'unknown',
        mergeable: 'unknown',
        number: input.number,
        reviewDecision: 'unknown',
        status: terminalStatus,
      };
}

function expectedHeadGeneration(expectedHeadSha: string | undefined): {
  readonly expectedHeadSha?: string;
} {
  return expectedHeadSha === undefined ? {} : { expectedHeadSha };
}

function maximumId(values: ReadonlyArray<number>): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

function preview(
  body: string,
): { readonly preview: string; readonly previewTruncated: boolean } | undefined {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= GITHUB_DISCUSSION_PREVIEW_MAX_LENGTH
    ? { preview: normalized, previewTruncated: false }
    : {
        preview: `${normalized.slice(0, GITHUB_DISCUSSION_PREVIEW_MAX_LENGTH - 1)}…`,
        previewTruncated: true,
      };
}

function feedback(
  kind: PullRequestDiscussionFeedbackKind,
  id: number,
  author: { readonly login: string } | null,
  body: string,
): PullRequestDiscussionFeedback | undefined {
  const bodyPreview = preview(body);
  return bodyPreview === undefined
    ? undefined
    : { author: author?.login ?? 'unknown-author', id, kind, ...bodyPreview };
}

function compactFeedback<A>(
  values: ReadonlyArray<A>,
  project: (value: A) => PullRequestDiscussionFeedback | undefined,
): ReadonlyArray<PullRequestDiscussionFeedback> {
  return values.flatMap((value) => {
    const projected = project(value);
    return projected === undefined ? [] : [projected];
  });
}

function pageCap(
  surface: GitHubDiscussionSurface,
  ids: ReadonlyArray<number>,
  mayHaveOlderItems: boolean,
): PullRequestDiscussionPageCap | undefined {
  return mayHaveOlderItems && ids.length > 0
    ? { oldestFetchedId: Math.min(...ids), surface }
    : undefined;
}

export function derivePullRequestTransitions(
  previous: PullRequestObservation | undefined,
  current: PullRequestObservation,
): ReadonlyArray<PullRequestWatcherTransition> {
  const transitions: PullRequestWatcherTransition[] = [];
  if (current.ci === 'failing' && previous?.ci !== 'failing') transitions.push('ci_failed');
  if (
    current.reviewDecision === 'changes_requested' &&
    previous?.reviewDecision !== 'changes_requested'
  )
    transitions.push('review_feedback');
  if (current.mergeable === 'conflicting' && previous?.mergeable !== 'conflicting')
    transitions.push('conflict');
  if (current.status === 'merged' && previous?.status !== 'merged') transitions.push('merged');
  if (current.status === 'closed' && previous?.status !== 'closed')
    transitions.push('closed_unmerged');
  return transitions;
}

export function makeGitHubWatcherService(
  options: {
    readonly runner?: GitHubCommandRunnerShape;
    readonly cadence?: Duration.Input;
    readonly hostedMetadata?: GitHubHostedMetadataShape;
  } = {},
): GitHubWatcherShape {
  const runner = options.runner ?? makeExecFileGitHubCommandRunner();
  const github = makeGitHubCli(runner);
  const hostedMetadata = options.hostedMetadata ?? makeGitHubHostedMetadataAdapter({ runner });
  const cadence = options.cadence ?? DEFAULT_GITHUB_WATCHER_CADENCE;
  let active: ActiveWatcher | undefined;
  const pollSemaphore = Semaphore.makeUnsafe(1);

  const inspect = Effect.fnUntraced(function* (
    cwd: string,
    rawAssociation: PullRequestWatcherAssociation,
  ) {
    const association = yield* Schema.decodeUnknownEffect(PullRequestAssociationSchema)(
      rawAssociation,
    ).pipe(Effect.mapError(watcherInputError));
    const identifier =
      association.number === undefined ? association.url : String(association.number);
    const viewed = yield* github.run(cwd, [
      'pr',
      'view',
      identifier,
      '--json',
      WATCHER_JSON_FIELDS,
    ]);
    const decoded = yield* decodeGitHubJson(
      'watch pull request',
      GitHubPullRequestObservationSchema,
      viewed.stdout,
    );
    if (association.number !== undefined && decoded.number !== association.number) {
      return yield* new GitHubResponseError({
        cause: { expected: association.number, received: decoded.number },
        operation: 'verify watched pull request number',
      });
    }
    // A just-pushed PR may briefly retain the previous head's rollup. Never
    // replay that stale CI metadata, but surface the bounded OID-only mismatch
    // so a remote branch that never converges cannot disappear silently.
    if (
      association.lastPushedHeadSha !== undefined &&
      decoded.headRefOid !== association.lastPushedHeadSha
    ) {
      return {
        _tag: 'HeadDivergence' as const,
        expectedHeadSha: association.lastPushedHeadSha,
        observedHeadSha: decoded.headRefOid,
        terminalObservation: terminalLifecycleObservation(decoded),
      };
    }
    return {
      _tag: 'Observation' as const,
      number: decoded.number,
      observation: toObservation(decoded),
    };
  });

  const inspectDiscussion = Effect.fnUntraced(function* (cwd: string, number: number) {
    const discussionResponse = yield* github.run(cwd, [
      'api',
      'graphql',
      '--raw-field',
      `query=${DISCUSSION_GRAPHQL_QUERY}`,
      '--field',
      'owner={owner}',
      '--field',
      'repo={repo}',
      '--field',
      `number=${number}`,
      '--field',
      `limit=${MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE}`,
    ]);
    const discussion = yield* hostedMetadata.decodeGraphQL(
      'watch pull request discussion',
      GitHubPullRequestDiscussionGraphQLSchema,
      discussionResponse.stdout,
    );
    const inlineResponse = yield* github.run(cwd, [
      'api',
      `repos/{owner}/{repo}/pulls/${number}/comments?per_page=${MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE}&sort=created&direction=desc`,
    ]);
    const inlineComments = yield* decodeGitHubJson(
      'watch inline pull request comments',
      GitHubInlineReviewCommentsSchema,
      inlineResponse.stdout,
    );
    const issueComments = discussion.data.repository.pullRequest.comments.nodes;
    const reviews = discussion.data.repository.pullRequest.reviews.nodes;
    const issueCommentId = maximumId(issueComments.map(({ databaseId }) => databaseId));
    const reviewId = maximumId(
      reviews.filter(({ submittedAt }) => submittedAt !== null).map(({ databaseId }) => databaseId),
    );
    const inlineReviewCommentId = maximumId(inlineComments.map(({ id }) => id));
    const pageCaps = [
      pageCap(
        'issue_comment',
        issueComments.map(({ databaseId }) => databaseId),
        discussion.data.repository.pullRequest.comments.pageInfo.hasPreviousPage,
      ),
      pageCap(
        'review',
        reviews.map(({ databaseId }) => databaseId),
        discussion.data.repository.pullRequest.reviews.pageInfo.hasPreviousPage,
      ),
      pageCap(
        'inline_review_comment',
        inlineComments.map(({ id }) => id),
        inlineComments.length === MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE,
      ),
    ].filter((value): value is PullRequestDiscussionPageCap => value !== undefined);
    return {
      cursor: {
        ...(issueCommentId === undefined ? {} : { issueCommentId }),
        ...(reviewId === undefined ? {} : { reviewId }),
        ...(inlineReviewCommentId === undefined ? {} : { inlineReviewCommentId }),
      },
      feedback: [
        ...compactFeedback(issueComments, (comment) =>
          feedback('issue_comment', comment.databaseId, comment.author, comment.body),
        ),
        ...compactFeedback(reviews, (review) =>
          review.submittedAt === null
            ? undefined
            : feedback('review', review.databaseId, review.author, review.body),
        ),
        ...compactFeedback(inlineComments, (comment) =>
          feedback('inline_review_comment', comment.id, comment.user, comment.body),
        ),
      ],
      ...(pageCaps.length === 0 ? {} : { pageCaps }),
    } satisfies PullRequestDiscussionSnapshot;
  });

  const pollUnlocked = (callbacks: GitHubWatcherCallbacks) =>
    Effect.suspend(() =>
      Effect.forEach(
        callbacks.persistedAssociations(),
        (pullRequest) => {
          const generation = expectedHeadGeneration(pullRequest.lastPushedHeadSha);
          return Schema.decodeUnknownEffect(PullRequestAssociationSchema)(pullRequest).pipe(
            Effect.mapError(watcherInputError),
            Effect.matchEffect({
              onFailure: (error) =>
                callbacks.onFailure({ pullRequestId: pullRequest.id, ...generation, error }),
              onSuccess: () =>
                hostedMetadata.reserveWatcherPoll(callbacks.cwd(), 1).pipe(
                  Effect.flatMap((reservation) => {
                    if (reservation.status === 'deferred') return Effect.void;
                    const cwd = callbacks.cwd();
                    return inspect(cwd, pullRequest).pipe(
                      Effect.matchEffect({
                        onFailure: (error) =>
                          callbacks.onFailure({
                            pullRequestId: pullRequest.id,
                            ...generation,
                            error,
                          }),
                        onSuccess: (inspected) => {
                          if (inspected._tag === 'HeadDivergence') {
                            const divergence = callbacks.onHeadDivergence({
                              expectedHeadSha: inspected.expectedHeadSha,
                              observedHeadSha: inspected.observedHeadSha,
                              pullRequestId: pullRequest.id,
                            });
                            return inspected.terminalObservation === undefined
                              ? divergence
                              : divergence.pipe(
                                  Effect.andThen(
                                    callbacks.onObservation({
                                      pullRequestId: pullRequest.id,
                                      ...generation,
                                      complete: false,
                                      observation: inspected.terminalObservation,
                                    }),
                                  ),
                                );
                          }
                          return callbacks
                            .onObservation({
                              pullRequestId: pullRequest.id,
                              ...generation,
                              complete: false,
                              observation: inspected.observation,
                            })
                            .pipe(
                              Effect.andThen(
                                inspectDiscussion(cwd, inspected.number).pipe(
                                  Effect.matchEffect({
                                    onFailure: (error) =>
                                      callbacks.onFailure({
                                        pullRequestId: pullRequest.id,
                                        ...generation,
                                        error,
                                      }),
                                    onSuccess: (discussion) =>
                                      callbacks.onObservation({
                                        pullRequestId: pullRequest.id,
                                        ...generation,
                                        complete: true,
                                        discussion,
                                        observation: inspected.observation,
                                      }),
                                  }),
                                ),
                              ),
                            );
                        },
                      }),
                    );
                  }),
                ),
            }),
          );
        },
        { discard: true },
      ),
    );

  const poll: GitHubWatcherShape['poll'] = (callbacks) =>
    pollSemaphore.withPermit(pollUnlocked(callbacks));

  const stop: GitHubWatcherShape['stop'] = Effect.fnUntraced(function* () {
    const current = active;
    active = undefined;
    if (current) yield* Scope.close(current.scope, Exit.void);
  });

  const start: GitHubWatcherShape['start'] = Effect.fnUntraced(function* (callbacks) {
    yield* stop();
    const scope = yield* Scope.make();
    const periodicPoll = poll(callbacks).pipe(
      Effect.catch(() =>
        Effect.sync(() => console.error('Pardes GitHub watcher poll callback failed.')),
      ),
      Effect.repeat(Schedule.spaced(cadence)),
    );
    yield* periodicPoll.pipe(Effect.forkIn(scope, { startImmediately: true }));
    active = { callbacks, scope };
  });

  const reconcile: GitHubWatcherShape['reconcile'] = () =>
    Effect.suspend(() => (active ? poll(active.callbacks) : Effect.void));

  return GitHubWatcher.of({ poll, reconcile, start, stop });
}
