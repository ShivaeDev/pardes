import { Effect, Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { initialManagerState, ManagerStateSchema } from '../manager/index.ts';
import { makeGitHubPublicationService } from './index.ts';
import { result, scriptedRunner } from './test-fixtures.ts';

function pullRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    baseRefName: 'main',
    body: 'Summary and validation.',
    headRefName: 'pardes/review/11111111-1111-4111-8111-111111111111',
    headRefOid: input.headSha,
    isDraft: false,
    number: 42,
    state: 'OPEN',
    title: 'Publish the bounded slice',
    url: 'https://github.test/acme/project/pull/42',
    ...overrides,
  };
}

const input = {
  baseBranch: 'main',
  body: 'Summary and validation.',
  cwd: '/tmp/managed-worker',
  headBranch: 'pardes/review/11111111-1111-4111-8111-111111111111',
  headSha: 'a'.repeat(40),
  title: 'Publish the bounded slice',
};

describe('GitHub publication boundary', () => {
  test('pushes exactly the audited SHA with an explicit branch refspec before creating a ready-for-review PR', async () => {
    const fixture = scriptedRunner([
      result(),
      result('[]'),
      result('https://github.test/acme/project/pull/42\n'),
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
      url: 'https://github.test/acme/project/pull/42',
    });
    expect(fixture.invocations[0]).toEqual({
      args: ['push', 'origin', `${input.headSha}:refs/heads/${input.headBranch}`],
      command: 'git',
      cwd: input.cwd,
    });
    expect(fixture.invocations[0]?.args).not.toContain('--force');
    expect(fixture.invocations[1]).toEqual({
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
    expect(fixture.invocations[2]).toEqual({
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
    expect(fixture.invocations[3]?.args).toEqual([
      'pr',
      'view',
      input.headBranch,
      '--json',
      'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
    ]);
    expect(fixture.invocations.at(-1)).toEqual({
      args: ['pr', 'view', '42', '--web'],
      command: 'gh',
      cwd: input.cwd,
    });
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
    expect(fixture.invocations[2]).toEqual({
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
    expect(fixture.invocations[1]?.args).toEqual([
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
    expect(fixture.invocations[3]?.args).toEqual([
      'pr',
      'view',
      '42',
      '--json',
      'number,url,state,isDraft,headRefName,headRefOid,baseRefName',
    ]);
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
    expect(fixture.invocations).toEqual([
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
        args: ['push', 'origin', `${input.headSha}:refs/heads/${legacyHeadBranch}`],
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
    expect(fixture.invocations).toEqual([
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
    expect(fixture.invocations).toEqual([
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

  test('syncs an existing opaque review gate by viewing its persisted number and non-force pushing exactly the audited SHA', async () => {
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
    expect(fixture.invocations).toEqual([
      {
        args: ['pr', 'view', '42', '--json', 'number,state,headRefName'],
        command: 'gh',
        cwd: input.cwd,
      },
      {
        args: ['push', 'origin', `${input.headSha}:refs/heads/${input.headBranch}`],
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

  test('rejects an existing review gate whose final remote head OID diverges after the audited push', async () => {
    const fixture = scriptedRunner([
      result(JSON.stringify(pullRequest())),
      result(),
      result(JSON.stringify(pullRequest({ headRefOid: 'b'.repeat(40) }))),
    ]);
    const service = makeGitHubPublicationService({ runner: fixture.runner });

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
    expect(fixture.invocations).toHaveLength(3);
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
    expect(fixture.invocations).toEqual([
      {
        args: ['pr', 'view', '42', '--json', 'number,state,headRefName'],
        command: 'gh',
        cwd: input.cwd,
      },
      {
        args: ['push', 'origin', `${input.headSha}:refs/heads/${legacyHeadBranch}`],
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
    expect(fixture.invocations).toEqual([
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
    expect(mismatch.invocations).toEqual([
      {
        args: ['pr', 'view', '42', '--json', 'number,state,headRefName'],
        command: 'gh',
        cwd: input.cwd,
      },
    ]);
  });

  test('rejects oversized final publication URLs instead of projecting them', async () => {
    const oversizedUrl = `https://github.test/${'a'.repeat(2_048)}`;
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
      'https://github.test/acme/project/pull/42\n--repo=attacker/project',
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
      url: 'https://github.test/acme/project/pull/1',
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
