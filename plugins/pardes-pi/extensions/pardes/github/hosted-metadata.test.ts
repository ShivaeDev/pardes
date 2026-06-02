import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  GITHUB_RATE_LIMIT_FALLBACK_MAX_AGE_MILLIS,
  makeGitHubHostedMetadataAdapter,
} from './index.ts';
import { GitHubAdvertisedDefaultBranchGraphQLSchema } from './schemas.ts';
import { result, scriptedRunner } from './test-fixtures.ts';

function fallbackResult(graphqlRemaining = 4_000, restRemaining = 3_000) {
  return result(
    JSON.stringify({
      ignored_private_extension: 'must not enter bounded health',
      resources: {
        core: { limit: 5_000, remaining: restRemaining, reset: 1_800_000_000 },
        graphql: { limit: 5_000, remaining: graphqlRemaining, reset: 1_800_000_100 },
        ignored_resource: { limit: 99, remaining: 1, reset: 1_800_000_200 },
      },
    }),
  );
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
              resetAt: '2026-06-01T01:00:00Z',
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
      resetAt: '2026-06-01T01:00:00Z',
      source: 'local_estimate',
    });
    expect(JSON.stringify(health)).not.toContain('private_body');
  });
});
