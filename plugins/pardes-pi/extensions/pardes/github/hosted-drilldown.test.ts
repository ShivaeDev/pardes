import { createHmac } from 'node:crypto';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  GITHUB_CHECK_METADATA_TRUST_LABEL,
  GITHUB_CI_LOG_EXCERPT_TRUST_LABEL,
  GITHUB_DISCUSSION_DRILLDOWN_EXCERPT_MAX_CHARS,
  GITHUB_DISCUSSION_EXCERPT_TRUST_LABEL,
  GITHUB_HOSTED_DRILLDOWN_MAX_CHECKS,
  makeGitHubHostedDrilldownService,
} from './index.ts';
import { result, scriptedRunner } from './test-fixtures.ts';

const HEAD_SHA = 'a'.repeat(40);
const RATE_LIMIT = {
  cost: 1,
  limit: 5_000,
  remaining: 4_999,
  resetAt: '2099-01-15T08:00:00Z',
};

function compactJwt(signature: 'signed' | 'unsecured'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from('{}').toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${
    signature === 'unsecured'
      ? ''
      : createHmac('sha256', 'fixture-material').update(unsigned).digest('base64url')
  }`;
}

function association(
  overrides: Partial<{ readonly url: string; readonly lastPushedHeadSha: string }> = {},
) {
  return {
    id: 'pr-42',
    lastPushedHeadSha: HEAD_SHA,
    number: 42,
    url: 'https://github.com/acme/project/pull/42',
    ...overrides,
  };
}

function checkRun(
  overrides: Partial<{
    readonly databaseId: number;
    readonly runId: number;
    readonly conclusion: string;
    readonly name: string;
    readonly status: string;
  }> = {},
) {
  return {
    __typename: 'CheckRun',
    checkSuite: {
      workflowRun: {
        databaseId: overrides.runId ?? 7001,
        url: `https://github.com/acme/project/actions/runs/${overrides.runId ?? 7001}`,
      },
    },
    conclusion: overrides.conclusion ?? 'FAILURE',
    databaseId: overrides.databaseId ?? 8001,
    detailsUrl: `https://github.com/acme/project/actions/runs/${overrides.runId ?? 7001}/job/${overrides.databaseId ?? 8001}`,
    name: overrides.name ?? 'lint',
    status: overrides.status ?? 'COMPLETED',
  };
}

function checksResult(
  options: {
    readonly nodes?: ReadonlyArray<unknown>;
    readonly hasNextPage?: boolean;
    readonly sha?: string;
  } = {},
) {
  return result(
    JSON.stringify({
      data: {
        rateLimit: RATE_LIMIT,
        repository: {
          object: {
            oid: options.sha ?? HEAD_SHA,
            statusCheckRollup: {
              contexts: {
                nodes: options.nodes ?? [checkRun()],
                pageInfo: { hasNextPage: options.hasNextPage ?? false },
              },
            },
          },
        },
      },
    }),
  );
}

