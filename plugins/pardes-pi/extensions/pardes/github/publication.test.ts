import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { initialManagerState, ManagerStateSchema } from '../manager/index.ts';
import { runGitFixture } from '../test-support.ts';
import {
  GitHubCommandError,
  makeGitHubHostedMetadataAdapter,
  makeGitHubPublicationService,
} from './index.ts';
import { result, scriptedRunner } from './test-fixtures.ts';
import {
  type GitHubCommandRunnerShape,
  makeExecFileGitHubCommandRunner,
  type ProcessInvocation,
  type ProcessResult,
} from './transport.ts';

function withoutBoundRepoArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.at(-2) === '--repo' && args.at(-1) === 'acme/project' ? args.slice(0, -2) : args;
}

function withoutBoundRepo(
  invocation: ProcessInvocation | undefined,
): ProcessInvocation | undefined {
  return invocation === undefined
    ? undefined
    : { ...invocation, args: withoutBoundRepoArgs(invocation.args) };
}

function withoutBoundRepos(
  invocations: ReadonlyArray<ProcessInvocation>,
): ReadonlyArray<ProcessInvocation> {
  return invocations.map(withoutBoundRepo) as ReadonlyArray<ProcessInvocation>;
}

function pullRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    baseRefName: 'main',
    body: 'Summary and validation.',
    headRefName:
      'pardes/review/readable-publish-pr-bounded-slice-11111111-1111-4111-8111-111111111111',
    headRefOid: input.headSha,
    isDraft: false,
    number: 42,
    state: 'OPEN',
    title: 'Publish the bounded slice',
    url: 'https://github.com/acme/project/pull/42',
    ...overrides,
  };
}

const HUMAN_CLAIM = 'pardes-reservation-manager-1-agent-1-c36cc3ff4f6b';

const input = {
  baseBranch: 'main',
  body: 'Summary and validation.',
  cwd: '/tmp/managed-worker',
  headBranch:
    'pardes/review/readable-publish-pr-bounded-slice-11111111-1111-4111-8111-111111111111',
  headSha: 'a'.repeat(40),
  title: 'Publish the bounded slice',
};

