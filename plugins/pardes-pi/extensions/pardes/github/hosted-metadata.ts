import { Clock, Effect, Ref, Semaphore } from 'effect';
import { decodeGitHubJson } from './codecs.ts';
import { type GitHubCommandError, GitHubResponseError } from './errors.ts';
import { type GitHubGraphQLRateLimit, GitHubRateLimitFallbackSchema } from './schemas.ts';
import {
  type GitHubCommandRunnerShape,
  makeExecFileGitHubCommandRunner,
  makeGitHubCli,
} from './transport.ts';

export const GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS = 60_000;
export const GITHUB_WATCHER_RATE_LIMIT_RESERVE = 100;
export const GITHUB_WATCHER_MODERATE_THRESHOLD = 2_000;
export const GITHUB_WATCHER_AGGRESSIVE_THRESHOLD = 1_000;
export const GITHUB_WATCHER_PAUSE_THRESHOLD = 500;
export const GITHUB_WATCHER_MODERATE_INTERVAL_MILLIS = 30_000;
export const GITHUB_WATCHER_AGGRESSIVE_INTERVAL_MILLIS = 60_000;
export const GITHUB_WATCHER_PAUSE_INTERVAL_MILLIS = 60_000;
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

export interface GitHubGraphQLRequestReservation {
  readonly id: string;
}

export type GitHubWatcherThrottleTier =
  | 'normal'
  | 'moderate'
  | 'aggressive'
  | 'paused'
  | 'unavailable';

export type GitHubWatcherRateLimitStatus =
  | {
      readonly status: 'ready';
      readonly tier: Exclude<GitHubWatcherThrottleTier, 'unavailable'>;
      readonly effectiveRemaining: number;
      readonly graphqlReservationId?: string;
    }
  | {
      readonly status: 'deferred';
      readonly reason: 'proactive_throttle' | 'rate_metadata_unavailable';
      readonly tier: Exclude<GitHubWatcherThrottleTier, 'normal'>;
      readonly effectiveRemaining?: number;
      readonly until?: string;
    };

export interface GitHubRateLimitCompactStatus {
  readonly effectiveRemaining?: number;
  readonly throttle: GitHubWatcherThrottleTier;
}

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
    reservationId?: string,
  ) => Effect.Effect<A, GitHubResponseError, R>;
  /** Reserve one GraphQL request before launch; exact decoded metadata settles only this identity. */
  readonly reserveGraphQLRequest: (
    estimatedCost?: number,
  ) => Effect.Effect<GitHubGraphQLRequestReservation>;
  readonly cancelGraphQLReservation: (reservationId: string) => Effect.Effect<void>;
  /** Conservatively debit CLI or REST paths whose selected response cannot carry GraphQL `rateLimit`. */
  readonly noteUnmeteredGraphQLRequest: (estimatedCost?: number) => Effect.Effect<void>;
  readonly noteUnmeteredRestRequest: (estimatedCost?: number) => Effect.Effect<void>;
  /** Reject unsupported repository or association routes before any hosted request. */
  readonly ensureFixedGitHubComRepository: (
    cwd: string,
  ) => Effect.Effect<void, GitHubCommandError | GitHubResponseError>;
  readonly ensureFixedGitHubComUrl: (url: string) => Effect.Effect<void, GitHubResponseError>;
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
  /** Bounded transient UI sample only; never persist this controller-scoped telemetry. */
  readonly compactStatusUnsafe: () => GitHubRateLimitCompactStatus;
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
  /** Identity-bearing GraphQL reservations settle only after their exact response decodes. */
  readonly reservationId?: string;
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
  readonly nextReservation: number;
  readonly nextWatcherAdmissionAtMillis?: number;
  readonly watcherPolling: GitHubWatcherRateLimitStatus;
}

function projectWatcherPolling(
  watcherPolling: GitHubWatcherRateLimitStatus,
): GitHubWatcherRateLimitStatus {
  if (watcherPolling.status === 'deferred') return watcherPolling;
  const { graphqlReservationId: _graphqlReservationId, ...projected } = watcherPolling;
  return projected;
}

function watcherThrottleTier(
  effectiveRemaining: number,
): Exclude<GitHubWatcherThrottleTier, 'unavailable'> {
  if (effectiveRemaining <= GITHUB_WATCHER_PAUSE_THRESHOLD) return 'paused';
  if (effectiveRemaining <= GITHUB_WATCHER_AGGRESSIVE_THRESHOLD) return 'aggressive';
  if (effectiveRemaining <= GITHUB_WATCHER_MODERATE_THRESHOLD) return 'moderate';
  return 'normal';
}

