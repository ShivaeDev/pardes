import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import { discoverRepository, resolveGitPathOutput } from './repository.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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
    const root = mkdtempSync(join(tmpdir(), 'pardes-repo-'));
    temporaryDirectories.push(root);
    const primary = join(root, 'project');
    execFileSync('git', ['init', '-b', 'main', primary]);
    git(primary, 'config', 'user.email', 'pardes@example.test');
    git(primary, 'config', 'user.name', 'Pardes Test');
    writeFileSync(join(primary, 'README.md'), 'fixture\n');
    git(primary, 'add', 'README.md');
    git(primary, 'commit', '-m', 'fixture');
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
