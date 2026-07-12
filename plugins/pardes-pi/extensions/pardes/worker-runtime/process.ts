import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Effect, type Scope } from 'effect';
import { gitEnvironmentForExplicitCwd } from '../git/index.ts';
import {
  type ChildLaunchProfile,
  childProfileEnvironment,
  childProfileTools,
  WORKER_CHILD_PROFILE,
} from './child-profile.ts';
import { WorkerProcessError } from './errors.ts';

export { VERIFIER_TOOLS, WORKER_TOOLS } from './child-profile.ts';

export const DEFAULT_WORKER_EXTENSION = fileURLToPath(
  new URL('./child-extension.ts', import.meta.url),
);

export interface WorkerProcessInput {
  readonly agentId: string;
  readonly managerId?: string;
  readonly repositoryKey?: string;
  readonly workstreamId?: string;
  readonly verificationId?: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly workerExtensionPath?: string;
  readonly childProfile?: ChildLaunchProfile;
}

export interface WorkerProcessOptions<Input extends WorkerProcessInput = WorkerProcessInput> {
  readonly command?: string;
  readonly args?: (input: Input) => ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}

export type WorkerProcess = ChildProcessWithoutNullStreams;

function workerProcessError(
  agentId: string,
  operation: string,
  cause: unknown,
): WorkerProcessError {
  return new WorkerProcessError({ agentId, cause, operation });
}

export function defaultWorkerProcessArgs(input: WorkerProcessInput): ReadonlyArray<string> {
  const profile = input.childProfile ?? WORKER_CHILD_PROFILE;
  return [
    '--mode',
    'rpc',
    '--session-dir',
    input.sessionDir,
    ...(input.sessionFile ? ['--session', input.sessionFile] : []),
    '--no-extensions',
    '--extension',
    input.workerExtensionPath ?? DEFAULT_WORKER_EXTENSION,
    '--tools',
    childProfileTools(profile),
    '--model',
    input.model,
    '--thinking',
    input.thinkingLevel,
  ];
}

export function ensureWorkerSessionDirectory(
  input: WorkerProcessInput,
): Effect.Effect<void, WorkerProcessError> {
  return Effect.tryPromise({
    catch: (cause) => workerProcessError(input.agentId, 'create worker session directory', cause),
    try: () => mkdir(input.sessionDir, { recursive: true }),
  });
}

function terminateWorkerProcess(child: WorkerProcess): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    let finished = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (force) clearTimeout(force);
      resume(Effect.void);
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    return Effect.sync(() => {
      clearTimeout(force);
      child.off('exit', finish);
    });
  });
}

export function spawnWorkerProcess<Input extends WorkerProcessInput>(
  input: Input,
  options: WorkerProcessOptions<Input> = {},
): Effect.Effect<WorkerProcess, WorkerProcessError, Scope.Scope> {
  const command = options.command ?? 'pi';
  const args = options.args?.(input) ?? defaultWorkerProcessArgs(input);
  const env = gitEnvironmentForExplicitCwd({
    ...process.env,
    ...options.env,
    PARDES_FEEDBACK_AGENT_ID: input.agentId,
    PARDES_FEEDBACK_MANAGER_ID: input.managerId,
    PARDES_FEEDBACK_REPOSITORY_KEY: input.repositoryKey,
    PARDES_FEEDBACK_VERIFICATION_ID: input.verificationId,
    PARDES_FEEDBACK_WORKSTREAM_ID: input.workstreamId,
    PARDES_WORKTREE_ROOT: input.cwd,
    ...childProfileEnvironment(input.childProfile),
  });
  const acquire = Effect.callback<WorkerProcess, WorkerProcessError>((resume) => {
    const child = spawn(command, [...args], { cwd: input.cwd, env, stdio: 'pipe' });
    let settled = false;
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      child.off('error', onError);
      resume(Effect.succeed(child));
    };
    const onError = (cause: unknown) => {
      if (settled) return;
      settled = true;
      child.off('spawn', onSpawn);
      resume(Effect.fail(workerProcessError(input.agentId, `spawn ${command}`, cause)));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    return Effect.sync(() => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
      child.kill('SIGTERM');
    });
  });
  return Effect.acquireRelease(acquire, (child) => terminateWorkerProcess(child));
}