function watcherIntervalMillis(tier: GitHubWatcherThrottleTier): number {
  if (tier === 'paused') return GITHUB_WATCHER_PAUSE_INTERVAL_MILLIS;
  if (tier === 'aggressive') return GITHUB_WATCHER_AGGRESSIVE_INTERVAL_MILLIS;
  if (tier === 'moderate') return GITHUB_WATCHER_MODERATE_INTERVAL_MILLIS;
  return 0;
}

function proactiveWatcherThrottle(
  tier: Exclude<GitHubWatcherThrottleTier, 'normal' | 'unavailable'>,
  effectiveRemaining: number,
  untilMillis: number,
): GitHubWatcherRateLimitStatus {
  return {
    effectiveRemaining,
    reason: 'proactive_throttle',
    status: 'deferred',
    tier,
    until: new Date(untilMillis).toISOString(),
  };
}

function pressure(remaining: number): GitHubRateLimitPressure {
  if (remaining === 0) return 'exhausted';
  return remaining <= GITHUB_WATCHER_PAUSE_THRESHOLD ? 'near_exhaustion' : 'ready';
}

function saturatedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function debtAmount(debt: ReadonlyArray<InternalDebtBucket>): number {
  return debt.reduce((total, bucket) => saturatedAdd(total, bucket.amount), 0);
}

