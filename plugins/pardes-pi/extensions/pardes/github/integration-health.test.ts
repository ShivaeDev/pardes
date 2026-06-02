import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  GITHUB_INTEGRATION_HEALTH_MAX_PULL_REQUESTS,
  GitHubCommandError,
  MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS,
  makeGitHubHostedMetadataAdapter,
  makeGitHubIntegrationHealthService,
} from './index.ts';
import { result, scriptedRunner } from './test-fixtures.ts';
import type { GitHubCommandRunnerShape, ProcessInvocation } from './transport.ts';

const MAIN_SHA = 'a'.repeat(40);
const AUDITED_PR_SHA = 'b'.repeat(40);
const OBSERVED_PR_SHA = 'c'.repeat(40);
const OLD_CHECK_SHA = 'd'.repeat(40);
const RATE_LIMIT = {
  cost: 1,
  limit: 5_000,
  remaining: 4_999,
  resetAt: '2026-06-01T01:00:00Z',
};

function defaultBranchResult(sha = MAIN_SHA) {
  return result(
    JSON.stringify({
      data: {
        rateLimit: RATE_LIMIT,
        repository: { defaultBranchRef: { name: 'main', target: { oid: sha } } },
      },
    }),
  );
}

function rateLimitFallbackResult() {
  return result(
    JSON.stringify({
      resources: {
        core: { limit: 5_000, remaining: 3_000, reset: 1_800_000_000 },
        graphql: { limit: 5_000, remaining: 4_000, reset: 1_800_000_000 },
      },
    }),
  );
}

function hostedChecksResult(
  options: {
    readonly sha?: string;
    readonly checks?: ReadonlyArray<unknown>;
    readonly hasNextPage?: boolean;
    readonly noRollup?: boolean;
  } = {},
) {
  return result(
    JSON.stringify({
      data: {
        rateLimit: RATE_LIMIT,
        repository: {
          object: {
            oid: options.sha ?? MAIN_SHA,
            statusCheckRollup:
              options.noRollup === true
                ? null
                : {
                    contexts: {
                      nodes: options.checks ?? [],
                      pageInfo: { hasNextPage: options.hasNextPage ?? false },
                    },
                  },
          },
        },
      },
    }),
  );
}

function checkRun(
  overrides: Partial<{
    readonly status: string;
    readonly conclusion: string | null;
    readonly workflowId: number | null;
  }> = {},
) {
  return {
    __typename: 'CheckRun',
    checkSuite: { workflowRun: { workflow: { databaseId: 101 } } },
    conclusion: 'SUCCESS',
    status: 'COMPLETED',
    ...overrides,
    ...(overrides.workflowId === undefined
      ? {}
      : { checkSuite: { workflowRun: { workflow: { databaseId: overrides.workflowId } } } }),
  };
}

function association(
  overrides: Partial<{
    readonly id: string;
    readonly url: string;
    readonly number: number;
    readonly lastPushedHeadSha: string;
    readonly headBranch: string;
  }> = {},
) {
  return {
    headBranch: 'pardes/review/12345678-1234-1234-1234-123456789abc',
    id: 'pr-42',
    lastPushedHeadSha: AUDITED_PR_SHA,
    number: 42,
    url: 'https://github.com/acme/project/pull/42',
    ...overrides,
  };
}

