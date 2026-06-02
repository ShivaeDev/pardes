import { createHash } from 'node:crypto';
import { Context, Data, Effect, Layer, Schedule, Schema } from 'effect';
import { decodeGitHubJson } from './codecs.ts';
import {
  type GitHubCommandError,
  GitHubPublicationInputError,
  GitHubResponseError,
  GitHubSyncInputError,
} from './errors.ts';
import {
  GITHUB_HOSTED_METADATA_HOSTNAME,
  type GitHubHostedMetadataShape,
  type GitHubRepositoryIdentity,
  makeGitHubHostedMetadataAdapter,
} from './hosted-metadata.ts';
import {
  GitHubOpenGateListSchema,
  GitHubPublicationMetadataSchema,
  GitHubPushedHeadMetadataSchema,
  GitHubSyncExistingPullRequestSchema,
  isHumanPublishedReviewBranch,
  isManagedPublishedReviewBranch,
  PublishedReviewBranchCandidatesInputSchema,
  PublishPullRequestInputSchema,
  ReleasePublishedReviewBranchClaimInputSchema,
  ReservePublishedReviewBranchInputSchema,
  SyncExistingPullRequestInputSchema,
} from './schemas.ts';
import {
  type GitHubCommandRunnerShape,
  makeExecFileGitHubCommandRunner,
  makeGitHubCli,
} from './transport.ts';

const LIST_OPEN_GATES_JSON_FIELDS = 'number,headRefName,baseRefName';
const SYNC_EXISTING_JSON_FIELDS = 'number,state,headRefName';
const PUBLICATION_METADATA_JSON_FIELDS =
  'number,url,state,isDraft,headRefName,headRefOid,baseRefName';
const PUSHED_HEAD_JSON_FIELDS = 'number,headRefName,headRefOid';
const DEFAULT_PUSHED_HEAD_VERIFICATION_DELAY_MILLIS = 250;
const DEFAULT_PUSHED_HEAD_VERIFICATION_RETRIES = 4;

type GitHubPullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

class GitHubPushedHeadMetadataLag extends Data.TaggedError('GitHubPushedHeadMetadataLag')<{
  readonly expected: SyncExistingPullRequestInput;
  readonly pullRequest: {
    readonly number: number;
    readonly headRefName: string;
    readonly headRefOid: string;
  };
}> {}

type PushedHeadVerificationError =
  | GitHubCommandError
  | GitHubResponseError
  | GitHubPushedHeadMetadataLag;

export interface PublishPullRequestInput {
  readonly cwd: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
  readonly openInBrowser?: boolean;
  /** Mechanical proof for initial human-owned publication, verified against its remote ownership anchor. */
  readonly humanHeadBranchReservation?: {
    readonly claimSha: string;
    readonly ownershipId: string;
  };
  /** Required update-only proof when the caller cannot prove a durable manager-owned reservation. */
  readonly legacyExistingPullRequestNumber?: number;
}

export interface PublishedReviewBranchCandidatesInput {
  readonly cwd: string;
  readonly disambiguator: string;
  readonly fallbackDisambiguator: string;
  readonly workstreamTitle: string;
}

export interface ReservePublishedReviewBranchInput {
  readonly cwd: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly ownershipId: string;
}

export interface ReleasePublishedReviewBranchClaimInput {
  readonly cwd: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly ownershipId: string;
}

export type ReservePublishedReviewBranchResult = 'collision' | 'hierarchy_collision' | 'reserved';

export interface SyncExistingPullRequestInput {
  readonly cwd: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly headBranch: string;
}

export type SyncExistingPullRequestResult =
  | { readonly status: 'synced' }
  | { readonly status: 'terminal'; readonly pullRequestStatus: 'merged' | 'closed' };

export interface PublishedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly status: 'open' | 'merged' | 'closed';
  readonly draft: boolean;
  readonly title: string;
  readonly body: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly action: 'created' | 'updated';
  readonly openedInBrowser: boolean;
}

