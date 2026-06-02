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
export const MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS = 64;
export const GITHUB_HOSTED_METADATA_HOSTNAME = 'github.com';
export const GITHUB_HOSTED_METADATA_CREDENTIAL_CONTEXT = 'github_com_controller_lifetime';

export type GitHubRateLimitBudgetSource = 'graphql' | 'rest_fallback' | 'local_estimate';
export type GitHubRateLimitPressure = 'ready' | 'near_exhaustion' | 'exhausted';
export type GitHubRateLimitFallbackStatus = 'not_requested' | 'available' | 'unavailable';
export type GitHubRateLimitResource = 'graphql' | 'rest';

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

export interface GitHubRequestReservation {
  readonly id: string;
}

export interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly pushTarget: string;
  readonly repo: string;
  readonly slug: string;
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
      readonly watcherCliReservationId?: string;
      readonly watcherRestReservationId?: string;
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
  /** One adapter belongs to one fresh controller; callers must keep its GitHub.com credentials fixed. */
  readonly credentialContext: typeof GITHUB_HOSTED_METADATA_CREDENTIAL_CONTEXT;
  readonly observation: 'bounded_hosted_rate_budget';
  readonly fallback: GitHubRateLimitFallbackStatus;
  readonly graphql: GitHubRateLimitBudgetObservation;
  readonly rest: GitHubRateLimitBudgetObservation;
  readonly watcherPolling: GitHubWatcherRateLimitStatus;
}

