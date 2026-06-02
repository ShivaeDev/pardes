import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import { runGitFixture } from '../test-support.ts';
import { gitEnvironmentForExplicitCwd } from './environment.ts';
import { runGit } from './transport.ts';

describe('Git command boundary', () => {
  test('captures fixture stderr for replay without printing successful setup chatter', () => {
    expect(() => runGitFixture(tmpdir(), 'pardes-fixture-command-does-not-exist')).toThrow(
      /git: 'pardes-fixture-command-does-not-exist' is not a git command/,
    );
  });

  test('preserves supported production Git environment while removing repository redirection', () => {
    expect(
      gitEnvironmentForExplicitCwd({
        GIT_ALLOW_PROTOCOL: 'https',
        GIT_ASKPASS: '/tmp/pardes-askpass',
        GIT_DEFAULT_HASH: 'sha256',
        GIT_DIR: '/tmp/redirected.git',
        GIT_PROTOCOL_FROM_USER: '0',
        GIT_SSH_COMMAND: 'ssh fixture',
      }),
    ).toEqual({
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_ASKPASS: '/tmp/pardes-askpass',
      GIT_DEFAULT_HASH: 'sha256',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_SSH_COMMAND: 'ssh fixture',
    });
  });

  test('uses its explicit cwd despite inherited repository redirection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-run-git-environment-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    const previousGitDir = process.env.GIT_DIR;
    try {
      runGitFixture(root, 'init', '-b', 'main', first);
      runGitFixture(root, 'init', '-b', 'main', second);
      process.env.GIT_DIR = join(second, '.git');

      expect(await Effect.runPromise(runGit(first, ['rev-parse', '--git-dir']))).toEqual({
        stderr: '',
        stdout: '.git\n',
      });
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('retains multiline option-looking text as one argv token', async () => {
    const body = 'first line\n--upload-pack=attacker/project\nlast line';

    const result = await Effect.runPromise(
      runGit(tmpdir(), [
        '-c',
        `pardes.argvFixture=${body}`,
        'config',
        '--get',
        'pardes.argvFixture',
      ]),
    );

    expect(result.stdout).toBe(`${body}\n`);
  });

  test('applies opt-in timeout and output circuit breakers', async () => {
    const oversized = await Effect.runPromise(
      runGit(tmpdir(), ['-c', 'alias.emit=!printf 1234567890', 'emit'], { maxBuffer: 4 }).pipe(
        Effect.flip,
      ),
    );
    const timedOut = await Effect.runPromise(
      runGit(tmpdir(), ['-c', 'alias.wait=!sleep 1', 'wait'], { timeoutMs: 10 }).pipe(Effect.flip),
    );

    expect(oversized._tag).toBe('GitCommandError');
    expect(timedOut._tag).toBe('GitCommandError');
  });
});
