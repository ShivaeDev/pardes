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
import { setTimeout as sleep } from 'node:timers/promises';
import { Cause, Effect, Exit, Fiber } from 'effect';
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

function escapedDescendantUpdate(cwd: string, keepParentAlive: boolean): void {
  const scriptDirectory = join(cwd, 'script');
  mkdirSync(scriptDirectory, { recursive: true });
  const script = join(scriptDirectory, 'update');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
  detached: true,
  stdio: ['ignore', process.stdout, process.stderr],
});
writeFileSync('escaped.pid', String(child.pid));
child.unref();
${keepParentAlive ? 'setInterval(() => {}, 10000);' : ''}
`,
  );
  chmodSync(script, 0o755);
}

function terminateEscapedFixture(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The fixture descendant may have exited independently.
  }
}

async function eventually(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for fixture state');
    await sleep(5);
  }
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
      'printf "%s\\n%s\\n%s\\n" "$PWD" "$PARDES_BOOTSTRAP_FIXTURE" "$#" > bootstrap-observed',
    );
    const outcome = await Effect.runPromise(
      makeWorktreeBootstrap({ env: { PARDES_BOOTSTRAP_FIXTURE: 'inherited' } }).run(cwd),
    );

    expect(outcome).toEqual({
      output: { countAccuracy: 'exact', stderrChars: 0, stdoutChars: 0 },
      status: 'succeeded',
    });
    expect(readFileSync(join(cwd, 'bootstrap-observed'), 'utf8')).toBe(
      `${realpathSync(cwd)}\ninherited\n0\n`,
    );
  });

  test('fails closed instead of guessing an interpreter for a non-executable hook', async () => {
    const cwd = worktree();
    updateScript(cwd, 'exit 0', false);
    const error = await failedUpdate(cwd);
    expect(error.reason).toBe('not_executable');
  });

  test('classifies a missing shebang interpreter as a spawn failure', async () => {
    const cwd = worktree();
    const scriptDirectory = join(cwd, 'script');
    mkdirSync(scriptDirectory, { recursive: true });
    const script = join(scriptDirectory, 'update');
    writeFileSync(script, '#!/definitely/missing-pardes-interpreter\n');
    chmodSync(script, 0o755);

    const error = await failedUpdate(cwd);

    expect(error).toMatchObject({ reason: 'spawn_failed' });
    expect(error.directExitObserved).toBeUndefined();
  });

  test('classifies a direct child signal without guessing a fallback interpreter', async () => {
    const cwd = worktree();
    updateScript(cwd, 'kill -TERM $$');

    const error = await failedUpdate(cwd);

    expect(error).toMatchObject({
      directExitObserved: true,
      reason: 'signaled',
      signal: 'SIGTERM',
    });
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

  test('interrupts the observable hook process group when provisioning is cancelled', async () => {
    const cwd = worktree();
    updateScript(cwd, 'printf "%s" "$$" > hook.pid\nsleep 10');
    const fiber = Effect.runFork(makeWorktreeBootstrap().run(cwd));
    await eventually(() => existsSync(join(cwd, 'hook.pid')));
    const pid = Number(readFileSync(join(cwd, 'hook.pid'), 'utf8'));

    await Effect.runPromise(Fiber.interrupt(fiber));
    await eventually(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  test('fails closed when a successful direct child leaves an inherited pipe unsettled', async () => {
    const cwd = worktree();
    escapedDescendantUpdate(cwd, false);

    const error = await failedUpdate(cwd);
    const escapedPid = Number(readFileSync(join(cwd, 'escaped.pid'), 'utf8'));
    try {
      expect(error).toMatchObject({
        diagnostic: { countAccuracy: 'lower_bound' },
        directExitObserved: true,
        reason: 'process_lifecycle_unsettled',
      });
      expect(() => process.kill(escapedPid, 0)).not.toThrow();
    } finally {
      terminateEscapedFixture(escapedPid);
    }
  });

  test('bounds timeout settlement when a new-session descendant escapes and retains output pipes', async () => {
    const cwd = worktree();
    escapedDescendantUpdate(cwd, true);
    const startedAt = Date.now();
    const error = await failedUpdate(cwd, 1_000);
    const elapsedMs = Date.now() - startedAt;
    const escapedPid = Number(readFileSync(join(cwd, 'escaped.pid'), 'utf8'));
    try {
      expect(error).toMatchObject({
        diagnostic: { countAccuracy: 'lower_bound' },
        reason: 'timeout',
      });
      expect(elapsedMs).toBeLessThan(2_000);
      expect(() => process.kill(escapedPid, 0)).not.toThrow();
      expect(worktreeUpdateFailureSummary(error)).toContain('escaped_descendants=not_observable');
    } finally {
      terminateEscapedFixture(escapedPid);
    }
  });
});
