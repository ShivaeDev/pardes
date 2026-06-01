import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import { makeRemoteBaselineResolver, resolveRemoteBaseline } from './baselines.ts';
import { GitCommandError } from './errors.ts';
import { discoverRepository } from './repository.ts';
import type { RepoState } from './schemas.ts';
import type { GitResult } from './transport.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function configureIdentity(repo: string): void {
  git(repo, 'config', 'user.email', 'pardes@example.test');
  git(repo, 'config', 'user.name', 'Pardes Test');
}

function localRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'pardes-baseline-local-'));
  temporaryDirectories.push(root);
  const primary = join(root, 'project');
  execFileSync('git', ['init', '-b', 'main', primary]);
  configureIdentity(primary);
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  git(primary, 'add', 'README.md');
  git(primary, 'commit', '-m', 'fixture');
  return primary;
}

function remoteRepository(defaultBranch = 'main') {
  const root = mkdtempSync(join(tmpdir(), 'pardes-baseline-remote-'));
  temporaryDirectories.push(root);
  const origin = join(root, 'origin.git');
  const primary = join(root, 'project');
  execFileSync('git', ['init', '--bare', '-b', defaultBranch, origin]);
  execFileSync('git', ['init', '-b', defaultBranch, primary]);
  configureIdentity(primary);
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  git(primary, 'add', 'README.md');
  git(primary, 'commit', '-m', 'fixture');
  git(primary, 'remote', 'add', 'origin', origin);
  git(primary, 'push', '-u', 'origin', defaultBranch);
  const publisher = join(root, 'publisher');
  execFileSync('git', ['clone', origin, publisher]);
  configureIdentity(publisher);
  return { defaultBranch, origin, primary, publisher, root };
}

async function repoState(primary: string): Promise<RepoState> {
  return Effect.runPromise(discoverRepository(primary));
}

function advance(repo: string, name: string): string {
  writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
  git(repo, 'add', `${name}.txt`);
  git(repo, 'commit', '-m', name);
  git(repo, 'push', 'origin', 'HEAD');
  return git(repo, 'rev-parse', 'HEAD');
}

describe('remote baseline resolution', () => {
  test("uses origin's configured non-main default branch and supports one validated explicit override", async () => {
    const fixture = remoteRepository('master');
    const repo = await repoState(fixture.primary);
    const masterSha = git(fixture.primary, 'rev-parse', 'HEAD');
    git(fixture.publisher, 'checkout', '-b', 'release/v1.2_3');
    const releaseSha = advance(fixture.publisher, 'release-baseline');

    expect(await Effect.runPromise(resolveRemoteBaseline(repo))).toEqual({
      branch: 'master',
      remote: 'origin',
      sha: masterSha,
    });
    expect(await Effect.runPromise(resolveRemoteBaseline(repo, 'release/v1.2_3'))).toEqual({
      branch: 'release/v1.2_3',
      remote: 'origin',
      sha: releaseSha,
    });
    expect(git(fixture.primary, 'rev-parse', 'HEAD')).toBe(masterSha);
  });

  test('resolves remote advancement freshly while ignoring stale local HEAD and tracking state', async () => {
    const fixture = remoteRepository();
    const repo = await repoState(fixture.primary);
    const initialSha = git(fixture.primary, 'rev-parse', 'HEAD');
    expect(await Effect.runPromise(resolveRemoteBaseline(repo))).toEqual({
      branch: 'main',
      remote: 'origin',
      sha: initialSha,
    });

    const advancedSha = advance(fixture.publisher, 'remote-advance');
    expect(git(fixture.primary, 'rev-parse', 'HEAD')).toBe(initialSha);
    expect(git(fixture.primary, 'rev-parse', 'refs/remotes/origin/main')).toBe(initialSha);

    expect(await Effect.runPromise(resolveRemoteBaseline(repo))).toEqual({
      branch: 'main',
      remote: 'origin',
      sha: advancedSha,
    });
    expect(git(fixture.primary, 'rev-parse', 'HEAD')).toBe(initialSha);
    expect(git(fixture.primary, 'rev-parse', 'refs/remotes/origin/main')).toBe(initialSha);
  });

  test('fails closed with bounded typed reasons for missing origin, missing default branch, and fetch failure', async () => {
    const local = localRepository();
    const missingRemote = await Effect.runPromise(
      resolveRemoteBaseline(await repoState(local)).pipe(Effect.flip),
    );
    expect(missingRemote).toMatchObject({ _tag: 'RemoteBaselineError', reason: 'missing_remote' });

    const emptyRoot = mkdtempSync(join(tmpdir(), 'pardes-baseline-empty-origin-'));
    temporaryDirectories.push(emptyRoot);
    const emptyOrigin = join(emptyRoot, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', emptyOrigin]);
    git(local, 'remote', 'add', 'origin', emptyOrigin);
    const missingDefault = await Effect.runPromise(
      resolveRemoteBaseline(await repoState(local)).pipe(Effect.flip),
    );
    expect(missingDefault).toMatchObject({
      _tag: 'RemoteBaselineError',
      reason: 'missing_default_branch',
    });

    const fixture = remoteRepository();
    const missingOverride = await Effect.runPromise(
      resolveRemoteBaseline(await repoState(fixture.primary), 'missing').pipe(Effect.flip),
    );
    expect(missingOverride).toMatchObject({ _tag: 'RemoteBaselineError', reason: 'fetch_failed' });
  });

  test('rejects an unsafe override before constructing any Git argv and bounds non-commit resolution', async () => {
    const repo = {
      currentCheckout: '/tmp/repo',
      gitCommonDir: '/tmp/repo/.git',
      key: 'repo',
      primaryCheckout: '/tmp/repo',
    };
    const calls: ReadonlyArray<string>[] = [];
    const sha = 'a'.repeat(40);
    const runner = (_cwd: string, args: ReadonlyArray<string>) => {
      calls.push(args);
      const command = args.join(' ');
      if (command === 'remote get-url origin')
        return Effect.succeed({ stderr: '', stdout: 'origin\n' } satisfies GitResult);
      if (command === 'ls-remote --exit-code --refs origin refs/heads/topic')
        return Effect.succeed({
          stderr: '',
          stdout: `${sha}\trefs/heads/topic\n`,
        } satisfies GitResult);
      if (command === `fetch --no-tags origin ${sha}`)
        return Effect.succeed({ stderr: '', stdout: '' } satisfies GitResult);
      return Effect.fail(
        new GitCommandError({ args, cause: 'fixture non-commit', cwd: '/tmp/repo' }),
      );
    };
    const resolve = makeRemoteBaselineResolver(runner);

    const invalid = await Effect.runPromise(
      resolve(repo, '--upload-pack=attacker/project').pipe(Effect.flip),
    );
    expect(invalid).toMatchObject({ _tag: 'RemoteBaselineError', reason: 'invalid_override' });
    expect(calls).toEqual([]);

    const nonCommit = await Effect.runPromise(resolve(repo, 'topic').pipe(Effect.flip));
    expect(nonCommit).toMatchObject({
      _tag: 'RemoteBaselineError',
      reason: 'non_commit_resolution',
    });
    expect(calls).toEqual([
      ['remote', 'get-url', 'origin'],
      ['ls-remote', '--exit-code', '--refs', 'origin', 'refs/heads/topic'],
      ['fetch', '--no-tags', 'origin', sha],
      ['rev-parse', '--verify', `${sha}^{commit}`],
    ]);
  });
});
