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
  /** Required update-only proof for a persisted gate created before manager-owned publication refs. */
  readonly legacyExistingPullRequestNumber?: number;
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

export function makeGitHubPublicationService(
  options: { readonly runner?: GitHubCommandRunnerShape } = {},
): GitHubPublicationShape {
  const runner = options.runner ?? makeExecFileGitHubCommandRunner();
  const command = (cwd: string, executable: string, args: ReadonlyArray<string>) =>
    runner.run({ args, command: executable, cwd });
  const github = makeGitHubCli(runner);

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
    const managedHeadBranch = isManagedPublishedReviewBranch(input.headBranch);
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

  return GitHubPublication.of({ publish, syncExisting });
}
