import { Context, Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, test } from 'vitest';
import type { PullRequestRecord } from '../manager/index.ts';
import {
  DEFAULT_GITHUB_WATCHER_CADENCE,
  DEFAULT_GITHUB_WATCHER_COMMAND_TIMEOUT,
  derivePullRequestTransitions,
  GitHubCommandError,
  GitHubWatcher,
  type GitHubWatcherCallbacks,
  type GitHubWatcherThrottleDiagnostic,
  MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS,
  makeGitHubHostedMetadataAdapter,
  makeGitHubWatcherService as makeGitHubWatcherServiceProduction,
  type PullRequestObservation,
  type PullRequestWatcherFailure,
  type PullRequestWatcherHeadDivergence,
  type PullRequestWatcherObservation,
} from './index.ts';
import { result, scriptedRunner } from './test-fixtures.ts';
import type { GitHubCommandRunnerShape, ProcessInvocation, ProcessResult } from './transport.ts';

const HEAD_SHA = 'a'.repeat(40);
const PREVIOUS_HEAD_SHA = 'b'.repeat(40);
const RATE_LIMIT = {
  cost: 1,
  limit: 5_000,
  remaining: 4_999,
  resetAt: '2026-06-01T01:00:00Z',
};

function rateLimitFallbackBudgetsResult(graphqlRemaining: number, restRemaining: number) {
  return result(
    JSON.stringify({
      resources: {
        core: { limit: 5_000, remaining: restRemaining, reset: 1_800_000_000 },
        graphql: { limit: 5_000, remaining: graphqlRemaining, reset: 1_800_000_000 },
      },
    }),
  );
}

function rateLimitFallbackResult(remaining = 5_000): ProcessResult {
  return rateLimitFallbackBudgetsResult(remaining, remaining);
}

function makeGitHubWatcherService(
  options: Parameters<typeof makeGitHubWatcherServiceProduction>[0] = {},
) {
  return makeGitHubWatcherServiceProduction({
    hostedMetadata:
      options.hostedMetadata ??
      makeGitHubHostedMetadataAdapter({
        runner: {
          run: ({ command }) =>
            Effect.succeed(
              command === 'git'
                ? result('git@github.com:acme/project.git\n')
                : rateLimitFallbackResult(),
            ),
        },
      }),
    ...options,
  });
}

function discussionResult(
  options: {
    readonly comments?: ReadonlyArray<unknown>;
    readonly reviews?: ReadonlyArray<unknown>;
    readonly inlineComments?: ReadonlyArray<unknown>;
    readonly commentsHavePreviousPage?: boolean;
    readonly reviewsHavePreviousPage?: boolean;
    readonly inlineCommentsHavePreviousPage?: boolean;
    readonly inlineThreadsHavePreviousPage?: boolean;
    readonly rateLimit?: typeof RATE_LIMIT;
  } = {},
): ProcessResult {
  return result(
    JSON.stringify({
      data: {
        rateLimit: options.rateLimit ?? RATE_LIMIT,
        repository: {
          pullRequest: {
            comments: {
              nodes: options.comments ?? [],
              pageInfo: { hasPreviousPage: options.commentsHavePreviousPage ?? false },
            },
            reviews: {
              nodes: options.reviews ?? [],
              pageInfo: { hasPreviousPage: options.reviewsHavePreviousPage ?? false },
            },
            reviewThreads: {
              nodes: (options.inlineComments ?? []).map((comment) => {
                const legacy = comment as { readonly id: number; readonly user: unknown };
                return {
                  comments: {
                    nodes: [{ author: legacy.user, databaseId: legacy.id }],
                    pageInfo: { hasPreviousPage: options.inlineCommentsHavePreviousPage ?? false },
                  },
                };
              }),
              pageInfo: { hasPreviousPage: options.inlineThreadsHavePreviousPage ?? false },
            },
          },
        },
      },
    }),
  );
}

function inlineCommentsResult(comments: ReadonlyArray<unknown> = []): ProcessResult {
  return result(JSON.stringify(comments));
}

function pullRequest(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    agentId: 'agent-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    id: 'pr-42',
    number: 42,
    status: 'open',
    updatedAt: '2026-06-01T00:00:00.000Z',
    url: 'https://github.com/acme/project/pull/42',
    workstreamId: 'ws-1',
    ...overrides,
  };
}

function callbacks(associations: ReadonlyArray<PullRequestRecord>) {
  const observations: PullRequestWatcherObservation[] = [];
  const failures: PullRequestWatcherFailure[] = [];
  const divergences: PullRequestWatcherHeadDivergence[] = [];
  const throttleDiagnostics: GitHubWatcherThrottleDiagnostic[] = [];
  const value: GitHubWatcherCallbacks = {
    cwd: () => '/tmp/project',
    onFailure: (event) =>
      Effect.sync(() => {
        failures.push(event);
      }),
    onHeadDivergence: (event) =>
      Effect.sync(() => {
        divergences.push(event);
      }),
    onObservation: (event) =>
      Effect.sync(() => {
        observations.push(event);
      }),
    onThrottleDiagnostic: (event) =>
      Effect.sync(() => {
        throttleDiagnostics.push(event);
      }),
    persistedAssociations: () => associations,
  };
  return { callbacks: value, divergences, failures, observations, throttleDiagnostics };
}

