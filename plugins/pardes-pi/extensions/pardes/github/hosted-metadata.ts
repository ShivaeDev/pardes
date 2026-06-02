import { Clock, Effect, Ref, Semaphore } from 'effect';
import { decodeGitHubJson } from './codecs.ts';
import type { GitHubCommandError, GitHubResponseError } from './errors.ts';
import { type GitHubGraphQLRateLimit, GitHubRateLimitFallbackSchema } from './schemas.ts';
import {
  type GitHubCommandRunnerShape,
  makeExecFileGitHubCommandRunner,
  makeGitHubCli,
} from './transport.ts';

export const GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS = 60_000;
export const GITHUB_WATCHER_RATE_LIMIT_RESERVE = 100;
export const GITHUB_WATCHER_GRAPHQL_ESTIMATED_COST_PER_PULL_REQUEST = 10;
export const GITHUB_WATCHER_REST_ESTIMATED_COST_PER_PULL_REQUEST = 1;
export const GITHUB_CLI_GRAPHQL_ESTIMATED_COST = 5;

export type GitHubRateLimitBudgetSource = 'graphql' | 'rest_fallback' | 'local_estimate';
export type GitHubRateLimitPressure = 'ready' | 'near_exhaustion' | 'exhausted';
export type GitHubRateLimitFallbackStatus = 'not_requested' | 'available' | 'unavailable';

export interface GitHubRateLimitBudget {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly source: GitHubRateLimitBudgetSource;
  readonly pressure: GitHubRateLimitPressure;
}

export type GitHubRateLimitBudgetObservation =
  | ({ readonly availability: 'available' } & GitHubRateLimitBudget)
  | { readonly availability: 'unavailable' };

export type GitHubWatcherRateLimitStatus =
  | { readonly status: 'ready' }
  | {
      readonly status: 'deferred';
      readonly reason: 'near_exhaustion' | 'rate_metadata_unavailable';
      readonly until?: string;
    };

export interface GitHubRateLimitHealth {
  readonly observation: 'bounded_hosted_rate_budget';
  readonly fallback: GitHubRateLimitFallbackStatus;
  readonly graphql: GitHubRateLimitBudgetObservation;
  readonly rest: GitHubRateLimitBudgetObservation;
  readonly watcherPolling: GitHubWatcherRateLimitStatus;
}

export interface GitHubHostedMetadataShape {
  /** Decode one server-selected GraphQL envelope and retain only its bounded rate metadata. */
  readonly decodeGraphQL: <
    A extends { readonly data: { readonly rateLimit: GitHubGraphQLRateLimit } },
    I,
    R,
  >(
    operation: string,
    schema: import('effect').Schema.Codec<A, I, R>,
    source: string,
  ) => Effect.Effect<A, GitHubResponseError, R>;
  /** Conservatively debit a CLI path whose selected response cannot carry GraphQL `rateLimit`. */
  readonly noteUnmeteredGraphQLRequest: (estimatedCost?: number) => Effect.Effect<void>;
  /** Refresh bounded REST and GraphQL budgets from GitHub's metadata-only fallback endpoint. */
  readonly refreshFallback: (
    cwd: string,
  ) => Effect.Effect<void, GitHubCommandError | GitHubResponseError>;
  /** Atomically reserve one bounded watcher cycle or defer it before any watched PR request runs. */
  readonly reserveWatcherPoll: (
    cwd: string,
    pullRequestCount: number,
  ) => Effect.Effect<GitHubWatcherRateLimitStatus>;
  readonly snapshot: () => Effect.Effect<GitHubRateLimitHealth>;
}

interface InternalRateLimitBudget {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly source: GitHubRateLimitBudgetSource;
}

interface HostedMetadataState {
  readonly fallback: GitHubRateLimitFallbackStatus;
  readonly fallbackObservedAtMillis?: number;
  readonly graphql?: InternalRateLimitBudget;
  readonly rest?: InternalRateLimitBudget;
  readonly watcherPolling: GitHubWatcherRateLimitStatus;
}