describe('GitHub integration-health inspection', () => {
  test('times out and interrupts a stalled command while degrading only the affected leaf to enum-only unavailable metadata', async () => {
    let invocations = 0;
    let interrupted = false;
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git')
          return Effect.succeed(result('git@github.com:acme/project.git\n'));
        invocations += 1;
        return invocations === 1
          ? Effect.succeed(defaultBranchResult())
          : Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            );
      },
    };

    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ commandTimeout: '5 millis', runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [],
      }),
    );

    expect(interrupted).toBe(true);
    expect(inspection.defaultBranch).toEqual({
      advertisedHeadSha: MAIN_SHA,
      availability: 'available',
      defaultBranch: 'main',
      hostedChecks: { availability: 'unavailable', issue: 'timed_out' },
    });
    expect(JSON.stringify(inspection)).not.toContain('GitHubIntegrationHealthTimeoutError');
  });

  test('uses shell-free server-selected GraphQL fields and reports current checks with shared default-branch failure hints', async () => {
    const fixture = scriptedRunner([
      defaultBranchResult(),
      hostedChecksResult({
        checks: [checkRun({ conclusion: 'FAILURE' }), checkRun({ workflowId: 102 })],
      }),
      result(JSON.stringify({ headRefOid: AUDITED_PR_SHA, number: 42 })),
      hostedChecksResult({
        checks: [checkRun({ conclusion: 'FAILURE' }), checkRun({ workflowId: 103 })],
        sha: AUDITED_PR_SHA,
      }),
    ]);

    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner: fixture.runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [association()],
      }),
    );

    expect(inspection).toEqual({
      bounds: { maxHostedChecksPerRef: 50, maxPullRequests: 12 },
      defaultBranch: {
        advertisedHeadSha: MAIN_SHA,
        availability: 'available',
        defaultBranch: 'main',
        hostedChecks: {
          availability: 'available',
          ci: 'failing',
          completeness: 'complete',
          countAccuracy: 'exact',
          headSha: MAIN_SHA,
          observedCheckCount: 2,
          observedFailingCheckCount: 1,
          relation: 'current',
        },
      },
      inspectedPullRequestCount: 1,
      observation: 'opt_in_read_only_hosted_metadata',
      omittedPullRequestCount: 0,
      pullRequests: [
        {
          auditedHeadSha: AUDITED_PR_SHA,
          hostedChecks: {
            availability: 'available',
            ci: 'failing',
            completeness: 'complete',
            countAccuracy: 'exact',
            headSha: AUDITED_PR_SHA,
            observedCheckCount: 2,
            observedFailingCheckCount: 1,
            relation: 'current',
          },
          id: 'pr-42',
          number: 42,
          observedHeadSha: AUDITED_PR_SHA,
          pullRequestHead: 'current',
          sharedFailingWorkflowCount: 1,
        },
      ],
      rateLimit: {
        credentialContext: 'github_com_controller_lifetime',
        fallback: 'not_requested',
        graphql: {
          availability: 'available',
          limit: 5_000,
          pressure: 'ready',
          remaining: 4_999,
          resetAt: '2026-06-01T01:00:00Z',
          source: 'graphql',
        },
        observation: 'bounded_hosted_rate_budget',
        rest: { availability: 'unavailable' },
        watcherPolling: {
          reason: 'rate_metadata_unavailable',
          status: 'deferred',
          tier: 'unavailable',
        },
      },
    });
    expect(fixture.invocations.map(({ command }) => command)).toEqual(['gh', 'gh', 'gh', 'gh']);
    expect(fixture.invocations.map(({ args }) => args.slice(0, 2))).toEqual([
      ['api', 'graphql'],
      ['api', 'graphql'],
      ['pr', 'view'],
      ['api', 'graphql'],
    ]);
    expect(fixture.invocations[1]?.args).toContain('expression=main');
    expect(fixture.invocations[1]?.args).toContain('limit=50');
    expect(fixture.invocations[0]?.args).toContain('owner=acme');
    expect(fixture.invocations[0]?.args).toContain('repo=project');
    expect(
      fixture.invocations
        .filter(({ args }) => args[0] === 'api')
        .every(({ args }) => args.includes('github.com')),
    ).toBe(true);
    expect(fixture.invocations[1]?.args.join(' ')).toContain('pageInfo{hasNextPage}');
    expect(fixture.invocations[0]?.args.join(' ')).toContain(
      'rateLimit{cost limit remaining resetAt}',
    );
    expect(fixture.invocations[1]?.args.join(' ')).toContain(
      'rateLimit{cost limit remaining resetAt}',
    );
    expect(fixture.invocations[1]?.args.join(' ')).toContain('workflow{databaseId}');
    expect(fixture.invocations[2]?.args).toEqual([
      'pr',
      'view',
      '42',
      '--json',
      'number,headRefOid',
      '--repo',
      'acme/project',
    ]);
    expect(fixture.invocations[3]?.args).toContain(`expression=${association().headBranch}`);
    expect(fixture.invocations.flatMap(({ args }) => args).join(' ')).not.toContain('actions/runs');
    expect(fixture.invocations.flatMap(({ args }) => args).join(' ')).not.toContain('logs');
    expect(JSON.stringify(inspection)).not.toContain('body');
  });

  test('classifies an audited PR-head divergence separately from stale hosted checks and suppresses shared hints', async () => {
    const fixture = scriptedRunner([
      defaultBranchResult(),
      hostedChecksResult({ checks: [checkRun({ conclusion: 'FAILURE' })] }),
      result(JSON.stringify({ headRefOid: OBSERVED_PR_SHA, number: 42 })),
      hostedChecksResult({ checks: [checkRun({ conclusion: 'FAILURE' })], sha: OLD_CHECK_SHA }),
    ]);

    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner: fixture.runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [association()],
      }),
    );

    expect(inspection.pullRequests[0]).toMatchObject({
      auditedHeadSha: AUDITED_PR_SHA,
      hostedChecks: {
        availability: 'available',
        ci: 'failing',
        completeness: 'complete',
        headSha: OLD_CHECK_SHA,
        relation: 'stale',
      },
      observedHeadSha: OBSERVED_PR_SHA,
      pullRequestHead: 'diverged',
      sharedFailingWorkflowCount: 0,
    });
  });

  test('retains page-cap evidence, marks non-failing partial observations unknown, and suppresses shared hints', async () => {
    const fixture = scriptedRunner([
      defaultBranchResult(),
      hostedChecksResult({ checks: [checkRun({ conclusion: 'FAILURE' })] }),
      result(JSON.stringify({ headRefOid: AUDITED_PR_SHA, number: 42 })),
      hostedChecksResult({
        checks: [checkRun({ conclusion: 'SUCCESS' })],
        hasNextPage: true,
        sha: AUDITED_PR_SHA,
      }),
    ]);

    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner: fixture.runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [association()],
      }),
    );

    expect(inspection.pullRequests[0]).toMatchObject({
      hostedChecks: {
        availability: 'available',
        ci: 'unknown',
        completeness: 'partial',
        countAccuracy: 'lower_bound',
        observedCheckCount: 1,
        observedFailingCheckCount: 0,
      },
      sharedFailingWorkflowCount: 0,
    });
  });

  test('suppresses shared hints when the default-branch page is partial even if matching failures are visible', async () => {
    const fixture = scriptedRunner([
      defaultBranchResult(),
      hostedChecksResult({ checks: [checkRun({ conclusion: 'FAILURE' })], hasNextPage: true }),
      result(JSON.stringify({ headRefOid: AUDITED_PR_SHA, number: 42 })),
      hostedChecksResult({ checks: [checkRun({ conclusion: 'FAILURE' })], sha: AUDITED_PR_SHA }),
    ]);

    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner: fixture.runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [association()],
      }),
    );

    expect(inspection.defaultBranch).toMatchObject({
      hostedChecks: {
        availability: 'available',
        ci: 'failing',
        completeness: 'partial',
        countAccuracy: 'lower_bound',
      },
    });
    expect(inspection.pullRequests[0]?.sharedFailingWorkflowCount).toBe(0);
  });

  test('maps an unknown completed conclusion to unknown instead of passing', async () => {
    const fixture = scriptedRunner([
      defaultBranchResult(),
      hostedChecksResult({ checks: [checkRun({ conclusion: 'FUTURE_CONCLUSION' })] }),
    ]);

    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner: fixture.runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [],
      }),
    );

    expect(inspection.defaultBranch).toMatchObject({
      hostedChecks: { availability: 'available', ci: 'unknown', completeness: 'complete' },
    });
  });

  test('degrades unavailable leaves safely and hard-caps review inspection before any argv invocation', async () => {
    const invocations: ProcessInvocation[] = [];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        invocations.push(invocation);
        return Effect.fail(
          new GitHubCommandError({
            args: invocation.args,
            cause: 'fixture outage with private diagnostics',
            command: invocation.command,
            cwd: invocation.cwd,
          }),
        );
      },
    };
    const pullRequests = Array.from(
      { length: GITHUB_INTEGRATION_HEALTH_MAX_PULL_REQUESTS + 3 },
      (_, index) => association({ id: `pr-${index}`, number: index + 1 }),
    );

    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner }).inspect({ cwd: '', pullRequests }),
    );

    expect(invocations).toEqual([]);
    expect(inspection.defaultBranch).toEqual({
      availability: 'unavailable',
      issue: 'command_failed',
    });
    expect(inspection.inspectedPullRequestCount).toBe(GITHUB_INTEGRATION_HEALTH_MAX_PULL_REQUESTS);
    expect(inspection.omittedPullRequestCount).toBe(3);
    expect(
      inspection.pullRequests.every(
        ({ hostedChecks }) =>
          hostedChecks.availability === 'unavailable' && hostedChecks.issue === 'command_failed',
      ),
    ).toBe(true);
    expect(JSON.stringify(inspection)).not.toContain('private diagnostics');
  });

  test('rejects same-host cross-repository association routes before mixing opt-in health metadata', async () => {
    const fixture = scriptedRunner([]);
    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner: fixture.runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [association({ url: 'https://github.com/other/project/pull/42' })],
      }),
    );

    expect(fixture.invocations).toEqual([]);
    expect(inspection.defaultBranch).toEqual({
      availability: 'unavailable',
      issue: 'unsupported_route',
    });
    expect(inspection.pullRequests[0]).toMatchObject({
      hostedChecks: { availability: 'unavailable', issue: 'unsupported_route' },
      pullRequestHead: 'unavailable',
    });
  });

  test('reserves opt-in health GraphQL spend before launch so watcher admission sees in-flight debt', async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git')
          return Effect.succeed(result('git@github.com:acme/project.git\n'));
        if (invocation.args[1] === 'graphql')
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
        if (invocation.args[1] === 'rate_limit') return Effect.succeed(rateLimitFallbackResult());
        return Effect.die(`Unexpected command: ${invocation.args.join(' ')}`);
      },
    };
    const hostedMetadata = makeGitHubHostedMetadataAdapter({ runner });
    const service = makeGitHubIntegrationHealthService({ hostedMetadata, runner });
    const fiber = Effect.runFork(service.inspect({ cwd: '/tmp/project', pullRequests: [] }));
    await Effect.runPromise(Deferred.await(entered));

    await Effect.runPromise(hostedMetadata.refreshFallback('/tmp/project'));
    expect(await Effect.runPromise(hostedMetadata.snapshot())).toMatchObject({
      graphql: { remaining: 3_995, source: 'local_estimate' },
    });
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test('bounds repeated failed health GraphQL launches when forced fallback recovery also fails', async () => {
    let fallbackRequests = 0;
    let graphqlRequests = 0;
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git')
          return Effect.succeed(result('git@github.com:acme/project.git\n'));
        if (invocation.args[1] === 'graphql') graphqlRequests += 1;
        else fallbackRequests += 1;
        return Effect.fail(new GitHubCommandError({ ...invocation, cause: 'fixture outage' }));
      },
    };
    const service = makeGitHubIntegrationHealthService({ runner });

    for (let index = 0; index < MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS + 3; index += 1) {
      const inspection = await Effect.runPromise(
        service.inspect({ cwd: '/tmp/project', pullRequests: [] }),
      );
      expect(inspection.defaultBranch).toMatchObject({ availability: 'unavailable' });
    }

    expect(graphqlRequests).toBe(MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS);
    expect(fallbackRequests).toBe(3);
  });

  test('recovers failed health GraphQL capacity through a bounded authoritative fallback retry', async () => {
    let fallbackRequests = 0;
    let graphqlRequests = 0;
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git')
          return Effect.succeed(result('git@github.com:acme/project.git\n'));
        if (invocation.args[1] === 'rate_limit') {
          fallbackRequests += 1;
          return Effect.succeed(rateLimitFallbackResult());
        }
        graphqlRequests += 1;
        return Effect.fail(new GitHubCommandError({ ...invocation, cause: 'fixture outage' }));
      },
    };
    const service = makeGitHubIntegrationHealthService({ runner });

    for (let index = 0; index < MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS + 1; index += 1) {
      const inspection = await Effect.runPromise(
        service.inspect({ cwd: '/tmp/project', pullRequests: [] }),
      );
      expect(inspection.defaultBranch).toMatchObject({ availability: 'unavailable' });
    }

    expect(graphqlRequests).toBe(MAX_GITHUB_OUTSTANDING_REQUEST_RESERVATIONS + 1);
    expect(fallbackRequests).toBe(1);
  });

  test('continues bounded PR observation when default-branch metadata is unavailable', async () => {
    let invocationCount = 0;
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        if (invocation.command === 'git')
          return Effect.succeed(result('git@github.com:acme/project.git\n'));
        invocationCount += 1;
        if (invocationCount === 1)
          return Effect.fail(
            new GitHubCommandError({
              args: invocation.args,
              cause: 'fixture outage',
              command: invocation.command,
              cwd: invocation.cwd,
            }),
          );
        if (invocation.args[0] === 'pr')
          return Effect.succeed(result(JSON.stringify({ headRefOid: AUDITED_PR_SHA, number: 42 })));
        return Effect.succeed(hostedChecksResult({ noRollup: true, sha: AUDITED_PR_SHA }));
      },
    };

    const { headBranch: _headBranch, ...legacyAssociation } = association();
    const inspection = await Effect.runPromise(
      makeGitHubIntegrationHealthService({ runner }).inspect({
        cwd: '/tmp/project',
        pullRequests: [legacyAssociation],
      }),
    );

    expect(inspection.defaultBranch).toEqual({
      availability: 'unavailable',
      issue: 'command_failed',
    });
    expect(inspection.pullRequests[0]).toMatchObject({
      hostedChecks: { availability: 'none' },
      pullRequestHead: 'current',
      sharedFailingWorkflowCount: 0,
    });
    expect(invocationCount).toBe(3);
  });
});
