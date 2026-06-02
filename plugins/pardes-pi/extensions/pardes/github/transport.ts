import { execFile } from 'node:child_process';
import { Effect } from 'effect';
import { GitHubCommandError } from './errors.ts';
import { githubCommandFailureDiagnosticHint } from './watcher-diagnostics.ts';

/** Last-resort process-ingestion circuit breaker; adapters should still request narrow server-side fields. */
export const GITHUB_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;

export interface ProcessInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Internal argv transport port shared by Git and gh invocations. */
export interface GitHubCommandRunnerShape {
  readonly run: (invocation: ProcessInvocation) => Effect.Effect<ProcessResult, GitHubCommandError>;
}

class GitHubProcessFailure {
  constructor(
    readonly error: unknown,
    readonly diagnosticHint: GitHubCommandError['diagnosticHint'],
  ) {}
}

export interface GitHubCliShape {
  readonly run: (
    cwd: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ProcessResult, GitHubCommandError>;
}

/** Shell-free process adapter: every value is passed to execFile as one argv token. */
export function makeExecFileGitHubCommandRunner(): GitHubCommandRunnerShape {
  return {
    run: ({ command, args, cwd }) =>
      Effect.tryPromise({
        catch: (cause) =>
          new GitHubCommandError({
            args,
            cause: cause instanceof GitHubProcessFailure ? cause.error : cause,
            command,
            cwd,
            ...(cause instanceof GitHubProcessFailure && cause.diagnosticHint !== undefined
              ? { diagnosticHint: cause.diagnosticHint }
              : {}),
          }),
        try: (signal) =>
          new Promise<ProcessResult>((resolve, reject) => {
            execFile(
              command,
              args,
              { cwd, encoding: 'utf8', maxBuffer: GITHUB_COMMAND_MAX_BUFFER_BYTES, signal },
              (error, stdout, stderr) => {
                if (error) {
                  reject(
                    new GitHubProcessFailure(error, githubCommandFailureDiagnosticHint(stderr)),
                  );
                  return;
                }
                resolve({ stderr, stdout });
              },
            );
          }),
      }),
  };
}

export function makeGitHubCli(runner: GitHubCommandRunnerShape): GitHubCliShape {
  return {
    run: (cwd, args) => runner.run({ args, command: 'gh', cwd }),
  };
}