function pressure(remaining: number): GitHubRateLimitPressure {
  if (remaining === 0) return 'exhausted';
  return remaining <= GITHUB_WATCHER_RATE_LIMIT_RESERVE ? 'near_exhaustion' : 'ready';
}

function observeBudget(
  value: InternalRateLimitBudget | undefined,
): GitHubRateLimitBudgetObservation {
  return value === undefined
    ? { availability: 'unavailable' }
    : { availability: 'available', ...value, pressure: pressure(value.remaining) };
}

function graphqlBudget(value: GitHubGraphQLRateLimit): InternalRateLimitBudget {
  return {
    limit: value.limit,
    remaining: value.remaining,
    resetAt: value.resetAt,
    source: 'graphql',
  };
}

function restFallbackBudget(value: {
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
}): InternalRateLimitBudget {
  return {
    limit: value.limit,
    remaining: value.remaining,
    resetAt: new Date(value.reset * 1_000).toISOString(),
    source: 'rest_fallback',
  };
}

function debit(
  value: InternalRateLimitBudget | undefined,
  estimatedCost: number,
): InternalRateLimitBudget | undefined {
  return value === undefined
    ? undefined
    : {
        ...value,
        remaining: Math.max(0, value.remaining - estimatedCost),
        source: 'local_estimate',
      };
}

function deferredUntil(
  graphql: InternalRateLimitBudget,
  rest: InternalRateLimitBudget,
  graphqlRequired: number,
  restRequired: number,
): string | undefined {
  const resets = [
    ...(graphql.remaining <= graphqlRequired ? [graphql.resetAt] : []),
    ...(rest.remaining <= restRequired ? [rest.resetAt] : []),
  ];
  return resets.sort().at(-1);
}

function validEstimatedCost(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : GITHUB_CLI_GRAPHQL_ESTIMATED_COST;
}

