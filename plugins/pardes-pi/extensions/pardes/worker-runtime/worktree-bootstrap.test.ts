import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import {
  makeWorktreeBootstrap,
  WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS,
  WorktreeUpdateError,
  worktreeUpdateFailureSummary,
} from './worktree-bootstrap.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function worktree(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pardes-worktree-bootstrap-'));
  temporaryDirectories.push(directory);
  return directory;
}

function updateScript(cwd: string, body: string, executable = true): string {
  const scriptDirectory = join(cwd, 'script');
  mkdirSync(scriptDirectory, { recursive: true });
  const script = join(scriptDirectory, 'update');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  if (executable) chmodSync(script, 0o755);
  return script;
}

async function failedUpdate(cwd: string, timeoutMs = 1_000): Promise<WorktreeUpdateError> {
  const exit = await Effect.runPromiseExit(makeWorktreeBootstrap({ timeoutMs }).run(cwd));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error('Expected worktree bootstrap failure');
  const error = Cause.squash(exit.cause);
  expect(error).toBeInstanceOf(WorktreeUpdateError);
  return error as WorktreeUpdateError;
}

describe('fresh worktree bootstrap', () => {
  test('is a no-op when script/update is absent', async () => {
    const cwd = worktree();
    await expect(Effect.runPromise(makeWorktreeBootstrap().run(cwd))).resolves.toEqual({
      status: 'absent',
    });
    expect(existsSync(join(cwd, 'script', 'update'))).toBe(false);
  });

  test('runs the executable directly from the worktree cwd with inherited environment', async () => {
    const cwd = worktree();
    updateScript(
      cwd,
      'printf "%s\\n%s\\n" "$PWD" "$PARDES_BOOTSTRAP_FIXTURE" > bootstrap-observed',
    );
    const outcome = await Effect.runPromise(
      makeWorktreeBootstrap({ env: { PARDES_BOOTSTRAP_FIXTURE: 'inherited' } }).run(cwd),
    );

    expect(outcome).toEqual({
      output: { stderrChars: 0, stdoutChars: 0 },
      status: 'succeeded',
    });
    expect(readFileSync(join(cwd, 'bootstrap-observed'), 'utf8')).toBe(
      `${realpathSync(cwd)}\ninherited\n`,
    );
  });

  test('fails closed instead of guessing an interpreter for a non-executable hook', async () => {
    const cwd = worktree();
    updateScript(cwd, 'exit 0', false);
    const error = await failedUpdate(cwd);
    expect(error.reason).toBe('not_executable');
  });

  test('returns bounded terminal-only tails and body-free durable failure metadata', async () => {
    const cwd = worktree();
    updateScript(
      cwd,
      `head -c ${WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS + 100} /dev/zero | tr '\\0' x\nprintf 'stderr-secret' >&2\nexit 23`,
    );
    const error = await failedUpdate(cwd);

    expect(error).toMatchObject({ exitCode: 23, reason: 'nonzero_exit' });
    expect(error.diagnostic.stdoutChars).toBe(WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS + 100);
    expect(error.diagnostic.stdoutTail).toHaveLength(WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS);
    expect(error.diagnostic.stderrTail).toBe('stderr-secret');
    expect(worktreeUpdateFailureSummary(error)).not.toContain('stderr-secret');
  });

  test('bounds a hung repository hook and reports timeout without launching anything else', async () => {
    const cwd = worktree();
    updateScript(cwd, 'sleep 10');
    const error = await failedUpdate(cwd, 20);
    expect(error.reason).toBe('timeout');
  });
});