describe('GitHub hosted drill-down service', () => {
  test('inspects first-N structural failing-check metadata at the gate audited SHA without selecting logs or bodies', async () => {
    const fixture = scriptedRunner([
      checksResult({
        hasNextPage: true,
        nodes: [
          checkRun(),
          checkRun({ conclusion: 'SUCCESS', databaseId: 8002, name: 'tests', runId: 7002 }),
          {
            __typename: 'StatusContext',
            state: 'FAILURE',
          },
          { ...checkRun({ databaseId: 8003, name: 'external', runId: 7003 }), checkSuite: null },
          {
            ...checkRun({ databaseId: 8004, name: 'mismatched URL', runId: 7004 }),
            detailsUrl: 'https://github.com/acme/project/actions/runs/9999/job/8004',
          },
        ],
      }),
    ]);

    const inspection = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).inspectFailingChecks({
        cwd: '/tmp/project',
        pullRequest: association(),
      }),
    );

    expect(inspection).toEqual({
      bounds: { maxChecks: GITHUB_HOSTED_DRILLDOWN_MAX_CHECKS },
      exactHeadSha: HEAD_SHA,
      failingChecks: [
        {
          conclusion: 'FAILURE',
          jobId: 8001,
          name: 'lint',
          runId: 7001,
          status: 'COMPLETED',
          url: 'https://github.com/acme/project/actions/runs/7001/job/8001',
        },
      ],
      observation: 'opt_in_read_only_hosted_check_metadata',
      observedCheckCount: 5,
      omittedCheckCountAccuracy: 'lower_bound',
      pullRequestId: 'pr-42',
      pullRequestNumber: 42,
      trust: GITHUB_CHECK_METADATA_TRUST_LABEL,
      unmappedFailingCheckCount: 2,
    });
    expect(fixture.invocations).toHaveLength(1);
    expect(fixture.invocations[0]?.args).toContain(`expression=${HEAD_SHA}`);
    expect(fixture.invocations[0]?.args).toContain(`limit=${GITHUB_HOSTED_DRILLDOWN_MAX_CHECKS}`);
    const argv = fixture.invocations[0]?.args.join(' ') ?? '';
    expect(argv).toContain('databaseId name detailsUrl status conclusion');
    expect(argv).not.toContain('logs');
    expect(argv).not.toContain('body');
    expect(argv).not.toContain('output');
  });

  test('rejects bidi and token-bearing malformed hosted check status instead of projecting raw external text', async () => {
    const unsafeStatus = `FUTURE_\u202e_ghp_abcdefghijklmnop`;
    const fixture = scriptedRunner([checksResult({ nodes: [checkRun({ status: unsafeStatus })] })]);

    const failure = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner })
        .inspectFailingChecks({ cwd: '/tmp/project', pullRequest: association() })
        .pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'inspect hosted drill-down checks',
    });
    expect(fixture.invocations).toHaveLength(1);
  });

  test('re-proves one known failing run/job before returning one paginated bounded redacted inert log excerpt', async () => {
    const secret = 'ghp_abcdefghijklmnop';
    const fixture = scriptedRunner([
      checksResult(),
      result(`line one\npassword=private-value\n${secret}\n\u001b[31mline four\u202e\nline five`),
    ]);

    const excerpt = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getCiLogExcerpt({
        cwd: '/tmp/project',
        jobId: 8001,
        maxChars: 64,
        page: 1,
        pullRequest: association(),
        runId: 7001,
      }),
    );

    expect(excerpt).toMatchObject({
      exactHeadSha: HEAD_SHA,
      jobId: 8001,
      maxChars: 64,
      observation: 'opt_in_read_only_redacted_ci_log_excerpt',
      page: 1,
      pullRequestId: 'pr-42',
      runId: 7001,
      trust: GITHUB_CI_LOG_EXCERPT_TRUST_LABEL,
      url: 'https://github.com/acme/project/actions/runs/7001/job/8001',
    });
    expect(excerpt.excerpt.length).toBeLessThanOrEqual(64);
    expect(excerpt.hasMore).toBe(true);
    expect(excerpt.excerpt).toContain('password=[REDACTED]');
    expect(excerpt.excerpt).not.toContain('private-value');
    expect(JSON.stringify(excerpt)).not.toContain(secret);
    expect(JSON.stringify(excerpt)).not.toContain('\u001b');
    expect(excerpt.excerpt).not.toContain('\u202e');
    expect(excerpt.excerpt).toContain('\\u202e');
    expect(fixture.invocations[1]?.args).toEqual([
      'api',
      'repos/acme/project/actions/jobs/8001/logs',
      '--hostname',
      'github.com',
    ]);
  });

  test('applies shared authorization and quoted-key redaction before CI excerpt pagination', async () => {
    const authorization = `Author${'ization'}`;
    const longCredential = 'x'.repeat(400);
    const signedShortJwt = compactJwt('signed');
    const fixture = scriptedRunner([
      checksResult(),
      result(
        `${authorization}: Basic ${longCredential}\n${JSON.stringify({ authorization: 'Basic json-auth-tail', client_secret: 'json-ci-secret', password: 'json ci tail' })}\n${signedShortJwt}\nvisible`,
      ),
    ]);

    const excerpt = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getCiLogExcerpt({
        cwd: '/tmp/project',
        jobId: 8001,
        maxChars: 200,
        pullRequest: association(),
        runId: 7001,
      }),
    );

    expect(excerpt.excerpt).toContain('Authorization: [REDACTED]');
    expect(excerpt.excerpt).toContain('"authorization":[REDACTED]');
    expect(excerpt.excerpt).toContain('"client_secret":[REDACTED]');
    expect(excerpt.excerpt).toContain('"password":[REDACTED]');
    expect(excerpt.excerpt).toContain('[REDACTED JWT]');
    expect(excerpt.excerpt).toContain('visible');
    expect(excerpt.hasMore).toBe(false);
    expect(excerpt.excerpt).not.toContain(longCredential);
    expect(excerpt.excerpt).not.toContain('json-auth-tail');
    expect(excerpt.excerpt).not.toContain('json-ci-secret');
    expect(excerpt.excerpt).not.toContain('json ci tail');
    expect(excerpt.excerpt).not.toContain(signedShortJwt);
  });

  test('rejects an arbitrary run/job before requesting a hosted log body', async () => {
    const fixture = scriptedRunner([checksResult()]);

    const failure = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner })
        .getCiLogExcerpt({
          cwd: '/tmp/project',
          jobId: 9999,
          pullRequest: association(),
          runId: 9998,
        })
        .pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'verify known failing hosted check for log excerpt',
    });
    expect(fixture.invocations).toHaveLength(1);
  });

  test('retrieves external discussion bodies only through an explicit surface/page path with first-N redacted excerpts', async () => {
    const authorization = `Author${'ization'}`;
    const authorizationLower = authorization.toLowerCase();
    const quotedYamlKey = `'api_${'key'}': 'yaml-tail-marker'`;
    const nestedSecret = ['escaped', 'json', 'tail'].join('-');
    const nestedToken = ['escaped', 'token', 'tail'].join('-');
    const deeplyNestedSecret = ['deeply', 'escaped', 'json', 'tail'].join('-');
    const deeplyNestedToken = ['deeply', 'escaped', 'token', 'tail'].join('-');
    const nested = JSON.stringify({
      message: JSON.stringify({ client_secret: nestedSecret, token: nestedToken }),
    });
    const deeplyNested = JSON.stringify({
      message: JSON.stringify({
        message: JSON.stringify({ client_secret: deeplyNestedSecret, token: deeplyNestedToken }),
      }),
    });
    const signedShortJwt = compactJwt('signed');
    // Unsecured compact JWTs carry an empty signature; redact conservatively rather than project them.
    const unsecuredJwt = compactJwt('unsecured');
    const secret = 'github_pat_abcdefghijklmnop';
    const temporaryAwsKey = `ASIA${'A'.repeat(16)}`;
    const items = Array.from({ length: 10 }, (_, index) => ({
      body:
        index === 0
          ? `client_secret=do-not-leak password="alpha beta" api_key='gamma delta' token=${secret} aws=${temporaryAwsKey} marker\u061cleft\n${JSON.stringify({ client_secret: 'json-do-not-leak', password: 'json alpha beta', token: 'generic-json-token' })}\n${quotedYamlKey}\n${nested}\n${deeplyNested}\n${signedShortJwt}\n${unsecuredJwt}\n${authorization}: Basic basic-tail-marker\n${authorizationLower}=token opaque-tail-marker\n${authorizationLower}: Digest username="admin", response="digest-tail-marker"\n${authorization}: Bearer bearer-tail-marker\n${authorization}: Custom unknown-tail-marker\n${'x'.repeat(5_000)}`
          : `body-${index}`,
      id: index + 1,
      user: index === 0 ? { login: 'alice' } : index === 1 ? { login: 'evil\u202e' } : null,
    }));
    const fixture = scriptedRunner([result(JSON.stringify(items))]);

    const page = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getDiscussionBodyExcerpts({
        cwd: '/tmp/project',
        page: 2,
        pullRequest: association(),
        surface: 'inline_review_comment',
      }),
    );

    expect(page).toMatchObject({
      bounds: {
        itemsPerPage: 10,
        maxExcerptCharsPerItem: GITHUB_DISCUSSION_DRILLDOWN_EXCERPT_MAX_CHARS,
      },
      hasMore: true,
      observation: 'opt_in_read_only_redacted_discussion_body_excerpts',
      page: 2,
      provenance: {
        auditedHeadSha: HEAD_SHA,
        repositoryRoute: 'fixed_github_com_repository',
        reviewGate: 'state_known',
        scope: 'pull_request_level_not_commit_bound',
      },
      pullRequestId: 'pr-42',
      pullRequestNumber: 42,
      surface: 'inline_review_comment',
      trust: GITHUB_DISCUSSION_EXCERPT_TRUST_LABEL,
    });
    expect(page.items).toHaveLength(10);
    expect(page.items[0]).toMatchObject({ author: 'alice', hasMore: true, id: 1 });
    expect(page.items[1]).toMatchObject({ author: 'unknown-author', id: 2 });
    expect(page.items[0]?.excerpt.length).toBe(GITHUB_DISCUSSION_DRILLDOWN_EXCERPT_MAX_CHARS);
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(JSON.stringify(page)).not.toContain(temporaryAwsKey);
    expect(page.items[0]?.excerpt).toContain('client_secret=[REDACTED]');
    expect(page.items[0]?.excerpt).toContain('password=[REDACTED]');
    expect(page.items[0]?.excerpt).toContain('api_key=[REDACTED]');
    expect(page.items[0]?.excerpt).toContain('token=[REDACTED]');
    expect(page.items[0]?.excerpt).not.toContain('[REDACTED] TOKEN]');
    expect(page.items[0]?.excerpt).not.toContain('do-not-leak');
    expect(page.items[0]?.excerpt).not.toContain('alpha beta');
    expect(page.items[0]?.excerpt).not.toContain('gamma delta');
    expect(page.items[0]?.excerpt).not.toContain('json-do-not-leak');
    expect(page.items[0]?.excerpt).not.toContain('json alpha beta');
    expect(page.items[0]?.excerpt).not.toContain('generic-json-token');
    expect(page.items[0]?.excerpt).not.toContain(nestedSecret);
    expect(page.items[0]?.excerpt).not.toContain(nestedToken);
    expect(page.items[0]?.excerpt).not.toContain(deeplyNestedSecret);
    expect(page.items[0]?.excerpt).not.toContain(deeplyNestedToken);
    expect(page.items[0]?.excerpt).not.toContain(signedShortJwt);
    expect(page.items[0]?.excerpt).not.toContain(unsecuredJwt);
    expect(page.items[0]?.excerpt.match(/\[REDACTED JWT\]/g)).toHaveLength(2);
    expect(page.items[0]?.excerpt).not.toContain('basic-tail-marker');
    expect(page.items[0]?.excerpt).not.toContain('yaml-tail-marker');
    expect(page.items[0]?.excerpt).not.toContain('opaque-tail-marker');
    expect(page.items[0]?.excerpt).not.toContain('digest-tail-marker');
    expect(page.items[0]?.excerpt).not.toContain('bearer-tail-marker');
    expect(page.items[0]?.excerpt).not.toContain('unknown-tail-marker');
    expect(page.items[0]?.excerpt).toContain('Authorization: [REDACTED]');
    expect(page.items[0]?.excerpt).toContain('authorization=[REDACTED]');
    expect(page.items[0]?.excerpt).toContain('authorization: [REDACTED]');
    expect(page.items[0]?.excerpt).not.toContain('\u061c');
    expect(page.items[0]?.excerpt).toContain('\\u061c');
    expect(fixture.invocations[0]?.args).toEqual([
      'api',
      'repos/acme/project/pulls/42/comments?per_page=10&page=2',
      '--hostname',
      'github.com',
    ]);
  });

  test('labels discussion bodies as PR-level rather than commit-bound when no audited SHA is available', async () => {
    const { lastPushedHeadSha: _lastPushedHeadSha, ...withoutAuditedHead } = association();
    const fixture = scriptedRunner([result('[]')]);

    const page = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getDiscussionBodyExcerpts({
        cwd: '/tmp/project',
        pullRequest: withoutAuditedHead,
        surface: 'issue_comment',
      }),
    );

    expect(page.provenance).toEqual({
      repositoryRoute: 'fixed_github_com_repository',
      reviewGate: 'state_known',
      scope: 'pull_request_level_not_commit_bound',
    });
    expect(page.provenance).not.toHaveProperty('auditedHeadSha');
    expect(fixture.invocations[0]?.args).toContain(
      'repos/acme/project/issues/42/comments?per_page=10&page=1',
    );
  });

  test('rejects cross-repository associations before any hosted request', async () => {
    const fixture = scriptedRunner([]);

    const failure = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner })
        .inspectFailingChecks({
          cwd: '/tmp/project',
          pullRequest: association({ url: 'https://github.com/other/project/pull/42' }),
        })
        .pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'enforce fixed github.com route for association URL',
    });
    expect(fixture.invocations).toEqual([]);
  });
});