export interface GitHubPublicationShape {
  readonly publish: (
    input: PublishPullRequestInput,
  ) => Effect.Effect<PublishedPullRequest, GitHubPublicationError>;
  readonly publishedReviewBranchCandidates: (
    input: PublishedReviewBranchCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<string>, GitHubPublicationError>;
  readonly releasePublishedReviewBranchClaim: (
    input: ReleasePublishedReviewBranchClaimInput,
  ) => Effect.Effect<void, GitHubPublicationError>;
  readonly reservePublishedReviewBranch: (
    input: ReservePublishedReviewBranchInput,
  ) => Effect.Effect<ReservePublishedReviewBranchResult, GitHubPublicationError>;
  readonly syncExisting: (
    input: SyncExistingPullRequestInput,
  ) => Effect.Effect<SyncExistingPullRequestResult, GitHubSyncExistingError>;
}

export type GitHubPublicationError =
  | GitHubCommandError
  | GitHubResponseError
  | GitHubPublicationInputError;
export type GitHubSyncExistingError =
  | GitHubCommandError
  | GitHubResponseError
  | GitHubSyncInputError;

export class GitHubPublication extends Context.Service<GitHubPublication, GitHubPublicationShape>()(
  'pardes/github/GitHubPublication',
) {
  static readonly layer = Layer.sync(GitHubPublication, () => makeGitHubPublicationService());
}

function responseError(operation: string, cause: unknown): GitHubResponseError {
  return new GitHubResponseError({ cause, operation });
}

function status(state: GitHubPullRequestState): PublishedPullRequest['status'] {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

const PUBLISHED_BRANCH_NAME_SLUG_MAX_LENGTH = 64;
const PUBLISHED_BRANCH_DISAMBIGUATOR_MAX_LENGTH = 8;
const SAFE_GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function publishedBranchSlug(value: string, fallback: string, maxLength: number): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function safeGitHubActor(value: string): string | undefined {
  const actor = value.trim();
  return actor.length <= 64 && SAFE_GITHUB_LOGIN.test(actor) ? actor.toLowerCase() : undefined;
}

function boundedVerificationOverride(
  name: string,
  value: number | undefined,
  maximum: number,
  integer: boolean,
): number {
  const resolved = value ?? maximum;
  if (
    !Number.isFinite(resolved) ||
    resolved < 0 ||
    resolved > maximum ||
    (integer && !Number.isSafeInteger(resolved))
  ) {
    throw new RangeError(
      `${name} must be a finite non-negative${integer ? ' safe integer' : ' number'} no greater than ${maximum}.`,
    );
  }
  return resolved;
}

export function makeGitHubPublicationService(
  options: {
    readonly runner?: GitHubCommandRunnerShape;
    readonly hostedMetadata?: GitHubHostedMetadataShape;
    /** Test seam: production callers may only tighten the bounded convergence window. */
    readonly pushedHeadVerificationDelayMillis?: number;
    /** Test seam: production callers may only tighten the bounded convergence window. */
    readonly pushedHeadVerificationRetries?: number;
  } = {},
): GitHubPublicationShape {
  const runner = options.runner ?? makeExecFileGitHubCommandRunner();
  const command = (cwd: string, executable: string, args: ReadonlyArray<string>) =>
    runner.run({ args, command: executable, cwd });
  const github = makeGitHubCli(runner);
  const hostedMetadata = options.hostedMetadata ?? makeGitHubHostedMetadataAdapter({ runner });
  const runGitHub = (route: GitHubRepositoryIdentity, cwd: string, args: ReadonlyArray<string>) =>
    hostedMetadata.accountOpaqueRequest(
      'graphql',
      github.run(cwd, [...args, '--repo', route.slug]),
    );
  const pushedHeadVerificationDelayMillis = boundedVerificationOverride(
    'pushedHeadVerificationDelayMillis',
    options.pushedHeadVerificationDelayMillis,
    DEFAULT_PUSHED_HEAD_VERIFICATION_DELAY_MILLIS,
    false,
  );
  const pushedHeadVerificationRetries = boundedVerificationOverride(
    'pushedHeadVerificationRetries',
    options.pushedHeadVerificationRetries,
    DEFAULT_PUSHED_HEAD_VERIFICATION_RETRIES,
    true,
  );

  const verifyPushedHead = Effect.fnUntraced(function* (
    input: SyncExistingPullRequestInput,
    route: GitHubRepositoryIdentity,
  ) {
    const verified = yield* runGitHub(route, input.cwd, [
      'pr',
      'view',
      String(input.pullRequestNumber),
      '--json',
      PUSHED_HEAD_JSON_FIELDS,
    ]);
    const pushedHead = yield* decodeGitHubJson(
      'verify pushed pull request head',
      GitHubPushedHeadMetadataSchema,
      verified.stdout,
    );
    if (
      pushedHead.number !== input.pullRequestNumber ||
      pushedHead.headRefName !== input.headBranch
    ) {
      return yield* responseError('verify pushed pull request head', {
        expected: input,
        pullRequest: pushedHead,
      });
    }
    if (pushedHead.headRefOid !== input.headSha) {
      return yield* new GitHubPushedHeadMetadataLag({ expected: input, pullRequest: pushedHead });
    }
  });

  const retryPushedHeadMetadataLag = <A>(
    verification: Effect.Effect<A, PushedHeadVerificationError>,
    operation = 'verify pushed pull request head',
  ) =>
    verification.pipe(
      Effect.retry(
        Schedule.both(
          Schedule.spaced(pushedHeadVerificationDelayMillis),
          Schedule.recurs(pushedHeadVerificationRetries),
        ).pipe(
          Schedule.setInputType<PushedHeadVerificationError>(),
          Schedule.while(({ input: error }) => error._tag === 'GitHubPushedHeadMetadataLag'),
        ),
      ),
      Effect.catchTag('GitHubPushedHeadMetadataLag', (error) =>
        Effect.fail(
          responseError(operation, {
            expected: error.expected,
            pullRequest: error.pullRequest,
          }),
        ),
      ),
    );

  const fallbackActor = Effect.fnUntraced(function* (cwd: string) {
    const configured = yield* command(cwd, 'git', ['config', '--get', 'user.name']).pipe(
      Effect.map(({ stdout }) => stdout.trim()),
      Effect.catch(() => Effect.succeed('')),
    );
    return publishedBranchSlug(configured || process.env.USER || 'user', 'user', 64);
  });

  const githubActor = Effect.fnUntraced(function* (cwd: string) {
    const login = yield* hostedMetadata
      .accountOpaqueRequest(
        'rest',
        github.run(cwd, [
          'api',
          'user',
          '--hostname',
          GITHUB_HOSTED_METADATA_HOSTNAME,
          '--jq',
          '.login',
        ]),
      )
      .pipe(
        Effect.map(({ stdout }) => safeGitHubActor(stdout)),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    return login ?? (yield* fallbackActor(cwd));
  });

  const remoteHeads = Effect.fnUntraced(function* (
    route: GitHubRepositoryIdentity,
    cwd: string,
    exactBranches: ReadonlyArray<string>,
    descendantRoots: ReadonlyArray<string> = [],
  ) {
    const patterns = [
      ...exactBranches.map((branch) => `refs/heads/${branch}`),
      ...descendantRoots.map((branch) => `refs/heads/${branch}/*`),
    ];
    const listed = yield* command(cwd, 'git', [
      'ls-remote',
      '--heads',
      route.pushTarget,
      ...patterns,
    ]);
    const heads = new Map<string, string>();
    for (const line of listed.stdout.trim().split(/\r?\n/)) {
      if (!line) continue;
      const [sha, ref, ...unexpected] = line.split(/\s+/);
      if (!sha || !ref || unexpected.length > 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
        return yield* responseError('decode advertised remote branch heads', { line });
      }
      heads.set(ref.replace(/^refs\/heads\//, ''), sha);
    }
    return heads;
  });

  const remoteBranchHead = Effect.fnUntraced(function* (
    route: GitHubRepositoryIdentity,
    cwd: string,
    branch: string,
  ) {
    return (yield* remoteHeads(route, cwd, [branch])).get(branch);
  });

  const reservationClaimBranch = (ownershipId: string, headBranch: string) => {
    const digest = createHash('sha256').update(headBranch).digest('hex').slice(0, 12);
    return `pardes-reservation-${publishedBranchSlug(ownershipId, 'owner', 80)}-${digest}`;
  };

  const branchAncestors = (branch: string): ReadonlyArray<string> => {
    const segments = branch.split('/');
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
  };

  const hasBranchDescendant = (heads: ReadonlyMap<string, string>, branch: string) =>
    Array.from(heads.keys()).some((head) => head.startsWith(`${branch}/`));

  const publishedReviewBranchCandidates: GitHubPublicationShape['publishedReviewBranchCandidates'] =
    Effect.fnUntraced(function* (rawInput: PublishedReviewBranchCandidatesInput) {
      const input = yield* Schema.decodeUnknownEffect(PublishedReviewBranchCandidatesInputSchema)(
        rawInput,
      ).pipe(Effect.mapError((cause) => new GitHubPublicationInputError({ cause })));
      const route = yield* hostedMetadata.fixedRoute(input.cwd);
      const actor = yield* githubActor(input.cwd);
      const title = publishedBranchSlug(
        input.workstreamTitle,
        'workstream',
        PUBLISHED_BRANCH_NAME_SLUG_MAX_LENGTH,
      );
      const disambiguator = publishedBranchSlug(
        input.disambiguator.replace(/^agent-/, ''),
        'worker',
        PUBLISHED_BRANCH_DISAMBIGUATOR_MAX_LENGTH,
      );
      const fallbackDisambiguator = publishedBranchSlug(
        input.fallbackDisambiguator.replace(/^manager-/, ''),
        'manager',
        PUBLISHED_BRANCH_DISAMBIGUATOR_MAX_LENGTH,
      );
      const namespaceRoot = `${actor}/pardes`;
      const namespaceHeads = yield* remoteHeads(route, input.cwd, [actor, namespaceRoot]);
      const namespaceRootBlocked = namespaceHeads.has(actor) || namespaceHeads.has(namespaceRoot);
      const preferred = namespaceRootBlocked
        ? `${actor}-pardes-${title}`
        : `${namespaceRoot}/${title}`;
      return [
        preferred,
        `${preferred}-${disambiguator}`,
        `${preferred}-${disambiguator}-${fallbackDisambiguator}`,
      ];
    });

  const reservePublishedReviewBranch: GitHubPublicationShape['reservePublishedReviewBranch'] =
    Effect.fnUntraced(function* (rawInput: ReservePublishedReviewBranchInput) {
      const input = yield* Schema.decodeUnknownEffect(ReservePublishedReviewBranchInputSchema)(
        rawInput,
      ).pipe(Effect.mapError((cause) => new GitHubPublicationInputError({ cause })));
      const route = yield* hostedMetadata.fixedRoute(input.cwd);
      const claimBranch = reservationClaimBranch(input.ownershipId, input.headBranch);
      const ancestors = branchAncestors(input.headBranch);
      const before = yield* remoteHeads(
        route,
        input.cwd,
        [...ancestors, input.headBranch, claimBranch],
        [input.headBranch, claimBranch],
      );
      const head = before.get(input.headBranch);
      const claim = before.get(claimBranch);
      if (hasBranchDescendant(before, claimBranch)) return 'collision';
      if (claim === input.headSha && head === input.headSha) return 'reserved';
      if (claim !== undefined)
        return yield* responseError('verify published review branch ownership claim', {
          claim,
          claimBranch,
          expected: input.headSha,
          head,
        });
      if (ancestors.some((branch) => before.has(branch))) return 'hierarchy_collision';
      if (before.size > 0) return 'collision';
      const reservation = yield* command(input.cwd, 'git', [
        'push',
        '--atomic',
        `--force-with-lease=refs/heads/${input.headBranch}:`,
        `--force-with-lease=refs/heads/${claimBranch}:`,
        route.pushTarget,
        `${input.headSha}:refs/heads/${input.headBranch}`,
        `${input.headSha}:refs/heads/${claimBranch}`,
      ]).pipe(Effect.exit);
      const after = yield* remoteHeads(
        route,
        input.cwd,
        [...ancestors, input.headBranch, claimBranch],
        [input.headBranch, claimBranch],
      );
      const reservedHead = after.get(input.headBranch);
      const reservedClaim = after.get(claimBranch);
      if (hasBranchDescendant(after, claimBranch)) return 'collision';
      if (reservedHead === input.headSha && reservedClaim === input.headSha) return 'reserved';
      if (reservedClaim === undefined && ancestors.some((branch) => after.has(branch)))
        return 'hierarchy_collision';
      if (reservedClaim === undefined && after.size > 0) return 'collision';
      if (reservation._tag === 'Failure') return yield* Effect.failCause(reservation.cause);
      return yield* responseError('verify reserved published review branch', {
        claimBranch,
        expected: input.headSha,
        reservedClaim,
        reservedHead,
      });
    });

  const releasePublishedReviewBranchClaim: GitHubPublicationShape['releasePublishedReviewBranchClaim'] =
    Effect.fnUntraced(function* (rawInput: ReleasePublishedReviewBranchClaimInput) {
      const input = yield* Schema.decodeUnknownEffect(ReleasePublishedReviewBranchClaimInputSchema)(
        rawInput,
      ).pipe(Effect.mapError((cause) => new GitHubPublicationInputError({ cause })));
      const route = yield* hostedMetadata.fixedRoute(input.cwd);
      const claimBranch = reservationClaimBranch(input.ownershipId, input.headBranch);
      const claim = yield* remoteBranchHead(route, input.cwd, claimBranch);
      if (claim === undefined) return;
      if (claim !== input.headSha)
        return yield* responseError('verify released published review branch ownership claim', {
          claim,
          claimBranch,
          expected: input.headSha,
        });
      yield* command(input.cwd, 'git', [
        'push',
        `--force-with-lease=refs/heads/${claimBranch}:${input.headSha}`,
        route.pushTarget,
        `:refs/heads/${claimBranch}`,
      ]);
    });

  const syncExisting: GitHubPublicationShape['syncExisting'] = Effect.fnUntraced(function* (
    rawInput: SyncExistingPullRequestInput,
  ) {
    const input = yield* Schema.decodeUnknownEffect(SyncExistingPullRequestInputSchema)(
      rawInput,
    ).pipe(Effect.mapError((cause) => new GitHubSyncInputError({ cause })));
    const route = yield* hostedMetadata.fixedRoute(input.cwd);
    const viewed = yield* runGitHub(route, input.cwd, [
      'pr',
      'view',
      String(input.pullRequestNumber),
      '--json',
      SYNC_EXISTING_JSON_FIELDS,
    ]);
    const pullRequest = yield* decodeGitHubJson(
      'view existing pull request for sync',
      GitHubSyncExistingPullRequestSchema,
      viewed.stdout,
    );
    if (pullRequest.number !== input.pullRequestNumber) {
      return yield* responseError('verify existing pull request number for sync', {
        expected: input.pullRequestNumber,
        pullRequest,
      });
    }
    const pullRequestStatus = status(pullRequest.state);
    if (pullRequestStatus !== 'open') return { pullRequestStatus, status: 'terminal' };
    if (pullRequest.headRefName !== input.headBranch) {
      return yield* responseError('verify existing pull request managed head for sync', {
        expected: input.headBranch,
        pullRequest,
      });
    }
    yield* command(input.cwd, 'git', [
      'push',
      route.pushTarget,
      `${input.headSha}:refs/heads/${input.headBranch}`,
    ]);
    // `gh pr view` may briefly report the previous hosted OID after the exact
    // remote ref update. Retry only that decoded OID mismatch: identity drift,
    // malformed metadata, and transport failures still fail immediately.
    yield* retryPushedHeadMetadataLag(verifyPushedHead(input, route));
    return { status: 'synced' };
  });

  const publish: GitHubPublicationShape['publish'] = Effect.fnUntraced(function* (
    rawInput: PublishPullRequestInput,
  ) {
    const input = yield* Schema.decodeUnknownEffect(PublishPullRequestInputSchema)(rawInput).pipe(
      Effect.mapError((cause) => new GitHubPublicationInputError({ cause })),
    );
    const route = yield* hostedMetadata.fixedRoute(input.cwd);
    const managedHeadBranch =
      input.legacyExistingPullRequestNumber === undefined &&
      isManagedPublishedReviewBranch(input.headBranch);
    if (
      isHumanPublishedReviewBranch(input.headBranch) &&
      input.legacyExistingPullRequestNumber === undefined
    ) {
      const reservation = input.humanHeadBranchReservation;
      if (!reservation) {
        return yield* new GitHubPublicationInputError({
          cause: 'human-owned published review branch requires durable ownership evidence',
        });
      }
      const claimBranch = reservationClaimBranch(reservation.ownershipId, input.headBranch);
      const proof = yield* remoteHeads(route, input.cwd, [input.headBranch, claimBranch]);
      if (
        proof.get(input.headBranch) !== reservation.claimSha ||
        proof.get(claimBranch) !== reservation.claimSha
      ) {
        return yield* responseError('verify human-owned published review branch reservation', {
          claimBranch,
          expected: reservation.claimSha,
          headBranch: input.headBranch,
          proof: Object.fromEntries(proof),
        });
      }
    }
    let existing: { readonly number: number } | undefined;
    if (!managedHeadBranch) {
      if (input.legacyExistingPullRequestNumber === undefined) {
        return yield* new GitHubPublicationInputError({
          cause: 'legacy published review branch requires an existing pull-request number',
        });
      }
      const viewed = yield* runGitHub(route, input.cwd, [
        'pr',
        'view',
        String(input.legacyExistingPullRequestNumber),
        '--json',
        PUBLICATION_METADATA_JSON_FIELDS,
      ]);
      const pullRequest = yield* decodeGitHubJson(
        'view existing legacy pull request for publication',
        GitHubPublicationMetadataSchema,
        viewed.stdout,
      );
      yield* hostedMetadata.fixedRoute(input.cwd, [pullRequest.url]);
      if (
        pullRequest.number !== input.legacyExistingPullRequestNumber ||
        status(pullRequest.state) !== 'open' ||
        pullRequest.headRefName !== input.headBranch ||
        pullRequest.baseRefName !== input.baseBranch
      ) {
        return yield* responseError('verify existing legacy pull request for publication', {
          expected: input,
          pullRequest,
        });
      }
      existing = pullRequest;
    }
    yield* command(input.cwd, 'git', [
      'push',
      route.pushTarget,
      `${input.headSha}:refs/heads/${input.headBranch}`,
    ]);
    if (managedHeadBranch) {
      const listed = yield* runGitHub(route, input.cwd, [
        'pr',
        'list',
        '--state',
        'open',
        '--head',
        input.headBranch,
        '--base',
        input.baseBranch,
        '--limit',
        '100',
        '--json',
        LIST_OPEN_GATES_JSON_FIELDS,
      ]);
      const pullRequests = yield* decodeGitHubJson(
        'list pull requests',
        GitHubOpenGateListSchema,
        listed.stdout,
      );
      existing = pullRequests.find(
        (pullRequest) =>
          pullRequest.headRefName === input.headBranch &&
          pullRequest.baseRefName === input.baseBranch,
      );
    }
    const action = existing ? ('updated' as const) : ('created' as const);
    if (existing) {
      yield* runGitHub(route, input.cwd, [
        'pr',
        'edit',
        String(existing.number),
        '--title',
        input.title,
        '--body',
        input.body,
        '--base',
        input.baseBranch,
      ]);
    } else {
      yield* runGitHub(route, input.cwd, [
        'pr',
        'create',
        '--title',
        input.title,
        '--body',
        input.body,
        '--base',
        input.baseBranch,
        '--head',
        input.headBranch,
      ]);
    }
    const identifier = existing ? String(existing.number) : input.headBranch;
    const viewPublishedPullRequest = Effect.fnUntraced(function* () {
      const viewed = yield* runGitHub(route, input.cwd, [
        'pr',
        'view',
        identifier,
        '--json',
        PUBLICATION_METADATA_JSON_FIELDS,
      ]);
      const pullRequest = yield* decodeGitHubJson(
        'view pull request',
        GitHubPublicationMetadataSchema,
        viewed.stdout,
      );
      yield* hostedMetadata.fixedRoute(input.cwd, [pullRequest.url]);
      if (
        (existing !== undefined && pullRequest.number !== existing.number) ||
        pullRequest.headRefName !== input.headBranch ||
        pullRequest.baseRefName !== input.baseBranch
      ) {
        return yield* responseError('verify published pull request head and base', {
          expected: input,
          pullRequest,
          selectedExistingPullRequest: existing,
        });
      }
      return pullRequest;
    });
    const verifyPublishedPullRequest =
      existing === undefined
        ? viewPublishedPullRequest().pipe(
            Effect.flatMap((pullRequest) =>
              pullRequest.headRefOid === input.headSha
                ? Effect.succeed(pullRequest)
                : Effect.fail(
                    responseError('verify published pull request head and base', {
                      expected: input,
                      pullRequest,
                      selectedExistingPullRequest: existing,
                    }),
                  ),
            ),
          )
        : retryPushedHeadMetadataLag(
            viewPublishedPullRequest().pipe(
              Effect.flatMap((pullRequest) =>
                pullRequest.headRefOid === input.headSha
                  ? Effect.succeed(pullRequest)
                  : Effect.fail(
                      new GitHubPushedHeadMetadataLag({
                        expected: {
                          cwd: input.cwd,
                          headBranch: input.headBranch,
                          headSha: input.headSha,
                          pullRequestNumber: existing.number,
                        },
                        pullRequest,
                      }),
                    ),
              ),
            ),
            'verify published pull request head and base',
          );
    const pullRequest = yield* verifyPublishedPullRequest;
    if (input.openInBrowser === true)
      yield* runGitHub(route, input.cwd, ['pr', 'view', String(pullRequest.number), '--web']);
    return {
      action,
      baseBranch: pullRequest.baseRefName,
      body: input.body,
      draft: pullRequest.isDraft,
      headBranch: pullRequest.headRefName,
      number: pullRequest.number,
      openedInBrowser: input.openInBrowser === true,
      status: status(pullRequest.state),
      title: input.title,
      url: pullRequest.url,
    };
  });

  return GitHubPublication.of({
    publish,
    publishedReviewBranchCandidates,
    releasePublishedReviewBranchClaim,
    reservePublishedReviewBranch,
    syncExisting,
  });
}
