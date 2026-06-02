import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { decodeGitHubJson } from './codecs.ts';
import {
  GITHUB_COMMAND_MAX_BUFFER_BYTES,
  type GitHubCommandRunnerShape,
  makeExecFileGitHubCommandRunner,
  makeGitHubCli,
  type ProcessInvocation,
} from './transport.ts';
import { classifyGitHubWatcherFailure } from './watcher-diagnostics.ts';

describe('GitHub CLI transport', () => {
  test('preserves injected gh argv exactly, including a multiline body as one token', async () => {
    const invocations: ProcessInvocation[] = [];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) =>
        Effect.sync(() => {
          invocations.push(invocation);
          return { stderr: '', stdout: '' };
        }),
    };
    const github = makeGitHubCli(runner);
    const body = 'Summary\n\n--repo=attacker/project remains body text';
    const args = ['pr', 'create', '--title', 'Bounded title', '--body', body, '--base', 'main'];

    await Effect.runPromise(github.run('/tmp/managed-worker', args));

    expect(invocations).toEqual([{ args, command: 'gh', cwd: '/tmp/managed-worker' }]);
    expect(invocations[0]?.args[5]).toBe(body);
  });

  test('keeps a bounded process-ingestion circuit breaker for shell-free argv adapters', () => {
    expect(GITHUB_COMMAND_MAX_BUFFER_BYTES).toBe(1024 * 1024);
  });

  test('interrupts the shell-free execFile child when its Effect is interrupted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pardes-gh-interrupt-'));
    const marker = join(directory, 'interrupted');
    const source = `const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(marker)}, "interrupted"); process.exit(0); }); setInterval(() => {}, 1000);`;
    try {
      const timed = await Effect.runPromise(
        makeExecFileGitHubCommandRunner()
          .run({
            args: ['-e', source],
            command: process.execPath,
            cwd: directory,
          })
          .pipe(Effect.timeoutOption('250 millis')),
      );

      expect(Option.isNone(timed)).toBe(true);
      for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt += 1) await sleep(10);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test('maps execFile failures to a typed error carrying raw structured diagnostics', async () => {
    const runner = makeExecFileGitHubCommandRunner();
    const invocation = {
      args: ['--body', 'one argv token'],
      command: 'pardes-command-that-does-not-exist',
      cwd: '/tmp',
    };

    const failure = await Effect.runPromise(runner.run(invocation).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubCommandError');
    expect(failure.command).toBe(invocation.command);
    expect(failure.cwd).toBe(invocation.cwd);
    expect(failure.args).toEqual(invocation.args);
  });

  test('reduces stderr auth symptoms to a safe hint without carrying stderr into the typed error', async () => {
    const token = 'ghp_private-token-marker';
    const failure = await Effect.runPromise(
      makeExecFileGitHubCommandRunner()
        .run({
          args: [
            '-e',
            `process.stderr.write("HTTP 401 authentication required ${token}"); process.exit(1);`,
          ],
          command: process.execPath,
          cwd: '/tmp',
        })
        .pipe(Effect.flip),
    );
    const diagnostic = classifyGitHubWatcherFailure(failure);

    expect(failure.diagnosticHint).toBe('authentication_likely');
    expect(failure.cause).not.toHaveProperty('stderr');
    expect(diagnostic).toEqual({
      kind: 'authentication_likely',
      summary: 'GitHub CLI authentication likely failed; run gh auth status.',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(token);
  });

  test('maps malformed JSON and schema mismatches to typed operation-specific response errors', async () => {
    const schema = Schema.Struct({ number: Schema.Number });

    const malformed = await Effect.runPromise(
      decodeGitHubJson('decode malformed fixture', schema, '{').pipe(Effect.flip),
    );
    const mismatched = await Effect.runPromise(
      decodeGitHubJson('decode mismatched fixture', schema, JSON.stringify({ number: '42' })).pipe(
        Effect.flip,
      ),
    );

    expect(malformed._tag).toBe('GitHubResponseError');
    expect(malformed.operation).toBe('decode malformed fixture');
    expect(mismatched._tag).toBe('GitHubResponseError');
    expect(mismatched.operation).toBe('decode mismatched fixture');
  });
});
