import { execFile } from 'node:child_process';
import { Effect } from 'effect';
import { GitCommandError } from './errors.ts';

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<GitResult, GitCommandError> {
  return Effect.tryPromise({
    catch: (cause) => new GitCommandError({ args, cause, cwd }),
    try: (signal) =>
      new Promise<GitResult>((resolve, reject) => {
        execFile('git', args, { cwd, encoding: 'utf8', signal }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stderr, stdout });
        });
      }),
  });
}
