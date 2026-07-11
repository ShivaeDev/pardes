import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Cause, Context, Data, Effect, Exit, Layer } from 'effect';
import { gitEnvironmentForExplicitCwd } from '../git/index.ts';

export const WORKTREE_UPDATE_SCRIPT = 'script/update';
export const WORKTREE_UPDATE_TIMEOUT_MS = 15 * 60_000;
export const WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS = 4_000;
const TERMINATION_GRACE_MS = 2_000;

export interface WorktreeUpdateOutput {
  readonly stdoutChars: number;
  readonly stderrChars: number;
}

export interface WorktreeUpdateDiagnostic extends WorktreeUpdateOutput {
  /** Terminal-only subprocess previews. Never persist these tails in manager state or artifacts. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export type WorktreeUpdateFailureReason =
  | 'inspect_failed'
  | 'not_executable'
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'signaled'
  | 'timeout';

export class WorktreeUpdateError extends Data.TaggedError('WorktreeUpdateError')<{
  readonly cwd: string;
  readonly diagnostic: WorktreeUpdateDiagnostic;
  readonly exitCode?: number;
  readonly reason: WorktreeUpdateFailureReason;
  readonly signal?: NodeJS.Signals;
  readonly cause?: unknown;
}> {}

export type WorktreeUpdateOutcome =
  | { readonly status: 'absent' }
  | { readonly status: 'succeeded'; readonly output: WorktreeUpdateOutput };

export interface WorktreeBootstrapShape {
  readonly run: (cwd: string) => Effect.Effect<WorktreeUpdateOutcome, WorktreeUpdateError>;
}

export interface WorktreeBootstrapOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export class WorktreeBootstrap extends Context.Service<WorktreeBootstrap, WorktreeBootstrapShape>()(
  'pardes/worker-runtime/WorktreeBootstrap',
) {
  static readonly layer = (options: WorktreeBootstrapOptions = {}) =>
    Layer.succeed(WorktreeBootstrap, makeWorktreeBootstrap(options));
}

interface MutableDiagnostic {
  stdoutChars: number;
  stderrChars: number;
  stdoutTail: string;
  stderrTail: string;
}

function appendTail(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS);
}

function snapshotDiagnostic(diagnostic: MutableDiagnostic): WorktreeUpdateDiagnostic {
  return { ...diagnostic };
}

function emptyDiagnostic(): WorktreeUpdateDiagnostic {
  return { stderrChars: 0, stderrTail: '', stdoutChars: 0, stdoutTail: '' };
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The direct child may have exited between observation and signaling.
    }
  }
  child.kill(signal);
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, 'SIGTERM');
  const force = setTimeout(() => signalProcessTree(child, 'SIGKILL'), TERMINATION_GRACE_MS);
  child.once('close', () => clearTimeout(force));
  force.unref();
}

function executeUpdate(
  cwd: string,
  scriptPath: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Effect.Effect<WorktreeUpdateOutcome, WorktreeUpdateError> {
  return Effect.callback<WorktreeUpdateOutcome, WorktreeUpdateError>((resume) => {
    const diagnostic: MutableDiagnostic = {
      stderrChars: 0,
      stderrTail: '',
      stdoutChars: 0,
      stdoutTail: '',
    };
    const child = spawn(scriptPath, [], {
      cwd,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      diagnostic.stdoutChars += chunk.length;
      diagnostic.stdoutTail = appendTail(diagnostic.stdoutTail, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      diagnostic.stderrChars += chunk.length;
      diagnostic.stderrTail = appendTail(diagnostic.stderrTail, chunk);
    });

    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGKILL');
    }, timeoutMs);
    const finish = (effect: Effect.Effect<WorktreeUpdateOutcome, WorktreeUpdateError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(effect);
    };
    child.once('error', (cause) => {
      finish(
        Effect.fail(
          new WorktreeUpdateError({
            cause,
            cwd,
            diagnostic: snapshotDiagnostic(diagnostic),
            reason: 'spawn_failed',
          }),
        ),
      );
    });
    child.once('close', (exitCode, signal) => {
      const captured = snapshotDiagnostic(diagnostic);
      if (timedOut) {
        finish(
          Effect.fail(new WorktreeUpdateError({ cwd, diagnostic: captured, reason: 'timeout' })),
        );
      } else if (signal !== null) {
        finish(
          Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: captured,
              reason: 'signaled',
              signal,
            }),
          ),
        );
      } else if (exitCode !== 0) {
        finish(
          Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: captured,
              ...(exitCode === null ? {} : { exitCode }),
              reason: 'nonzero_exit',
            }),
          ),
        );
      } else {
        finish(
          Effect.succeed({
            output: {
              stderrChars: captured.stderrChars,
              stdoutChars: captured.stdoutChars,
            },
            status: 'succeeded',
          }),
        );
      }
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      terminate(child);
    });
  });
}

/**
 * Run the checkout-owned conventional update hook directly so its executable bit
 * and shebang select the interpreter. The child inherits the manager environment;
 * Pardes neither reads nor copies repository secret/config files.
 */
export function makeWorktreeBootstrap(
  options: WorktreeBootstrapOptions = {},
): WorktreeBootstrapShape {
  const timeoutMs = options.timeoutMs ?? WORKTREE_UPDATE_TIMEOUT_MS;
  return {
    run: (cwd) =>
      Effect.gen(function* () {
        const scriptPath = join(cwd, WORKTREE_UPDATE_SCRIPT);
        const metadata = yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => lstat(scriptPath),
        }).pipe(Effect.exit);
        if (Exit.isFailure(metadata)) {
          const cause = Cause.squash(metadata.cause);
          if (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === 'ENOENT'
          ) {
            return { status: 'absent' } as const;
          }
          return yield* new WorktreeUpdateError({
            cause,
            cwd,
            diagnostic: emptyDiagnostic(),
            reason: 'inspect_failed',
          });
        }
        const executable = yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => access(scriptPath, constants.X_OK),
        }).pipe(Effect.exit);
        if (Exit.isFailure(executable)) {
          return yield* new WorktreeUpdateError({
            cause: Cause.squash(executable.cause),
            cwd,
            diagnostic: emptyDiagnostic(),
            reason: 'not_executable',
          });
        }
        const env = gitEnvironmentForExplicitCwd({ ...process.env, ...options.env });
        return yield* executeUpdate(cwd, scriptPath, timeoutMs, env);
      }),
  };
}

export function worktreeUpdateFailureSummary(error: WorktreeUpdateError): string {
  const suffix =
    error.exitCode === undefined
      ? error.signal === undefined
        ? ''
        : ` signal=${error.signal}`
      : ` exitCode=${error.exitCode}`;
  return `[${error.reason}] ${WORKTREE_UPDATE_SCRIPT} failed.${suffix} chars(stdout=${error.diagnostic.stdoutChars}, stderr=${error.diagnostic.stderrChars}, shown=0).`;
}

export function renderWorktreeUpdateTerminalDiagnostic(error: WorktreeUpdateError): string {
  const stdout = error.diagnostic.stdoutTail || '(no stdout)';
  const stderr = error.diagnostic.stderrTail || '(no stderr)';
  return `${worktreeUpdateFailureSummary(error)}\nstdout tail (max ${WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS} chars):\n${stdout}\nstderr tail (max ${WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS} chars):\n${stderr}`;
}