describe('GitHub publication boundary', () => {
  test('plans the logged-in GitHub actor readable branch without a visible ID by default', async () => {
    const fixture = scriptedRunner([result('OctoUser\n'), result()]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const branches = await Effect.runPromise(
      service.publishedReviewBranchCandidates({
        cwd: input.cwd,
        disambiguator: 'agent-12345678',
        fallbackDisambiguator: 'manager-87654321',
        workstreamTitle: 'Readable Branch UX',
      }),
    );

    expect(branches).toEqual([
      'octouser/pardes/readable-branch-ux',
      'octouser/pardes/readable-branch-ux-12345678',
      'octouser/pardes/readable-branch-ux-12345678-87654321',
    ]);
  });

  test('proves the fixed route before explicitly hosted actor lookup and retains conservative REST debt', async () => {
    const fixture = scriptedRunner([
      result(
        JSON.stringify({
          resources: {
            core: { limit: 5_000, remaining: 3_000, reset: 1_800_000_000 },
            graphql: { limit: 5_000, remaining: 4_000, reset: 1_800_000_000 },
          },
        }),
      ),
      result('OctoUser\n'),
      result(),
    ]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.succeed(1_700_000_000_000),
      runner: fixture.runner,
    });
    const service = makeGitHubPublicationService({ hostedMetadata, runner: fixture.runner });
    await Effect.runPromise(hostedMetadata.refreshFallback(input.cwd));

    await Effect.runPromise(
      service.publishedReviewBranchCandidates({
        cwd: input.cwd,
        disambiguator: 'agent-12345678',
        fallbackDisambiguator: 'manager-87654321',
        workstreamTitle: 'Readable Branch UX',
      }),
    );
    const rateLimit = await Effect.runPromise(hostedMetadata.snapshot());

    expect(fixture.invocations[1]?.args).toEqual([
      'api',
      'user',
      '--hostname',
      'github.com',
      '--jq',
      '.login',
    ]);
    expect(fixture.invocations[2]?.args).toEqual([
      'ls-remote',
      '--heads',
      'git@github.com:acme/project.git',
      'refs/heads/octouser',
      'refs/heads/octouser/pardes',
    ]);
    expect(rateLimit.rest).toMatchObject({ remaining: 2_999, source: 'local_estimate' });
  });

  test('falls back to a sanitized Git config actor when the GitHub login response is not safe', async () => {
    const fixture = scriptedRunner([result('Not Safe Actor!\n'), result('Local Dev\n'), result()]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const branches = await Effect.runPromise(
      service.publishedReviewBranchCandidates({
        cwd: input.cwd,
        disambiguator: 'agent-12345678',
        fallbackDisambiguator: 'manager-87654321',
        workstreamTitle: 'Readable Branch UX',
      }),
    );

    expect(branches[0]).toBe('local-dev/pardes/readable-branch-ux');
  });

  test('plans a bounded flat fallback when an ancestor leaf blocks the readable hierarchy', async () => {
    const fixture = scriptedRunner([
      result('actor\n'),
      result(`${input.headSha}\trefs/heads/actor\n`),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const branches = await Effect.runPromise(
      service.publishedReviewBranchCandidates({
        cwd: input.cwd,
        disambiguator: 'agent-12345678',
        fallbackDisambiguator: 'manager-87654321',
        workstreamTitle: 'Readable Branch UX',
      }),
    );

    expect(branches[0]).toBe('actor-pardes-readable-branch-ux');
  });

  test('transfers and reserves an exact local-only audited SHA with a create-only atomic push', async () => {
    const branch = 'actor/pardes/readable-branch-ux';
    const claim = HUMAN_CLAIM;
    const advertised = `${input.headSha}\trefs/heads/${branch}\n${input.headSha}\trefs/heads/${claim}\n`;
    const fixture = scriptedRunner([result(), result(), result(advertised)]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const reserved = await Effect.runPromise(
      service.reservePublishedReviewBranch({
        cwd: input.cwd,
        headBranch: branch,
        headSha: input.headSha,
        ownershipId: 'manager-1-agent-1',
      }),
    );

    expect(reserved).toBe('reserved');
    expect(fixture.invocations[1]).toEqual({
      args: [
        'push',
        '--atomic',
        `--force-with-lease=refs/heads/${branch}:`,
        `--force-with-lease=refs/heads/${claim}:`,
        'git@github.com:acme/project.git',
        `${input.headSha}:refs/heads/${branch}`,
        `${input.headSha}:refs/heads/${claim}`,
      ],
      command: 'git',
      cwd: input.cwd,
    });
  });

  test('removes only the exact transient ownership anchor after durable finalization', async () => {
    const claim = HUMAN_CLAIM;
    const fixture = scriptedRunner([result(`${input.headSha}\trefs/heads/${claim}\n`), result()]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    await Effect.runPromise(
      service.releasePublishedReviewBranchClaim({
        cwd: input.cwd,
        headBranch: 'actor/pardes/readable-branch-ux',
        headSha: input.headSha,
        ownershipId: 'manager-1-agent-1',
      }),
    );

    expect(fixture.invocations[1]?.args).toEqual([
      'push',
      `--force-with-lease=refs/heads/${claim}:${input.headSha}`,
      'git@github.com:acme/project.git',
      `:refs/heads/${claim}`,
    ]);
  });

  test('recovers a lost create response only when the exact SHA and ownership anchor are advertised', async () => {
    const branch = 'actor/pardes/readable-branch-ux';
    const claim = HUMAN_CLAIM;
    const advertised = `${input.headSha}\trefs/heads/${branch}\n${input.headSha}\trefs/heads/${claim}\n`;
    const invocations: Array<{
      readonly args: ReadonlyArray<string>;
      readonly command: string;
      readonly cwd: string;
    }> = [];
    const outputs: Array<ProcessResult | 'lost'> = [
      result('git@github.com:acme/project.git\n'),
      result(),
      'lost',
      result(advertised),
    ];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        invocations.push(invocation);
        const output = outputs.shift();
        return output === 'lost'
          ? Effect.fail(
              new GitHubCommandError({
                args: invocation.args,
                cause: 'fixture lost response',
                command: invocation.command,
                cwd: invocation.cwd,
              }),
            )
          : Effect.succeed(output ?? result());
      },
    };
    const service = makeGitHubPublicationService({ runner });

    expect(
      await Effect.runPromise(
        service.reservePublishedReviewBranch({
          cwd: input.cwd,
          headBranch: branch,
          headSha: input.headSha,
          ownershipId: 'manager-1-agent-1',
        }),
      ),
    ).toBe('reserved');
  });

  test('rejects a hierarchy-descendant collision without pushing or overwriting', async () => {
    const branch = 'actor/pardes/readable-branch-ux';
    const fixture = scriptedRunner([result(`${input.headSha}\trefs/heads/${branch}/descendant\n`)]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    expect(
      await Effect.runPromise(
        service.reservePublishedReviewBranch({
          cwd: input.cwd,
          headBranch: branch,
          headSha: input.headSha,
          ownershipId: 'manager-1-agent-1',
        }),
      ),
    ).toBe('collision');
    expect(fixture.invocations).toHaveLength(1);
  });

  test('classifies an actual bare-Git ownership-claim descendant as a bounded collision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-publication-claim-descendant-'));
    const origin = join(root, 'origin.git');
    const project = join(root, 'project');
    const git = (...args: string[]) => runGitFixture(project, ...args);
    try {
      runGitFixture(root, 'init', '--bare', '-b', 'main', origin);
      runGitFixture(root, 'init', '-b', 'main', project);
      git('config', 'user.email', 'pardes@example.test');
      git('config', 'user.name', 'Pardes Test');
      writeFileSync(join(project, 'README.md'), 'fixture\n');
      git('add', 'README.md');
      git('commit', '-m', 'fixture');
      git('remote', 'add', 'origin', origin);
      const headSha = git('rev-parse', 'HEAD');
      git('push', 'origin', `${headSha}:refs/heads/${HUMAN_CLAIM}/child`);
      const execRunner = makeExecFileGitHubCommandRunner();
      const runner: GitHubCommandRunnerShape = {
        run: (invocation) =>
          invocation.command === 'git' && invocation.args.join(' ') === 'remote get-url origin'
            ? Effect.succeed(result('git@github.com:acme/project.git\n'))
            : execRunner.run({
                ...invocation,
                args: invocation.args.map((arg) =>
                  arg === 'git@github.com:acme/project.git' ? 'origin' : arg,
                ),
              }),
      };
      const service = makeGitHubPublicationService({ runner });

      expect(
        await Effect.runPromise(
          service.reservePublishedReviewBranch({
            cwd: project,
            headBranch: 'actor/pardes/readable-branch-ux',
            headSha,
            ownershipId: 'manager-1-agent-1',
          }),
        ),
      ).toBe('collision');
      expect(git('ls-remote', '--heads', 'origin')).toContain(`refs/heads/${HUMAN_CLAIM}/child`);
      expect(git('ls-remote', '--heads', 'origin')).not.toContain(
        'refs/heads/actor/pardes/readable-branch-ux',
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('classifies an actor-root TOCTOU hierarchy conflict after failed atomic reservation', async () => {
    const branch = 'actor/pardes/readable-branch-ux';
    const outputs: Array<ProcessResult | 'race'> = [
      result('git@github.com:acme/project.git\n'),
      result(),
      'race',
      result(`${input.headSha}\trefs/heads/actor\n`),
    ];
    const invocations: Array<{
      readonly args: ReadonlyArray<string>;
      readonly command: string;
      readonly cwd: string;
    }> = [];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        invocations.push(invocation);
        const output = outputs.shift();
        return output === 'race'
          ? Effect.fail(
              new GitHubCommandError({
                args: invocation.args,
                cause: 'fixture actor-root race',
                command: invocation.command,
                cwd: invocation.cwd,
              }),
            )
          : Effect.succeed(output ?? result());
      },
    };
    const service = makeGitHubPublicationService({ runner });

    expect(
      await Effect.runPromise(
        service.reservePublishedReviewBranch({
          cwd: input.cwd,
          headBranch: branch,
          headSha: input.headSha,
          ownershipId: 'manager-1-agent-1',
        }),
      ),
    ).toBe('hierarchy_collision');
    expect(invocations).toHaveLength(4);
  });

  test('allows create-capable human publication only after mechanical remote reservation proof', async () => {
    const headBranch = 'actor/pardes/readable-branch-ux';
    const fixture = scriptedRunner([
      result(
        `${input.headSha}\trefs/heads/${headBranch}\n${input.headSha}\trefs/heads/${HUMAN_CLAIM}\n`,
      ),
      result(),
      result('[]'),
      result(),
      result(JSON.stringify(pullRequest({ headRefName: headBranch }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const published = await Effect.runPromise(
      service.publish({
        ...input,
        headBranch,
        humanHeadBranchReservation: { claimSha: input.headSha, ownershipId: 'manager-1-agent-1' },
      }),
    );

    expect(published).toMatchObject({ action: 'created', headBranch });
    expect(fixture.invocations[0]?.args).toEqual([
      'ls-remote',
      '--heads',
      'git@github.com:acme/project.git',
      `refs/heads/${headBranch}`,
      `refs/heads/${HUMAN_CLAIM}`,
    ]);
    expect(fixture.invocations[1]?.args).toEqual([
      'push',
      'git@github.com:acme/project.git',
      `${input.headSha}:refs/heads/${headBranch}`,
    ]);
  });

  test('rejects unrelated pre-existing human refs when their claimed ownership anchor is absent', async () => {
    const headBranch = 'actor/pardes/unrelated';
    const fixture = scriptedRunner([result(`${input.headSha}\trefs/heads/${headBranch}\n`)]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(
      service
        .publish({
          ...input,
          headBranch,
          humanHeadBranchReservation: { claimSha: input.headSha, ownershipId: 'manager-1-agent-1' },
        })
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('GitHubResponseError');
    if (failure._tag !== 'GitHubResponseError') throw failure;
    expect(failure.operation).toBe('verify human-owned published review branch reservation');
    expect(fixture.invocations).toHaveLength(1);
  });

  test('pushes exactly the audited SHA to the proved immutable remote target before creating a ready-for-review PR', async () => {
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result('https://github.com/acme/project/pull/42\n'),
      result(JSON.stringify(pullRequest())),
      result(),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const published = await Effect.runPromise(service.publish({ ...input, openInBrowser: true }));

    expect(published).toEqual({
      action: 'created',
      baseBranch: input.baseBranch,
      body: input.body,
      draft: false,
      headBranch: input.headBranch,
      number: 42,
      openedInBrowser: true,
      status: 'open',
      title: input.title,
      url: 'https://github.com/acme/project/pull/42',
    });
    expect(fixture.invocations[0]).toEqual({
      args: [
        'push',
        'git@github.com:acme/project.git',
        `${input.headSha}:refs/heads/${input.headBranch}`,
      ],
      command: 'git',
      cwd: input.cwd,
    });
    expect(fixture.invocations[0]?.args).not.toContain('--force');
    expect(
      fixture.invocations
        .filter(({ args, command }) => command === 'gh' && args[0] === 'pr')
        .every(({ args }) => args.at(-2) === '--repo' && args.at(-1) === 'acme/project'),
    ).toBe(true);
    expect(withoutBoundRepo(fixture.invocations[1])).toEqual({
      args: [
        'pr',
        'list',
        '--state',
        'open',
        '--head',
        input.headBranch,
        '--base',
        input.baseBranch,
        '--limit',
        '100',
        '--json',
        'number,headRefName,baseRefName',
      ],
      command: 'gh',
      cwd: input.cwd,
    });
    expect(withoutBoundRepo(fixture.invocations[2])).toEqual({
      args: [
        'pr',
        'create',
        '--title',
        input.title,
        '--body',
        input.body,
        '--base',
        input.baseBranch,
        '--head',
        input.headBranch,
      ],
      command: 'gh',
      cwd: input.cwd,
    });
    expect(withoutBoundRepoArgs(fixture.invocations[3]?.args ?? [])).toEqual([
      'pr',
      'view',
      input.headBranch,
      '--json',
      'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
    ]);
    expect(withoutBoundRepo(fixture.invocations.at(-1))).toEqual({
      args: ['pr', 'view', '42', '--web'],
      command: 'gh',
      cwd: input.cwd,
    });
  });

  test('retains completed CLI-only hosted spend conservatively without changing exact-SHA publication', async () => {
    const fallback = scriptedRunner([
      result(
        JSON.stringify({
          resources: {
            core: { limit: 5_000, remaining: 3_000, reset: 1_800_000_000 },
            graphql: { limit: 5_000, remaining: 4_000, reset: 1_800_000_000 },
          },
        }),
      ),
    ]);
    const hostedMetadata = makeGitHubHostedMetadataAdapter({
      nowMillis: Effect.succeed(1_700_000_000_000),
      runner: fallback.runner,
    });
    await Effect.runPromise(hostedMetadata.refreshFallback(input.cwd));
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result('https://github.com/acme/project/pull/42\n'),
      result(JSON.stringify(pullRequest())),
    ]);
    const service = makeGitHubPublicationService({ hostedMetadata, runner: fixture.runner });

    await Effect.runPromise(service.publish(input));
    const rateLimit = await Effect.runPromise(hostedMetadata.snapshot());

    expect(rateLimit.graphql).toMatchObject({ remaining: 3_985, source: 'local_estimate' });
    expect(rateLimit.rest).toMatchObject({ remaining: 3_000, source: 'rest_fallback' });
    expect(fixture.invocations[0]).toEqual({
      args: [
        'push',
        'git@github.com:acme/project.git',
        `${input.headSha}:refs/heads/${input.headBranch}`,
      ],
      command: 'git',
      cwd: input.cwd,
    });
    expect(fixture.invocations[0]?.args).not.toContain('--force');
  });

  test('keeps schema-v1 opaque reservations publishable without force-pushing', async () => {
    const opaqueHeadBranch = 'pardes/review/11111111-1111-4111-8111-111111111111';
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result(),
      result(JSON.stringify(pullRequest({ headRefName: opaqueHeadBranch }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const published = await Effect.runPromise(
      service.publish({ ...input, headBranch: opaqueHeadBranch }),
    );

    expect(published).toMatchObject({ action: 'created', headBranch: opaqueHeadBranch });
    expect(fixture.invocations[0]?.args).toEqual([
      'push',
      'git@github.com:acme/project.git',
      `${input.headSha}:refs/heads/${opaqueHeadBranch}`,
    ]);
    expect(fixture.invocations.flatMap(({ args }) => args)).not.toContain('--force');
  });

  test('keeps pre-flat nested readable reservations publishable for stable durable reuse', async () => {
    const nestedHeadBranch =
      'pardes/review/readable/publish-pr/bounded-slice-11111111-1111-4111-8111-111111111111';
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result(),
      result(JSON.stringify(pullRequest({ headRefName: nestedHeadBranch }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const published = await Effect.runPromise(
      service.publish({ ...input, headBranch: nestedHeadBranch }),
    );

    expect(published).toMatchObject({ action: 'created', headBranch: nestedHeadBranch });
    expect(fixture.invocations[0]?.args).toEqual([
      'push',
      'git@github.com:acme/project.git',
      `${input.headSha}:refs/heads/${nestedHeadBranch}`,
    ]);
    expect(fixture.invocations.flatMap(({ args }) => args)).not.toContain('--force');
  });

  test('rejects a published review gate whose final remote head OID diverges from the audited push', async () => {
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result(),
      result(JSON.stringify(pullRequest({ headRefOid: 'b'.repeat(40) }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubResponseError');
    if (failure._tag !== 'GitHubResponseError') throw failure;
    expect(failure.operation).toBe('verify published pull request head and base');
    expect(fixture.invocations).toHaveLength(4);
  });

  test('updates and reuses an existing open draft PR without duplicating or force-converting it', async () => {
    const existing = pullRequest({ body: 'Old body', isDraft: true, title: 'Old title' });
    const fixture = scriptedRunner([
      result(),
      result(JSON.stringify([existing])),
      result(),
      result(
        JSON.stringify(
          pullRequest({
            body: 'Untrusted external body',
            isDraft: true,
            title: 'Untrusted external title',
          }),
        ),
      ),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const published = await Effect.runPromise(service.publish(input));

    expect(published.action).toBe('updated');
    expect(published.draft).toBe(true);
    expect(published.title).toBe(input.title);
    expect(published.body).toBe(input.body);
    expect(published.openedInBrowser).toBe(false);
    expect(fixture.invocations.some(({ args }) => args[0] === 'pr' && args[1] === 'create')).toBe(
      false,
    );
    expect(withoutBoundRepo(fixture.invocations[2])).toEqual({
      args: [
        'pr',
        'edit',
        '42',
        '--title',
        input.title,
        '--body',
        input.body,
        '--base',
        input.baseBranch,
      ],
      command: 'gh',
      cwd: input.cwd,
    });
    expect(withoutBoundRepoArgs(fixture.invocations[1]?.args ?? [])).toEqual([
      'pr',
      'list',
      '--state',
      'open',
      '--head',
      input.headBranch,
      '--base',
      input.baseBranch,
      '--limit',
      '100',
      '--json',
      'number,headRefName,baseRefName',
    ]);
    expect(withoutBoundRepoArgs(fixture.invocations[3]?.args ?? [])).toEqual([
      'pr',
      'view',
      '42',
      '--json',
      'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
    ]);
  });

  test('accepts explicit existing-PR publication after its temporarily stale hosted head OID converges', async () => {
    const existing = pullRequest();
    const stale = result(JSON.stringify(pullRequest({ headRefOid: 'b'.repeat(40) })));
    const fixture = scriptedRunner([
      result(),
      result(JSON.stringify([existing])),
      result(),
      stale,
      result(JSON.stringify(pullRequest())),
    ]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const published = await Effect.runPromise(service.publish(input));

    expect(published.action).toBe('updated');
    expect(fixture.invocations).toHaveLength(5);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
    expect(
      fixture.invocations.filter(({ args }) => args[0] === 'pr' && args[1] === 'edit'),
    ).toHaveLength(1);
    expect(fixture.invocations.some(({ args }) => args[0] === 'pr' && args[1] === 'create')).toBe(
      false,
    );
  });

  test('fails explicit existing-PR publication after bounded hosted head OID convergence attempts', async () => {
    const existing = pullRequest();
    const divergent = result(JSON.stringify(pullRequest({ headRefOid: 'b'.repeat(40) })));
    const fixture = scriptedRunner([
      result(),
      result(JSON.stringify([existing])),
      result(),
      divergent,
      divergent,
      divergent,
    ]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubResponseError');
    if (failure._tag !== 'GitHubResponseError') throw failure;
    expect(failure.operation).toBe('verify published pull request head and base');
    expect(fixture.invocations).toHaveLength(6);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
    expect(
      fixture.invocations.filter(({ args }) => args[0] === 'pr' && args[1] === 'edit'),
    ).toHaveLength(1);
    expect(fixture.invocations.some(({ args }) => args[0] === 'pr' && args[1] === 'create')).toBe(
      false,
    );
  });

  test('rejects explicit existing-PR identity drift immediately without repeating publication effects', async () => {
    const existing = pullRequest();
    const fixture = scriptedRunner([
      result(),
      result(JSON.stringify([existing])),
      result(),
      result(
        JSON.stringify(pullRequest({ number: 43, url: 'https://github.com/acme/project/pull/43' })),
      ),
    ]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubResponseError');
    if (failure._tag !== 'GitHubResponseError') throw failure;
    expect(failure.operation).toBe('verify published pull request head and base');
    expect(fixture.invocations).toHaveLength(4);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
    expect(
      fixture.invocations.filter(({ args }) => args[0] === 'pr' && args[1] === 'edit'),
    ).toHaveLength(1);
    expect(fixture.invocations.some(({ args }) => args[0] === 'pr' && args[1] === 'create')).toBe(
      false,
    );
  });

  test('rejects malformed explicit existing-PR publication metadata immediately without repeating effects', async () => {
    const existing = pullRequest();
    const fixture = scriptedRunner([
      result(),
      result(JSON.stringify([existing])),
      result(),
      result('{'),
    ]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubResponseError');
    expect(fixture.invocations).toHaveLength(4);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
    expect(
      fixture.invocations.filter(({ args }) => args[0] === 'pr' && args[1] === 'edit'),
    ).toHaveLength(1);
  });

  test('does not retry an explicit existing-PR command failure after hosted-OID lag', async () => {
    const existing = pullRequest();
    const fixture = scriptedRunner([
      result(),
      result(JSON.stringify([existing])),
      result(),
      result(JSON.stringify(pullRequest({ headRefOid: 'b'.repeat(40) }))),
    ]);
    let invocationCount = 0;
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: {
        run: (invocation) => {
          invocationCount += 1;
          return invocationCount === 5
            ? Effect.fail(
                new GitHubCommandError({
                  ...invocation,
                  cause: 'fixture publication verification outage',
                }),
              )
            : fixture.runner.run(invocation);
        },
      },
    });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubCommandError');
    expect(invocationCount).toBe(5);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
    expect(
      fixture.invocations.filter(({ args }) => args[0] === 'pr' && args[1] === 'edit'),
    ).toHaveLength(1);
  });

  test('rejects malformed gh JSON through a typed response error', async () => {
    const fixture = scriptedRunner([result(), result('[{"number":"not-a-number"}]')]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubResponseError');
    expect(fixture.invocations).toHaveLength(2);
  });

  test('rejects unsafe branch, non-immutable SHA, and accidental local managed-head publication before invoking a child process', async () => {
    const fixture = scriptedRunner([]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const branchFailure = await Effect.runPromise(
      service.publish({ ...input, baseBranch: '--malicious-option' }).pipe(Effect.flip),
    );
    const shaFailure = await Effect.runPromise(
      service.publish({ ...input, headSha: 'HEAD' }).pipe(Effect.flip),
    );
    const localHeadFailure = await Effect.runPromise(
      service.publish({ ...input, headBranch: 'pardes/manager-1/agent-1' }).pipe(Effect.flip),
    );

    expect(branchFailure._tag).toBe('GitHubPublicationInputError');
    expect(shaFailure._tag).toBe('GitHubPublicationInputError');
    expect(localHeadFailure._tag).toBe('GitHubPublicationInputError');
    expect(fixture.invocations).toEqual([]);

    const unreserved = scriptedRunner([result()]);
    const readableLocalHeadFailure = await Effect.runPromise(
      makeGitHubPublicationService({ runner: unreserved.runner })
        .publish({ ...input, headBranch: 'local-dev/pardes/readable-workstream' })
        .pipe(Effect.flip),
    );
    expect(readableLocalHeadFailure._tag).toBe('GitHubPublicationInputError');
    expect(unreserved.invocations).toHaveLength(0);
  });

  test('rejects invalid Git ref forms in pre-hardening branch compatibility before invoking a child process', async () => {
    const fixture = scriptedRunner([]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    for (const headBranch of [
      'pardes/../agent-1',
      'pardes/manager-1/..',
      'pardes/manager.lock/agent-1',
      'pardes/manager-1/agent.lock',
      'pardes/.manager/agent-1',
      'pardes/manager-1/.agent',
      'pardes/manager-1/agent.',
      'pardes/manager..one/agent-1',
      'pardes/manager-1/agent..one',
    ]) {
      const failure = await Effect.runPromise(
        service
          .publish({ ...input, headBranch, legacyExistingPullRequestNumber: 42 })
          .pipe(Effect.flip),
      );
      expect(failure._tag).toBe('GitHubPublicationInputError');
    }

    expect(fixture.invocations).toEqual([]);
  });

  test('rejects a non-github.com repository origin before push or hosted publication requests', async () => {
    const invocations: ProcessInvocation[] = [];
    const runner: GitHubCommandRunnerShape = {
      run: (invocation) => {
        invocations.push(invocation);
        return Effect.succeed(result('git@github.enterprise.test:acme/project.git\n'));
      },
    };
    const service = makeGitHubPublicationService({ runner });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'enforce fixed github.com route for repository origin',
    });
    expect(invocations).toEqual([
      { args: ['remote', 'get-url', 'origin'], command: 'git', cwd: input.cwd },
    ]);
  });

  test('updates an exactly matching open pre-hardening review gate only after remote proof and without creating or force-pushing', async () => {
    const legacyHeadBranch = 'pardes/manager-1/agent-1';
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest({ headRefName: legacyHeadBranch }))),
      result(),
      result(),
      result(JSON.stringify(pullRequest({ headRefName: legacyHeadBranch }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const published = await Effect.runPromise(
      service.publish({
        ...input,
        headBranch: legacyHeadBranch,
        legacyExistingPullRequestNumber: 42,
      }),
    );

    expect(published).toMatchObject({ action: 'updated', headBranch: legacyHeadBranch });
    expect(withoutBoundRepos(fixture.invocations)).toEqual([
      {
        args: [
          'pr',
          'view',
          '42',
          '--json',
          'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
        ],
        command: 'gh',
        cwd: input.cwd,
      },
      {
        args: [
          'push',
          'git@github.com:acme/project.git',
          `${input.headSha}:refs/heads/${legacyHeadBranch}`,
        ],
        command: 'git',
        cwd: input.cwd,
      },
      {
        args: [
          'pr',
          'edit',
          '42',
          '--title',
          input.title,
          '--body',
          input.body,
          '--base',
          input.baseBranch,
        ],
        command: 'gh',
        cwd: input.cwd,
      },
      {
        args: [
          'pr',
          'view',
          '42',
          '--json',
          'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
        ],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
    expect(fixture.invocations.flatMap(({ args }) => args)).not.toContain('--force');
    expect(fixture.invocations.some(({ args }) => args[0] === 'pr' && args[1] === 'create')).toBe(
      false,
    );
  });

  test('rejects a non-matching pre-hardening review gate before any push or create', async () => {
    const legacyHeadBranch = 'pardes/manager-1/agent-1';
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest({ headRefName: 'pardes/manager-1/agent-other' }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(
      service
        .publish({
          ...input,
          headBranch: legacyHeadBranch,
          legacyExistingPullRequestNumber: 42,
        })
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('GitHubResponseError');
    expect(withoutBoundRepos(fixture.invocations)).toEqual([
      {
        args: [
          'pr',
          'view',
          '42',
          '--json',
          'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
        ],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
  });

  test('rejects a pre-hardening review gate base mismatch before any push or edit', async () => {
    const legacyHeadBranch = 'pardes/manager-1/agent-1';
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest({ baseRefName: 'main', headRefName: legacyHeadBranch }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(
      service
        .publish({
          ...input,
          baseBranch: 'release',
          headBranch: legacyHeadBranch,
          legacyExistingPullRequestNumber: 42,
        })
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('GitHubResponseError');
    expect(withoutBoundRepos(fixture.invocations)).toEqual([
      {
        args: [
          'pr',
          'view',
          '42',
          '--json',
          'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
        ],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
  });

  test('syncs an existing managed review gate by viewing its persisted number and non-force pushing exactly the audited SHA', async () => {
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest())),
      result(),
      result(JSON.stringify(pullRequest())),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const synced = await Effect.runPromise(
      service.syncExisting({
        cwd: input.cwd,
        headBranch: input.headBranch,
        headSha: input.headSha,
        pullRequestNumber: 42,
      }),
    );

    expect(synced).toEqual({ status: 'synced' });
    expect(withoutBoundRepos(fixture.invocations)).toEqual([
      {
        args: ['pr', 'view', '42', '--json', 'number,state,headRefName'],
        command: 'gh',
        cwd: input.cwd,
      },
      {
        args: [
          'push',
          'git@github.com:acme/project.git',
          `${input.headSha}:refs/heads/${input.headBranch}`,
        ],
        command: 'git',
        cwd: input.cwd,
      },
      {
        args: ['pr', 'view', '42', '--json', 'number,headRefName,headRefOid'],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
    expect(fixture.invocations.flatMap(({ args }) => args)).not.toContain('--force');
  });

  test('accepts an existing review gate only after its temporarily stale hosted head OID converges to the audited push', async () => {
    const previousHeadSha = 'b'.repeat(40);
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest({ headRefOid: previousHeadSha }))),
      result(),
      result(JSON.stringify(pullRequest({ headRefOid: previousHeadSha }))),
      result(JSON.stringify(pullRequest())),
    ]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const synced = await Effect.runPromise(
      service.syncExisting({
        cwd: input.cwd,
        headBranch: input.headBranch,
        headSha: input.headSha,
        pullRequestNumber: 42,
      }),
    );

    expect(synced).toEqual({ status: 'synced' });
    expect(fixture.invocations).toHaveLength(4);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toEqual([
      {
        args: [
          'push',
          'git@github.com:acme/project.git',
          `${input.headSha}:refs/heads/${input.headBranch}`,
        ],
        command: 'git',
        cwd: input.cwd,
      },
    ]);
    expect(fixture.invocations.flatMap(({ args }) => args)).not.toContain('--force');
  });

  test('fails closed after bounded hosted head OID convergence attempts when an existing review gate truly diverges', async () => {
    const divergent = result(JSON.stringify(pullRequest({ headRefOid: 'b'.repeat(40) })));
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest())),
      result(),
      divergent,
      divergent,
      divergent,
    ]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const failure = await Effect.runPromise(
      service
        .syncExisting({
          cwd: input.cwd,
          headBranch: input.headBranch,
          headSha: input.headSha,
          pullRequestNumber: 42,
        })
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('GitHubResponseError');
    if (failure._tag !== 'GitHubResponseError') throw failure;
    expect(failure.operation).toBe('verify pushed pull request head');
    expect(fixture.invocations).toHaveLength(5);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
    expect(fixture.invocations.flatMap(({ args }) => args)).not.toContain('--force');
  });

  test('does not retry a decoded pushed-head identity mismatch as temporary hosted metadata lag', async () => {
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest())),
      result(),
      result(JSON.stringify(pullRequest({ number: 43 }))),
    ]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const failure = await Effect.runPromise(
      service
        .syncExisting({
          cwd: input.cwd,
          headBranch: input.headBranch,
          headSha: input.headSha,
          pullRequestNumber: 42,
        })
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('GitHubResponseError');
    expect(fixture.invocations).toHaveLength(3);
  });

  test('rejects invalid pushed-head convergence overrides during service construction', () => {
    for (const options of [
      { pushedHeadVerificationDelayMillis: Number.POSITIVE_INFINITY },
      { pushedHeadVerificationDelayMillis: -1 },
      { pushedHeadVerificationDelayMillis: 251 },
      { pushedHeadVerificationRetries: Number.POSITIVE_INFINITY },
      { pushedHeadVerificationRetries: -1 },
      { pushedHeadVerificationRetries: 1.5 },
      { pushedHeadVerificationRetries: 5 },
    ]) {
      expect(() => makeGitHubPublicationService(options)).toThrow(RangeError);
    }
  });

  test('does not retry malformed post-push metadata or repeat the exact push', async () => {
    const fixture = scriptedRunner([result(JSON.stringify(pullRequest())), result(), result('{')]);
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: fixture.runner,
    });

    const failure = await Effect.runPromise(
      service
        .syncExisting({
          cwd: input.cwd,
          headBranch: input.headBranch,
          headSha: input.headSha,
          pullRequestNumber: 42,
        })
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('GitHubResponseError');
    expect(fixture.invocations).toHaveLength(3);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
  });

  test('does not retry a command failure after one hosted-OID lag observation or repeat the exact push', async () => {
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest())),
      result(),
      result(JSON.stringify(pullRequest({ headRefOid: 'b'.repeat(40) }))),
    ]);
    let invocationCount = 0;
    const service = makeGitHubPublicationService({
      pushedHeadVerificationDelayMillis: 0,
      pushedHeadVerificationRetries: 2,
      runner: {
        run: (invocation) => {
          invocationCount += 1;
          return invocationCount === 4
            ? Effect.fail(
                new GitHubCommandError({
                  ...invocation,
                  cause: 'fixture hosted verification outage',
                }),
              )
            : fixture.runner.run(invocation);
        },
      },
    });

    const failure = await Effect.runPromise(
      service
        .syncExisting({
          cwd: input.cwd,
          headBranch: input.headBranch,
          headSha: input.headSha,
          pullRequestNumber: 42,
        })
        .pipe(Effect.flip),
    );

    expect(failure._tag).toBe('GitHubCommandError');
    expect(invocationCount).toBe(4);
    expect(fixture.invocations.filter(({ command }) => command === 'git')).toHaveLength(1);
  });

  test('keeps existing local-shaped published review branches syncable without allowing accidental new publication', async () => {
    const legacyHeadBranch = 'pardes/manager-1/agent-1';
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest({ headRefName: legacyHeadBranch }))),
      result(),
      result(JSON.stringify(pullRequest({ headRefName: legacyHeadBranch }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const synced = await Effect.runPromise(
      service.syncExisting({
        cwd: input.cwd,
        headBranch: legacyHeadBranch,
        headSha: input.headSha,
        pullRequestNumber: 42,
      }),
    );

    expect(synced).toEqual({ status: 'synced' });
    expect(withoutBoundRepos(fixture.invocations)).toEqual([
      {
        args: ['pr', 'view', '42', '--json', 'number,state,headRefName'],
        command: 'gh',
        cwd: input.cwd,
      },
      {
        args: [
          'push',
          'git@github.com:acme/project.git',
          `${input.headSha}:refs/heads/${legacyHeadBranch}`,
        ],
        command: 'git',
        cwd: input.cwd,
      },
      {
        args: ['pr', 'view', '42', '--json', 'number,headRefName,headRefOid'],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
  });

  test('treats a newly terminal existing review gate as benign and never pushes it', async () => {
    const fixture = scriptedRunner([result(JSON.stringify(pullRequest({ state: 'MERGED' })))]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const synced = await Effect.runPromise(
      service.syncExisting({
        cwd: input.cwd,
        headBranch: input.headBranch,
        headSha: input.headSha,
        pullRequestNumber: 42,
      }),
    );

    expect(synced).toEqual({ pullRequestStatus: 'merged', status: 'terminal' });
    expect(withoutBoundRepos(fixture.invocations)).toEqual([
      {
        args: ['pr', 'view', '42', '--json', 'number,state,headRefName'],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
  });

  test('rejects malformed existing-sync input and an open PR with a different head without pushing', async () => {
    const empty = scriptedRunner([]);
    const service = makeGitHubPublicationService({ runner: empty.runner });

    const invalid = await Effect.runPromise(
      service
        .syncExisting({
          cwd: input.cwd,
          headBranch: 'feature/not-managed',
          headSha: 'HEAD',
          pullRequestNumber: 0,
        })
        .pipe(Effect.flip),
    );

    expect(invalid._tag).toBe('GitHubSyncInputError');
    expect(empty.invocations).toEqual([]);

    const mismatch = scriptedRunner([
      result(JSON.stringify(pullRequest({ headRefName: 'pardes/manager-1/agent-other' }))),
    ]);
    const mismatchService = makeGitHubPublicationService({ runner: mismatch.runner });
    const mismatchFailure = await Effect.runPromise(
      mismatchService
        .syncExisting({
          cwd: input.cwd,
          headBranch: input.headBranch,
          headSha: input.headSha,
          pullRequestNumber: 42,
        })
        .pipe(Effect.flip),
    );

    expect(mismatchFailure._tag).toBe('GitHubResponseError');
    expect(withoutBoundRepos(mismatch.invocations)).toEqual([
      {
        args: ['pr', 'view', '42', '--json', 'number,state,headRefName'],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
  });

  test('rejects a same-host cross-repository final publication URL', async () => {
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result(),
      result(JSON.stringify(pullRequest({ url: 'https://github.com/other/project/pull/42' }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'enforce fixed github.com route for association URL',
    });
  });

  test('rejects a same-repository final publication URL whose path number disagrees with metadata', async () => {
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result(),
      result(JSON.stringify(pullRequest({ url: 'https://github.com/acme/project/pull/43' }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure).toMatchObject({
      _tag: 'GitHubResponseError',
      operation: 'view pull request',
    });
  });

  test('rejects oversized final publication URLs instead of projecting them', async () => {
    const oversizedUrl = `https://github.com/${'a'.repeat(2_048)}`;
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result(),
      result(JSON.stringify(pullRequest({ url: oversizedUrl }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

    const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

    expect(failure._tag).toBe('GitHubResponseError');
    if (failure._tag !== 'GitHubResponseError') throw failure;
    expect(failure.operation).toBe('view pull request');
    expect('url' in failure).toBe(false);
  });

  test('rejects option-like or newline payloads in final publication URLs instead of projecting them', async () => {
    for (const unsafeUrl of [
      '--repo=attacker/project',
      'https://github.com/acme/project/pull/42\n--repo=attacker/project',
    ]) {
      const fixture = scriptedRunner([
        result(),
        result('[]'),
        result(),
        result(JSON.stringify(pullRequest({ url: unsafeUrl }))),
      ]);
      const service = makeGitHubPublicationService({ runner: fixture.runner });

      const failure = await Effect.runPromise(service.publish(input).pipe(Effect.flip));

      expect(failure._tag).toBe('GitHubResponseError');
      if (failure._tag !== 'GitHubResponseError') throw failure;
      expect(failure.operation).toBe('view pull request');
      expect('url' in failure).toBe(false);
    }
  });

  test('keeps schema-v1 state with an opaque agent branch reservation decodable', async () => {
    const state = initialManagerState('manager-1', {
      currentCheckout: '/tmp/project',
      gitCommonDir: '/tmp/project/.git',
      key: 'repo-1',
      primaryCheckout: '/tmp/project',
    });
    const opaqueHeadBranch = 'pardes/review/11111111-1111-4111-8111-111111111111';
    const agent = {
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'agent-1',
      model: 'fixture-model',
      publishedReviewBranch: opaqueHeadBranch,
      role: 'worker' as const,
      sessionDir: '/tmp/session',
      status: 'idle' as const,
      task: 'Preserve the schema-v1 reservation.',
      thinkingLevel: 'high' as const,
      updatedAt: '2026-06-01T00:00:00.000Z',
      workstreamId: 'ws-1',
    };

    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(ManagerStateSchema)({
        ...state,
        agents: { [agent.id]: agent },
      }),
    );

    expect(decoded.agents[agent.id]?.publishedReviewBranch).toBe(opaqueHeadBranch);
  });

  test('keeps schema-v1 state with the original minimal PR record decodable', async () => {
    const state = initialManagerState('manager-1', {
      currentCheckout: '/tmp/project',
      gitCommonDir: '/tmp/project/.git',
      key: 'repo-1',
      primaryCheckout: '/tmp/project',
    });
    const legacyRecord = {
      agentId: 'agent-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      id: 'pr-legacy',
      status: 'open' as const,
      updatedAt: '2026-06-01T00:00:00.000Z',
      url: 'https://github.com/acme/project/pull/1',
      workstreamId: 'ws-1',
    };

    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(ManagerStateSchema)({
        ...state,
        pullRequests: { [legacyRecord.id]: legacyRecord },
      }),
    );

    expect(decoded.pullRequests[legacyRecord.id]).toEqual(legacyRecord);
  });
});
