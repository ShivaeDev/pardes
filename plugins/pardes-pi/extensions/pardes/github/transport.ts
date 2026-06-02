import { execFile } from 'node:child_process';
import { Effect } from 'effect';
import { gitEnvironmentForExplicitCwd } from '../git/index.ts';
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

interface SafeGitHubProcessFailureMetadata {
  readonly kind: 'exec_file_failed';
  readonly code?: string | number;
  readonly signal?: string;
  readonly killed?: boolean;
}

class GitHubProcessFailure {
  constructor(
    readonly metadata: SafeGitHubProcessFailureMetadata,
    readonly diagnosticHint: GitHubCommandError['diagnosticHint'],
  ) {}
}

function safeUnknownProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeProcessFailureMetadata(error: unknown): SafeGitHubProcessFailureMetadata {
  const code = safeUnknownProperty(error, 'code');
  const signal = safeUnknownProperty(error, 'signal');
  const killed = safeUnknownProperty(error, 'killed');
  return {
    kind: 'exec_file_failed',
    ...(typeof code === 'number' && Number.isSafeInteger(code)
      ? { code }
      : typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
        ? { code }
        : {}),
    ...(typeof signal === 'string' && /^[A-Z0-9_]{1,40}$/.test(signal) ? { signal } : {}),
    ...(typeof killed === 'boolean' ? { killed } : {}),
  };
}

function safeCommand(command: string): string {
  return command === 'gh' || command === 'git' ? command : 'unrecognized-command';
}

function safeArg(args: ReadonlyArray<string>, index: number): string | undefined {
  try {
    const value = args[index];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Retain only the operation prefix needed by bounded error rendering; never payload argv. */
function safeArgs(command: string, args: ReadonlyArray<string>): ReadonlyArray<string> {
  const first = safeArg(args, 0);
  const second = safeArg(args, 1);
  if (
    command === 'gh' &&
    first === 'pr' &&
    ['create', 'edit', 'list', 'view'].includes(second ?? '')
  )
    return ['pr', second as string];
  if (command === 'gh' && first === 'api') return ['api'];
  if (command === 'git' && first === 'push') return ['push'];
  return [];
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
            args: safeArgs(command, args),
            cause:
              cause instanceof GitHubProcessFailure
                ? cause.metadata
                : safeProcessFailureMetadata(cause),
            command: safeCommand(command),
            cwd: '[redacted]',
            ...(cause instanceof GitHubProcessFailure && cause.diagnosticHint !== undefined
              ? { diagnosticHint: cause.diagnosticHint }
              : {}),
          }),
        try: (signal) =>
          new Promise<ProcessResult>((resolve, reject) => {
            execFile(
              command,
              args,
              {
                cwd,
                encoding: 'utf8',
                maxBuffer: GITHUB_COMMAND_MAX_BUFFER_BYTES,
                signal,
                ...(command === 'git' ? { env: gitEnvironmentForExplicitCwd() } : {}),
              },
              (error, stdout, stderr) => {
                if (error) {
                  reject(
                    new GitHubProcessFailure(
                      safeProcessFailureMetadata(error),
                      githubCommandFailureDiagnosticHint(stderr),
                    ),
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