export function makeGitHubHostedMetadataAdapter(
  options: {
    readonly fallbackMaxAgeMillis?: number;
    readonly nowMillis?: Effect.Effect<number>;
    readonly runner?: GitHubCommandRunnerShape;
  } = {},
): GitHubHostedMetadataShape {
  const cli = makeGitHubCli(options.runner ?? makeExecFileGitHubCommandRunner());
  const fallbackMaxAgeMillis =
    options.fallbackMaxAgeMillis ?? GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
  if (!Number.isSafeInteger(fallbackMaxAgeMillis) || fallbackMaxAgeMillis < 0)
    throw new RangeError('fallbackMaxAgeMillis must be a non-negative safe integer.');
  const nowMillis = options.nowMillis ?? Clock.currentTimeMillis;
  const state = Ref.makeUnsafe<HostedMetadataState>({
    fallback: 'not_requested',
    watcherPolling: { status: 'ready' },
  });
  const refreshSemaphore = Semaphore.makeUnsafe(1);

  const refreshFallback: GitHubHostedMetadataShape['refreshFallback'] = (cwd) =>
    refreshSemaphore.withPermit(
      Effect.gen(function* () {
        const now = yield* nowMillis;
        const current = yield* Ref.get(state);
        const resetReached =
          (current.graphql !== undefined && Date.parse(current.graphql.resetAt) <= now) ||
          (current.rest !== undefined && Date.parse(current.rest.resetAt) <= now);
        if (
          current.fallbackObservedAtMillis !== undefined &&
          now - current.fallbackObservedAtMillis < fallbackMaxAgeMillis &&
          !resetReached
        )
          return;
        const response = yield* cli
          .run(cwd, ['api', 'rate_limit'])
          .pipe(
            Effect.tapError(() =>
              Ref.update(state, (value) => ({ ...value, fallback: 'unavailable' as const })),
            ),
          );
        const decoded = yield* decodeGitHubJson(
          'inspect GitHub rate-limit fallback',
          GitHubRateLimitFallbackSchema,
          response.stdout,
        ).pipe(
          Effect.tapError(() =>
            Ref.update(state, (value) => ({ ...value, fallback: 'unavailable' as const })),
          ),
        );
        yield* Ref.update(state, (value) => ({
          ...value,
          fallback: 'available' as const,
          fallbackObservedAtMillis: now,
          graphql: restFallbackBudget(decoded.resources.graphql),
          rest: restFallbackBudget(decoded.resources.core),
        }));
      }),
    );

  const decodeGraphQL: GitHubHostedMetadataShape['decodeGraphQL'] = (operation, schema, source) =>
    decodeGitHubJson(operation, schema, source).pipe(
      Effect.tap((decoded) =>
        Ref.update(state, (value) => ({
          ...value,
          graphql: graphqlBudget(decoded.data.rateLimit),
        })),
      ),
    );

  const noteUnmeteredGraphQLRequest: GitHubHostedMetadataShape['noteUnmeteredGraphQLRequest'] = (
    estimatedCost = GITHUB_CLI_GRAPHQL_ESTIMATED_COST,
  ) =>
    Ref.update(state, (value) => ({
      ...value,
      graphql: debit(value.graphql, validEstimatedCost(estimatedCost)),
    }));

  const reserveWatcherPoll: GitHubHostedMetadataShape['reserveWatcherPoll'] = Effect.fnUntraced(
    function* (cwd, pullRequestCount) {
      if (pullRequestCount === 0) return { status: 'ready' } as const;
      const refreshed = yield* Effect.result(refreshFallback(cwd));
      const count =
        Number.isSafeInteger(pullRequestCount) && pullRequestCount > 0 ? pullRequestCount : 1;
      const graphqlCost = count * GITHUB_WATCHER_GRAPHQL_ESTIMATED_COST_PER_PULL_REQUEST;
      const restCost = count * GITHUB_WATCHER_REST_ESTIMATED_COST_PER_PULL_REQUEST;
      return yield* Ref.modify(
        state,
        (value): readonly [GitHubWatcherRateLimitStatus, HostedMetadataState] => {
          const graphql = value.graphql;
          const rest = value.rest;
          if (graphql === undefined || rest === undefined) {
            const watcherPolling = {
              reason: 'rate_metadata_unavailable',
              status: 'deferred',
            } as const;
            return [watcherPolling, { ...value, watcherPolling }];
          }
          const graphqlRequired = GITHUB_WATCHER_RATE_LIMIT_RESERVE + graphqlCost;
          const restRequired = GITHUB_WATCHER_RATE_LIMIT_RESERVE + restCost;
          if (
            graphql.remaining <= graphqlRequired ||
            rest.remaining <= restRequired ||
            (refreshed._tag === 'Failure' && value.fallbackObservedAtMillis === undefined)
          ) {
            const until = deferredUntil(graphql, rest, graphqlRequired, restRequired);
            const watcherPolling = {
              reason: 'near_exhaustion',
              status: 'deferred',
              ...(until === undefined ? {} : { until }),
            } as const;
            return [watcherPolling, { ...value, watcherPolling }];
          }
          const watcherPolling = { status: 'ready' } as const;
          return [
            watcherPolling,
            {
              ...value,
              graphql: debit(graphql, graphqlCost),
              rest: debit(rest, restCost),
              watcherPolling,
            },
          ];
        },
      );
    },
  );

  const snapshot: GitHubHostedMetadataShape['snapshot'] = () =>
    Ref.get(state).pipe(
      Effect.map((value) => ({
        fallback: value.fallback,
        graphql: observeBudget(value.graphql),
        observation: 'bounded_hosted_rate_budget' as const,
        rest: observeBudget(value.rest),
        watcherPolling: value.watcherPolling,
      })),
    );

  return {
    decodeGraphQL,
    noteUnmeteredGraphQLRequest,
    refreshFallback,
    reserveWatcherPoll,
    snapshot,
  };
}
