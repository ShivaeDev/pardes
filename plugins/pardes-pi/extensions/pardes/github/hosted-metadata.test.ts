import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS,
  GitHubCommandError,
  MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS,
  makeGitHubHostedMetadataAdapter,
} from './index.ts';
import { GitHubAdvertisedDefaultBranchGraphQLSchema } from './schemas.ts';
import { result, scriptedRunner } from './test-fixtures.ts';
import type { GitHubCommandRunnerShape, ProcessInvocation } from './transport.ts';

function fallbackResult(
  graphqlRemaining = 4_000,
  restRemaining = 3_000,
  restReset = 1_800_000_000,
  graphqlReset = restReset + 100,
) {
  return result(
    JSON.stringify({
      ignored_private_extension: 'must not enter bounded health',
      resources: {
        core: { limit: 5_000, remaining: restRemaining, reset: restReset },
        graphql: { limit: 5_000, remaining: graphqlRemaining, reset: graphqlReset },
        ignored_resource: { limit: 99, remaining: 1, reset: 1_800_000_200 },
      },
    }),
  );
}

function graphQlEnvelope(
  rateLimit: Partial<{
    readonly cost: number;
    readonly limit: number;
    readonly remaining: number;
    readonly resetAt: string;
  }> = {},
) {
  return JSON.stringify({
    data: {
      rateLimit: {
        cost: 1,
        limit: 5_000,
        remaining: 4_000,
        resetAt: '2027-01-15T08:01:40Z',
        ...rateLimit,
      },
      repository: { defaultBranchRef: null },
    },
  });
}

