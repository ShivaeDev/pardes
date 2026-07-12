import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Effect, Exit, Scope } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import { requiredValue, runGitFixture } from '../test-support.ts';
import { childProfileEnvironment, verifierChildProfile } from './child-profile.ts';
import {
  DEFAULT_WORKER_EXTENSION,
  defaultWorkerProcessArgs,
  ensureWorkerSessionDirectory,
  spawnWorkerProcess,
  VERIFIER_TOOLS,
  WORKER_TOOLS,
  type WorkerProcessInput,
} from './process.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pardes-worker-process-'));
  temporaryDirectories.push(directory);
  return directory;
}

function workerInput(
  root: string,
  overrides: Partial<WorkerProcessInput> = {},
): WorkerProcessInput {
  return {
    agentId: 'agent-process-fixture',
    cwd: root,
    model: 'fixture/model',
    sessionDir: join(root, 'sessions', 'agent-process-fixture'),
    thinkingLevel: 'low',
    ...overrides,
  };
}

async function closeScope(scope: Scope.Closeable): Promise<void> {
  await Effect.runPromise(Scope.close(scope, Exit.void));
}

describe('worker process', () => {
  test('constructs the exact default argv without a retained session', () => {
    const input = workerInput('/tmp/pardes-worker-root');
    expect(defaultWorkerProcessArgs(input)).toEqual([
      '--mode',
      'rpc',
      '--session-dir',
      '/tmp/pardes-worker-root/sessions/agent-process-fixture',
      '--no-extensions',
      '--extension',
      DEFAULT_WORKER_EXTENSION,
      '--tools',
      WORKER_TOOLS,
      '--model',
      'fixture/model',
      '--thinking',
      'low',
    ]);
  });

  test('uses one atomic verifier scratch profile for Bash-safe tools and captured-head evidence', () => {
    const childProfile = verifierChildProfile('a'.repeat(40), 'b'.repeat(40));
    const args = defaultWorkerProcessArgs(
      workerInput('/tmp/pardes-verifier-root', { childProfile }),
    );
    expect(args[args.indexOf('--tools') + 1]).toBe(VERIFIER_TOOLS);
    expect(VERIFIER_TOOLS.split(',')).toEqual([
      'read',
      'bash',
      'grep',
      'find',
      'ls',
      'feedback',
      'verification_evidence',
      'report_to_manager',
      'ask_manager',
    ]);
    expect(VERIFIER_TOOLS.split(',')).toContain('bash');
    for (const excluded of ['edit', 'write'])
      expect(VERIFIER_TOOLS.split(',')).not.toContain(excluded);
    expect(childProfileEnvironment(childProfile)).toEqual({
      PARDES_AGENT_PROFILE: 'verifier',
      PARDES_VERIFICATION_BASELINE_SHA: 'a'.repeat(40),
      PARDES_VERIFICATION_REVIEWED_SHA: 'b'.repeat(40),
    });
  });

  test('clears inherited verifier evidence when launching the default worker profile', () => {
    expect(childProfileEnvironment()).toEqual({
      PARDES_AGENT_PROFILE: 'worker',
      PARDES_VERIFICATION_BASELINE_SHA: undefined,
      PARDES_VERIFICATION_REVIEWED_SHA: undefined,
    });
  });

  test('disables discovered package extensions and explicitly loads only the child-worker extension', () => {
    const args = defaultWorkerProcessArgs(workerInput('/tmp/pardes-worker-root'));
    const extensionFlags = args.flatMap((arg, index) => (arg === '--extension' ? [index] : []));

    expect(args.filter((arg) => arg === '--no-extensions')).toHaveLength(1);
    expect(extensionFlags).toHaveLength(1);
    const extensionFlag = requiredValue(extensionFlags[0]);
    expect(args.slice(extensionFlag, extensionFlag + 2)).toEqual([
      '--extension',
      DEFAULT_WORKER_EXTENSION,
    ]);
    expect(args).not.toContain('extensions/pardes/index.ts');
  });

  test('uses an input-pinned manager snapshot path instead of the mutable shared default', () => {
    const input = workerInput('/tmp/pardes-worker-root', {
      workerExtensionPath:
        '/tmp/pardes-manager/runtime/child-extension/pinned/worker-runtime/child-extension.ts',
    });
    const args = defaultWorkerProcessArgs(input);

    expect(args.slice(args.indexOf('--extension'), args.indexOf('--extension') + 2)).toEqual([
      '--extension',
      '/tmp/pardes-manager/runtime/child-extension/pinned/worker-runtime/child-extension.ts',
    ]);
    expect(args).not.toContain(DEFAULT_WORKER_EXTENSION);
  });

  test('places the retained session immediately after the session directory', () => {
    const input = workerInput('/tmp/pardes-worker-root', {
      sessionFile: '/tmp/retained-session.jsonl',
    });
    expect(defaultWorkerProcessArgs(input)).toEqual([
      '--mode',
      'rpc',
      '--session-dir',
      '/tmp/pardes-worker-root/sessions/agent-process-fixture',
      '--session',
      '/tmp/retained-session.jsonl',
      '--no-extensions',
      '--extension',
      DEFAULT_WORKER_EXTENSION,
      '--tools',
      WORKER_TOOLS,
      '--model',
      'fixture/model',
      '--thinking',
      'low',
    ]);
  });

  test('creates a retained worker session directory recursively', async () => {
    const root = temporaryDirectory();
    const sessionDir = join(root, 'nested', 'worker', 'sessions');
    await Effect.runPromise(ensureWorkerSessionDirectory(workerInput(root, { sessionDir })));
    expect(existsSync(sessionDir)).toBe(true);
  });

  test('reports recursive session directory creation failures as typed WorkerProcessError', async () => {
    const root = temporaryDirectory();
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const exit = await Effect.runPromiseExit(
      ensureWorkerSessionDirectory(workerInput(root, { sessionDir: join(blocker, 'sessions') })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('Expected worker session directory creation to fail');
    expect(Cause.squash(exit.cause)).toMatchObject({
      _tag: 'WorkerProcessError',
      agentId: 'agent-process-fixture',
      cause: { code: 'ENOTDIR' },
      operation: 'create worker session directory',
    });
  });

  test('reports a bad executable as typed WorkerProcessError', async () => {
    const root = temporaryDirectory();
    const command = join(root, 'missing-worker-executable');
    const exit = await Effect.runPromiseExit(
      Effect.scoped(spawnWorkerProcess(workerInput(root), { args: () => [], command })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('Expected worker spawn to fail');
    expect(Cause.squash(exit.cause)).toMatchObject({
      _tag: 'WorkerProcessError',
      agentId: 'agent-process-fixture',
      cause: { code: 'ENOENT' },
      operation: `spawn ${command}`,
    });
  });

  test('exposes raw pipes and spawns with cwd plus merged worker environment', async () => {
    const root = temporaryDirectory();
    const script = join(root, 'inspect-worker.mjs');
    writeFileSync(
      script,
      `
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  inheritedPath: process.env.PATH,
  fixture: process.env.PARDES_PROCESS_FIXTURE,
  worktreeRoot: process.env.PARDES_WORKTREE_ROOT,
  agentProfile: process.env.PARDES_AGENT_PROFILE,
  verificationBaseline: process.env.PARDES_VERIFICATION_BASELINE_SHA,
  verificationReviewed: process.env.PARDES_VERIFICATION_REVIEWED_SHA,
  feedbackAgentId: process.env.PARDES_FEEDBACK_AGENT_ID,
  feedbackManagerId: process.env.PARDES_FEEDBACK_MANAGER_ID,
  feedbackRepositoryKey: process.env.PARDES_FEEDBACK_REPOSITORY_KEY,
  feedbackVerificationId: process.env.PARDES_FEEDBACK_VERIFICATION_ID,
  feedbackWorkstreamId: process.env.PARDES_FEEDBACK_WORKSTREAM_ID,
}) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    const scope = await Effect.runPromise(Scope.make());
    const child = await Effect.runPromise(
      spawnWorkerProcess(
        workerInput(root, {
          managerId: 'manager-process-fixture',
          repositoryKey: 'repo-process-fixture',
          verificationId: 'verify-process-fixture',
          workstreamId: 'stream-process-fixture',
        }),
        {
          args: () => [script],
          command: process.execPath,
          env: {
            PARDES_PROCESS_FIXTURE: 'present',
            PARDES_VERIFICATION_BASELINE_SHA: 'leaked-baseline',
            PARDES_VERIFICATION_REVIEWED_SHA: 'leaked-reviewed-head',
            PARDES_WORKTREE_ROOT: '/tmp/incorrect-root',
          },
        },
      ).pipe(Scope.provide(scope)),
    );
    try {
      expect(child.stdin.writable).toBe(true);
      expect(child.stdout.readable).toBe(true);
      expect(child.stderr.readable).toBe(true);
      const line = await new Promise<string>((resolve) =>
        child.stdout.once('data', (chunk) => resolve(String(chunk))),
      );
      expect(JSON.parse(line) as unknown).toEqual({
        agentProfile: 'worker',
        cwd: realpathSync(root),
        feedbackAgentId: 'agent-process-fixture',
        feedbackManagerId: 'manager-process-fixture',
        feedbackRepositoryKey: 'repo-process-fixture',
        feedbackVerificationId: 'verify-process-fixture',
        feedbackWorkstreamId: 'stream-process-fixture',
        fixture: 'present',
        inheritedPath: process.env.PATH,
        worktreeRoot: root,
      });
    } finally {
      await closeScope(scope);
    }
  });

  test('keeps child Bash Git rooted in its managed cwd despite inherited repository redirection', async () => {
    const root = temporaryDirectory();
    const worktree = join(root, 'worktree');
    const redirected = join(root, 'redirected');
    runGitFixture(root, 'init', '-b', 'main', worktree);
    runGitFixture(root, 'init', '-b', 'main', redirected);
    const scope = await Effect.runPromise(Scope.make());
    const child = await Effect.runPromise(
      spawnWorkerProcess(workerInput(worktree), {
        args: () => [
          '-c',
          'printf "%s\\n" "$GIT_DIR" "$GIT_ALLOW_PROTOCOL" "$GIT_DEFAULT_HASH"; git rev-parse --git-dir; sleep 10',
        ],
        command: '/bin/bash',
        env: {
          GIT_ALLOW_PROTOCOL: 'https',
          GIT_DEFAULT_HASH: 'sha256',
          GIT_DIR: join(redirected, '.git'),
        },
      }).pipe(Scope.provide(scope)),
    );
    try {
      const output = await new Promise<string>((resolve) => {
        let accumulated = '';
        const onData = (chunk: Buffer) => {
          accumulated += String(chunk);
          if (accumulated.split('\n').length < 5) return;
          child.stdout.off('data', onData);
          resolve(accumulated);
        };
        child.stdout.on('data', onData);
      });
      expect(output.split('\n').slice(0, 4)).toEqual(['', 'https', 'sha256', '.git']);
    } finally {
      await closeScope(scope);
    }
  });

  test('terminates the worker when its scope closes', async () => {
    const root = temporaryDirectory();
    const scope = await Effect.runPromise(Scope.make());
    const child = await Effect.runPromise(
      spawnWorkerProcess(workerInput(root), {
        args: () => ['--eval', 'setInterval(() => {}, 1000)'],
        command: process.execPath,
      }).pipe(Scope.provide(scope)),
    );
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    await closeScope(scope);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
