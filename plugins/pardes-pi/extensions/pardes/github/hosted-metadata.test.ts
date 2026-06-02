import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS,
  GitHubCommandError,
  makeGitHubHostedMetadataAdapter,
} from './index.ts';
import { GitHubAdvertisedDefaultBranchGraphQLSchema } from './schemas.ts';
import { result, scriptedRunner } from './test-fixtures.ts';

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
      { args: ['api', 'rate_limit'], command: 'gh', cwd: '/tmp/project' },
    ]);
    expect(health).toEqual({
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
      watcherPolling: { status: 'ready' },
    });
    expect(JSON.stringify(health)).not.toContain('ignored');
    expect(JSON.stringify(health)).not.toContain('private');
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
          invocations += 1;
          return invocations === 1
            ? Effect.succeed(fallbackResult())
            : Effect.fail(new GitHubCommandError({ ...invocation, cause: 'fixture outage' }));
        },
      },
    });

    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toEqual({
      status: 'ready',
    });
    now += GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toEqual({
      reason: 'rate_metadata_unavailable',
      status: 'deferred',
    });
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      fallback: 'unavailable',
      watcherPolling: { reason: 'rate_metadata_unavailable', status: 'deferred' },
    });
    expect(invocations).toBe(2);
  });

  test('binds a pre-observation CLI debit to the first fallback reset window instead of overwriting it', async () => {
    const fixture = scriptedRunner([fallbackResult()]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.succeed(1_700_000_000_000),
      runner: fixture.runner,
    });

    await Effect.runPromise(adapter.noteUnmeteredGraphQLRequest());
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));

    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 3_995, source: 'local_estimate' },
    });
  });

  test('keeps local watcher reservations and CLI debits outstanding across delayed hosted observations', async () => {
    let now = 1_700_000_000_000;
    const fixture = scriptedRunner([fallbackResult(), fallbackResult()]);
    const adapter = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner: fixture.runner,
    });

    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toEqual({
      status: 'ready',
    });
    await Effect.runPromise(
      adapter.decodeGraphQL(
        'delayed GraphQL budget fixture',
        GitHubAdvertisedDefaultBranchGraphQLSchema,
        graphQlEnvelope(),
      ),
    );
    await Effect.runPromise(adapter.noteUnmeteredGraphQLRequest());
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 3_985, source: 'local_estimate' },
      rest: { remaining: 2_999, source: 'local_estimate' },
    });

    now += GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS;
    await Effect.runPromise(adapter.refreshFallback('/tmp/project'));
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      graphql: { remaining: 3_985, source: 'local_estimate' },
      rest: { remaining: 2_999, source: 'local_estimate' },
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
      reason: 'near_exhaustion',
      status: 'deferred',
    });
    now = 1_700_000_002_000;
    expect(await Effect.runPromise(adapter.reserveWatcherPoll('/tmp/project', 1))).toEqual({
      status: 'ready',
    });
    expect(await Effect.runPromise(adapter.snapshot())).toMatchObject({
      fallback: 'available',
      graphql: { remaining: 3_990, source: 'local_estimate' },
      rest: { remaining: 2_999, source: 'local_estimate' },
      watcherPolling: { status: 'ready' },
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
    await Effect.runPromise(adapter.noteUnmeteredGraphQLRequest());
    const health = await Effect.runPromise(adapter.snapshot());

    expect(decoded.data.repository.defaultBranchRef).toBeNull();
    expect(health.graphql).toEqual({
      availability: 'available',
      limit: 5_000,
      pressure: 'ready',
      remaining: 245,
      resetAt: '2027-01-15T08:01:40Z',
      source: 'local_estimate',
    });
    expect(JSON.stringify(health)).not.toContain('private_body');
  });
});
