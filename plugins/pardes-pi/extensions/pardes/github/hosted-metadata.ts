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
export const GITHUB_HOSTED_METADATA_HOSTNAME = 'github.com';
export const GITHUB_HOSTED_METADATA_CREDENTIAL_CONTEXT = 'github_com_controller_lifetime';

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
  /** One adapter belongs to one fresh controller and its fixed GitHub.com credential context. */
  readonly credentialContext: typeof GITHUB_HOSTED_METADATA_CREDENTIAL_CONTEXT;
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

type InternalObservedBudgetSource = Exclude<GitHubRateLimitBudgetSource, 'local_estimate'>;

interface InternalObservedBudget {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly source: InternalObservedBudgetSource;
}

interface InternalDebtBucket {
  readonly amount: number;
  /** Undefined only until the first decoded observation can bind the debt to one reset window. */
  readonly resetAt?: string;
}

interface InternalDebtLedger {
  readonly graphql: ReadonlyArray<InternalDebtBucket>;
  readonly rest: ReadonlyArray<InternalDebtBucket>;
}

interface HostedMetadataState {
  readonly debt: InternalDebtLedger;
  readonly fallback: GitHubRateLimitFallbackStatus;
  readonly fallbackObservedAtMillis?: number;
  readonly graphql?: InternalObservedBudget;
  readonly rest?: InternalObservedBudget;
  readonly watcherPolling: GitHubWatcherRateLimitStatus;
}

function pressure(remaining: number): GitHubRateLimitPressure {
  if (remaining === 0) return 'exhausted';
  return remaining <= GITHUB_WATCHER_RATE_LIMIT_RESERVE ? 'near_exhaustion' : 'ready';
}

function saturatedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function debtAmount(debt: ReadonlyArray<InternalDebtBucket>): number {
  return debt.reduce((total, bucket) => saturatedAdd(total, bucket.amount), 0);
}

/** Collapse represented debts to the latest reset window: retaining older debt longer is bounded and conservative. */
function compactDebt(debt: ReadonlyArray<InternalDebtBucket>): ReadonlyArray<InternalDebtBucket> {
  let unknownAmount = 0;
  let knownAmount = 0;
  let latestResetAt: string | undefined;
  for (const bucket of debt) {
    if (bucket.resetAt === undefined) {
      unknownAmount = saturatedAdd(unknownAmount, bucket.amount);
      continue;
    }
    knownAmount = saturatedAdd(knownAmount, bucket.amount);
    if (latestResetAt === undefined || Date.parse(bucket.resetAt) > Date.parse(latestResetAt))
      latestResetAt = bucket.resetAt;
  }
  return [
    ...(unknownAmount === 0 ? [] : [{ amount: unknownAmount }]),
    ...(latestResetAt === undefined ? [] : [{ amount: knownAmount, resetAt: latestResetAt }]),
  ];
}

function pruneDebt(
  debt: ReadonlyArray<InternalDebtBucket>,
  nowMillis: number,
): ReadonlyArray<InternalDebtBucket> {
  return debt.filter(({ resetAt }) => resetAt === undefined || Date.parse(resetAt) > nowMillis);
}

function bindUnknownDebt(
  debt: ReadonlyArray<InternalDebtBucket>,
  resetAt: string,
  nowMillis: number,
): ReadonlyArray<InternalDebtBucket> {
  return Date.parse(resetAt) <= nowMillis
    ? debt
    : compactDebt(debt.map((bucket) => ({ ...bucket, resetAt: bucket.resetAt ?? resetAt })));
}

function debtResetAt(
  observed: InternalObservedBudget | undefined,
  nowMillis: number,
): string | undefined {
  return observed !== undefined && Date.parse(observed.resetAt) > nowMillis
    ? observed.resetAt
    : undefined;
}

function addDebt(
  debt: ReadonlyArray<InternalDebtBucket>,
  amount: number,
  resetAt: string | undefined,
): ReadonlyArray<InternalDebtBucket> {
  return compactDebt([...debt, { amount, ...(resetAt === undefined ? {} : { resetAt }) }]);
}

function pruneLedger(debt: InternalDebtLedger, nowMillis: number): InternalDebtLedger {
  return {
    graphql: pruneDebt(debt.graphql, nowMillis),
    rest: pruneDebt(debt.rest, nowMillis),
  };
}

