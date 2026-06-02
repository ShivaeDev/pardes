import { Context, Effect, Layer, Schema } from 'effect';
import { decodeGitHubJson } from './codecs.ts';
import {
  type GitHubCommandError,
  GitHubPublicationInputError,
  GitHubResponseError,
  GitHubSyncInputError,
} from './errors.ts';
import {
  GitHubOpenGateListSchema,
  GitHubPublicationMetadataSchema,
  GitHubPushedHeadMetadataSchema,
  GitHubSyncExistingPullRequestSchema,
  isManagedPublishedReviewBranch,
  PublishPullRequestInputSchema,
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

type GitHubPullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PublishPullRequestInput {
  readonly cwd: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
  readonly openInBrowser?: boolean;
  /** Required update-only proof when the caller cannot prove a durable manager-owned reservation. */
  readonly legacyExistingPullRequestNumber?: number;
  /** Capability proof that this exact managed head was durably reserved before create-capable publication. */
  readonly managedHeadBranchReservation?: boolean;
}

export interface ReservePublishedReviewBranchInput {
  readonly cwd: string;
  readonly disambiguator: string;
  readonly fallbackDisambiguator: string;
  readonly headSha: string;
  readonly workstreamTitle: string;
}

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
  readonly reservePublishedReviewBranch: (
    input: ReservePublishedReviewBranchInput,
  ) => Effect.Effect<string, GitHubPublicationError>;
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

export function makeGitHubPublicationService(
  options: { readonly runner?: GitHubCommandRunnerShape } = {},
): GitHubPublicationShape {
  const runner = options.runner ?? makeExecFileGitHubCommandRunner();
  const command = (cwd: string, executable: string, args: ReadonlyArray<string>) =>
    runner.run({ args, command: executable, cwd });
  const github = makeGitHubCli(runner);

  const fallbackActor = Effect.fnUntraced(function* (cwd: string) {
    const configured = yield* command(cwd, 'git', ['config', '--get', 'user.name']).pipe(
      Effect.map(({ stdout }) => stdout.trim()),
      Effect.catch(() => Effect.succeed('')),
    );
    return publishedBranchSlug(configured || process.env.USER || 'user', 'user', 64);
  });

  const githubActor = Effect.fnUntraced(function* (cwd: string) {
    const login = yield* github.run(cwd, ['api', 'user', '--jq', '.login']).pipe(
      Effect.map(({ stdout }) => safeGitHubActor(stdout)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return login ?? (yield* fallbackActor(cwd));
  });

  const remoteBranchExists = Effect.fnUntraced(function* (cwd: string, branch: string) {
    const listed = yield* command(cwd, 'git', [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branch}`,
    ]);
    return listed.stdout.trim().length > 0;
  });

  const reservePublishedReviewBranch: GitHubPublicationShape['reservePublishedReviewBranch'] =
    Effect.fnUntraced(function* (rawInput: ReservePublishedReviewBranchInput) {
      const input = yield* Schema.decodeUnknownEffect(ReservePublishedReviewBranchInputSchema)(
        rawInput,
      ).pipe(Effect.mapError((cause) => new GitHubPublicationInputError({ cause })));
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
      const namespaceRootBlocked = yield* remoteBranchExists(input.cwd, namespaceRoot);
      const preferred = namespaceRootBlocked
        ? `${actor}-pardes-${title}`
        : `${namespaceRoot}/${title}`;
      const candidates = [
        preferred,
        `${preferred}-${disambiguator}`,
        `${preferred}-${disambiguator}-${fallbackDisambiguator}`,
      ];
      for (const branch of candidates) {
        if (yield* remoteBranchExists(input.cwd, branch)) continue;
        const creation = yield* github
          .run(input.cwd, [
            'api',
            'repos/{owner}/{repo}/git/refs',
            '--method',
            'POST',
            '--field',
            `ref=refs/heads/${branch}`,
            '--field',
            `sha=${input.headSha}`,
          ])
          .pipe(Effect.exit);
        if (creation._tag === 'Success') return branch;
        if (yield* remoteBranchExists(input.cwd, branch)) continue;
        return yield* Effect.failCause(creation.cause);
      }
      return yield* responseError('reserve unique published review branch', { candidates });
    });

  const syncExisting: GitHubPublicationShape['syncExisting'] = Effect.fnUntraced(function* (
    rawInput: SyncExistingPullRequestInput,
  ) {
    const input = yield* Schema.decodeUnknownEffect(SyncExistingPullRequestInputSchema)(
      rawInput,
    ).pipe(Effect.mapError((cause) => new GitHubSyncInputError({ cause })));
    const viewed = yield* github.run(input.cwd, [
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
      'origin',
      `${input.headSha}:refs/heads/${input.headBranch}`,
    ]);
    const verified = yield* github.run(input.cwd, [
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
      pushedHead.headRefName !== input.headBranch ||
      pushedHead.headRefOid !== input.headSha
    ) {
      return yield* responseError('verify pushed pull request head', {
        expected: input,
        pullRequest: pushedHead,
      });
    }
    return { status: 'synced' };
  });

  const publish: GitHubPublicationShape['publish'] = Effect.fnUntraced(function* (
    rawInput: PublishPullRequestInput,
  ) {
    const input = yield* Schema.decodeUnknownEffect(PublishPullRequestInputSchema)(rawInput).pipe(
      Effect.mapError((cause) => new GitHubPublicationInputError({ cause })),
    );
    const managedHeadBranch =
      input.managedHeadBranchReservation === true &&
      isManagedPublishedReviewBranch(input.headBranch);
    let existing: { readonly number: number } | undefined;
    if (!managedHeadBranch) {
      if (input.legacyExistingPullRequestNumber === undefined) {
        return yield* new GitHubPublicationInputError({
          cause: 'legacy published review branch requires an existing pull-request number',
        });
      }
      const viewed = yield* github.run(input.cwd, [
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
      'origin',
      `${input.headSha}:refs/heads/${input.headBranch}`,
    ]);
    if (managedHeadBranch) {
      const listed = yield* github.run(input.cwd, [
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
      yield* github.run(input.cwd, [
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
      yield* github.run(input.cwd, [
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
    const viewed = yield* github.run(input.cwd, [
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
    if (
      (existing !== undefined && pullRequest.number !== existing.number) ||
      pullRequest.headRefName !== input.headBranch ||
      pullRequest.headRefOid !== input.headSha ||
      pullRequest.baseRefName !== input.baseBranch
    ) {
      return yield* responseError('verify published pull request head and base', {
        expected: input,
        pullRequest,
        selectedExistingPullRequest: existing,
      });
    }
    if (input.openInBrowser === true)
      yield* github.run(input.cwd, ['pr', 'view', String(pullRequest.number), '--web']);
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

  return GitHubPublication.of({ publish, reservePublishedReviewBranch, syncExisting });
}
