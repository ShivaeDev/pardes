import { Effect } from 'effect';
import type { GitHubCommandRunnerShape, ProcessInvocation, ProcessResult } from './transport.ts';

export function result(stdout = ''): ProcessResult {
  return { stderr: '', stdout };
}

export function scriptedRunner(outputs: ReadonlyArray<ProcessResult>) {
  const invocations: ProcessInvocation[] = [];
  const queue = [...outputs];
  const runner: GitHubCommandRunnerShape = {
    run: (invocation) =>
      Effect.sync(() => {
        // Shared production services validate one fixed GitHub.com origin before hosted calls.
        // Keep ordinary scripted fixtures focused on hosted argv; route regressions use explicit runners.
        if (invocation.command === 'git' && invocation.args.join(' ') === 'remote get-url origin')
          return result('git@github.com:acme/project.git\n');
        invocations.push(invocation);
        const next = queue.shift();
        if (!next)
          throw new Error(`Unexpected command: ${invocation.command} ${invocation.args.join(' ')}`);
        return next;
      }),
  };
  return { invocations, runner };
}
