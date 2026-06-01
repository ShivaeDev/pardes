import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { Effect } from 'effect';
import { RepositoryError } from './errors.ts';
import type { RepoState } from './schemas.ts';
import { runGit } from './transport.ts';

function repositoryGit(cwd: string, args: ReadonlyArray<string>) {
  return runGit(cwd, args).pipe(
    Effect.mapError(
      (cause) => new RepositoryError({ cause, cwd, operation: `git ${args.join(' ')}` }),
    ),
  );
}

export function resolveGitPathOutput(from: string, stdout: string): string {
  return resolve(from, stdout.replace(/\r?\n$/, ''));
}

export function repoKey(primaryCheckout: string): string {
  const name = basename(primaryCheckout).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo';
  const digest = createHash('sha256').update(primaryCheckout).digest('hex').slice(0, 12);
  return `${name}-${digest}`;
}

export const discoverRepository = Effect.fnUntraced(function* (cwd: string) {
  const currentCheckout = resolveGitPathOutput(
    cwd,
    (yield* repositoryGit(cwd, ['rev-parse', '--show-toplevel'])).stdout,
  );
  const gitCommonDir = resolveGitPathOutput(
    currentCheckout,
    (yield* repositoryGit(currentCheckout, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])).stdout,
  );
  if (basename(gitCommonDir) !== '.git') {
    return yield* new RepositoryError({
      cause: `Expected a non-bare repository with a .git common directory, received ${gitCommonDir}`,
      cwd,
      operation: 'discover primary checkout',
    });
  }
  const primaryCheckout = dirname(gitCommonDir);
  return {
    currentCheckout,
    gitCommonDir,
    key: repoKey(primaryCheckout),
    primaryCheckout,
  } satisfies RepoState;
});