function observation(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    ci: 'passing',
    mergeable: 'mergeable',
    number: 42,
    reviewDecision: 'approved',
    status: 'open',
    ...overrides,
  };
}

describe('GitHub watcher service', () => {
  test('host-qualifies watcher reads despite alternate GH_HOST and projects body-free metadata', async () => {
    const oversizedPreview = `Please inspect ${'x'.repeat(300)}`;
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          body: 'untrusted PR body must not enter the projection',
          comments: [{ body: 'coarse payload comment must not enter the projection' }],
          headRefOid: HEAD_SHA,
          mergeable: 'CONFLICTING',
          number: 42,
          reviewDecision: 'CHANGES_REQUESTED',
          state: 'OPEN',
          statusCheckRollup: [
            {
              conclusion: 'FAILURE',
              detailsUrl: 'https://github.com/logs',
              name: 'untrusted check name',
              status: 'COMPLETED',
            },
          ],
        }),
      ),
      discussionResult({
        comments: [{ author: { login: 'alice' }, body: oversizedPreview, databaseId: 101 }],
        inlineComments: [{ body: 'Inline concern on the changed line.', id: 301, user: null }],
        reviews: [
          {
            author: { login: 'bob' },
            body: 'Please add the focused regression test.',
            databaseId: 201,
            submittedAt: '2026-06-01T00:00:00Z',
          },
          {
            author: { login: 'pending-reviewer' },
            body: 'pending body is not submitted',
            databaseId: 204,
            submittedAt: null,
          },
          { author: null, body: '   ', databaseId: 203, submittedAt: '2026-06-01T00:00:00Z' },
        ],
      }),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const received = callbacks([pullRequest({ lastPushedHeadSha: HEAD_SHA })]);

    const previousGitHubHost = process.env.GH_HOST;
    process.env.GH_HOST = 'github.enterprise.test';
    try {
      await Effect.runPromise(service.poll(received.callbacks));
    } finally {
      if (previousGitHubHost === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = previousGitHubHost;
    }

    expect(received.failures).toEqual([]);
    const projectedObservation = {
      ci: 'failing' as const,
      mergeable: 'conflicting' as const,
      number: 42,
      reviewDecision: 'changes_requested' as const,
      status: 'open' as const,
    };
    expect(received.observations).toEqual([
      {
        complete: false,
        expectedHeadSha: HEAD_SHA,
        observation: projectedObservation,
        pullRequestId: 'pr-42',
      },
      {
        complete: true,
        discussion: {
          cursor: { inlineReviewCommentId: 301, issueCommentId: 101, reviewId: 203 },
          feedback: [
            { author: 'alice', id: 101, kind: 'issue_comment' },
            { author: 'bob', id: 201, kind: 'review' },
            { author: 'unknown-author', id: 203, kind: 'review' },
            { author: 'unknown-author', id: 301, kind: 'inline_review_comment' },
          ],
        },
        expectedHeadSha: HEAD_SHA,
        observation: projectedObservation,
        pullRequestId: 'pr-42',
      },
    ]);
    expect(fixture.invocations[0]).toEqual({
      args: [
        'pr',
        'view',
        '42',
        '--json',
        'number,headRefOid,state,mergeable,reviewDecision,statusCheckRollup',
        '--repo',
        'github.com/acme/project',
      ],
      command: 'gh',
      cwd: '/tmp/project',
    });
    expect(fixture.invocations[1]?.args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(fixture.invocations[1]?.args).toContain('limit=100');
    expect(fixture.invocations[1]?.args).toContain('github.com');
    expect(fixture.invocations[1]?.args).toContain('owner=acme');
    expect(fixture.invocations[1]?.args).toContain('repo=project');
    expect(fixture.invocations).toHaveLength(2);
    expect(fixture.invocations[1]?.args.join(' ')).toContain('reviewThreads(last:$limit)');
    expect(fixture.invocations[1]?.args.join(' ')).not.toContain('body');
    expect(fixture.invocations.every(({ command }) => command === 'gh')).toBe(true);
    expect(fixture.invocations[0]?.args.join(',')).not.toContain('body');
    expect(fixture.invocations[0]?.args.join(',')).not.toContain('comment');
    expect(JSON.stringify(received.observations)).not.toContain('pending body');
    expect(JSON.stringify(received.observations)).not.toContain(oversizedPreview);
  });

  test('normalizes unsafe external discussion authors while retaining body-free structural metadata', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult({
        comments: [
          { author: { login: 'unsafe\u202eauthor' }, body: 'must remain omitted', databaseId: 101 },
        ],
      }),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.failures).toEqual([]);
    expect(received.observations[1]?.discussion?.feedback).toEqual([
      { author: 'unknown-author', id: 101, kind: 'issue_comment' },
    ]);
    expect(JSON.stringify(received.observations)).not.toContain('must remain omitted');
    expect(JSON.stringify(received.observations)).not.toContain('\u202e');
  });

  test('projects content-free page-cap evidence without fetching additional discussion pages', async () => {
    const inlineComments = Array.from({ length: 100 }, (_, index) => ({
      body: 'bounded inline preview',
      id: 301 + index,
      user: { login: 'inline-user' },
    }));
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult({
        comments: [
          { author: { login: 'alice' }, body: 'first bounded preview', databaseId: 101 },
          { author: { login: 'bob' }, body: 'second bounded preview', databaseId: 102 },
        ],
        commentsHavePreviousPage: true,
        inlineComments,
        inlineCommentsHavePreviousPage: true,
      }),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.failures).toEqual([]);
    expect(received.observations[1]?.discussion?.pageCaps).toEqual([
      { oldestFetchedId: 101, surface: 'issue_comment' },
      { oldestFetchedId: 301, requiresCursorHold: true, surface: 'inline_review_comment' },
    ]);
    expect(received.observations[1]?.discussion?.feedback).toHaveLength(102);
    expect(fixture.invocations).toHaveLength(2);
    expect(fixture.invocations[1]?.args.join(' ')).toContain('pageInfo{hasPreviousPage}');
    expect(fixture.invocations[1]?.args.join(' ')).toContain(
      'rateLimit{cost limit remaining resetAt}',
    );
  });

  test('forces inline cursor hold when omitted outer review threads make visible overlap unsafe', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult({
        inlineComments: [
          { id: 50, user: { login: 'older-thread' } },
          { id: 102, user: { login: 'newer-thread' } },
        ],
        inlineThreadsHavePreviousPage: true,
      }),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.failures).toEqual([]);
    expect(received.observations[1]?.discussion).toMatchObject({
      cursor: { inlineReviewCommentId: 102 },
      pageCaps: [
        {
          oldestFetchedId: 50,
          requiresCursorHold: true,
          surface: 'inline_review_comment',
        },
      ],
    });
  });

  test('reads currently persisted associations when the manual poll effect executes', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'UNKNOWN',
          number: 42,
          reviewDecision: '',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult(),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const associations: PullRequestRecord[] = [];
    const received = callbacks(associations);
    const manualPoll = service.poll(received.callbacks);
    associations.push(pullRequest());

    await Effect.runPromise(manualPoll);

    expect(received.observations[0]?.observation).toEqual({
      ci: 'unknown',
      mergeable: 'unknown',
      number: 42,
      reviewDecision: 'unknown',
      status: 'open',
    });
    expect(fixture.invocations).toHaveLength(2);
  });

  test('polls immediately when started and then uses the prompt bounded cadence', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult(),
    ]);
    const service = makeGitHubWatcherService({ cadence: '1 hour', runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    expect(DEFAULT_GITHUB_WATCHER_CADENCE).toBe('15 seconds');
    await Effect.runPromise(service.start(received.callbacks));

    expect(received.observations).toHaveLength(2);
    expect(fixture.invocations).toHaveLength(2);
    await Effect.runPromise(service.stop());
  });

  test("skips a previous head's stale CI rollup while surfacing bounded head divergence", async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: PREVIOUS_HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }],
        }),
      ),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const received = callbacks([pullRequest({ lastPushedHeadSha: HEAD_SHA })]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.observations).toEqual([]);
    expect(received.failures).toEqual([]);
    expect(received.divergences).toEqual([
      { expectedHeadSha: HEAD_SHA, observedHeadSha: PREVIOUS_HEAD_SHA, pullRequestId: 'pr-42' },
    ]);
    expect(fixture.invocations).toHaveLength(1);
  });

  test('surfaces divergence but still emits sanitized terminal lifecycle metadata for an unexpected remote head', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: PREVIOUS_HEAD_SHA,
          mergeable: 'CONFLICTING',
          number: 42,
          reviewDecision: 'CHANGES_REQUESTED',
          state: 'MERGED',
          statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }],
        }),
      ),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const received = callbacks([pullRequest({ lastPushedHeadSha: HEAD_SHA })]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.divergences).toEqual([
      { expectedHeadSha: HEAD_SHA, observedHeadSha: PREVIOUS_HEAD_SHA, pullRequestId: 'pr-42' },
    ]);
    expect(received.observations).toEqual([
      {
        complete: false,
        expectedHeadSha: HEAD_SHA,
        observation: {
          ci: 'unknown',
          mergeable: 'unknown',
          number: 42,
          reviewDecision: 'unknown',
          status: 'merged',
        },
        pullRequestId: 'pr-42',
      },
    ]);
    expect(received.failures).toEqual([]);
    expect(fixture.invocations).toHaveLength(1);
  });

  test('binds delayed discussion completion to the association head captured before inspection', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult(),
    ]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const associations = [pullRequest({ lastPushedHeadSha: HEAD_SHA })];
    const received = callbacks(associations);
    const originalOnObservation = received.callbacks.onObservation;
    let callbacksObserved = 0;
    const interleavedCallbacks: GitHubWatcherCallbacks = {
      ...received.callbacks,
      onObservation: (event) =>
        originalOnObservation(event).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              callbacksObserved += 1;
              if (callbacksObserved === 1)
                associations[0] = pullRequest({ lastPushedHeadSha: PREVIOUS_HEAD_SHA });
            }),
          ),
        ),
    };

    await Effect.runPromise(service.poll(interleavedCallbacks));

    expect(received.observations.map(({ expectedHeadSha }) => expectedHeadSha)).toEqual([
      HEAD_SHA,
      HEAD_SHA,
    ]);
    expect(associations[0]?.lastPushedHeadSha).toBe(PREVIOUS_HEAD_SHA);
  });

  test('reconciles through active callbacks only until its Effect-owned scope is stopped', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult(),
    ]);
    const service = makeGitHubWatcherService({ cadence: '1 hour', runner: fixture.runner });
    const associations: PullRequestRecord[] = [];
    const received = callbacks(associations);

    await Effect.runPromise(service.reconcile());
    await Effect.runPromise(service.start(received.callbacks));
    associations.push(pullRequest());
    await Effect.runPromise(service.reconcile());
    await Effect.runPromise(service.stop());
    await Effect.runPromise(service.reconcile());

    expect(received.observations).toHaveLength(2);
    expect(fixture.invocations).toHaveLength(2);
  });

  test('serializes overlapping poll entry paths used by periodic polling and manual reconciliation', async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    let invocations = 0;
    let concurrentCommands = 0;
    let maximumConcurrentCommands = 0;
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) =>
        Effect.gen(function* () {
          invocations += 1;
          concurrentCommands += 1;
          maximumConcurrentCommands = Math.max(maximumConcurrentCommands, concurrentCommands);
          if (invocations === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          concurrentCommands -= 1;
          if (invocation.args[0] === 'pr') {
            return result(
              JSON.stringify({
                headRefOid: HEAD_SHA,
                mergeable: 'MERGEABLE',
                number: 42,
                reviewDecision: 'APPROVED',
                state: 'OPEN',
                statusCheckRollup: [],
              }),
            );
          }
          return invocation.args[1] === 'graphql' ? discussionResult() : inlineCommentsResult();
        }),
    };
    const service = makeGitHubWatcherService({ cadence: '1 hour', runner });
    const received = callbacks([pullRequest()]);
    const first = Effect.runFork(service.poll(received.callbacks));
    await Effect.runPromise(Deferred.await(entered));
    const second = Effect.runFork(service.poll(received.callbacks));

    await Effect.runPromise(Effect.sleep('20 millis'));
    expect(invocations).toBe(1);
    expect(maximumConcurrentCommands).toBe(1);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(second));

    expect(invocations).toBe(4);
    expect(maximumConcurrentCommands).toBe(1);
    expect(received.observations).toHaveLength(4);
  });

  test('closes an active polling scope when the watcher Layer is released', async () => {
    let persistedAssociationReads = 0;
    const received = callbacks([]);
    const layerCallbacks: GitHubWatcherCallbacks = {
      ...received.callbacks,
      persistedAssociations: () => {
        persistedAssociationReads += 1;
        return [];
      },
    };
    const service = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(GitHubWatcher.layer);
          const service = Context.get(context, GitHubWatcher);
          yield* service.start(layerCallbacks);
          yield* service.reconcile();
          return service;
        }),
      ),
    );
    const readsBeforeReleasedReconciliation = persistedAssociationReads;

    await Effect.runPromise(service.reconcile());

    expect(persistedAssociationReads).toBeGreaterThan(0);
    expect(persistedAssociationReads).toBe(readsBeforeReleasedReconciliation);
  });

  test('emits one typed unavailable throttle diagnostic until fallback recovery clears it', async () => {
    const recovery = scriptedRunner([
      rateLimitFallbackResult(),
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult(),
    ]);
    let invocations = 0;
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git')
          return Effect.succeed(result('git@github.com:acme/project.git\n'));
        invocations += 1;
        return invocations <= 2
          ? Effect.fail(new GitHubCommandError({ ...invocation, cause: 'fixture outage' }))
          : recovery.runner.run(invocation);
      },
    };
    const service = makeGitHubWatcherServiceProduction({ runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));
    await Effect.runPromise(service.poll(received.callbacks));
    expect(received.throttleDiagnostics).toEqual([
      { status: 'rate_metadata_unavailable', tier: 'unavailable' },
    ]);
    expect(received.failures).toEqual([]);
    expect(received.observations).toEqual([]);

    await Effect.runPromise(service.poll(received.callbacks));
    expect(received.throttleDiagnostics).toEqual([
      { status: 'rate_metadata_unavailable', tier: 'unavailable' },
      { status: 'rate_metadata_recovered', tier: 'normal' },
    ]);
    expect(received.observations).toHaveLength(2);
  });

  test.each([
    ['HTTP 429', { statusCode: 429 }],
    ['secondary limit', { stderr: 'HTTP 403: secondary rate limit exceeded' }],
  ])('quietly stops a multi-gate pass and reconciles after a classified %s symptom', async (_label, cause) => {
    let now = 1_700_000_000_000;
    let fallbackRequests = 0;
    const watchedPullRequests: string[] = [];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git')
          return Effect.succeed(result('git@github.com:acme/project.git\n'));
        if (invocation.args[0] === 'api' && invocation.args[1] === 'rate_limit') {
          fallbackRequests += 1;
          return Effect.succeed(rateLimitFallbackResult());
        }
        if (invocation.args[0] === 'pr' && invocation.args[1] === 'view') {
          watchedPullRequests.push(invocation.args[2] ?? 'missing');
          return Effect.fail(new GitHubCommandError({ ...invocation, cause }));
        }
        return Effect.die(`Unexpected command: ${invocation.command} ${invocation.args.join(' ')}`);
      },
    };
    const hostedMetadata = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.sync(() => now),
      runner,
      unsafeNowMillis: () => now,
    });
    const service = makeGitHubWatcherServiceProduction({ hostedMetadata, runner });
    const received = callbacks([
      pullRequest(),
      pullRequest({ id: 'pr-43', number: 43, url: 'https://github.com/acme/project/pull/43' }),
      pullRequest({ id: 'pr-44', number: 44, url: 'https://github.com/acme/project/pull/44' }),
    ]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(watchedPullRequests).toEqual(['42']);
    expect(fallbackRequests).toBe(1);
    expect(received.failures).toEqual([]);
    expect(received.throttleDiagnostics).toEqual([
      { status: 'rate_metadata_recovered', tier: 'normal' },
      { status: 'proactive_throttle', tier: 'paused' },
    ]);
    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      graphql: { availability: 'available', remaining: 4_995, source: 'local_estimate' },
      watcherPolling: { reason: 'proactive_throttle', status: 'deferred', tier: 'paused' },
    });
    expect(hostedMetadata.compactStatusUnsafe()).toMatchObject({ throttle: 'paused' });

    await Effect.runPromise(service.poll(received.callbacks));
    expect(watchedPullRequests).toEqual(['42']);
    expect(fallbackRequests).toBe(1);

    now += 60_000;
    await Effect.runPromise(service.poll(received.callbacks));
    expect(watchedPullRequests).toEqual(['42', '43']);
    expect(fallbackRequests).toBe(2);
  });

  test('re-emits unavailable metadata diagnostics when watcher callbacks are rebound', async () => {
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) =>
        invocation.command === 'git'
          ? Effect.succeed(result('git@github.com:acme/project.git\n'))
          : Effect.fail(new GitHubCommandError({ ...invocation, cause: 'fixture outage' })),
    };
    const service = makeGitHubWatcherServiceProduction({ runner });
    const first = callbacks([pullRequest()]);
    const rebound = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(first.callbacks));
    await Effect.runPromise(service.poll(first.callbacks));
    await Effect.runPromise(service.poll(rebound.callbacks));

    expect(first.throttleDiagnostics).toEqual([
      { status: 'rate_metadata_unavailable', tier: 'unavailable' },
    ]);
    expect(rebound.throttleDiagnostics).toEqual([
      { status: 'rate_metadata_unavailable', tier: 'unavailable' },
    ]);
  });

  test('defers watcher polling before watched PR requests when the bounded fallback reports near exhaustion', async () => {
    const fixture = scriptedRunner([rateLimitFallbackResult(100)]);
    const service = makeGitHubWatcherServiceProduction({ runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.observations).toEqual([]);
    expect(received.failures).toEqual([]);
    expect(received.throttleDiagnostics).toEqual([
      { status: 'proactive_throttle', tier: 'paused' },
    ]);
    expect(fixture.invocations).toEqual([
      {
        args: ['api', 'rate_limit', '--hostname', 'github.com'],
        command: 'gh',
        cwd: '/tmp/project',
      },
    ]);
  });

  test('preserves the watcher reserve floor across the pre-discussion CLI estimate boundary', async () => {
    for (const remaining of [111, 112, 113, 114, 115]) {
      const fixture = scriptedRunner([rateLimitFallbackBudgetsResult(remaining, 5_000)]);
      const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
      const service = makeGitHubWatcherServiceProduction({
        hostedMetadata,
        runner: fixture.runner,
      });
      const received = callbacks([pullRequest()]);

      await Effect.runPromise(service.poll(received.callbacks));

      expect(received.observations).toEqual([]);
      expect(received.failures).toEqual([]);
      expect(received.throttleDiagnostics).toEqual([
        { status: 'proactive_throttle', tier: 'paused' },
      ]);
      expect(fixture.invocations).toEqual([
        {
          args: ['api', 'rate_limit', '--hostname', 'github.com'],
          command: 'gh',
          cwd: '/tmp/project',
        },
      ]);
    }
  });

  test('defers before ready when 63 identities leave no capacity for the mandatory metadata pair', async () => {
    const fixture = scriptedRunner([rateLimitFallbackResult()]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    for (let index = 0; index < MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS - 1; index += 1) {
      const reservation = await Effect.runPromise(hostedMetadata.reserveGraphQLRequest());
      await Effect.runPromise(hostedMetadata.launchGraphQLRequest(reservation.id));
    }
    const service = makeGitHubWatcherServiceProduction({
      hostedMetadata,
      runner: fixture.runner,
    });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.observations).toEqual([]);
    expect(received.failures).toEqual([]);
    expect(received.throttleDiagnostics).toEqual([
      { status: 'proactive_throttle', tier: 'paused' },
    ]);
    expect(fixture.invocations).toEqual([
      {
        args: ['api', 'rate_limit', '--hostname', 'github.com'],
        command: 'gh',
        cwd: '/tmp/project',
      },
    ]);
    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      watcherPolling: { reason: 'proactive_throttle', status: 'deferred', tier: 'paused' },
    });
  });

  test('atomically leases every watcher identity so a foreground overlap cannot steal a mandatory slot', async () => {
    const fixture = scriptedRunner([
      rateLimitFallbackResult(),
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult(),
    ]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    for (let index = 0; index < MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS - 2; index += 1) {
      const reservation = await Effect.runPromise(hostedMetadata.reserveGraphQLRequest());
      await Effect.runPromise(hostedMetadata.launchGraphQLRequest(reservation.id));
    }
    const service = makeGitHubWatcherServiceProduction({
      hostedMetadata,
      runner: fixture.runner,
    });
    const received = callbacks([pullRequest()]);
    const foregroundAttempts: string[] = [];

    await Effect.runPromise(
      service.poll({
        ...received.callbacks,
        onThrottleDiagnostic: (event) =>
          received.callbacks.onThrottleDiagnostic(event).pipe(
            Effect.andThen(
              event.status !== 'rate_metadata_recovered'
                ? Effect.void
                : hostedMetadata.reserveGraphQLRequest().pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        Effect.sync(() => {
                          foregroundAttempts.push(error._tag);
                        }),
                      onSuccess: ({ id }) =>
                        Effect.sync(() => {
                          foregroundAttempts.push(`unexpected:${id}`);
                        }),
                    }),
                  ),
            ),
          ),
      }),
    );

    expect(foregroundAttempts).toEqual(['GitHubResponseError']);
    expect(received.failures).toEqual([]);
    expect(received.observations).toHaveLength(2);
    expect(fixture.invocations).toHaveLength(3);
  });

  test('uses server-selected GraphQL inline metadata without allocating REST watcher debt', async () => {
    const fixture = scriptedRunner([
      rateLimitFallbackResult(),
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult({ inlineComments: [{ id: 301, user: { login: 'alice' } }] }),
    ]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    const service = makeGitHubWatcherServiceProduction({ hostedMetadata, runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.failures).toEqual([]);
    expect(received.observations[1]?.discussion?.feedback).toContainEqual({
      author: 'alice',
      id: 301,
      kind: 'inline_review_comment',
    });
    expect(fixture.invocations).toHaveLength(3);
    expect(fixture.invocations[2]?.args.join(' ')).not.toContain('/pulls/42/comments');
    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      rest: { remaining: 5_000, source: 'rest_fallback' },
    });
  });

  test('rechecks the bounded budget between review gates and defers later gates after a low GraphQL observation', async () => {
    const fixture = scriptedRunner([
      rateLimitFallbackResult(),
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult({
        rateLimit: { ...RATE_LIMIT, remaining: 100, resetAt: '2027-01-15T08:00:00Z' },
      }),
    ]);
    const service = makeGitHubWatcherServiceProduction({ runner: fixture.runner });
    const received = callbacks([
      pullRequest(),
      pullRequest({ id: 'pr-43', number: 43, url: 'https://github.com/acme/project/pull/43' }),
    ]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.failures).toEqual([]);
    expect(received.observations.map(({ pullRequestId }) => pullRequestId)).toEqual([
      'pr-42',
      'pr-42',
    ]);
    expect(received.throttleDiagnostics).toEqual([
      { status: 'rate_metadata_recovered', tier: 'normal' },
      { status: 'proactive_throttle', tier: 'paused' },
    ]);
    expect(fixture.invocations).toHaveLength(3);
    expect(fixture.invocations[0]?.args).toEqual(['api', 'rate_limit', '--hostname', 'github.com']);
    expect(fixture.invocations.some(({ args }) => args.includes('43'))).toBe(false);
  });

  test('rotates throttled admission fairly across review gates in every low-budget tier', async () => {
    for (const { initialDelay, interval, remaining } of [
      { initialDelay: 0, interval: 30_000, remaining: 1_500 },
      { initialDelay: 0, interval: 60_000, remaining: 900 },
      { initialDelay: 60_000, interval: 60_000, remaining: 400 },
    ]) {
      let now = 1_700_000_000_000;
      const metadata = (number: number) =>
        result(
          JSON.stringify({
            headRefOid: HEAD_SHA,
            mergeable: 'MERGEABLE',
            number,
            reviewDecision: 'APPROVED',
            state: 'OPEN',
            statusCheckRollup: [],
          }),
        );
      const fixture = scriptedRunner([
        rateLimitFallbackResult(remaining),
        ...(initialDelay === 0 ? [] : [rateLimitFallbackResult(remaining)]),
        metadata(42),
        discussionResult({ rateLimit: { ...RATE_LIMIT, remaining } }),
        ...(interval < 60_000 ? [] : [rateLimitFallbackResult(remaining)]),
        metadata(43),
        discussionResult({ rateLimit: { ...RATE_LIMIT, remaining } }),
      ]);
      const hostedMetadata = makeGitHubHostedMetadataAdapter({
        nowMillis: Effect.sync(() => now),
        runner: fixture.runner,
      });
      const service = makeGitHubWatcherServiceProduction({
        hostedMetadata,
        runner: fixture.runner,
      });
      const received = callbacks([
        pullRequest(),
        pullRequest({ id: 'pr-43', number: 43, url: 'https://github.com/acme/project/pull/43' }),
      ]);

      await Effect.runPromise(service.poll(received.callbacks));
      now += initialDelay;
      if (initialDelay > 0) await Effect.runPromise(service.poll(received.callbacks));
      now += interval;
      await Effect.runPromise(service.poll(received.callbacks));

      expect(received.failures).toEqual([]);
      expect(received.observations.map(({ pullRequestId }) => pullRequestId)).toEqual([
        'pr-42',
        'pr-42',
        'pr-43',
        'pr-43',
      ]);
    }
  });

  test('stops low-tier passes after global deferral instead of proving every gate route', async () => {
    let originProofs = 0;
    const fixture = scriptedRunner([
      rateLimitFallbackResult(1_500),
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 1,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
      discussionResult({ rateLimit: { ...RATE_LIMIT, remaining: 1_500 } }),
    ]);
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command !== 'git') return fixture.runner.run(invocation);
        originProofs += 1;
        return Effect.succeed(result('git@github.com:acme/project.git\n'));
      },
    };
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner });
    const service = makeGitHubWatcherServiceProduction({ hostedMetadata, runner });
    const received = callbacks(
      Array.from({ length: 12 }, (_, index) =>
        pullRequest({
          id: `pr-${index + 1}`,
          number: index + 1,
          url: `https://github.com/acme/project/pull/${index + 1}`,
        }),
      ),
    );

    await Effect.runPromise(service.poll(received.callbacks));
    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.failures).toEqual([]);
    expect(received.observations).toHaveLength(2);
    expect(originProofs).toBe(3);
    expect(fixture.invocations).toHaveLength(3);
  });

  test('settles each healthy watcher GraphQL reservation after its exact decoded observation', async () => {
    const metadata = result(
      JSON.stringify({
        headRefOid: HEAD_SHA,
        mergeable: 'MERGEABLE',
        number: 42,
        reviewDecision: 'APPROVED',
        state: 'OPEN',
        statusCheckRollup: [],
      }),
    );
    const fixture = scriptedRunner([
      rateLimitFallbackResult(),
      metadata,
      discussionResult({ rateLimit: { ...RATE_LIMIT, resetAt: '2027-01-15T08:00:00Z' } }),
      metadata,
      discussionResult({
        rateLimit: { ...RATE_LIMIT, remaining: 4_998, resetAt: '2027-01-15T08:00:00Z' },
      }),
    ]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    const service = makeGitHubWatcherServiceProduction({ hostedMetadata, runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));
    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.observations).toHaveLength(4);
    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      graphql: { remaining: 4_998, source: 'graphql' },
      rest: { remaining: 5_000, source: 'rest_fallback' },
    });
  });

  test('keeps 12 healthy metadata-only review gates live across repeated watcher cycles without REST debt', async () => {
    const gates = Array.from({ length: 12 }, (_, index) =>
      pullRequest({
        id: `pr-${index + 1}`,
        number: index + 1,
        url: `https://github.com/acme/project/pull/${index + 1}`,
      }),
    );
    const metadata = (number: number) =>
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      );
    const outputs = [rateLimitFallbackResult()];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let index = 0; index < gates.length; index += 1) {
        outputs.push(
          metadata(index + 1),
          discussionResult({
            rateLimit: {
              ...RATE_LIMIT,
              remaining: 4_999 - cycle * gates.length - index,
              resetAt: '2027-01-15T08:00:00Z',
            },
          }),
        );
      }
    }
    const fixture = scriptedRunner(outputs);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    const service = makeGitHubWatcherServiceProduction({ hostedMetadata, runner: fixture.runner });
    const received = callbacks(gates);

    await Effect.runPromise(service.poll(received.callbacks));
    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.failures).toEqual([]);
    expect(received.observations).toHaveLength(48);
    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      graphql: { remaining: 4_976, source: 'graphql' },
      rest: { remaining: 5_000, source: 'rest_fallback' },
      watcherPolling: { status: 'ready', tier: 'normal' },
    });
    expect(fixture.invocations).toHaveLength(1 + 2 * 12 * 2);
  });

  test('cancels unlaunched watcher placeholders when an observation callback fails', async () => {
    const fixture = scriptedRunner([
      rateLimitFallbackResult(),
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
    ]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    const service = makeGitHubWatcherServiceProduction({ hostedMetadata, runner: fixture.runner });
    const received = callbacks([pullRequest()]);
    const callbackFailure = new Error('fixture callback failure before GraphQL launch');

    const failure = await Effect.runPromise(
      service
        .poll({ ...received.callbacks, onObservation: () => Effect.fail(callbackFailure) })
        .pipe(Effect.flip),
    );

    expect(failure).toBe(callbackFailure);
    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      graphql: { remaining: 4_995, source: 'local_estimate' },
      rest: { remaining: 5_000, source: 'rest_fallback' },
    });
    expect(fixture.invocations).toHaveLength(2);
  });

  test('cancels unlaunched watcher placeholders when a fiber interrupts during callback handoff', async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const fixture = scriptedRunner([
      rateLimitFallbackResult(),
      result(
        JSON.stringify({
          headRefOid: HEAD_SHA,
          mergeable: 'MERGEABLE',
          number: 42,
          reviewDecision: 'APPROVED',
          state: 'OPEN',
          statusCheckRollup: [],
        }),
      ),
    ]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner: fixture.runner });
    const service = makeGitHubWatcherServiceProduction({ hostedMetadata, runner: fixture.runner });
    const received = callbacks([pullRequest()]);
    const fiber = Effect.runFork(
      service.poll({
        ...received.callbacks,
        onObservation: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    );
    await Effect.runPromise(Deferred.await(entered));

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      graphql: { remaining: 4_995, source: 'local_estimate' },
      rest: { remaining: 5_000, source: 'rest_fallback' },
    });
    expect(fixture.invocations).toHaveLength(2);
  });

  test('rejects a same-host cross-repository watcher association before hosted requests', async () => {
    const invocations: ProcessInvocation[] = [];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        invocations.push(invocation);
        return invocation.command === 'git'
          ? Effect.succeed(result('git@github.com:acme/project.git\n'))
          : Effect.die('unsupported association route must fail before hosted command invocation');
      },
    };
    const service = makeGitHubWatcherServiceProduction({ runner });
    const received = callbacks([pullRequest({ url: 'https://github.com/other/project/pull/42' })]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(invocations).toEqual([
      { args: ['remote', 'get-url', 'origin'], command: 'git', cwd: '/tmp/project' },
    ]);
    expect(received.failures).toHaveLength(1);
    expect(received.failures[0]?.error).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'enforce fixed github.com route for association URL',
    });
  });

  test('times out and interrupts a stalled command through the typed watcher failure callback', async () => {
    let interrupted = false;
    const runner: GitHubCommandRunnerShape = {
      run: () =>
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
    };
    const service = makeGitHubWatcherService({ commandTimeout: '5 millis', runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(DEFAULT_GITHUB_WATCHER_COMMAND_TIMEOUT).toBe('10 seconds');
    expect(interrupted).toBe(true);
    expect(received.observations).toEqual([]);
    expect(received.failures).toHaveLength(1);
    expect(received.failures[0]?.error._tag).toBe('GitHubWatcherTimeoutError');
  });

  test('reports malformed gh metadata through the typed watcher failure callback', async () => {
    const fixture = scriptedRunner([result(JSON.stringify({ number: 'not-a-number' }))]);
    const service = makeGitHubWatcherService({ runner: fixture.runner });
    const received = callbacks([pullRequest()]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.observations).toEqual([]);
    expect(received.failures).toHaveLength(1);
    expect(received.failures[0]?.pullRequestId).toBe('pr-42');
    expect(received.failures[0]?.error._tag).toBe('GitHubResponseError');
  });

  test('reports malformed untrusted discussion payloads through the typed watcher failure callback', async () => {
    const metadata = result(
      JSON.stringify({
        headRefOid: HEAD_SHA,
        mergeable: 'UNKNOWN',
        number: 42,
        reviewDecision: '',
        state: 'OPEN',
        statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }],
      }),
    );
    const malformedGraphql = scriptedRunner([
      metadata,
      discussionResult({
        comments: [{ author: { login: 42 }, body: 'malformed author', databaseId: 101 }],
      }),
    ]);
    const malformedInline = scriptedRunner([
      metadata,
      discussionResult({ inlineComments: [{ id: 301, user: { login: 42 } }] }),
    ]);

    for (const fixture of [malformedGraphql, malformedInline]) {
      const received = callbacks([pullRequest()]);
      await Effect.runPromise(
        makeGitHubWatcherService({ runner: fixture.runner }).poll(received.callbacks),
      );
      expect(received.observations).toEqual([
        {
          complete: false,
          observation: {
            ci: 'failing',
            mergeable: 'unknown',
            number: 42,
            reviewDecision: 'unknown',
            status: 'open',
          },
          pullRequestId: 'pr-42',
        },
      ]);
      expect(received.failures).toHaveLength(1);
      expect(received.failures[0]?.error._tag).toBe('GitHubResponseError');
    }
    expect(malformedGraphql.invocations).toHaveLength(2);
    expect(malformedInline.invocations).toHaveLength(2);
  });

  test('rejects a persisted association whose URL path number disagrees before invoking gh', async () => {
    const fixture = scriptedRunner([]);
    const service = makeGitHubWatcherServiceProduction({ runner: fixture.runner });
    const received = callbacks([pullRequest({ url: 'https://github.com/acme/project/pull/43' })]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.observations).toEqual([]);
    expect(received.failures[0]?.error._tag).toBe('GitHubWatcherInputError');
    expect(fixture.invocations).toEqual([]);
  });

  test('rejects an unsafe legacy association URL before invoking gh', async () => {
    const fixture = scriptedRunner([]);
    const service = makeGitHubWatcherServiceProduction({ runner: fixture.runner });
    const received = callbacks([
      pullRequest({ number: undefined, url: '--repo=attacker/project' }),
    ]);

    await Effect.runPromise(service.poll(received.callbacks));

    expect(received.observations).toEqual([]);
    expect(received.failures[0]?.error._tag).toBe('GitHubWatcherInputError');
    expect(fixture.invocations).toEqual([]);
  });

  test('derives each actionable transition once from persisted projection changes', () => {
    const previous = observation({
      ci: 'passing',
      mergeable: 'mergeable',
      reviewDecision: 'approved',
    });
    const actionable = observation({
      ci: 'failing',
      mergeable: 'conflicting',
      reviewDecision: 'changes_requested',
      status: 'merged',
    });

    expect(derivePullRequestTransitions(previous, actionable)).toEqual([
      'ci_failed',
      'review_feedback',
      'conflict',
      'merged',
    ]);
    expect(derivePullRequestTransitions(actionable, actionable)).toEqual([]);
    expect(derivePullRequestTransitions(previous, observation({ status: 'closed' }))).toEqual([
      'closed_unmerged',
    ]);
  });
});
