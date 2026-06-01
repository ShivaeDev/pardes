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
        invocations.push(invocation);
        const next = queue.shift();
        if (!next)
          throw new Error(`Unexpected command: ${invocation.command} ${invocation.args.join(' ')}`);
        return next;
      }),
  };
  return { invocations, runner };
}
