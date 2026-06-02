import { realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import { copyLocalGitRepositoryFixture, runGitFixture } from '../test-support.ts';
import { discoverRepository, resolveGitPathOutput } from './repository.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function git(cwd: string, ...args: string[]): string {
  return runGitFixture(cwd, ...args);
}

describe('resolveGitPathOutput', () => {
  test('removes one terminal LF while preserving a trailing-space segment', () => {
    const from = join(tmpdir(), 'pardes-repo-base');

    expect(resolveGitPathOutput(from, 'project \n')).toBe(resolve(from, 'project '));
  });

  test('removes one terminal CRLF while preserving a trailing-space segment', () => {
    const from = join(tmpdir(), 'pardes-repo-base');

    expect(resolveGitPathOutput(from, 'project \r\n')).toBe(resolve(from, 'project '));
  });
});

describe('repository discovery', () => {
  test('resolves the primary checkout from both primary and linked worktrees', async () => {
    const { repo: primary, root } = copyLocalGitRepositoryFixture('pardes-repo-');
    temporaryDirectories.push(root);
    const linked = join(root, 'linked');
    git(primary, 'worktree', 'add', '-b', 'worker', linked, 'HEAD');

    const fromPrimary = await Effect.runPromise(discoverRepository(primary));
    const fromLinked = await Effect.runPromise(discoverRepository(linked));

    expect(fromPrimary.primaryCheckout).toBe(realpathSync(primary));
    expect(fromLinked.primaryCheckout).toBe(realpathSync(primary));
    expect(fromLinked.currentCheckout).toBe(realpathSync(linked));
    expect(fromLinked.gitCommonDir).toBe(join(realpathSync(primary), '.git'));
    expect(fromLinked.key).toBe(fromPrimary.key);
  });
});
