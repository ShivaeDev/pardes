import { Cause, Clock, Effect, Exit } from 'effect';
import type { StateStoreShape, StoreError } from '../storage/index.ts';
import {
  renderWorktreeUpdateTerminalDiagnostic,
  type WorktreeBootstrapShape,
  WorktreeUpdateError,
  worktreeUpdateFailureSummary,
} from '../worker-runtime/index.ts';
import type { AgentRecord, ManagerEvent, ManagerState, WorktreeBootstrapRecord } from './domain.ts';

const UNRECORDED_BOOTSTRAP_SUMMARY =
  '[state_persistence] script/update terminal outcome was not durably recorded; completion and process termination are unknown; automatic rerun is disabled.';

export const EXTERNALLY_INTERRUPTED_BOOTSTRAP_SUMMARY =
  '[external_interrupt] script/update was interrupted; completion and process termination are unknown; automatic rerun is disabled.';

/** Never leave retained crashed ownership claiming that repository bootstrap is still running. */
export function settleUnrecordedWorktreeBootstrap(
  record: AgentRecord['worktreeBootstrap'],
  completedAt: string,
  failureSummary = UNRECORDED_BOOTSTRAP_SUMMARY,
): WorktreeBootstrapRecord | undefined {
  if (record?.status !== 'running') return record;
  return {
    completedAt,
    failureSummary,
    script: 'script/update',
    startedAt: record.startedAt,
    status: 'interrupted',
  };
}

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

export interface DurableWorktreeBootstrapCallbacks {
  readonly appendEventSafely: (event: ManagerEvent) => Effect.Effect<void>;
  readonly event: (type: string, summary: string, createdAt: string) => ManagerEvent;
}

export interface DurableWorktreeBootstrapInput {
  readonly agent: AgentRecord;
  readonly bootstrap: WorktreeBootstrapShape;
  readonly callbacks: DurableWorktreeBootstrapCallbacks;
  readonly cwd: string;
  readonly label: string;
  readonly namespace: { readonly store: StateStoreShape; state: ManagerState };
}

/** Persist the fresh-checkout preparation edge before any child runtime can launch. */
export const runDurableWorktreeBootstrap = Effect.fnUntraced(function* (
  input: DurableWorktreeBootstrapInput,
) {
  const { agent, bootstrap, callbacks, cwd, label, namespace } = input;
  const startedAt =
    agent.worktreeBootstrap?.status === 'running'
      ? agent.worktreeBootstrap.startedAt
      : yield* nowIso;
  yield* callbacks.appendEventSafely(
    callbacks.event(
      'worktree_bootstrap_started',
      `Checking ${label} for conventional script/update before child launch.`,
      startedAt,
    ),
  );
  const outcome = yield* bootstrap.run(cwd).pipe(Effect.exit);
  const completedAt = yield* nowIso;
  if (Exit.isFailure(outcome)) {
    const error = Cause.squash(outcome.cause);
    if (error instanceof WorktreeUpdateError) {
      console.error(
        `Pardes worktree bootstrap failed for ${agent.id}.\n${renderWorktreeUpdateTerminalDiagnostic(error)}`,
      );
      const failureSummary = worktreeUpdateFailureSummary(error);
      yield* namespace.store
        .mutate((state) => {
          const current = state.agents[agent.id];
          if (!current) return Effect.succeed([undefined, state] as const);
          return Effect.succeed([
            undefined,
            {
              ...state,
              agents: {
                ...state.agents,
                [agent.id]: {
                  ...current,
                  worktreeBootstrap: {
                    completedAt,
                    failureSummary,
                    output: {
                      ...(error.diagnostic.countAccuracy === undefined
                        ? {}
                        : { countAccuracy: error.diagnostic.countAccuracy }),
                      stderrChars: error.diagnostic.stderrChars,
                      stdoutChars: error.diagnostic.stdoutChars,
                    },
                    script: 'script/update',
                    startedAt,
                    status: 'failed',
                  },
                },
              },
            },
          ] as const);
        })
        .pipe(
          Effect.catch((persistError: StoreError) =>
            Effect.sync(() =>
              console.error(
                `Pardes failed to persist worktree bootstrap failure for ${agent.id}`,
                persistError,
              ),
            ),
          ),
        );
      yield* callbacks.appendEventSafely(
        callbacks.event(
          'worktree_bootstrap_failed',
          `${label} bootstrap failed before child launch. ${failureSummary}`,
          completedAt,
        ),
      );
    }
    return yield* Effect.failCause(outcome.cause);
  }
  const record =
    outcome.value.status === 'absent'
      ? ({ checkedAt: completedAt, script: 'script/update', status: 'absent' } as const)
      : ({
          completedAt,
          output: outcome.value.output,
          script: 'script/update',
          startedAt,
          status: 'succeeded',
        } as const);
  yield* namespace.store.mutate((state) => {
    const current = state.agents[agent.id];
    if (!current) return Effect.succeed([undefined, state] as const);
    return Effect.succeed([
      undefined,
      {
        ...state,
        agents: {
          ...state.agents,
          [agent.id]: { ...current, worktreeBootstrap: record },
        },
      },
    ] as const);
  });
  yield* callbacks.appendEventSafely(
    callbacks.event(
      outcome.value.status === 'absent'
        ? 'worktree_bootstrap_absent'
        : 'worktree_bootstrap_succeeded',
      outcome.value.status === 'absent'
        ? `${label} has no script/update; bootstrap was a no-op.`
        : `${label} script/update completed before child launch; output text omitted (stdout chars=${outcome.value.output.stdoutChars}, stderr chars=${outcome.value.output.stderrChars}).`,
      completedAt,
    ),
  );
});