/** Collapse unmetered estimates while retaining identity-bearing in-flight reservations. */
function compactDebt(debt: ReadonlyArray<InternalDebtBucket>): ReadonlyArray<InternalDebtBucket> {
  let unknownAmount = 0;
  let knownAmount = 0;
  let latestResetAt: string | undefined;
  const reservations: InternalDebtBucket[] = [];
  for (const bucket of debt) {
    if (bucket.reservationId !== undefined) {
      reservations.push(bucket);
      continue;
    }
    if (bucket.resetAt === undefined) {
      unknownAmount = saturatedAdd(unknownAmount, bucket.amount);
      continue;
    }
    knownAmount = saturatedAdd(knownAmount, bucket.amount);
    if (latestResetAt === undefined || Date.parse(bucket.resetAt) > Date.parse(latestResetAt))
      latestResetAt = bucket.resetAt;
  }
  return [
    ...reservations,
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
  reservationId?: string,
): ReadonlyArray<InternalDebtBucket> {
  return compactDebt([
    ...debt,
    {
      amount,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(reservationId === undefined ? {} : { reservationId }),
    },
  ]);
}

/** Exact GraphQL metadata represents this request's decoded cost; settle this identity only. */
function settleGraphqlReservation(
  debt: ReadonlyArray<InternalDebtBucket>,
  reservationId: string | undefined,
  decodedCost: number,
): ReadonlyArray<InternalDebtBucket> {
  return reservationId === undefined || !Number.isSafeInteger(decodedCost) || decodedCost < 0
    ? debt
    : compactDebt(debt.filter((bucket) => bucket.reservationId !== reservationId));
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

function effectiveRemaining(state: HostedMetadataState, debt = state.debt): number | undefined {
  const graphql = effectiveBudget(state.graphql, debt.graphql);
  const rest = effectiveBudget(state.rest, debt.rest);
  return graphql === undefined || rest === undefined
    ? undefined
    : Math.min(graphql.remaining, rest.remaining);
}

function compactStatus(
  state: HostedMetadataState,
  nowMillis: number,
): GitHubRateLimitCompactStatus {
  const debt = pruneLedger(state.debt, nowMillis);
  const remaining = effectiveRemaining(state, debt);
  return {
    ...(remaining === undefined ? {} : { effectiveRemaining: remaining }),
    throttle: remaining === undefined ? 'unavailable' : watcherThrottleTier(remaining),
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
  decodedCost: number,
  nowMillis: number,
  reservationId?: string,
): HostedMetadataState {
  const debt = pruneLedger(state.debt, nowMillis);
  const graphql = mergeObservedBudget(state.graphql, incoming);
  return {
    ...state,
    debt: {
      ...debt,
      graphql: bindUnknownDebt(
        settleGraphqlReservation(debt.graphql, reservationId, decodedCost),
        graphql.resetAt,
        nowMillis,
      ),
    },
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

function validEstimatedCost(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : GITHUB_CLI_GRAPHQL_ESTIMATED_COST;
}

function metadataUnavailable(value: HostedMetadataState): HostedMetadataState {
  return { ...value, fallback: 'unavailable' };
}

function fixedRouteError(route: string): GitHubResponseError {
  return new GitHubResponseError({
    cause: 'unsupported hosted route',
    operation: `enforce fixed ${GITHUB_HOSTED_METADATA_HOSTNAME} route for ${route}`,
  });
}

function isFixedGitHubComUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'ssh:') &&
    parsed.hostname === GITHUB_HOSTED_METADATA_HOSTNAME &&
    parsed.port === ''
  );
}

function isFixedGitHubComRemote(value: string): boolean {
  const remote = value.trim();
  return isFixedGitHubComUrl(remote) || /^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/.test(remote);
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
  const runner = options.runner ?? makeExecFileGitHubCommandRunner();
  const cli = makeGitHubCli(runner);
  const fallbackMaxAgeMillis =
    options.fallbackMaxAgeMillis ?? GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
  if (!Number.isSafeInteger(fallbackMaxAgeMillis) || fallbackMaxAgeMillis < 0)
    throw new RangeError('fallbackMaxAgeMillis must be a non-negative safe integer.');
  const nowMillis = options.nowMillis ?? Clock.currentTimeMillis;
  const state = Ref.makeUnsafe<HostedMetadataState>({
    debt: { graphql: [], rest: [] },
    fallback: 'not_requested',
    nextReservation: 1,
    watcherPolling: {
      reason: 'rate_metadata_unavailable',
      status: 'deferred',
      tier: 'unavailable',
    },
  });
  const fixedRouteSemaphore = Semaphore.makeUnsafe(1);
  const refreshSemaphore = Semaphore.makeUnsafe(1);

  const ensureFixedGitHubComUrl: GitHubHostedMetadataShape['ensureFixedGitHubComUrl'] = (url) =>
    isFixedGitHubComUrl(url) && new URL(url).protocol === 'https:'
      ? Effect.void
      : Effect.fail(fixedRouteError('association URL'));

  const ensureFixedGitHubComRepository: GitHubHostedMetadataShape['ensureFixedGitHubComRepository'] =
    (cwd) =>
      fixedRouteSemaphore.withPermit(
        runner
          .run({ args: ['remote', 'get-url', 'origin'], command: 'git', cwd })
          .pipe(
            Effect.flatMap(({ stdout }) =>
              isFixedGitHubComRemote(stdout)
                ? Effect.void
                : Effect.fail(fixedRouteError('repository origin')),
            ),
          ),
      );

  const refreshFallback: GitHubHostedMetadataShape['refreshFallback'] = (cwd) =>
    refreshSemaphore.withPermit(
      Effect.gen(function* () {
        yield* ensureFixedGitHubComRepository(cwd);
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

  const decodeGraphQL: GitHubHostedMetadataShape['decodeGraphQL'] = (
    operation,
    schema,
    source,
    reservationId,
  ) =>
    decodeGitHubJson(operation, schema, source).pipe(
      Effect.tap((decoded) =>
        Effect.flatMap(nowMillis, (now) =>
          Ref.update(state, (value) =>
            observeGraphql(
              value,
              graphqlBudget(decoded.data.rateLimit),
              decoded.data.rateLimit.cost,
              now,
              reservationId,
            ),
          ),
        ),
      ),
    );

  const reserveGraphQLRequest: GitHubHostedMetadataShape['reserveGraphQLRequest'] = (
    estimatedCost = GITHUB_CLI_GRAPHQL_ESTIMATED_COST,
  ) =>
    Effect.flatMap(nowMillis, (now) =>
      Ref.modify(
        state,
        (value): readonly [GitHubGraphQLRequestReservation, HostedMetadataState] => {
          const debt = pruneLedger(value.debt, now);
          const id = `graphql-${value.nextReservation}`;
          return [
            { id },
            {
              ...value,
              debt: {
                ...debt,
                graphql: addDebt(
                  debt.graphql,
                  validEstimatedCost(estimatedCost),
                  debtResetAt(value.graphql, now),
                  id,
                ),
              },
              nextReservation: value.nextReservation + 1,
            },
          ];
        },
      ),
    );

  const cancelGraphQLReservation: GitHubHostedMetadataShape['cancelGraphQLReservation'] = (
    reservationId,
  ) =>
    Ref.update(state, (value) => ({
      ...value,
      debt: {
        ...value.debt,
        graphql: settleGraphqlReservation(value.debt.graphql, reservationId, 0),
      },
    }));

  const noteUnmeteredRequest = (resource: keyof InternalDebtLedger, estimatedCost: number) =>
    Effect.flatMap(nowMillis, (now) =>
      Ref.update(state, (value) => {
        const debt = pruneLedger(value.debt, now);
        return {
          ...value,
          debt: {
            ...debt,
            [resource]: addDebt(
              debt[resource],
              validEstimatedCost(estimatedCost),
              debtResetAt(value[resource], now),
            ),
          },
        };
      }),
    );

  const noteUnmeteredGraphQLRequest: GitHubHostedMetadataShape['noteUnmeteredGraphQLRequest'] = (
    estimatedCost = GITHUB_CLI_GRAPHQL_ESTIMATED_COST,
  ) => noteUnmeteredRequest('graphql', estimatedCost);

  const noteUnmeteredRestRequest: GitHubHostedMetadataShape['noteUnmeteredRestRequest'] = (
    estimatedCost = GITHUB_WATCHER_REST_ESTIMATED_COST_PER_PULL_REQUEST,
  ) => noteUnmeteredRequest('rest', estimatedCost);

  const reserveWatcherPoll: GitHubHostedMetadataShape['reserveWatcherPoll'] = Effect.fnUntraced(
    function* (cwd, pullRequestCount) {
      const beforeRefresh = yield* nowMillis;
      const deferred = yield* Ref.modify(state, (value) => {
        const debt = pruneLedger(value.debt, beforeRefresh);
        const remaining = effectiveRemaining(value, debt);
        if (
          value.nextWatcherAdmissionAtMillis === undefined ||
          value.nextWatcherAdmissionAtMillis <= beforeRefresh ||
          remaining === undefined
        )
          return [undefined, { ...value, debt }] as const;
        const tier = watcherThrottleTier(remaining);
        const watcherPolling = proactiveWatcherThrottle(
          tier === 'normal'
            ? 'moderate'
            : (tier as Exclude<GitHubWatcherThrottleTier, 'normal' | 'unavailable'>),
          remaining,
          value.nextWatcherAdmissionAtMillis,
        );
        return [watcherPolling, { ...value, debt, watcherPolling }] as const;
      });
      if (deferred !== undefined) return deferred;
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
              tier: 'unavailable',
            } as const;
            return [watcherPolling, { ...pruned, watcherPolling }];
          }
          const graphql = effectiveBudget(pruned.graphql, debt.graphql);
          const rest = effectiveBudget(pruned.rest, debt.rest);
          const remaining = effectiveRemaining(pruned, debt);
          if (graphql === undefined || rest === undefined || remaining === undefined) {
            const watcherPolling = {
              reason: 'rate_metadata_unavailable',
              status: 'deferred',
              tier: 'unavailable',
            } as const;
            return [watcherPolling, { ...pruned, watcherPolling }];
          }
          const tier = watcherThrottleTier(remaining);
          const interval = watcherIntervalMillis(tier);
          const nextAdmission = pruned.nextWatcherAdmissionAtMillis;
          const insufficient = graphql.remaining <= graphqlCost || rest.remaining <= restCost;
          const newlyPaused = tier === 'paused' && pruned.watcherPolling.tier !== 'paused';
          if (
            interval > 0 &&
            (newlyPaused || insufficient || (nextAdmission !== undefined && nextAdmission > now))
          ) {
            const untilMillis = insufficient
              ? Math.max(now + interval, Date.parse(graphql.resetAt), Date.parse(rest.resetAt))
              : nextAdmission !== undefined && nextAdmission > now
                ? nextAdmission
                : now + interval;
            const watcherPolling = proactiveWatcherThrottle(
              tier as Exclude<GitHubWatcherThrottleTier, 'normal' | 'unavailable'>,
              remaining,
              untilMillis,
            );
            return [
              watcherPolling,
              { ...pruned, nextWatcherAdmissionAtMillis: untilMillis, watcherPolling },
            ];
          }
          const graphqlReservationId = `graphql-${pruned.nextReservation}`;
          const watcherPolling = {
            effectiveRemaining: remaining,
            graphqlReservationId,
            status: 'ready',
            tier,
          } as const;
          const { nextWatcherAdmissionAtMillis: _nextWatcherAdmissionAtMillis, ...withoutNext } =
            pruned;
          return [
            watcherPolling,
            {
              ...withoutNext,
              debt: {
                ...debt,
                graphql: addDebt(
                  debt.graphql,
                  graphqlCost,
                  debtResetAt(pruned.graphql, now),
                  graphqlReservationId,
                ),
              },
              nextReservation: pruned.nextReservation + 1,
              ...(interval === 0 ? {} : { nextWatcherAdmissionAtMillis: now + interval }),
              watcherPolling,
            },
          ];
        },
      );
    },
  );

  const compactStatusUnsafe: GitHubHostedMetadataShape['compactStatusUnsafe'] = () =>
    compactStatus(Ref.getUnsafe(state), Date.now());

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
            watcherPolling: projectWatcherPolling(pruned.watcherPolling),
          },
          pruned,
        ];
      }),
    );

  return {
    cancelGraphQLReservation,
    compactStatusUnsafe,
    decodeGraphQL,
    ensureFixedGitHubComRepository,
    ensureFixedGitHubComUrl,
    noteUnmeteredGraphQLRequest,
    noteUnmeteredRestRequest,
    refreshFallback,
    reserveGraphQLRequest,
    reserveWatcherPoll,
    snapshot,
  };
}