function effectiveBudget(
  observed: InternalObservedBudget | undefined,
  debt: ReadonlyArray<InternalDebtBucket>,
): GitHubRateLimitBudget | undefined {
  if (observed === undefined) return undefined;
  const outstanding = debtAmount(debt);
  return {
    ...observed,
    pressure: pressure(Math.max(0, observed.remaining - outstanding)),
    remaining: Math.max(0, observed.remaining - outstanding),
    source: outstanding === 0 ? observed.source : 'local_estimate',
  };
}

function observeBudget(
  observed: InternalObservedBudget | undefined,
  debt: ReadonlyArray<InternalDebtBucket>,
): GitHubRateLimitBudgetObservation {
  const effective = effectiveBudget(observed, debt);
  return effective === undefined
    ? { availability: 'unavailable' }
    : { availability: 'available', ...effective };
}

function graphqlBudget(value: GitHubGraphQLRateLimit): InternalObservedBudget {
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
}): InternalObservedBudget {
  return {
    limit: value.limit,
    remaining: value.remaining,
    resetAt: new Date(value.reset * 1_000).toISOString(),
    source: 'rest_fallback',
  };
}

/** Retain monotonic conservative hosted observations so delayed responses cannot restore spent budget. */
function mergeObservedBudget(
  current: InternalObservedBudget | undefined,
  incoming: InternalObservedBudget,
): InternalObservedBudget {
  if (current === undefined) return incoming;
  const currentReset = Date.parse(current.resetAt);
  const incomingReset = Date.parse(incoming.resetAt);
  if (incomingReset < currentReset) return current;
  if (incomingReset > currentReset) return incoming;
  return incoming.remaining < current.remaining ? incoming : current;
}

function observeGraphql(
  state: HostedMetadataState,
  incoming: InternalObservedBudget,
  nowMillis: number,
): HostedMetadataState {
  const debt = pruneLedger(state.debt, nowMillis);
  const graphql = mergeObservedBudget(state.graphql, incoming);
  return {
    ...state,
    debt: { ...debt, graphql: bindUnknownDebt(debt.graphql, graphql.resetAt, nowMillis) },
    graphql,
  };
}

function observeFallback(
  state: HostedMetadataState,
  graphqlIncoming: InternalObservedBudget,
  restIncoming: InternalObservedBudget,
  nowMillis: number,
): HostedMetadataState {
  const debt = pruneLedger(state.debt, nowMillis);
  const graphql = mergeObservedBudget(state.graphql, graphqlIncoming);
  const rest = mergeObservedBudget(state.rest, restIncoming);
  return {
    ...state,
    debt: {
      graphql: bindUnknownDebt(debt.graphql, graphql.resetAt, nowMillis),
      rest: bindUnknownDebt(debt.rest, rest.resetAt, nowMillis),
    },
    fallback: 'available',
    fallbackObservedAtMillis: nowMillis,
    graphql,
    rest,
  };
}

