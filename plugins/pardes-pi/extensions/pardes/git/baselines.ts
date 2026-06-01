import { Effect } from 'effect';
import { type GitCommandError, RemoteBaselineError, type RemoteBaselineFailure } from './errors.ts';
import { REMOTE_BASELINE_BRANCH_MAX_LENGTH, type RepoState } from './schemas.ts';
import { type GitResult, runGit } from './transport.ts';

const ORIGIN = 'origin';
const FULL_COMMIT_SHA = /^[0-9a-f]{40,64}$/;
const SAFE_BRANCH_CHARACTERS = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

export interface RemoteBaseline {
  readonly remote: 'origin';
  readonly branch: string;
  readonly sha: string;
}

type GitRunner = (
  cwd: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<GitResult, GitCommandError>;

function baselineError(reason: RemoteBaselineFailure, cause?: unknown): RemoteBaselineError {
  return new RemoteBaselineError({ reason, ...(cause === undefined ? {} : { cause }) });
}

/** Conservative Git branch validation runs before an override is interpolated into any argv token. */
export function isValidRemoteBaselineBranch(branch: string): boolean {
  if (
    branch.length === 0 ||
    branch.length > REMOTE_BASELINE_BRANCH_MAX_LENGTH ||
    !SAFE_BRANCH_CHARACTERS.test(branch)
  )
    return false;
  if (
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{')
  )
    return false;
  return branch
    .split('/')
    .every(
      (segment) => segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock'),
    );
}

function outputLines(stdout: string): ReadonlyArray<string> {
  return stdout.split(/\r?\n/).filter(Boolean);
}

function defaultBranch(stdout: string): string | undefined {
  const prefix = 'ref: refs/heads/';
  const suffix = '\tHEAD';
  const symbolic = outputLines(stdout).find(
    (line) => line.startsWith(prefix) && line.endsWith(suffix),
  );
  return symbolic?.slice(prefix.length, -suffix.length);
}

function resolvedSha(stdout: string, expectedRef: string): string | undefined {
  for (const line of outputLines(stdout)) {
    const [sha, ref, ...excess] = line.split('\t');
    if (
      excess.length === 0 &&
      ref === expectedRef &&
      sha !== undefined &&
      FULL_COMMIT_SHA.test(sha)
    )
      return sha;
  }
  return undefined;
}

/**
 * Resolve a fresh origin ref to one exact advertised SHA, fetch that immutable
 * object without updating a checkout or local tracking ref, then prove it is a
 * commit before managed-worktree creation uses it.
 */
export function makeRemoteBaselineResolver(run: GitRunner = runGit) {
  const git = (repo: RepoState, args: ReadonlyArray<string>, failure: RemoteBaselineFailure) =>
    run(repo.primaryCheckout, args).pipe(Effect.mapError((cause) => baselineError(failure, cause)));

  return Effect.fnUntraced(function* (repo: RepoState, branchOverride?: string) {
    if (branchOverride !== undefined && !isValidRemoteBaselineBranch(branchOverride)) {
      return yield* baselineError('invalid_override');
    }

    yield* git(repo, ['remote', 'get-url', ORIGIN], 'missing_remote');

    let branch: string;
    let sha: string | undefined;
    if (branchOverride === undefined) {
      const advertised = yield* git(
        repo,
        ['ls-remote', '--symref', ORIGIN, 'HEAD'],
        'fetch_failed',
      );
      const advertisedBranch = defaultBranch(advertised.stdout);
      if (!advertisedBranch || !isValidRemoteBaselineBranch(advertisedBranch)) {
        return yield* baselineError('missing_default_branch');
      }
      branch = advertisedBranch;
      sha = resolvedSha(advertised.stdout, 'HEAD');
      if (!sha) return yield* baselineError('non_commit_resolution');
    } else {
      branch = branchOverride;
      const ref = `refs/heads/${branch}`;
      const advertised = yield* git(
        repo,
        ['ls-remote', '--exit-code', '--refs', ORIGIN, ref],
        'fetch_failed',
      );
      sha = resolvedSha(advertised.stdout, ref);
      if (!sha) return yield* baselineError('non_commit_resolution');
    }

    yield* git(repo, ['fetch', '--no-tags', ORIGIN, sha], 'fetch_failed');
    const commit = yield* git(
      repo,
      ['rev-parse', '--verify', `${sha}^{commit}`],
      'non_commit_resolution',
    );
    if (commit.stdout.trim() !== sha) return yield* baselineError('non_commit_resolution');
    return { branch, remote: ORIGIN, sha } satisfies RemoteBaseline;
  });
}

export const resolveRemoteBaseline = makeRemoteBaselineResolver();
