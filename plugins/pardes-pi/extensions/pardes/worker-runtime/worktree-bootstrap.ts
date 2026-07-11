import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Cause, Context, Data, Effect, Exit, Layer } from 'effect';
import { gitEnvironmentForExplicitCwd } from '../git/index.ts';

export const WORKTREE_UPDATE_SCRIPT = 'script/update';
export const WORKTREE_UPDATE_TIMEOUT_MS = 15 * 60_000;
export const WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS = 4_000;
export const WORKTREE_UPDATE_FINAL_DRAIN_MS = 100;
export const WORKTREE_UPDATE_TIMEOUT_EXIT_CONFIRM_MS = 500;

export interface WorktreeUpdateOutput {
  readonly stdoutChars: number;
  readonly stderrChars: number;
  /** Lower-bound means inherited pipes were force-closed after a bounded final drain. */
  readonly countAccuracy?: 'exact' | 'lower_bound';
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
  | 'process_lifecycle_unsettled'
  | 'signaled'
  | 'timeout';

export class WorktreeUpdateError extends Data.TaggedError('WorktreeUpdateError')<{
  readonly cwd: string;
  readonly diagnostic: WorktreeUpdateDiagnostic;
  readonly exitCode?: number;
  readonly reason: WorktreeUpdateFailureReason;
  readonly signal?: NodeJS.Signals;
  /** False means the timeout bound elapsed after group signaling without observing direct-child exit. */
  readonly directExitObserved?: boolean;
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

function snapshotDiagnostic(
  diagnostic: MutableDiagnostic,
  countAccuracy: WorktreeUpdateOutput['countAccuracy'] = 'exact',
): WorktreeUpdateDiagnostic {
  return { ...diagnostic, countAccuracy };
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
    let directExitObserved = false;
    let finalDrain: ReturnType<typeof setTimeout> | undefined;
    let timeoutConfirmation: ReturnType<typeof setTimeout> | undefined;
    let pendingCompletion:
      | ((
          accuracy: 'exact' | 'lower_bound',
        ) => Effect.Effect<WorktreeUpdateOutcome, WorktreeUpdateError>)
      | undefined;

    const clearTimers = () => {
      clearTimeout(timeout);
      if (finalDrain) clearTimeout(finalDrain);
      if (timeoutConfirmation) clearTimeout(timeoutConfirmation);
      finalDrain = undefined;
      timeoutConfirmation = undefined;
    };
    const finish = (effect: Effect.Effect<WorktreeUpdateOutcome, WorktreeUpdateError>) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resume(effect);
    };
    const forceBoundedCompletion = () => {
      const completion = pendingCompletion;
      if (!completion || settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish(completion('lower_bound'));
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGKILL');
      timeoutConfirmation = setTimeout(() => {
        if (settled) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(
          Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: snapshotDiagnostic(diagnostic, 'lower_bound'),
              directExitObserved,
              reason: 'timeout',
            }),
          ),
        );
      }, WORKTREE_UPDATE_TIMEOUT_EXIT_CONFIRM_MS);
      timeoutConfirmation.unref();
    }, timeoutMs);

    child.once('error', (cause) => {
      if (settled) return;
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
    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      directExitObserved = true;
      // Signal descendants that remain in the managed process group. A descendant
      // that creates a new session is outside this observable cleanup boundary.
      signalProcessTree(child, 'SIGKILL');
      pendingCompletion = (accuracy) => {
        const captured = snapshotDiagnostic(diagnostic, accuracy);
        if (timedOut) {
          return Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: captured,
              directExitObserved: true,
              reason: 'timeout',
            }),
          );
        }
        if (accuracy === 'lower_bound') {
          return Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: captured,
              directExitObserved: true,
              ...(exitCode === null || exitCode === 0 ? {} : { exitCode }),
              reason: 'process_lifecycle_unsettled',
              ...(signal === null ? {} : { signal }),
            }),
          );
        }
        if (signal !== null) {
          return Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: captured,
              directExitObserved: true,
              reason: 'signaled',
              signal,
            }),
          );
        }
        if (exitCode !== 0) {
          return Effect.fail(
            new WorktreeUpdateError({
              cwd,
              diagnostic: captured,
              directExitObserved: true,
              ...(exitCode === null ? {} : { exitCode }),
              reason: 'nonzero_exit',
            }),
          );
        }
        return Effect.succeed({
          output: {
            countAccuracy: accuracy,
            stderrChars: captured.stderrChars,
            stdoutChars: captured.stdoutChars,
          },
          status: 'succeeded',
        });
      };
      finalDrain = setTimeout(forceBoundedCompletion, WORKTREE_UPDATE_FINAL_DRAIN_MS);
      finalDrain.unref();
    });
    child.once('close', () => {
      if (settled) return;
      const completion = pendingCompletion;
      if (completion) finish(completion('exact'));
    });
    return Effect.sync(() => {
      settled = true;
      clearTimers();
      signalProcessTree(child, 'SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
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
  const process =
    error.directExitObserved === undefined
      ? 'process=not_started_or_unavailable'
      : `process=direct_exit_${error.directExitObserved ? 'observed' : 'unobserved'}, managed_group_signal=attempted, escaped_descendants=not_observable`;
  const accuracy = error.diagnostic.countAccuracy === 'lower_bound' ? '>=' : '';
  return `[${error.reason}] ${WORKTREE_UPDATE_SCRIPT} failed.${suffix} chars(stdout=${accuracy}${error.diagnostic.stdoutChars}, stderr=${accuracy}${error.diagnostic.stderrChars}, shown=0); ${process}.`;
}

export function renderWorktreeUpdateTerminalDiagnostic(error: WorktreeUpdateError): string {
  const stdout = error.diagnostic.stdoutTail || '(no stdout)';
  const stderr = error.diagnostic.stderrTail || '(no stderr)';
  return `${worktreeUpdateFailureSummary(error)}\nstdout tail (max ${WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS} chars):\n${stdout}\nstderr tail (max ${WORKTREE_UPDATE_DIAGNOSTIC_TAIL_MAX_CHARS} chars):\n${stderr}`;
}