function deferredUntil(
  graphql: GitHubRateLimitBudget,
  rest: GitHubRateLimitBudget,
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

function metadataUnavailable(value: HostedMetadataState): HostedMetadataState {
  return { ...value, fallback: 'unavailable' };
}

function fallbackUsable(
  value: HostedMetadataState,
  nowMillis: number,
  maxAgeMillis: number,
): boolean {
  return (
    value.fallback === 'available' &&
    value.fallbackObservedAtMillis !== undefined &&
    nowMillis - value.fallbackObservedAtMillis < maxAgeMillis &&
    value.graphql !== undefined &&
    Date.parse(value.graphql.resetAt) > nowMillis &&
    value.rest !== undefined &&
    Date.parse(value.rest.resetAt) > nowMillis
  );
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
    debt: { graphql: [], rest: [] },
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
          current.fallback === 'available' &&
          current.fallbackObservedAtMillis !== undefined &&
          now - current.fallbackObservedAtMillis < fallbackMaxAgeMillis &&
          !resetReached
        )
          return;
        const response = yield* cli
          .run(cwd, ['api', 'rate_limit', '--hostname', GITHUB_HOSTED_METADATA_HOSTNAME])
          .pipe(Effect.tapError(() => Ref.update(state, metadataUnavailable)));
        const decoded = yield* decodeGitHubJson(
          'inspect GitHub rate-limit fallback',
          GitHubRateLimitFallbackSchema,
          response.stdout,
        ).pipe(Effect.tapError(() => Ref.update(state, metadataUnavailable)));
        yield* Ref.update(state, (value) =>
          observeFallback(
            value,
            restFallbackBudget(decoded.resources.graphql),
            restFallbackBudget(decoded.resources.core),
            now,
          ),
        );
      }),
    );

  const decodeGraphQL: GitHubHostedMetadataShape['decodeGraphQL'] = (operation, schema, source) =>
    decodeGitHubJson(operation, schema, source).pipe(
      Effect.tap((decoded) =>
        Effect.flatMap(nowMillis, (now) =>
          Ref.update(state, (value) =>
            observeGraphql(value, graphqlBudget(decoded.data.rateLimit), now),
          ),
        ),
      ),
    );

  const noteUnmeteredGraphQLRequest: GitHubHostedMetadataShape['noteUnmeteredGraphQLRequest'] = (
    estimatedCost = GITHUB_CLI_GRAPHQL_ESTIMATED_COST,
  ) =>
    Effect.flatMap(nowMillis, (now) =>
      Ref.update(state, (value) => {
        const debt = pruneLedger(value.debt, now);
        return {
          ...value,
          debt: {
            ...debt,
            graphql: addDebt(
              debt.graphql,
              validEstimatedCost(estimatedCost),
              debtResetAt(value.graphql, now),
            ),
          },
        };
      }),
    );

  const reserveWatcherPoll: GitHubHostedMetadataShape['reserveWatcherPoll'] = Effect.fnUntraced(
    function* (cwd, pullRequestCount) {
      if (pullRequestCount === 0) return { status: 'ready' } as const;
      yield* Effect.result(refreshFallback(cwd));
      const now = yield* nowMillis;
      const count =
        Number.isSafeInteger(pullRequestCount) && pullRequestCount > 0 ? pullRequestCount : 1;
      const graphqlCost = count * GITHUB_WATCHER_GRAPHQL_ESTIMATED_COST_PER_PULL_REQUEST;
      const restCost = count * GITHUB_WATCHER_REST_ESTIMATED_COST_PER_PULL_REQUEST;
      return yield* Ref.modify(
        state,
        (value): readonly [GitHubWatcherRateLimitStatus, HostedMetadataState] => {
          const debt = pruneLedger(value.debt, now);
          const pruned = { ...value, debt };
          if (!fallbackUsable(pruned, now, fallbackMaxAgeMillis)) {
            const watcherPolling = {
              reason: 'rate_metadata_unavailable',
              status: 'deferred',
            } as const;
            return [watcherPolling, { ...pruned, watcherPolling }];
          }
          const graphql = effectiveBudget(pruned.graphql, debt.graphql);
          const rest = effectiveBudget(pruned.rest, debt.rest);
          if (graphql === undefined || rest === undefined) {
            const watcherPolling = {
              reason: 'rate_metadata_unavailable',
              status: 'deferred',
            } as const;
            return [watcherPolling, { ...pruned, watcherPolling }];
          }
          const graphqlRequired = GITHUB_WATCHER_RATE_LIMIT_RESERVE + graphqlCost;
          const restRequired = GITHUB_WATCHER_RATE_LIMIT_RESERVE + restCost;
          if (graphql.remaining <= graphqlRequired || rest.remaining <= restRequired) {
            const until = deferredUntil(graphql, rest, graphqlRequired, restRequired);
            const watcherPolling = {
              reason: 'near_exhaustion',
              status: 'deferred',
              ...(until === undefined ? {} : { until }),
            } as const;
            return [watcherPolling, { ...pruned, watcherPolling }];
          }
          const watcherPolling = { status: 'ready' } as const;
          return [
            watcherPolling,
            {
              ...pruned,
              debt: {
                graphql: addDebt(debt.graphql, graphqlCost, debtResetAt(pruned.graphql, now)),
                rest: addDebt(debt.rest, restCost, debtResetAt(pruned.rest, now)),
              },
              watcherPolling,
            },
          ];
        },
      );
    },
  );

  const snapshot: GitHubHostedMetadataShape['snapshot'] = () =>
    Effect.flatMap(nowMillis, (now) =>
      Ref.modify(state, (value): readonly [GitHubRateLimitHealth, HostedMetadataState] => {
        const debt = pruneLedger(value.debt, now);
        const pruned = { ...value, debt };
        return [
          {
            credentialContext: GITHUB_HOSTED_METADATA_CREDENTIAL_CONTEXT,
            fallback: pruned.fallback,
            graphql: observeBudget(pruned.graphql, debt.graphql),
            observation: 'bounded_hosted_rate_budget',
            rest: observeBudget(pruned.rest, debt.rest),
            watcherPolling: pruned.watcherPolling,
          },
          pruned,
        ];
      }),
    );

  return {
    decodeGraphQL,
    noteUnmeteredGraphQLRequest,
    refreshFallback,
    reserveWatcherPoll,
    snapshot,
  };
}