export interface GitHubHostedMetadataShape {
  /** Decode one server-selected GraphQL envelope and settle only its exact launched reservation. */
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
  /** Reserve GraphQL work before launch; a bounded cap fails closed after repeated unobserved launches. */
  readonly reserveGraphQLRequest: (
    estimatedCost?: number,
  ) => Effect.Effect<GitHubRequestReservation, GitHubResponseError>;
  readonly launchGraphQLRequest: (reservationId: string) => Effect.Effect<void>;
  /** Cleanup only known-unlaunched work. Launched-but-unobserved debt remains conservative. */
  readonly cancelUnlaunchedGraphQLReservation: (reservationId: string) => Effect.Effect<void>;
  /** Finalize a GraphQL handoff: cancel unlaunched work or retain completed-unobserved debt. */
  readonly finalizeGraphQLRequest: (reservationId: string) => Effect.Effect<void>;
  /** Consume one already-reserved opaque identity and retain conservative debt until observation. */
  readonly accountReservedOpaqueRequest: <A, E, R>(
    resource: GitHubRateLimitResource,
    reservationId: string,
    request: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitHubResponseError, R>;
  /** Reserve, launch, and retain conservative opaque CLI or REST debt until later observation. */
  readonly accountOpaqueRequest: <A, E, R>(
    resource: GitHubRateLimitResource,
    request: Effect.Effect<A, E, R>,
    estimatedCost?: number,
  ) => Effect.Effect<A, E | GitHubResponseError, R>;
  /** Derive and prove the one supported repository identity before any hosted request. */
  readonly fixedRoute: (
    cwd: string,
    urls?: ReadonlyArray<string>,
  ) => Effect.Effect<GitHubRepositoryIdentity, GitHubCommandError | GitHubResponseError>;
  /** Once bound, enforce the fixed repository across manager lifecycle activation boundaries. */
  readonly ensureControllerScope: (
    cwd: string,
  ) => Effect.Effect<void, GitHubCommandError | GitHubResponseError>;
  /** Refresh bounded REST and GraphQL budgets from GitHub's metadata-only fallback endpoint. */
  readonly refreshFallback: (
    cwd: string,
    route?: GitHubRepositoryIdentity,
  ) => Effect.Effect<void, GitHubCommandError | GitHubResponseError>;
  /** Force one bounded authoritative fallback reconciliation after the reservation cap is reached. */
  readonly recoverRequestCapacity: (
    cwd: string,
    route?: GitHubRepositoryIdentity,
  ) => Effect.Effect<void, GitHubCommandError | GitHubResponseError>;
  /** Atomically reserve one bounded watcher cycle or defer it before any watched GitHub request. */
  readonly reserveWatcherPoll: (
    cwd: string,
    pullRequestCount: number,
    route?: GitHubRepositoryIdentity,
  ) => Effect.Effect<GitHubWatcherRateLimitStatus, GitHubCommandError | GitHubResponseError>;
  readonly snapshot: () => Effect.Effect<GitHubRateLimitHealth>;
  /** Bounded transient UI sample only; never persist this controller-scoped telemetry. */
  readonly compactStatusUnsafe: () => GitHubRateLimitCompactStatus;
}

type InternalObservedBudgetSource = Exclude<GitHubRateLimitBudgetSource, 'local_estimate'>;
type InternalReservationPhase = 'reserved' | 'launched' | 'completed_unobserved';

interface InternalObservedBudget {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly source: InternalObservedBudgetSource;
}

interface InternalDebtBucket {
  readonly amount: number;
  /** Undefined only until one decoded observation can bind debt to a reset window. */
  readonly resetAt?: string;
  /** Only locally completed debt may be reconciled by a causally later authoritative launch. */
  readonly completedSequence?: number;
  /** Identity-bearing requests remain distinct until causal settlement or conservative reset pruning. */
  readonly reservationId?: string;
  readonly phase?: InternalReservationPhase;
  /** A GraphQL response may reconcile only debt already completed when its request launched. */
  readonly causalBoundarySequence?: number;
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
  readonly nextCompletedSequence: number;
  readonly nextReservation: number;
  readonly nextWatcherAdmissionAtMillis?: number;
  readonly watcherPolling: GitHubWatcherRateLimitStatus;
}

function projectWatcherPolling(
  watcherPolling: GitHubWatcherRateLimitStatus,
): GitHubWatcherRateLimitStatus {
  if (watcherPolling.status === 'deferred') return watcherPolling;
  const {
    graphqlReservationId: _graphqlReservationId,
    watcherCliReservationId: _watcherCliReservationId,
    watcherRestReservationId: _watcherRestReservationId,
    ...projected
  } = watcherPolling;
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

function identityDebtCount(debt: InternalDebtLedger): number {
  return [...debt.graphql, ...debt.rest].filter(({ reservationId }) => reservationId !== undefined)
    .length;
}

/** Collapse anonymous estimates while retaining bounded identity-bearing in-flight requests. */
function compactDebt(debt: ReadonlyArray<InternalDebtBucket>): ReadonlyArray<InternalDebtBucket> {
  let unknownAmount = 0;
  let unknownCompletedSequence: number | undefined;
  let knownAmount = 0;
  let knownCompletedSequence: number | undefined;
  let latestResetAt: string | undefined;
  const reservations: InternalDebtBucket[] = [];
  for (const bucket of debt) {
    if (bucket.reservationId !== undefined) {
      reservations.push(bucket);
      continue;
    }
    if (bucket.resetAt === undefined) {
      unknownAmount = saturatedAdd(unknownAmount, bucket.amount);
      unknownCompletedSequence = maximumSequence(
        unknownCompletedSequence,
        bucket.completedSequence,
      );
      continue;
    }
    knownAmount = saturatedAdd(knownAmount, bucket.amount);
    knownCompletedSequence = maximumSequence(knownCompletedSequence, bucket.completedSequence);
    if (latestResetAt === undefined || Date.parse(bucket.resetAt) > Date.parse(latestResetAt))
      latestResetAt = bucket.resetAt;
  }
  return [
    ...reservations,
    ...(unknownAmount === 0
      ? []
      : [
          {
            amount: unknownAmount,
            ...(unknownCompletedSequence === undefined
              ? {}
              : { completedSequence: unknownCompletedSequence }),
          },
        ]),
    ...(latestResetAt === undefined
      ? []
      : [
          {
            amount: knownAmount,
            resetAt: latestResetAt,
            ...(knownCompletedSequence === undefined
              ? {}
              : { completedSequence: knownCompletedSequence }),
          },
        ]),
  ];
}

function maximumSequence(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

/** Live identities may span reset rollover; only completed anonymous window debt expires eagerly. */
function pruneDebt(
  debt: ReadonlyArray<InternalDebtBucket>,
  nowMillis: number,
): ReadonlyArray<InternalDebtBucket> {
  return debt.filter(
    ({ reservationId, resetAt }) =>
      reservationId !== undefined || resetAt === undefined || Date.parse(resetAt) > nowMillis,
  );
}

function pruneLedger(debt: InternalDebtLedger, nowMillis: number): InternalDebtLedger {
  return {
    graphql: pruneDebt(debt.graphql, nowMillis),
    rest: pruneDebt(debt.rest, nowMillis),
  };
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
  resetAt?: string,
  reservation?: {
    readonly id: string;
    readonly phase: InternalReservationPhase;
  },
): ReadonlyArray<InternalDebtBucket> {
  return compactDebt([
    ...debt,
    {
      amount,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(reservation === undefined
        ? {}
        : {
            phase: reservation.phase,
            reservationId: reservation.id,
          }),
    },
  ]);
}

function updateReservation(
  debt: InternalDebtLedger,
  reservationId: string,
  update: (bucket: InternalDebtBucket) => InternalDebtBucket | undefined,
): InternalDebtLedger {
  const map = (values: ReadonlyArray<InternalDebtBucket>) =>
    compactDebt(
      values.flatMap((bucket) => {
        if (bucket.reservationId !== reservationId) return [bucket];
        const updated = update(bucket);
        return updated === undefined ? [] : [updated];
      }),
    );
  return { graphql: map(debt.graphql), rest: map(debt.rest) };
}

function findReservation(
  debt: InternalDebtLedger,
  reservationId: string,
): InternalDebtBucket | undefined {
  return [...debt.graphql, ...debt.rest].find((bucket) => bucket.reservationId === reservationId);
}

function completeRequest(
  value: HostedMetadataState,
  reservationId: string,
  cancelReserved: boolean,
): HostedMetadataState {
  const reservation = findReservation(value.debt, reservationId);
  if (reservation === undefined || reservation.phase === 'completed_unobserved') return value;
  if (reservation.phase === 'reserved')
    return cancelReserved
      ? { ...value, debt: updateReservation(value.debt, reservationId, () => undefined) }
      : value;
  const completedSequence = value.nextCompletedSequence;
  return {
    ...value,
    debt: updateReservation(value.debt, reservationId, (bucket) => ({
      ...bucket,
      completedSequence,
      phase: 'completed_unobserved',
    })),
    nextCompletedSequence: completedSequence + 1,
  };
}

function reconcileObservedDebt(
  debt: ReadonlyArray<InternalDebtBucket>,
  causalBoundarySequence: number | undefined,
): ReadonlyArray<InternalDebtBucket> {
  if (causalBoundarySequence === undefined) return debt;
  return compactDebt(
    debt.filter(
      (bucket) =>
        bucket.completedSequence === undefined || bucket.completedSequence > causalBoundarySequence,
    ),
  );
}

function reservationCausalBoundary(
  debt: InternalDebtLedger,
  reservationId: string | undefined,
): number | undefined {
  if (reservationId === undefined) return undefined;
  return findReservation(debt, reservationId)?.causalBoundarySequence;
}

function effectiveBudget(
  observed: InternalObservedBudget | undefined,
  debt: ReadonlyArray<InternalDebtBucket>,
): GitHubRateLimitBudget | undefined {
  if (observed === undefined) return undefined;
  const outstanding = debtAmount(debt);
  const remaining = Math.max(0, observed.remaining - outstanding);
  return {
    ...observed,
    pressure: pressure(remaining),
    remaining,
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
  fallbackMaxAgeMillis: number,
): GitHubRateLimitCompactStatus {
  if (!fallbackUsable(state, nowMillis, fallbackMaxAgeMillis)) return { throttle: 'unavailable' };
  const remaining = effectiveRemaining(state, pruneLedger(state.debt, nowMillis));
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

function snapshotBudget(
  observed: InternalObservedBudget | undefined,
  debt: ReadonlyArray<InternalDebtBucket>,
  nowMillis: number,
  fallbackAvailable: boolean,
): GitHubRateLimitBudgetObservation {
  return observed === undefined ||
    Date.parse(observed.resetAt) <= nowMillis ||
    (observed.source === 'rest_fallback' && !fallbackAvailable)
    ? { availability: 'unavailable' }
    : observeBudget(observed, debt);
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

/** Retain monotonic hosted observations so delayed responses cannot restore spent budget. */
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
  reservationId?: string,
): HostedMetadataState {
  const debt = pruneLedger(state.debt, nowMillis);
  const causalBoundarySequence = reservationCausalBoundary(debt, reservationId);
  const settled =
    reservationId === undefined ? debt : updateReservation(debt, reservationId, () => undefined);
  const graphql = mergeObservedBudget(state.graphql, incoming);
  return {
    ...state,
    debt: {
      ...settled,
      graphql: bindUnknownDebt(
        reconcileObservedDebt(settled.graphql, causalBoundarySequence),
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
  causalBoundarySequence: number,
): HostedMetadataState {
  const debt = pruneLedger(state.debt, nowMillis);
  const graphql = mergeObservedBudget(state.graphql, graphqlIncoming);
  const rest = mergeObservedBudget(state.rest, restIncoming);
  return {
    ...state,
    debt: {
      graphql: bindUnknownDebt(
        reconcileObservedDebt(debt.graphql, causalBoundarySequence),
        graphql.resetAt,
        nowMillis,
      ),
      rest: bindUnknownDebt(
        reconcileObservedDebt(debt.rest, causalBoundarySequence),
        rest.resetAt,
        nowMillis,
      ),
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
  return {
    ...value,
    fallback: 'unavailable',
    watcherPolling: {
      reason: 'rate_metadata_unavailable',
      status: 'deferred',
      tier: 'unavailable',
    },
  };
}

function responseError(operation: string, cause: unknown): GitHubResponseError {
  return new GitHubResponseError({ cause, operation });
}

function fixedRouteError(route: string): GitHubResponseError {
  return responseError(
    `enforce fixed ${GITHUB_HOSTED_METADATA_HOSTNAME} route for ${route}`,
    'unsupported hosted route',
  );
}

function reservationCapacityError(): GitHubResponseError {
  return responseError(
    'reserve hosted GitHub request',
    `outstanding request reservation cap ${MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS} reached`,
  );
}

function reservedRequestUnavailableError(): GitHubResponseError {
  return responseError('consume reserved hosted GitHub request', 'request reservation unavailable');
}

function repositoryParts(
  owner: string,
  repoWithSuffix: string,
  transport: 'https' | 'ssh',
): GitHubRepositoryIdentity | undefined {
  const repo = repoWithSuffix.endsWith('.git') ? repoWithSuffix.slice(0, -4) : repoWithSuffix;
  const safe = /^[a-zA-Z0-9_.-]+$/;
  return safe.test(owner) &&
    safe.test(repo) &&
    owner.length > 0 &&
    repo.length > 0 &&
    owner !== '.' &&
    owner !== '..' &&
    repo !== '.' &&
    repo !== '..'
    ? {
        owner,
        pushTarget:
          transport === 'ssh'
            ? `git@${GITHUB_HOSTED_METADATA_HOSTNAME}:${owner}/${repo}.git`
            : `https://${GITHUB_HOSTED_METADATA_HOSTNAME}/${owner}/${repo}.git`,
        repo,
        slug: `${owner}/${repo}`,
      }
    : undefined;
}

function remoteIdentity(value: string): GitHubRepositoryIdentity | undefined {
  const remote = value.trim();
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/.exec(remote);
  if (scp) return repositoryParts(scp[1] ?? '', scp[2] ?? '', 'ssh');
  if (!URL.canParse(remote)) return undefined;
  const parsed = new URL(remote);
  const parts = parsed.pathname.split('/').filter(Boolean);
  return (parsed.protocol === 'https:' || parsed.protocol === 'ssh:') &&
    parsed.hostname === GITHUB_HOSTED_METADATA_HOSTNAME &&
    parsed.port === '' &&
    parsed.password === '' &&
    parsed.username === (parsed.protocol === 'ssh:' ? 'git' : '') &&
    parts.length === 2
    ? repositoryParts(parts[0] ?? '', parts[1] ?? '', parsed.protocol === 'ssh:' ? 'ssh' : 'https')
    : undefined;
}

function routeUrlMatches(identity: GitHubRepositoryIdentity, value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  const parts = parsed.pathname.split('/').filter(Boolean);
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === GITHUB_HOSTED_METADATA_HOSTNAME &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parts.length === 4 &&
    parts[0]?.toLowerCase() === identity.owner.toLowerCase() &&
    parts[1]?.toLowerCase() === identity.repo.toLowerCase() &&
    parts[2] === 'pull' &&
    /^\d+$/.test(parts[3] ?? '')
  );
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
    readonly unsafeNowMillis?: () => number;
  } = {},
): GitHubHostedMetadataShape {
  const runner = options.runner ?? makeExecFileGitHubCommandRunner();
  const cli = makeGitHubCli(runner);
  const fallbackMaxAgeMillis =
    options.fallbackMaxAgeMillis ?? GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
  if (!Number.isSafeInteger(fallbackMaxAgeMillis) || fallbackMaxAgeMillis < 0)
    throw new RangeError('fallbackMaxAgeMillis must be a non-negative safe integer.');
  const nowMillis = options.nowMillis ?? Clock.currentTimeMillis;
  const unsafeNowMillis = options.unsafeNowMillis ?? Date.now;
  const state = Ref.makeUnsafe<HostedMetadataState>({
    debt: { graphql: [], rest: [] },
    fallback: 'not_requested',
    nextCompletedSequence: 1,
    nextReservation: 1,
    watcherPolling: {
      reason: 'rate_metadata_unavailable',
      status: 'deferred',
      tier: 'unavailable',
    },
  });
  let canonicalIdentity: GitHubRepositoryIdentity | undefined;
  const fixedRouteSemaphore = Semaphore.makeUnsafe(1);
  const refreshSemaphore = Semaphore.makeUnsafe(1);

  const fixedRoute: GitHubHostedMetadataShape['fixedRoute'] = (cwd, urls = []) =>
    fixedRouteSemaphore.withPermit(
      runner.run({ args: ['remote', 'get-url', 'origin'], command: 'git', cwd }).pipe(
        Effect.flatMap(({ stdout }) => {
          const identity = remoteIdentity(stdout);
          if (
            identity === undefined ||
            (canonicalIdentity !== undefined &&
              identity.slug.toLowerCase() !== canonicalIdentity.slug.toLowerCase())
          )
            return Effect.fail(fixedRouteError('repository origin'));
          const admitted = canonicalIdentity ?? identity;
          if (urls.some((url) => !routeUrlMatches(admitted, url)))
            return Effect.fail(fixedRouteError('association URL'));
          canonicalIdentity = admitted;
          return Effect.succeed(admitted);
        }),
        Effect.tapError(() => Ref.update(state, metadataUnavailable)),
      ),
    );

  const ensureControllerScope: GitHubHostedMetadataShape['ensureControllerScope'] = (cwd) =>
    Effect.suspend(() =>
      canonicalIdentity === undefined ? Effect.void : fixedRoute(cwd).pipe(Effect.asVoid),
    );

  const refreshFallbackInternal = (
    cwd: string,
    route: GitHubRepositoryIdentity | undefined,
    force: boolean,
  ) =>
    refreshSemaphore.withPermit(
      Effect.gen(function* () {
        yield* route === undefined ? fixedRoute(cwd) : Effect.succeed(route);
        const now = yield* nowMillis;
        const current = yield* Ref.get(state);
        const resetReached =
          (current.graphql !== undefined && Date.parse(current.graphql.resetAt) <= now) ||
          (current.rest !== undefined && Date.parse(current.rest.resetAt) <= now);
        if (
          !force &&
          current.fallback === 'available' &&
          current.fallbackObservedAtMillis !== undefined &&
          now - current.fallbackObservedAtMillis < fallbackMaxAgeMillis &&
          !resetReached
        )
          return;
        const causalBoundarySequence = current.nextCompletedSequence - 1;
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
            causalBoundarySequence,
          ),
        );
      }),
    );

  const refreshFallback: GitHubHostedMetadataShape['refreshFallback'] = (cwd, route) =>
    refreshFallbackInternal(cwd, route, false);

  const recoverRequestCapacity: GitHubHostedMetadataShape['recoverRequestCapacity'] = (
    cwd,
    route,
  ) => refreshFallbackInternal(cwd, route, true);

  const reserveIdentityRequest = (
    resource: GitHubRateLimitResource,
    estimatedCost: number,
  ): Effect.Effect<GitHubRequestReservation, GitHubResponseError> =>
    Effect.flatMap(nowMillis, (now) =>
      Ref.modify(state, (value) => {
        const debt = pruneLedger(value.debt, now);
        if (identityDebtCount(debt) >= MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS)
          return [undefined, { ...value, debt }] as const;
        const id = `request-${value.nextReservation}`;
        return [
          { id },
          {
            ...value,
            debt: {
              ...debt,
              [resource]: addDebt(
                debt[resource],
                validEstimatedCost(estimatedCost),
                debtResetAt(value[resource], now),
                { id, phase: 'reserved' },
              ),
            },
            nextReservation: value.nextReservation + 1,
          },
        ] as const;
      }).pipe(
        Effect.flatMap((reservation) =>
          reservation === undefined
            ? Effect.fail(reservationCapacityError())
            : Effect.succeed(reservation),
        ),
      ),
    );

  const launchRequest = (reservationId: string) =>
    Ref.update(state, (value) => ({
      ...value,
      debt: updateReservation(value.debt, reservationId, (bucket) => ({
        ...bucket,
        causalBoundarySequence: value.nextCompletedSequence - 1,
        phase: 'launched',
      })),
    }));

  const launchReservedRequest = (resource: GitHubRateLimitResource, reservationId: string) =>
    Ref.modify(state, (value) => {
      const reserved = value.debt[resource].some(
        (bucket) => bucket.reservationId === reservationId && bucket.phase === 'reserved',
      );
      return [
        reserved,
        reserved
          ? {
              ...value,
              debt: updateReservation(value.debt, reservationId, (bucket) => ({
                ...bucket,
                causalBoundarySequence: value.nextCompletedSequence - 1,
                phase: 'launched',
              })),
            }
          : value,
      ] as const;
    }).pipe(
      Effect.flatMap((reserved) =>
        reserved ? Effect.void : Effect.fail(reservedRequestUnavailableError()),
      ),
    );

  const completeUnobservedRequest = (reservationId: string) =>
    Ref.update(state, (value) => completeRequest(value, reservationId, false));

  // Successful opaque work loses its identity only after rebinding crossing spend to the current
  // observed reset window. Without a current window it remains anonymous unknown-window debt.
  const retainCompletedOpaqueDebt = (resource: GitHubRateLimitResource, reservationId: string) =>
    Effect.flatMap(nowMillis, (now) =>
      Ref.update(state, (value) => {
        const resetAt = debtResetAt(value[resource], now);
        return {
          ...value,
          debt: updateReservation(value.debt, reservationId, (bucket) => ({
            amount: bucket.amount,
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(bucket.completedSequence === undefined
              ? {}
              : { completedSequence: bucket.completedSequence }),
          })),
        };
      }),
    );

  const cancelUnlaunchedGraphQLReservation: GitHubHostedMetadataShape['cancelUnlaunchedGraphQLReservation'] =
    (reservationId) =>
      Ref.update(state, (value) => ({
        ...value,
        debt: updateReservation(value.debt, reservationId, (bucket) =>
          bucket.phase === 'reserved' ? undefined : bucket,
        ),
      }));

  const finalizeGraphQLRequest: GitHubHostedMetadataShape['finalizeGraphQLRequest'] = (
    reservationId,
  ) => Ref.update(state, (value) => completeRequest(value, reservationId, true));

  const reserveGraphQLRequest: GitHubHostedMetadataShape['reserveGraphQLRequest'] = (
    estimatedCost = GITHUB_CLI_GRAPHQL_ESTIMATED_COST,
  ) => reserveIdentityRequest('graphql', estimatedCost);

  const launchGraphQLRequest: GitHubHostedMetadataShape['launchGraphQLRequest'] = launchRequest;

  const accountReservedOpaqueRequest: GitHubHostedMetadataShape['accountReservedOpaqueRequest'] = (
    resource,
    reservationId,
    request,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* launchReservedRequest(resource, reservationId);
        const value = yield* restore(request).pipe(
          Effect.ensuring(completeUnobservedRequest(reservationId)),
        );
        yield* retainCompletedOpaqueDebt(resource, reservationId);
        return value;
      }),
    );

  const accountOpaqueRequest: GitHubHostedMetadataShape['accountOpaqueRequest'] = (
    resource,
    request,
    estimatedCost = resource === 'graphql'
      ? GITHUB_CLI_GRAPHQL_ESTIMATED_COST
      : GITHUB_WATCHER_REST_ESTIMATED_COST_PER_PULL_REQUEST,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const reservation = yield* reserveIdentityRequest(resource, estimatedCost);
        yield* launchReservedRequest(resource, reservation.id);
        const value = yield* restore(request).pipe(
          Effect.ensuring(completeUnobservedRequest(reservation.id)),
        );
        yield* retainCompletedOpaqueDebt(resource, reservation.id);
        return value;
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
            observeGraphql(value, graphqlBudget(decoded.data.rateLimit), now, reservationId),
          ),
        ),
      ),
    );

  const reserveWatcherPoll: GitHubHostedMetadataShape['reserveWatcherPoll'] = Effect.fnUntraced(
    function* (cwd, pullRequestCount, route) {
      const admittedRoute = yield* route === undefined ? fixedRoute(cwd) : Effect.succeed(route);
      const beforeRefresh = yield* nowMillis;
      const deferred = yield* Ref.modify(state, (value) => {
        const debt = pruneLedger(value.debt, beforeRefresh);
        const remaining = effectiveRemaining(value, debt);
        if (
          value.nextWatcherAdmissionAtMillis === undefined ||
          value.nextWatcherAdmissionAtMillis <= beforeRefresh ||
          remaining === undefined ||
          !fallbackUsable(value, beforeRefresh, fallbackMaxAgeMillis)
        )
          return [undefined, { ...value, debt }] as const;
        const tier = watcherThrottleTier(remaining);
        if (tier === 'normal') return [undefined, { ...value, debt }] as const;
        const watcherPolling = proactiveWatcherThrottle(
          tier,
          remaining,
          value.nextWatcherAdmissionAtMillis,
        );
        return [watcherPolling, { ...value, debt, watcherPolling }] as const;
      });
      if (deferred !== undefined) return deferred;
      const refreshed = yield* Effect.result(refreshFallback(cwd, admittedRoute));
      const now = yield* nowMillis;
      const count =
        Number.isSafeInteger(pullRequestCount) && pullRequestCount > 0 ? pullRequestCount : 1;
      const graphqlCost = Math.min(
        Number.MAX_SAFE_INTEGER,
        count * GITHUB_WATCHER_GRAPHQL_ESTIMATED_COST_PER_PULL_REQUEST,
      );
      const graphqlCliCost = Math.min(
        Number.MAX_SAFE_INTEGER,
        count * GITHUB_CLI_GRAPHQL_ESTIMATED_COST,
      );
      const graphqlCycleCost = saturatedAdd(graphqlCost, graphqlCliCost);
      const restCost = Math.min(
        Number.MAX_SAFE_INTEGER,
        count * GITHUB_WATCHER_REST_ESTIMATED_COST_PER_PULL_REQUEST,
      );
      return yield* Ref.modify(
        state,
        (value): readonly [GitHubWatcherRateLimitStatus, HostedMetadataState] => {
          const debt = pruneLedger(value.debt, now);
          const pruned = { ...value, debt };
          if (refreshed._tag === 'Failure' || !fallbackUsable(pruned, now, fallbackMaxAgeMillis)) {
            const watcherPolling = {
              reason: 'rate_metadata_unavailable',
              status: 'deferred',
              tier: 'unavailable',
            } as const;
            return [watcherPolling, { ...metadataUnavailable(pruned), watcherPolling }] as const;
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
            return [watcherPolling, { ...metadataUnavailable(pruned), watcherPolling }] as const;
          }
          const tier = watcherThrottleTier(remaining);
          const interval = watcherIntervalMillis(tier);
          const nextAdmission = pruned.nextWatcherAdmissionAtMillis;
          const insufficient =
            graphql.remaining <=
              saturatedAdd(GITHUB_WATCHER_RATE_LIMIT_RESERVE, graphqlCycleCost) ||
            rest.remaining <= saturatedAdd(GITHUB_WATCHER_RATE_LIMIT_RESERVE, restCost);
          const newlyPaused = tier === 'paused' && pruned.watcherPolling.tier !== 'paused';
          if (
            insufficient ||
            (interval > 0 && (newlyPaused || (nextAdmission !== undefined && nextAdmission > now)))
          ) {
            const deferredTier =
              tier === 'normal'
                ? ('paused' as const)
                : (tier as Exclude<GitHubWatcherThrottleTier, 'normal' | 'unavailable'>);
            const deferredInterval = watcherIntervalMillis(deferredTier);
            const untilMillis = insufficient
              ? Math.max(
                  now + deferredInterval,
                  Date.parse(graphql.resetAt),
                  Date.parse(rest.resetAt),
                )
              : nextAdmission !== undefined && nextAdmission > now
                ? nextAdmission
                : now + deferredInterval;
            const watcherPolling = proactiveWatcherThrottle(deferredTier, remaining, untilMillis);
            return [
              watcherPolling,
              { ...pruned, nextWatcherAdmissionAtMillis: untilMillis, watcherPolling },
            ] as const;
          }
          // A ready watcher cycle needs discussion, pre-discussion CLI, and inline REST identities.
          // Lease capacity for the mandatory trio before any watched request can launch.
          if (identityDebtCount(debt) >= MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS - 2) {
            const watcherPolling = proactiveWatcherThrottle(
              'paused',
              remaining,
              now + GITHUB_WATCHER_PAUSE_INTERVAL_MILLIS,
            );
            return [
              watcherPolling,
              {
                ...pruned,
                nextWatcherAdmissionAtMillis: now + GITHUB_WATCHER_PAUSE_INTERVAL_MILLIS,
                watcherPolling,
              },
            ] as const;
          }
          const graphqlReservationId = `request-${pruned.nextReservation}`;
          const watcherCliReservationId = `request-${pruned.nextReservation + 1}`;
          const watcherRestReservationId = `request-${pruned.nextReservation + 2}`;
          const watcherPolling = {
            effectiveRemaining: remaining,
            graphqlReservationId,
            status: 'ready',
            tier,
            watcherCliReservationId,
            watcherRestReservationId,
          } as const;
          const { nextWatcherAdmissionAtMillis: _nextWatcherAdmissionAtMillis, ...withoutNext } =
            pruned;
          return [
            watcherPolling,
            {
              ...withoutNext,
              debt: {
                graphql: addDebt(
                  addDebt(debt.graphql, graphqlCost, debtResetAt(pruned.graphql, now), {
                    id: graphqlReservationId,
                    phase: 'reserved',
                  }),
                  graphqlCliCost,
                  debtResetAt(pruned.graphql, now),
                  { id: watcherCliReservationId, phase: 'reserved' },
                ),
                rest: addDebt(debt.rest, restCost, debtResetAt(pruned.rest, now), {
                  id: watcherRestReservationId,
                  phase: 'reserved',
                }),
              },
              nextReservation: pruned.nextReservation + 3,
              ...(interval === 0 ? {} : { nextWatcherAdmissionAtMillis: now + interval }),
              watcherPolling,
            },
          ] as const;
        },
      );
    },
  );

  const compactStatusUnsafe: GitHubHostedMetadataShape['compactStatusUnsafe'] = () =>
    compactStatus(Ref.getUnsafe(state), unsafeNowMillis(), fallbackMaxAgeMillis);

  const snapshot: GitHubHostedMetadataShape['snapshot'] = () =>
    Effect.flatMap(nowMillis, (now) =>
      Ref.modify(state, (value): readonly [GitHubRateLimitHealth, HostedMetadataState] => {
        const debt = pruneLedger(value.debt, now);
        const pruned = { ...value, debt };
        const projected =
          pruned.fallback === 'available' && !fallbackUsable(pruned, now, fallbackMaxAgeMillis)
            ? metadataUnavailable(pruned)
            : pruned;
        const fallbackAvailable = projected.fallback === 'available';
        return [
          {
            credentialContext: GITHUB_HOSTED_METADATA_CREDENTIAL_CONTEXT,
            fallback: projected.fallback,
            graphql: snapshotBudget(projected.graphql, debt.graphql, now, fallbackAvailable),
            observation: 'bounded_hosted_rate_budget',
            rest: snapshotBudget(projected.rest, debt.rest, now, fallbackAvailable),
            watcherPolling: projectWatcherPolling(projected.watcherPolling),
          },
          projected,
        ];
      }),
    );

  return {
    accountOpaqueRequest,
    accountReservedOpaqueRequest,
    cancelUnlaunchedGraphQLReservation,
    compactStatusUnsafe,
    decodeGraphQL,
    ensureControllerScope,
    finalizeGraphQLRequest,
    fixedRoute,
    launchGraphQLRequest,
    recoverRequestCapacity,
    refreshFallback,
    reserveGraphQLRequest,
    reserveWatcherPoll,
    snapshot,
  };
}
