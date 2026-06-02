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

function compactJwt(signature: 'signed' | 'unsecured', whitespaceHeader = false): string {
  const header = Buffer.from(
    whitespaceHeader
      ? '{ "alg":"HS256","typ":"JWT" }'
      : JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from('{}').toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${
    signature === 'unsecured'
      ? ''
      : createHmac('sha256', 'fixture-material').update(unsigned).digest('base64url')
  }`;
}

const AMBIGUOUS_SECRET_EXCERPT_MARKER =
  '[REDACTED EXCERPT: ambiguous secret-bearing serialization]';

function ambiguousSecretSources() {
  const tokenKey = `to${'ken'}`;
  const passwordKey = `pass${'word'}`;
  const escapedQuote = `\\${'"'}`;
  const tripleQuote = ['"', '"', '"'].join('');
  const unicodeTokenKey = `\\u${'0074'}oken`;
  const nestedSecret = ['escaped', 'json', 'tail'].join('-');
  const nestedToken = ['escaped', 'token', 'tail'].join('-');
  const deeplyNestedSecret = ['deeply', 'escaped', 'json', 'tail'].join('-');
  const deeplyNestedToken = ['deeply', 'escaped', 'token', 'tail'].join('-');
  return [
    {
      label: 'YAML block scalar',
      source: `${tokenKey}: |\n  yaml-block-tail`,
      tail: 'yaml-block-tail',
    },
    {
      label: 'YAML folded scalar',
      source: `${passwordKey}: >-\n  yaml-folded-tail`,
      tail: 'yaml-folded-tail',
    },
    {
      label: 'TOML triple-quoted scalar',
      source: `${tokenKey} = ${tripleQuote}\nmultiline-tail\n${tripleQuote}`,
      tail: 'multiline-tail',
    },
    {
      label: 'JSON unicode-escaped key',
      source: `{"${unicodeTokenKey}":"unicode-tail"}`,
      tail: 'unicode-tail',
    },
    {
      label: 'mixed double-single quoted assignment',
      source: `${tokenKey}="abc'quoted-tail`,
      tail: 'quoted-tail',
    },
    {
      label: 'mixed single-double quoted assignment',
      source: `${passwordKey}='abc"quoted-tail`,
      tail: 'quoted-tail',
    },
    {
      label: 'incomplete escaped assignment',
      source: `{${escapedQuote}client_${'secret'}${escapedQuote}:${escapedQuote}terminal-tail`,
      tail: 'terminal-tail',
    },
    {
      label: 'escaped unquoted assignment',
      source: `{${escapedQuote}${tokenKey}${escapedQuote}:unquoted-tail}`,
      tail: 'unquoted-tail',
    },
    {
      label: 'nested serialized assignment',
      source: JSON.stringify({
        message: JSON.stringify({ client_secret: nestedSecret, token: nestedToken }),
      }),
      tail: nestedSecret,
    },
    {
      label: 'deeply nested serialized assignment',
      source: JSON.stringify({
        message: JSON.stringify({
          message: JSON.stringify({ client_secret: deeplyNestedSecret, token: deeplyNestedToken }),
        }),
      }),
      tail: deeplyNestedSecret,
    },
  ] as const;
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

  test('sanitizes whitespace-header JWTs, unicode-escaped secret keys, and incomplete key PEMs in hosted check names', async () => {
    const whitespaceHeaderJwt = compactJwt('signed', true);
    const unicodeTokenKey = `\\u${'0074'}oken`;
    const pemPrefix = ['-----BEGIN ', 'PRIVATE ', 'KEY-----'].join('');
    const fixture = scriptedRunner([
      checksResult({
        nodes: [
          checkRun({ name: whitespaceHeaderJwt }),
          checkRun({ databaseId: 8002, name: `{"${unicodeTokenKey}":"name-tail"}`, runId: 7002 }),
          checkRun({ databaseId: 8003, name: `${pemPrefix}\nname-tail`, runId: 7003 }),
        ],
      }),
    ]);

    const inspection = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).inspectFailingChecks({
        cwd: '/tmp/project',
        pullRequest: association(),
      }),
    );

    expect(inspection.failingChecks.map(({ name }) => name)).toEqual([
      '[REDACTED JWT]',
      AMBIGUOUS_SECRET_EXCERPT_MARKER,
      '[REDACTED PEM]',
    ]);
    expect(JSON.stringify(inspection)).not.toContain(whitespaceHeaderJwt);
    expect(JSON.stringify(inspection)).not.toContain('name-tail');
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
      result(
        `line one\npassword=private-value\n${secret}\n\u001b[31mline four\u202e\nline five\n${'z'.repeat(100)}`,
      ),
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
    const tokenKey = `to${'ken'}`;
    const longCredential = 'x'.repeat(400);
    const signedShortJwt = compactJwt('signed');
    const whitespaceHeaderJwt = compactJwt('signed', true);
    const fixture = scriptedRunner([
      checksResult(),
      result(
        `${authorization}: Basic ${longCredential}\n${JSON.stringify({ authorization: 'Basic json-auth-tail', client_secret: 'json-ci-secret', password: 'json ci tail' })}\n${tokenKey}=unquoted-tail with-ambiguous-suffix\n${signedShortJwt}\n${whitespaceHeaderJwt}\nBearer tiny\nvisible`,
      ),
    ]);

    const excerpt = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getCiLogExcerpt({
        cwd: '/tmp/project',
        jobId: 8001,
        maxChars: 400,
        pullRequest: association(),
        runId: 7001,
      }),
    );

    expect(excerpt.excerpt).toContain('Authorization: [REDACTED]');
    expect(excerpt.excerpt).toContain('"authorization":[REDACTED]');
    expect(excerpt.excerpt).toContain('"client_secret":[REDACTED]');
    expect(excerpt.excerpt).toContain('"password":[REDACTED]');
    expect(excerpt.excerpt.match(/\[REDACTED JWT\]/g)).toHaveLength(2);
    expect(excerpt.excerpt).toContain(`${tokenKey}=[REDACTED]`);
    expect(excerpt.excerpt).not.toContain('with-ambiguous-suffix');
    expect(excerpt.excerpt).toContain('Bearer [REDACTED]');
    expect(excerpt.excerpt).not.toContain('Bearer tiny');
    expect(excerpt.excerpt).toContain('visible');
    expect(excerpt.hasMore).toBe(false);
    expect(excerpt.excerpt).not.toContain(longCredential);
    expect(excerpt.excerpt).not.toContain('json-auth-tail');
    expect(excerpt.excerpt).not.toContain('json-ci-secret');
    expect(excerpt.excerpt).not.toContain('json ci tail');
    expect(excerpt.excerpt).not.toContain(signedShortJwt);
    expect(excerpt.excerpt).not.toContain(whitespaceHeaderJwt);
  });

  test.each(
    ambiguousSecretSources(),
  )('omits ambiguous $label from explicit CI excerpts before pagination', async ({
    source,
    tail,
  }) => {
    const fixture = scriptedRunner([checksResult(), result(`${source}\nvisible-after-secret`)]);

    const excerpt = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getCiLogExcerpt({
        cwd: '/tmp/project',
        jobId: 8001,
        maxChars: 200,
        pullRequest: association(),
        runId: 7001,
      }),
    );

    expect(excerpt.excerpt).toBe(AMBIGUOUS_SECRET_EXCERPT_MARKER);
    expect(excerpt.hasMore).toBe(false);
    expect(excerpt.excerpt).not.toContain(tail);
    expect(excerpt.excerpt).not.toContain('visible-after-secret');
  });

  test('redacts incomplete key PEM fragments through explicit CI excerpt end', async () => {
    const pemPrefix = ['-----BEGIN ', 'PRIVATE ', 'KEY-----'].join('');
    const fixture = scriptedRunner([checksResult(), result(`visible\n${pemPrefix}\npem-tail`)]);

    const excerpt = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getCiLogExcerpt({
        cwd: '/tmp/project',
        jobId: 8001,
        pullRequest: association(),
        runId: 7001,
      }),
    );

    expect(excerpt.excerpt).toBe('visible\n[REDACTED PEM]');
    expect(excerpt.hasMore).toBe(false);
    expect(excerpt.excerpt).not.toContain('pem-tail');
  });

  test('does not fail closed for delimiter-distinct benign escaped keys in CI excerpts', async () => {
    const escapedQuote = `\\${'"'}`;
    const source = `{${escapedQuote}tokenizer${escapedQuote}:${escapedQuote}ordinary${escapedQuote},${escapedQuote}secretary${escapedQuote}:${escapedQuote}text${escapedQuote}}`;
    const fixture = scriptedRunner([checksResult(), result(source)]);

    const excerpt = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getCiLogExcerpt({
        cwd: '/tmp/project',
        jobId: 8001,
        pullRequest: association(),
        runId: 7001,
      }),
    );

    expect(excerpt.excerpt).toBe(source);
    expect(excerpt.excerpt).not.toBe(AMBIGUOUS_SECRET_EXCERPT_MARKER);
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
    const signedShortJwt = compactJwt('signed');
    const whitespaceHeaderJwt = compactJwt('signed', true);
    // Unsecured compact JWTs carry an empty signature; redact conservatively rather than project them.
    const unsecuredJwt = compactJwt('unsecured');
    const secret = 'github_pat_abcdefghijklmnop';
    const temporaryAwsKey = `ASIA${'A'.repeat(16)}`;
    const items = Array.from({ length: 10 }, (_, index) => ({
      body:
        index === 0
          ? `marker\u061cleft\nclient_secret=do-not-leak\npassword="alpha beta"\napi_key='gamma delta'\ntoken=${secret}\naws=${temporaryAwsKey}\n${JSON.stringify({ client_secret: 'json-do-not-leak', password: 'json alpha beta', token: 'generic-json-token' })}\n${quotedYamlKey}\n${signedShortJwt}\n${whitespaceHeaderJwt}\n${unsecuredJwt}\nBearer tiny\n${authorization}: Basic basic-tail-marker\n${authorizationLower}=token opaque-tail-marker\n${authorizationLower}: Digest username="admin", response="digest-tail-marker"\n${authorization}: Bearer bearer-tail-marker\n${authorization}: Custom unknown-tail-marker\n${'x'.repeat(5_000)}`
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
    expect(page.items[0]?.excerpt).not.toContain(signedShortJwt);
    expect(page.items[0]?.excerpt).not.toContain(whitespaceHeaderJwt);
    expect(page.items[0]?.excerpt).not.toContain(unsecuredJwt);
    expect(page.items[0]?.excerpt.match(/\[REDACTED JWT\]/g)).toHaveLength(3);
    expect(page.items[0]?.excerpt).not.toContain('Bearer tiny');
    expect(page.items[0]?.excerpt).toContain('Bearer [REDACTED]');
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

  test.each(
    ambiguousSecretSources(),
  )('omits ambiguous $label from explicit PR-level discussion excerpts before pagination', async ({
    source,
    tail,
  }) => {
    const fixture = scriptedRunner([
      result(JSON.stringify([{ body: `${source}\nvisible-after-secret`, id: 1, user: null }])),
    ]);

    const page = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getDiscussionBodyExcerpts({
        cwd: '/tmp/project',
        pullRequest: association(),
        surface: 'issue_comment',
      }),
    );

    expect(page.items[0]?.excerpt).toBe(AMBIGUOUS_SECRET_EXCERPT_MARKER);
    expect(page.items[0]?.hasMore).toBe(false);
    expect(page.items[0]?.excerpt).not.toContain(tail);
    expect(page.items[0]?.excerpt).not.toContain('visible-after-secret');
    expect(page.provenance.scope).toBe('pull_request_level_not_commit_bound');
  });

  test('redacts incomplete key PEM fragments through explicit PR-level discussion excerpt end', async () => {
    const pemPrefix = ['-----BEGIN ', 'PRIVATE ', 'KEY-----'].join('');
    const fixture = scriptedRunner([
      result(JSON.stringify([{ body: `visible\n${pemPrefix}\npem-tail`, id: 1, user: null }])),
    ]);

    const page = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getDiscussionBodyExcerpts({
        cwd: '/tmp/project',
        pullRequest: association(),
        surface: 'issue_comment',
      }),
    );

    expect(page.items[0]?.excerpt).toBe('visible\n[REDACTED PEM]');
    expect(page.items[0]?.hasMore).toBe(false);
    expect(page.items[0]?.excerpt).not.toContain('pem-tail');
  });

  test('does not fail closed for delimiter-distinct benign escaped keys in PR-level discussion excerpts', async () => {
    const escapedQuote = `\\${'"'}`;
    const source = `{${escapedQuote}tokenizer${escapedQuote}:${escapedQuote}ordinary${escapedQuote},${escapedQuote}secretary${escapedQuote}:${escapedQuote}text${escapedQuote}}`;
    const fixture = scriptedRunner([result(JSON.stringify([{ body: source, id: 1, user: null }]))]);

    const page = await Effect.runPromise(
      makeGitHubHostedDrilldownService({ runner: fixture.runner }).getDiscussionBodyExcerpts({
        cwd: '/tmp/project',
        pullRequest: association(),
        surface: 'issue_comment',
      }),
    );

    expect(page.items[0]?.excerpt).toBe(source);
    expect(page.items[0]?.excerpt).not.toBe(AMBIGUOUS_SECRET_EXCERPT_MARKER);
    expect(page.provenance.scope).toBe('pull_request_level_not_commit_bound');
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