describe('GitHub hosted metadata adapter', () => {
  test('decodes the metadata-only REST fallback into bounded redacted token budgets', async () => {
    const fixture = scriptedRunner([fallbackResult()]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.succeed(1_700_000_000_000),
      runner: fixture.runner,
    });

    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));
    const health = await Effect.runPromise(adapter.snapshot());

    expect(fixture.invocations).toEqual([
      {
        args: ['api', 'rate_limit', '--hostname', 'github.com'],
        command: 'gh',
        cwd: '/tmp/project',
      },
    ]);
    expect(health).toEqual({
      credentialContext: 'github_com_controller_lifetime',
      fallback: 'available',
      graphql: {
        availability: 'available',
        limit: 5_000,
        pressure: 'ready',
        remaining: 4_000,
        resetAt: '2027-01-15T08:01:40.000Z',
        source: 'rest_fallback',
      },
      observation: 'bounded_hosted_rate_budget',
      rest: {
        availability: 'available',
        limit: 5_000,
        pressure: 'ready',
        remaining: 3_000,
        resetAt: '2027-01-15T08:00:00.000Z',
        source: 'rest_fallback',
      },
      watcherPolling: {
        reason: 'rate_metadata_unavailable',
        status: 'deferred',
        tier: 'unavailable',
      },
    });
    expect(JSON.stringify(health)).not.toContain('ignored');
    expect(JSON.stringify(health)).not.toContain('private');
  });

  test('starts a fresh bounded cache for each fixed GitHub.com controller credential context', async () => {
    const fixture = scriptedRunner([fallbackResult()]);
    const first = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    await Effect.runPromise(first.refreshFallback('/tmp/project'));
    const fresh = makeGitHubHostedMetadataAdapter();

    expect(await Effect.runPromise(first.snapshot())).toMatchObject({
      credentialContext: 'github_com_controller_lifetime',
      fallback: 'available',
    });
    expect(await Effect.runPromise(fresh.snapshot())).toEqual({
      credentialContext: 'github_com_controller_lifetime',
      fallback: 'not_requested',
      graphql: { availability: 'unavailable' },
      observation: 'bounded_hosted_rate_budget',
      rest: { availability: 'unavailable' },
      watcherPolling: {
        reason: 'rate_metadata_unavailable',
        status: 'deferred',
        tier: 'unavailable',
      },
    });
  });

  test('rejects a non-github.com origin before fallback metadata requests', async () => {
    const invocations: ProcessInvocation[] = [];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        invocations.push(invocation);
        return Effect.succeed(result('git@github.enterprise.test:acme/project.git\n'));
      },
    };
    const adapter = makeGitHubHostedMetadataAdapter({ runner });

    const failure = await Effect.runPromise(
      adapter.refreshFallback('/tmp/project').pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'enforce fixed github.com route for repository origin',
    });
    expect(invocations).toEqual([
      { args: ['remote', 'get-url', 'origin'], command: 'git', cwd: '/tmp/project' },
    ]);
  });

  test('invalidates young fallback metadata when the current fixed-route proof fails', async () => {
    let originChecks = 0;
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git') {
          originChecks += 1;
          return Effect.succeed(
            result(
              originChecks === 1
                ? 'git@github.com:acme/project.git\n'
                : 'git@github.com:other/project.git\n',
            ),
          );
        }
        return Effect.succeed(fallbackResult());
      },
    };
    const adapter = makeGitHubHostedMetadataAdapter({ runner });
    const first = await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1));
    if (first.status !== 'ready' || first.graphqlReservationId === undefined)
      throw new Error('fixture watcher reservation was not admitted');
    await Effect.runPromise(adapter.cancelUnlaunchedGraphQLReservation(first.graphqlReservationId));

    const failure = await Effect.runPromise(
      adapter.reserveWatcherPoll('/tmp/project', 1).pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'enforce fixed github.com route for repository origin',
    });
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      fallback: 'unavailable',
      watcherPolling: {
        reason: 'rate_metadata_unavailable',
        status: 'deferred',
        tier: 'unavailable',
      },
    });
    expect(originChecks).toBe(2);
  });

  test('enforces one fixed repository scope until a fresh controller adapter is created', async () => {
    let origin = 'git@github.com:acme/one.git\n';
    const adapter = makeGitHubHostedMetadataAdapter({
      runner: {
        run: () => Effect.succeed(result(origin)),
      },
    });

    await Effect.runPromise(adapter.fixedRoute('/tmp/one'));
    await Effect.runPromise(adapter.ensureControllerScope('/tmp/one'));
    origin = 'git@github.com:acme/two.git\n';
    const failure = await Effect.runPromise(
      adapter.ensureControllerScope('/tmp/two').pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'enforce fixed github.com route for repository origin',
    });
  });

  test('shows unavailable compact telemetry after current route proof failure', async () => {
    let origin = 'git@github.com:acme/project.git\n';
    const now = 1_700_000_000_000;
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.succeed(now),
      runner: {
        run: (invocation) =>
          invocation.command === 'git'
            ? Effect.succeed(result(origin))
            : Effect.succeed(fallbackResult()),
      },
      unsafeNowMillis: () => now,
    });
    const reservation = await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1));
    if (reservation.status !== 'ready' || reservation.graphqlReservationId === undefined)
      throw new Error('fixture watcher reservation was not admitted');
    await Effect.runPromise(
      adapter.cancelUnlaunchedGraphQLReservation(reservation.graphqlReservationId),
    );
    expect(adapter.compactStatusUnsafe()).toEqual({
      effectiveRemaining: 3_000,
      throttle: 'normal',
    });

    origin = 'git@github.com:other/project.git\n';
    await Effect.runPromise(adapter.fixedRoute('/tmp/project').pipe(Effect.flip));

    expect(adapter.compactStatusUnsafe()).toEqual({ throttle: 'unavailable' });
  });

  test('does not project proactive recovery from stale budget while fallback remains unavailable', async () => {
    const now = 1_700_000_000_000;
    let origin = 'git@github.com:acme/project.git\n';
    let hostedRequests = 0;
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: {
        run: (invocation) => {
          if (invocation.command === 'git') return Effect.succeed(result(origin));
          hostedRequests += 1;
          return hostedRequests === 1
            ? Effect.succeed(fallbackResult(1_500, 1_500))
            : Effect.fail(new GitHubCommandError({ ...invocation, cause: 'fixture outage' }));
        },
      },
    });
    const reservation = await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1));
    if (reservation.status !== 'ready' || reservation.graphqlReservationId === undefined)
      throw new Error('fixture watcher reservation was not admitted');
    await Effect.runPromise(
      adapter.cancelUnlaunchedGraphQLReservation(reservation.graphqlReservationId),
    );
    origin = 'git@github.com:other/project.git\n';
    await Effect.runPromise(adapter.fixedRoute('/tmp/project').pipe(Effect.flip));
    origin = 'git@github.com:acme/project.git\n';

    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toEqual({
      reason: 'rate_metadata_unavailable',
      status: 'deferred',
      tier: 'unavailable',
    });
    expect(hostedRequests).toBe(2);
  });

  test('bounds launched-but-unobserved identity debt after repeated failed health-style requests', async () => {
    const adapter = makeGitHubHostedMetadataAdapter();
    for (let index = 0; index < MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS; index += 1) {
      const reservation = await Effect.runPromise(adapter.reserveGraphQLRequest());
      await Effect.runPromise(adapter.launchGraphQLRequest(reservation.id));
    }

    const failure = await Effect.runPromise(adapter.reserveGraphQLRequest().pipe(Effect.flip));

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'reserve hosted GitHub request',
    });
  });

  test('recovers completed-unobserved identity capacity through one forced authoritative fallback', async () => {
    const fixture = scriptedRunner([fallbackResult()]);
    const adapter = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    for (let index = 0; index < MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS; index += 1) {
      const reservation = await Effect.runPromise(adapter.reserveGraphQLRequest());
      await Effect.runPromise(adapter.launchGraphQLRequest(reservation.id));
      await Effect.runPromise(adapter.finalizeGraphQLRequest(reservation.id));
    }
    await Effect.runPromise(adapter.reserveGraphQLRequest().pipe(Effect.flip));

    await Effect.runPromise(adapter.recoverRequestCapacity('/tmp/project'));

    expect(await Effect.runPromise(adapter.reserveGraphQLRequest())).toMatchObject({
      id: 'request-65',
    });
    expect(fixture.invocations).toHaveLength(1);
  });

  test('rejects malformed fallback metadata with a typed operation-specific response error', async () => {
    const fixture = scriptedRunner([
      result(JSON.stringify({ resources: { core: { remaining: 'credential-shaped-secret' } } })),
    ]);
    const adapter = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });

    const failure = await Effect.runPromise(
      adapter.refreshFallback('/tmp/project').pipe(Effect.flip),
    );
    const health = await Effect.runPromise(adapter.snapshot());

    expect(failure._tag).toBe('GitHubResponseError');
    if (failure._tag !== 'GitHubResponseError') throw failure;
    expect(failure.operation).toBe('inspect GitHub rate-limit fallback');
    expect(health.fallback).toBe('unavailable');
    expect(JSON.stringify(health)).not.toContain('credential-shaped-secret');
  });

  test('caches fallback inspection for a bounded interval and refreshes deterministically after it expires', async () => {
    let now = 1_700_000_000_000;
    const fixture = scriptedRunner([fallbackResult(), fallbackResult(3_999, 2_999)]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: fixture.runner,
    });

    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));
    now += GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));

    expect(fixture.invocations).toHaveLength(2);
    const health = await Effect.runPromise(adapter.snapshot());
    expect(health.graphql).toMatchObject({ remaining: 3_999, source: 'rest_fallback' });
    expect(health.rest).toMatchObject({ remaining: 2_999, source: 'rest_fallback' });
  });

  test('defers fail-closed when expired fallback metadata cannot be refreshed', async () => {
    let now = 1_700_000_000_000;
    let invocations = 0;
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: {
        run: (invocation) => {
          if (invocation.command === 'git')
            return Effect.succeed(result('git@github.com:acme/project.git\n'));
          invocations += 1;
          return invocations === 1
            ? Effect.succeed(fallbackResult())
            : Effect.fail(new GitHubCommandError({ ...invocation, cause: 'fixture outage' }));
        },
      },
    });

    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toMatchObject({
      status: 'ready',
    });
    now += GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toEqual({
      reason: 'rate_metadata_unavailable',
      status: 'deferred',
      tier: 'unavailable',
    });
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      fallback: 'unavailable',
      watcherPolling: { reason: 'rate_metadata_unavailable', status: 'deferred' },
    });
    expect(invocations).toBe(2);
  });

  test('reconciles pre-observation completed debt only after a causally later fallback observation', async () => {
    const fixture = scriptedRunner([fallbackResult()]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.succeed(1_700_000_000_000),
      runner: fixture.runner,
    });

    await Effect.runPromise(
      adapter.accountOpaqueRequest('graphql', Effect.fail('fixture outage')).pipe(Effect.flip),
    );
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));

    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 4_000, source: 'rest_fallback' },
    });
  });

  test('retains successful opaque spend until a causally later authoritative fallback reconciles it', async () => {
    let now = 1_700_000_000_000;
    const fixture = scriptedRunner([fallbackResult(), fallbackResult(3_900, 2_900)]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: fixture.runner,
    });
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));

    await Effect.runPromise(adapter.accountOpaqueRequest('graphql', Effect.succeed('ok')));
    await Effect.runPromise(adapter.accountOpaqueRequest('rest', Effect.succeed('ok')));
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 3_995, source: 'local_estimate' },
      rest: { remaining: 2_999, source: 'local_estimate' },
    });

    now += GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 3_900, source: 'rest_fallback' },
      rest: { remaining: 2_900, source: 'rest_fallback' },
    });
  });

  test('keeps local watcher reservations outstanding across delayed hosted observations', async () => {
    let now = 1_700_000_000_000;
    const fixture = scriptedRunner([fallbackResult(), fallbackResult()]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: fixture.runner,
    });

    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toMatchObject({
      status: 'ready',
    });
    await Effect.runPromise(
      adapter.decodeGraphQL(
        'delayed GraphQL budget fixture',
        GitHubAdvertisedDefaultBranchGraphQLSchema,
        graphQlEnvelope(),
      ),
    );
    await Effect.runPromise(
      adapter.accountOpaqueRequest('graphql', Effect.fail('fixture outage')).pipe(Effect.flip),
    );
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 3_985, source: 'local_estimate' },
      rest: { remaining: 3_000, source: 'rest_fallback' },
    });

    now += GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 3_990, source: 'local_estimate' },
      rest: { remaining: 3_000, source: 'rest_fallback' },
    });
  });

  test('applies deterministic normal, moderate, aggressive, and paused watcher admission tiers', async () => {
    const scenario = async (remaining: number) => {
      let now = 1_700_000_000_000;
      const fixture = scriptedRunner([
        fallbackResult(remaining, remaining),
        fallbackResult(remaining, remaining),
      ]);
      const adapter = makeGitHubHostedMetadataAdapter({
        nowMillis: Effect.sync(() => now),
        runner: fixture.runner,
        unsafeNowMillis: () => now,
      });
      return {
        adapter,
        advance: (millis: number) => {
          now += millis;
        },
      };
    };

    const normal = await scenario(3_000);
    expect(
      await Effect.runPromise(normal.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      status: 'ready',
      tier: 'normal',
    });
    expect(
      await Effect.runPromise(normal.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      status: 'ready',
      tier: 'normal',
    });

    const moderate = await scenario(1_500);
    expect(
      await Effect.runPromise(moderate.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      status: 'ready',
      tier: 'moderate',
    });
    expect(moderate.adapter.compactStatusUnsafe()).toEqual({
      effectiveRemaining: 1_490,
      throttle: 'moderate',
    });
    expect(
      await Effect.runPromise(moderate.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      reason: 'proactive_throttle',
      status: 'deferred',
      tier: 'moderate',
      until: '2023-11-14T22:13:50.000Z',
    });
    expect(await Effect.runPromise(moderate.adapter.snapshot())).toMatchObject({
      watcherPolling: {
        reason: 'proactive_throttle',
        status: 'deferred',
        tier: 'moderate',
      },
    });
    moderate.advance(30_000);
    expect(
      await Effect.runPromise(moderate.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      status: 'ready',
      tier: 'moderate',
    });

    const aggressive = await scenario(900);
    expect(
      await Effect.runPromise(aggressive.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      status: 'ready',
      tier: 'aggressive',
    });
    expect(
      await Effect.runPromise(aggressive.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      reason: 'proactive_throttle',
      status: 'deferred',
      tier: 'aggressive',
      until: '2023-11-14T22:14:20.000Z',
    });

    const paused = await scenario(400);
    expect(
      await Effect.runPromise(paused.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      reason: 'proactive_throttle',
      status: 'deferred',
      tier: 'paused',
      until: '2023-11-14T22:14:20.000Z',
    });
    expect(paused.adapter.compactStatusUnsafe()).toEqual({
      effectiveRemaining: 400,
      throttle: 'paused',
    });
    paused.advance(59_999);
    expect(
      await Effect.runPromise(paused.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      status: 'deferred',
      tier: 'paused',
    });
    paused.advance(1);
    expect(
      await Effect.runPromise(paused.adapter.reserveWatcherPoll('/tmp/project', 1)),
    ).toMatchObject({
      status: 'ready',
      tier: 'paused',
    });
  });

  test('preserves the explicit watcher reserve floor while paused', async () => {
    let now = 1_700_000_000_000;
    const fixture = scriptedRunner([fallbackResult(105, 105), fallbackResult(105, 105)]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: fixture.runner,
    });

    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toMatchObject({
      reason: 'proactive_throttle',
      status: 'deferred',
      tier: 'paused',
    });
    now += 60_000;
    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toMatchObject({
      reason: 'proactive_throttle',
      status: 'deferred',
      tier: 'paused',
    });
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 105 },
      rest: { remaining: 105 },
    });
  });

  test('moves a deferred watcher budget back to ready only after a decoded post-reset fallback refresh', async () => {
    let now = 1_700_000_000_000;
    const fixture = scriptedRunner([
      fallbackResult(100, 100, 1_700_000_001, 1_700_000_001),
      fallbackResult(4_000, 3_000, 1_700_003_600, 1_700_003_600),
    ]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: fixture.runner,
    });

    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toMatchObject({
      reason: 'proactive_throttle',
      status: 'deferred',
    });
    now = 1_700_000_061_000;
    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toMatchObject({
      status: 'ready',
    });
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      fallback: 'available',
      graphql: { remaining: 3_990, source: 'local_estimate' },
      rest: { remaining: 3_000, source: 'rest_fallback' },
      watcherPolling: { effectiveRemaining: 3_000, status: 'ready', tier: 'normal' },
    });
    expect(fixture.invocations).toHaveLength(2);
  });

  test('rejects semantically invalid remaining budgets and reset timestamps with typed fail-closed decoding', async () => {
    for (const source of [
      graphQlEnvelope({ remaining: 5_001 }),
      graphQlEnvelope({ resetAt: '2026-02-30T01:00:00Z' }),
    ]) {
      const adapter = makeGitHubHostedMetadataAdapter();
      const failure = await Effect.runPromise(
        adapter
          .decodeGraphQL(
            'semantically invalid GraphQL fixture',
            GitHubAdvertisedDefaultBranchGraphQLSchema,
            source,
          )
          .pipe(Effect.flip),
      );
      expect(failure._tag).toBe('GitHubResponseError');
    }

    for (const source of [
      fallbackResult(5_001),
      result(
        JSON.stringify({
          resources: {
            core: { limit: 5_000, remaining: 3_000, reset: 10_000_000_001 },
            graphql: { limit: 5_000, remaining: 4_000, reset: 1_800_000_000 },
          },
        }),
      ),
    ]) {
      const fixture = scriptedRunner([source]);
      const adapter = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
      const failure = await Effect.runPromise(
        adapter.refreshFallback('/tmp/project').pipe(Effect.flip),
      );
      expect(failure._tag).toBe('GitHubResponseError');
      expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
        fallback: 'unavailable',
      });
    }
  });

  test('retains GraphQL reset metadata and conservatively debits CLI-only paths without retaining response bodies', async () => {
    const fixture = scriptedRunner([fallbackResult()]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.succeed(1_700_000_000_000),
      runner: fixture.runner,
    });
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));
    const decoded = await Effect.runPromise(
      adapter.decodeGraphQL(
        'fixture GraphQL envelope',
        GitHubAdvertisedDefaultBranchGraphQLSchema,
        JSON.stringify({
          data: {
            rateLimit: {
              cost: 1,
              limit: 5_000,
              remaining: 250,
              resetAt: '2027-01-15T08:01:40Z',
            },
            repository: { defaultBranchRef: null },
          },
          private_body: 'must not enter adapter state',
        }),
      ),
    );
    await Effect.runPromise(
      adapter.accountOpaqueRequest('graphql', Effect.fail('fixture outage')).pipe(Effect.flip),
    );
    const health = await Effect.runPromise(adapter.snapshot());

    expect(decoded.data.repository.defaultBranchRef).toBeNull();
    expect(health.graphql).toEqual({
      availability: 'available',
      limit: 5_000,
      pressure: 'near_exhaustion',
      remaining: 245,
      resetAt: '2027-01-15T08:01:40Z',
      source: 'local_estimate',
    });
    expect(JSON.stringify(health)).not.toContain('private_body');
  });
});
