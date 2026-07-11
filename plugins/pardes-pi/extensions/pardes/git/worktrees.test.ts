import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import {
  copyLocalGitRepositoryFixture,
  copyOriginGitRepositoryFixture,
  runGitFixture,
} from '../test-support.ts';
import { WorktreeError } from './errors.ts';
import { discoverRepository } from './repository.ts';
import type { WorktreeLease } from './schemas.ts';
import { runGit } from './transport.ts';
import {
  type CreateDetachedReviewCheckoutInput,
  type ManagedLeaseOwner,
  type ManagedWorktreeShape,
  makeManagedWorktreeService,
  managedWorktreeBranch,
} from './worktrees.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function git(cwd: string, ...args: string[]): string {
  return runGitFixture(cwd, ...args);
}

function executableOnPath(name: string): string {
  const executable = (process.env.PATH ?? '')
    .split(delimiter)
    .map((directory) => join(directory, name))
    .find(existsSync);
  if (!executable) throw new Error(`Could not resolve ${name} on PATH`);
  return realpathSync(executable);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const worktreeGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: Parameters<typeof runGit>[2],
) =>
  runGit(cwd, args, options).pipe(
    Effect.mapError(
      (cause) => new WorktreeError({ cause, operation: `git ${args.join(' ')}`, path: cwd }),
    ),
  );

function owner(
  repo: ManagedLeaseOwner['repo'],
  managerId: string,
  agentId: string,
): ManagedLeaseOwner {
  return { agentId, managerId, repo };
}

function inspectProvenance(
  service: ManagedWorktreeShape,
  owner: ManagedLeaseOwner,
  lease: WorktreeLease,
) {
  const inspect = service.inspectWithProvenance;
  if (!inspect) throw new Error('Expected opt-in Git provenance inspection');
  return inspect(owner, lease);
}

const provisionReview = Effect.fnUntraced(function* (
  service: ManagedWorktreeShape,
  input: CreateDetachedReviewCheckoutInput,
) {
  const lease = yield* service.prepareDetachedReviewCheckout(input);
  yield* service.provisionDetachedReviewCheckout(
    { managerId: input.managerId, repo: input.repo, verificationId: input.verificationId },
    lease,
  );
  return lease;
});

function fixtureRepository(): string {
  const { repo, root } = copyLocalGitRepositoryFixture('pardes-worktree-');
  temporaryDirectories.push(root);
  return realpathSync(repo);
}

describe('managed worktree service', () => {
  test('creates an isolated lease from an explicit SHA and removes only when clean', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-1', branchPointSha, managerId: 'manager-1', repo }),
    );

    expect(lease.path).toBe(
      join(primary, '.worktrees', 'pardes', 'manager-1', 'agent-1', 'agent-1'),
    );
    expect(git(lease.path, 'rev-parse', 'HEAD')).toBe(branchPointSha);
    expect(git(lease.path, 'branch', '--show-current')).toBe('pardes-test/pardes/agent-1');
    expect(git(primary, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(
      await Effect.runPromise(service.inspect(owner(repo, 'manager-1', 'agent-1'), lease)),
    ).toMatchObject({ changedPaths: [], dirty: false, headSha: branchPointSha, path: lease.path });

    const changed = join(lease.path, 'worker.txt');
    writeFileSync(changed, 'dirty\n');
    expect(
      await Effect.runPromise(service.inspect(owner(repo, 'manager-1', 'agent-1'), lease)),
    ).toMatchObject({
      changedPaths: ['worker.txt'],
      dirty: true,
      headSha: branchPointSha,
      path: lease.path,
    });
    const removal = await Effect.runPromise(
      service.removeIfClean(owner(repo, 'manager-1', 'agent-1'), lease).pipe(Effect.flip),
    );
    expect(removal._tag).toBe('DirtyWorktreeError');
    expect(existsSync(lease.path)).toBe(true);

    git(lease.path, 'add', 'worker.txt');
    git(lease.path, 'commit', '-m', 'worker fixture');
    const committedHeadSha = git(lease.path, 'rev-parse', 'HEAD');
    expect(
      await Effect.runPromise(service.inspect(owner(repo, 'manager-1', 'agent-1'), lease)),
    ).toMatchObject({
      changedPaths: ['worker.txt'],
      dirty: false,
      headSha: committedHeadSha,
      path: lease.path,
    });
    await Effect.runPromise(service.removeIfClean(owner(repo, 'manager-1', 'agent-1'), lease));
    expect(existsSync(lease.path)).toBe(false);
  });

  test('tracks an exact verified remote review branch with a different local name and is idempotent', async () => {
    const fixture = copyOriginGitRepositoryFixture('pardes-worktree-tracking-');
    temporaryDirectories.push(fixture.root);
    const primary = realpathSync(fixture.repo);
    const repo = await Effect.runPromise(discoverRepository(primary));
    const headSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const leaseOwner = owner(repo, 'manager-track', 'agent-track');
    const lease = await Effect.runPromise(
      service.create({
        agentId: leaseOwner.agentId,
        branchPointSha: headSha,
        managerId: leaseOwner.managerId,
        name: 'Local Worker Name',
        repo,
      }),
    );
    const remoteBranch = 'reviewer/pardes/hosted-review-name';
    git(primary, 'push', 'origin', `${headSha}:refs/heads/${remoteBranch}`);
    git(primary, 'update-ref', '-d', `refs/remotes/origin/${remoteBranch}`);
    const advertisedBefore = git(primary, 'ls-remote', '--heads', 'origin');

    const configured = await Effect.runPromise(
      service.trackPublishedReviewBranch(leaseOwner, lease, { headBranch: remoteBranch, headSha }),
    );
    const idempotent = await Effect.runPromise(
      service.trackPublishedReviewBranch(leaseOwner, lease, { headBranch: remoteBranch, headSha }),
    );

    expect(lease.branch).not.toBe(remoteBranch);
    expect(configured).toEqual({
      localBranch: lease.branch,
      remote: 'origin',
      remoteBranch,
      status: 'configured',
    });
    expect(idempotent).toEqual({ ...configured, status: 'already_configured' });
    expect(git(lease.path, 'rev-parse', '--verify', '@{upstream}^{commit}')).toBe(headSha);
    expect(git(lease.path, 'config', '--get', `branch.${lease.branch}.remote`)).toBe('origin');
    expect(git(lease.path, 'config', '--get', `branch.${lease.branch}.merge`)).toBe(
      `refs/heads/${remoteBranch}`,
    );
    expect(git(primary, 'ls-remote', '--heads', 'origin')).toBe(advertisedBefore);
  });

  test('replaces mismatched upstream config and materializes an already configured missing tracking ref', async () => {
    const fixture = copyOriginGitRepositoryFixture('pardes-worktree-retracking-');
    temporaryDirectories.push(fixture.root);
    const primary = realpathSync(fixture.repo);
    const repo = await Effect.runPromise(discoverRepository(primary));
    const headSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const leaseOwner = owner(repo, 'manager-retrack', 'agent-retrack');
    const lease = await Effect.runPromise(
      service.create({
        agentId: leaseOwner.agentId,
        branchPointSha: headSha,
        managerId: leaseOwner.managerId,
        name: 'Retrack Worker',
        repo,
      }),
    );
    const remoteBranch = 'reviewer/pardes/retracked-review';
    git(primary, 'push', 'origin', `${headSha}:refs/heads/${remoteBranch}`);
    git(lease.path, 'branch', '--set-upstream-to=origin/main', '--', lease.branch);

    const replaced = await Effect.runPromise(
      service.trackPublishedReviewBranch(leaseOwner, lease, { headBranch: remoteBranch, headSha }),
    );
    expect(replaced.status).toBe('configured');
    expect(git(lease.path, 'config', '--get', `branch.${lease.branch}.merge`)).toBe(
      `refs/heads/${remoteBranch}`,
    );

    git(primary, 'update-ref', '-d', `refs/remotes/origin/${remoteBranch}`);
    const retainedConfig = await Effect.runPromise(
      service.trackPublishedReviewBranch(leaseOwner, lease, { headBranch: remoteBranch, headSha }),
    );
    expect(retainedConfig.status).toBe('already_configured');
    expect(
      git(lease.path, 'rev-parse', '--verify', `refs/remotes/origin/${remoteBranch}^{commit}`),
    ).toBe(headSha);
  });

  test('rejects invalid tracking inputs and executes only local Git commands', async () => {
    const fixture = copyOriginGitRepositoryFixture('pardes-worktree-tracking-input-');
    temporaryDirectories.push(fixture.root);
    const primary = realpathSync(fixture.repo);
    const repo = await Effect.runPromise(discoverRepository(primary));
    const headSha = git(primary, 'rev-parse', 'HEAD');
    const leaseOwner = owner(repo, 'manager-input', 'agent-input');
    const commands: ReadonlyArray<string>[] = [];
    const service = makeManagedWorktreeService({
      publishedReviewBranchGit: (cwd, args, options) => {
        commands.push(args);
        return worktreeGit(cwd, args, options);
      },
    });
    const lease = await Effect.runPromise(
      service.create({
        agentId: leaseOwner.agentId,
        branchPointSha: headSha,
        managerId: leaseOwner.managerId,
        name: 'Tracking Input',
        repo,
      }),
    );

    const invalidSha = await Effect.runPromise(
      service
        .trackPublishedReviewBranch(leaseOwner, lease, {
          headBranch: 'reviewer/pardes/valid',
          headSha: 'HEAD',
        })
        .pipe(Effect.flip),
    );
    expect(invalidSha).toMatchObject({ _tag: 'InvalidWorktreeInputError', field: 'headSha' });
    expect(commands).toEqual([]);

    const invalidBranch = await Effect.runPromise(
      service
        .trackPublishedReviewBranch(leaseOwner, lease, {
          headBranch: 'reviewer/pardes/../invalid',
          headSha,
        })
        .pipe(Effect.flip),
    );
    expect(invalidBranch._tag).toBe('WorktreeError');

    const missingObject = await Effect.runPromise(
      service
        .trackPublishedReviewBranch(leaseOwner, lease, {
          headBranch: 'reviewer/pardes/missing-object',
          headSha: 'f'.repeat(40),
        })
        .pipe(Effect.flip),
    );
    expect(missingObject._tag).toBe('WorktreeError');

    const remoteBranch = 'reviewer/pardes/local-commands-only';
    await Effect.runPromise(
      service.trackPublishedReviewBranch(leaseOwner, lease, { headBranch: remoteBranch, headSha }),
    );
    expect(
      commands.some(([command]) => ['fetch', 'ls-remote', 'push'].includes(command ?? '')),
    ).toBe(false);
    expect(commands.flat()).not.toContain('--force');
  });

  test('fails a contended tracking-ref CAS and converges on retry without overwriting the competitor', async () => {
    const fixture = copyOriginGitRepositoryFixture('pardes-worktree-tracking-cas-');
    temporaryDirectories.push(fixture.root);
    const primary = realpathSync(fixture.repo);
    const repo = await Effect.runPromise(discoverRepository(primary));
    const baselineSha = git(primary, 'rev-parse', 'HEAD');
    const leaseOwner = owner(repo, 'manager-cas', 'agent-cas');
    const baseService = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      baseService.create({
        agentId: leaseOwner.agentId,
        branchPointSha: baselineSha,
        managerId: leaseOwner.managerId,
        name: 'Tracking CAS',
        repo,
      }),
    );
    writeFileSync(join(lease.path, 'expected.txt'), 'expected review head\n');
    git(lease.path, 'add', 'expected.txt');
    git(lease.path, 'commit', '-m', 'expected review head');
    const expectedSha = git(lease.path, 'rev-parse', 'HEAD');
    writeFileSync(join(primary, 'competitor.txt'), 'competing local ref head\n');
    git(primary, 'add', 'competitor.txt');
    git(primary, 'commit', '-m', 'competing local ref head');
    const competingSha = git(primary, 'rev-parse', 'HEAD');
    const remoteBranch = 'reviewer/pardes/cas-review';
    const remoteRef = `refs/remotes/origin/${remoteBranch}`;
    git(primary, 'update-ref', remoteRef, baselineSha);
    let raced = false;
    let updateArgs: ReadonlyArray<string> | undefined;
    const racingService = makeManagedWorktreeService({
      publishedReviewBranchGit: (cwd, args, options) => {
        if (args[0] !== 'update-ref' || raced) return worktreeGit(cwd, args, options);
        raced = true;
        updateArgs = args;
        return Effect.sync(() => git(cwd, 'update-ref', remoteRef, competingSha, baselineSha)).pipe(
          Effect.flatMap(() => worktreeGit(cwd, args, options)),
        );
      },
    });

    const contention = await Effect.runPromise(
      racingService
        .trackPublishedReviewBranch(leaseOwner, lease, {
          headBranch: remoteBranch,
          headSha: expectedSha,
        })
        .pipe(Effect.flip),
    );

    expect(contention._tag).toBe('WorktreeError');
    expect(updateArgs).toEqual(['update-ref', '--no-deref', remoteRef, expectedSha, baselineSha]);
    expect(git(lease.path, 'rev-parse', '--verify', `${remoteRef}^{commit}`)).toBe(competingSha);
    expect(
      git(
        lease.path,
        'for-each-ref',
        '--format=%(upstream:remoteref)',
        `refs/heads/${lease.branch}`,
      ),
    ).toBe('');
    const converged = await Effect.runPromise(
      baseService.trackPublishedReviewBranch(leaseOwner, lease, {
        headBranch: remoteBranch,
        headSha: expectedSha,
      }),
    );
    expect(converged.status).toBe('configured');
    expect(git(lease.path, 'rev-parse', '--verify', `${remoteRef}^{commit}`)).toBe(expectedSha);
  });

  test('reports a partial local config failure after ref materialization and converges on retry', async () => {
    const fixture = copyOriginGitRepositoryFixture('pardes-worktree-tracking-partial-');
    temporaryDirectories.push(fixture.root);
    const primary = realpathSync(fixture.repo);
    const repo = await Effect.runPromise(discoverRepository(primary));
    const headSha = git(primary, 'rev-parse', 'HEAD');
    const leaseOwner = owner(repo, 'manager-partial', 'agent-partial');
    const remoteBranch = 'reviewer/pardes/partial-review';
    const remoteRef = `refs/remotes/origin/${remoteBranch}`;
    git(primary, 'push', 'origin', `${headSha}:refs/heads/${remoteBranch}`);
    git(primary, 'update-ref', '-d', remoteRef);
    const advertisedBefore = git(primary, 'ls-remote', '--heads', 'origin');
    const failingService = makeManagedWorktreeService({
      publishedReviewBranchGit: (cwd, args, options) =>
        args[0] === 'branch'
          ? Effect.fail(
              new WorktreeError({
                cause: 'fixture config failure',
                operation: 'git branch --set-upstream-to',
                path: cwd,
              }),
            )
          : worktreeGit(cwd, args, options),
    });
    const lease = await Effect.runPromise(
      failingService.create({
        agentId: leaseOwner.agentId,
        branchPointSha: headSha,
        managerId: leaseOwner.managerId,
        name: 'Tracking Partial',
        repo,
      }),
    );

    const partial = await Effect.runPromise(
      failingService
        .trackPublishedReviewBranch(leaseOwner, lease, { headBranch: remoteBranch, headSha })
        .pipe(Effect.flip),
    );

    expect(partial._tag).toBe('WorktreeError');
    expect(git(lease.path, 'rev-parse', '--verify', `${remoteRef}^{commit}`)).toBe(headSha);
    expect(
      git(
        lease.path,
        'for-each-ref',
        '--format=%(upstream:remoteref)',
        `refs/heads/${lease.branch}`,
      ),
    ).toBe('');
    expect(git(primary, 'ls-remote', '--heads', 'origin')).toBe(advertisedBefore);
    const retried = await Effect.runPromise(
      makeManagedWorktreeService().trackPublishedReviewBranch(leaseOwner, lease, {
        headBranch: remoteBranch,
        headSha,
      }),
    );
    expect(retried.status).toBe('configured');
    expect(git(lease.path, 'rev-parse', '--verify', '@{upstream}^{commit}')).toBe(headSha);
  });

  test('uses readable workstream names locally and adds a short ID only for an actual collision', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const first = await Effect.runPromise(
      service.create({
        agentId: 'agent-11111111',
        branchPointSha,
        managerId: 'manager-one',
        name: 'Résumé Release',
        repo,
      }),
    );
    const second = await Effect.runPromise(
      service.create({
        agentId: 'agent-22222222',
        branchPointSha,
        managerId: 'manager-two',
        name: 'Résumé Release',
        repo,
      }),
    );

    expect(first.branch).toBe('pardes-test/pardes/resume-release');
    expect(first.path).toBe(
      join(primary, '.worktrees', 'pardes', 'manager-one', 'agent-11111111', 'resume-release'),
    );
    expect(second.branch).toBe('pardes-test/pardes/resume-release-22222222');
    expect(second.path).toBe(
      join(
        primary,
        '.worktrees',
        'pardes',
        'manager-two',
        'agent-22222222',
        'resume-release-22222222',
      ),
    );
  });

  test('uses a flat local fallback only when an existing namespace-root leaf blocks the readable hierarchy', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    git(primary, 'branch', 'pardes-test');
    const service = makeManagedWorktreeService();

    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-root-blocked',
        branchPointSha,
        managerId: 'manager-root-blocked',
        name: 'Readable Worktree',
        repo,
      }),
    );

    expect(lease.branch).toBe('pardes-test-pardes-readable-worktree');
    expect(lease.path).toBe(
      join(
        primary,
        '.worktrees',
        'pardes',
        'manager-root-blocked',
        'agent-root-blocked',
        'readable-worktree',
      ),
    );
  });

  test('adds a short local disambiguator when a readable candidate has descendants', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    git(primary, 'branch', 'pardes-test/pardes/readable-worktree/descendant');
    const service = makeManagedWorktreeService();

    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-12345678',
        branchPointSha,
        managerId: 'manager-descendant',
        name: 'Readable Worktree',
        repo,
      }),
    );

    expect(lease.branch).toBe('pardes-test/pardes/readable-worktree-12345678');
  });

  test('returns an immutable audited head snapshot when later commits advance the worker branch', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-snapshot', branchPointSha, managerId: 'manager-1', repo }),
    );
    writeFileSync(join(lease.path, 'first.txt'), 'first audited commit\n');
    git(lease.path, 'add', 'first.txt');
    git(lease.path, 'commit', '-m', 'first audited fixture');

    const firstInspection = await Effect.runPromise(
      service.inspect(owner(repo, 'manager-1', 'agent-snapshot'), lease),
    );
    expect(firstInspection).toMatchObject({
      changedPaths: ['first.txt'],
      dirty: false,
      headSha: git(lease.path, 'rev-parse', 'HEAD'),
      path: lease.path,
    });

    writeFileSync(join(lease.path, 'second.txt'), 'later commit\n');
    git(lease.path, 'add', 'second.txt');
    git(lease.path, 'commit', '-m', 'later fixture');
    const secondInspection = await Effect.runPromise(
      service.inspect(owner(repo, 'manager-1', 'agent-snapshot'), lease),
    );

    expect(secondInspection.headSha).not.toBe(firstInspection.headSha);
    expect(firstInspection.changedPaths).toEqual(['first.txt']);
    expect(secondInspection.changedPaths).toEqual(['first.txt', 'second.txt']);
  });

  test('distinguishes cooperative first-parent candidates from additive merge context', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-provenance', branchPointSha, managerId: 'manager-1', repo }),
    );
    writeFileSync(join(lease.path, 'worker.txt'), 'worker authored\n');
    git(lease.path, 'add', 'worker.txt');
    git(lease.path, 'commit', '-m', 'worker-authored fixture');
    const workerAuthoredSha = git(lease.path, 'rev-parse', 'HEAD');

    writeFileSync(join(primary, 'main.txt'), 'additive main change\n');
    git(primary, 'add', 'main.txt');
    git(primary, 'commit', '-m', 'main integration fixture');
    git(lease.path, 'merge', '--no-edit', 'main');
    const integratedHeadSha = git(lease.path, 'rev-parse', 'HEAD');
    const inspection = await Effect.runPromise(
      inspectProvenance(service, owner(repo, 'manager-1', 'agent-provenance'), lease),
    );

    expect(workerAuthoredSha).not.toBe(integratedHeadSha);
    expect(inspection).toMatchObject({
      changedPaths: ['main.txt', 'worker.txt'],
      dirty: false,
      headSha: integratedHeadSha,
      provenance: {
        attribution: 'cooperative_first_parent',
        branchPointSha,
        firstParentNonMergeCommitCount: 1,
        firstParentNonMergePaths: ['worker.txt'],
        headSha: integratedHeadSha,
        latestDelta: {
          changedPaths: ['main.txt'],
          commitSha: integratedHeadSha,
          kind: 'merge_commit',
        },
        mergeCommitCount: 1,
        mergePaths: ['main.txt'],
        status: 'available',
        totalBranchCommitCount: 2,
        totalBranchDeltaPaths: ['main.txt', 'worker.txt'],
      },
    });
  });

  test('refuses stable provenance for dirty worktrees while retaining total safety-audit paths', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-dirty', branchPointSha, managerId: 'manager-1', repo }),
    );
    writeFileSync(join(lease.path, 'worker.txt'), 'committed worker change\n');
    git(lease.path, 'add', 'worker.txt');
    git(lease.path, 'commit', '-m', 'worker fixture');
    writeFileSync(join(lease.path, 'dirty.txt'), 'live dirty change\n');

    const inspection = await Effect.runPromise(
      inspectProvenance(service, owner(repo, 'manager-1', 'agent-dirty'), lease),
    );

    expect(inspection).toMatchObject({
      changedPaths: ['dirty.txt', 'worker.txt'],
      dirty: true,
      provenance: { dirtyPaths: ['dirty.txt'], reason: 'dirty_worktree', status: 'unavailable' },
    });
  });

  test('degrades over-bound dirty provenance without dropping the routine safety-audit path set', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService({ provenanceMaxPaths: 1 });
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-dirty-path-bound',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    writeFileSync(join(lease.path, 'committed.txt'), 'committed\n');
    git(lease.path, 'add', 'committed.txt');
    git(lease.path, 'commit', '-m', 'committed fixture');
    writeFileSync(join(lease.path, 'dirty-a.txt'), 'dirty a\n');
    writeFileSync(join(lease.path, 'dirty-b.txt'), 'dirty b\n');

    expect(
      await Effect.runPromise(
        inspectProvenance(service, owner(repo, 'manager-1', 'agent-dirty-path-bound'), lease),
      ),
    ).toMatchObject({
      changedPaths: ['committed.txt', 'dirty-a.txt', 'dirty-b.txt'],
      dirty: true,
      provenance: {
        bounds: { maxPaths: 1 },
        dirtyPaths: [],
        reason: 'bounds_exceeded',
        status: 'unavailable',
      },
    });
  });

  test('degrades honestly when the bounded total safety diff exceeds its output limit', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService({ provenanceGitMaxBufferBytes: 65 });
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-dirty-bound',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    const committedPath = `${'long-committed-path-'.repeat(8)}.txt`;
    writeFileSync(join(lease.path, committedPath), 'committed worker change\n');
    git(lease.path, 'add', committedPath);
    git(lease.path, 'commit', '-m', 'long worker fixture');
    writeFileSync(join(lease.path, 'dirty.txt'), 'live dirty change\n');

    expect(
      await Effect.runPromise(
        inspectProvenance(service, owner(repo, 'manager-1', 'agent-dirty-bound'), lease),
      ),
    ).toMatchObject({
      changedPaths: ['dirty.txt'],
      dirty: true,
      provenance: {
        dirtyPaths: ['dirty.txt'],
        reason: 'total_diff_unavailable',
        status: 'unavailable',
      },
    });
  });

  test('degrades deterministically when the bounded total safety diff exceeds its timeout', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService({ provenanceTotalDiffGitTimeoutMs: 100 });
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-diff-timeout',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    writeFileSync(join(lease.path, 'changed.txt'), 'changed\n');
    git(lease.path, 'add', 'changed.txt');
    git(lease.path, 'commit', '-m', 'timeout fixture');

    const wrapperRoot = mkdtempSync(join(tmpdir(), 'pardes-slow-git-'));
    temporaryDirectories.push(wrapperRoot);
    const wrapper = join(wrapperRoot, 'git');
    const marker = join(wrapperRoot, 'diff-started');
    const realGit = executableOnPath('git');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "diff" ]; then\n  : > ${shellQuote(marker)}\n  sleep 1\nfi\nexec ${shellQuote(realGit)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    const inspection = await (async () => {
      try {
        process.env.PATH = `${wrapperRoot}${delimiter}${originalPath ?? ''}`;
        return await Effect.runPromise(
          inspectProvenance(service, owner(repo, 'manager-1', 'agent-diff-timeout'), lease),
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    })();

    expect(existsSync(marker)).toBe(true);
    expect(inspection).toMatchObject({
      changedPaths: [],
      dirty: false,
      provenance: {
        dirtyPaths: [],
        reason: 'total_diff_unavailable',
        status: 'unavailable',
      },
    });
  });

  test('rejects routine inspection and degrades opt-in provenance when the writing branch mismatches its retained lease', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-branch', branchPointSha, managerId: 'manager-1', repo }),
    );
    git(lease.path, 'checkout', '-b', 'unexpected-branch');

    expect(
      await Effect.runPromise(
        service.inspect(owner(repo, 'manager-1', 'agent-branch'), lease).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'managed writing checkout branch does not match its retained lease',
    });
    expect(
      await Effect.runPromise(
        inspectProvenance(service, owner(repo, 'manager-1', 'agent-branch'), lease),
      ),
    ).toMatchObject({
      provenance: {
        dirtyPaths: [],
        observedBranch: 'unexpected-branch',
        reason: 'branch_mismatch',
        status: 'unavailable',
      },
    });
  });

  test('degrades disconnected orphan history instead of attributing unrelated commits', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-orphan', branchPointSha, managerId: 'manager-1', repo }),
    );
    git(lease.path, 'checkout', '--orphan', 'orphan-temp');
    git(lease.path, 'rm', '-rf', '.');
    writeFileSync(join(lease.path, 'unrelated.txt'), 'disconnected history\n');
    git(lease.path, 'add', 'unrelated.txt');
    git(lease.path, 'commit', '-m', 'orphan fixture');
    git(lease.path, 'branch', '-D', lease.branch);
    git(lease.path, 'branch', '-m', lease.branch);

    expect(
      await Effect.runPromise(
        inspectProvenance(service, owner(repo, 'manager-1', 'agent-orphan'), lease),
      ),
    ).toMatchObject({
      provenance: { dirtyPaths: [], reason: 'baseline_not_ancestor', status: 'unavailable' },
    });
  });

  test('degrades provenance before path materialization exceeds its configured cap', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService({ provenanceMaxPaths: 1 });
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-bounds', branchPointSha, managerId: 'manager-1', repo }),
    );
    writeFileSync(join(lease.path, 'first.txt'), 'first\n');
    writeFileSync(join(lease.path, 'second.txt'), 'second\n');
    git(lease.path, 'add', 'first.txt', 'second.txt');
    git(lease.path, 'commit', '-m', 'bounded provenance fixture');

    expect(
      await Effect.runPromise(
        inspectProvenance(service, owner(repo, 'manager-1', 'agent-bounds'), lease),
      ),
    ).toMatchObject({
      provenance: {
        bounds: { maxPaths: 1 },
        dirtyPaths: [],
        reason: 'bounds_exceeded',
        status: 'unavailable',
      },
    });
  });

  test('keeps touched cooperative non-merge candidate paths invariant when additive merge context appears', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-touched', branchPointSha, managerId: 'manager-1', repo }),
    );
    writeFileSync(join(lease.path, 'reverted.txt'), 'temporary\n');
    git(lease.path, 'add', 'reverted.txt');
    git(lease.path, 'commit', '-m', 'add temporary fixture');
    rmSync(join(lease.path, 'reverted.txt'));
    git(lease.path, 'add', '-A');
    git(lease.path, 'commit', '-m', 'remove temporary fixture');
    writeFileSync(join(lease.path, 'stable.txt'), 'stable\n');
    git(lease.path, 'add', 'stable.txt');
    git(lease.path, 'commit', '-m', 'stable fixture');

    const before = await Effect.runPromise(
      inspectProvenance(service, owner(repo, 'manager-1', 'agent-touched'), lease),
    );
    writeFileSync(join(primary, 'main.txt'), 'additive main\n');
    git(primary, 'add', 'main.txt');
    git(primary, 'commit', '-m', 'main fixture');
    git(lease.path, 'merge', '--no-edit', 'main');
    const after = await Effect.runPromise(
      inspectProvenance(service, owner(repo, 'manager-1', 'agent-touched'), lease),
    );

    expect(before.provenance).toMatchObject({
      firstParentNonMergePaths: ['reverted.txt', 'stable.txt'],
      status: 'available',
    });
    expect(after.provenance).toMatchObject({
      firstParentNonMergePaths: ['reverted.txt', 'stable.txt'],
      mergePaths: ['main.txt'],
      status: 'available',
    });
  });

  test('degrades unsupported octopus merge graphs instead of assigning semantic attribution', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-octopus', branchPointSha, managerId: 'manager-1', repo }),
    );
    writeFileSync(join(lease.path, 'worker.txt'), 'worker\n');
    git(lease.path, 'add', 'worker.txt');
    git(lease.path, 'commit', '-m', 'worker fixture');
    git(primary, 'branch', 'side', branchPointSha);
    writeFileSync(join(primary, 'main.txt'), 'main\n');
    git(primary, 'add', 'main.txt');
    git(primary, 'commit', '-m', 'main fixture');
    git(primary, 'checkout', 'side');
    writeFileSync(join(primary, 'side.txt'), 'side\n');
    git(primary, 'add', 'side.txt');
    git(primary, 'commit', '-m', 'side fixture');
    git(primary, 'checkout', 'main');
    git(lease.path, 'merge', '--no-edit', 'main', 'side');

    expect(
      await Effect.runPromise(
        inspectProvenance(service, owner(repo, 'manager-1', 'agent-octopus'), lease),
      ),
    ).toMatchObject({
      provenance: { dirtyPaths: [], reason: 'unsupported_graph', status: 'unavailable' },
    });
  });

  test('degrades provenance when first-parent traversal exceeds its configured commit cap', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService({ provenanceMaxFirstParentCommits: 1 });
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-commit-bounds',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    for (const path of ['first.txt', 'second.txt']) {
      writeFileSync(join(lease.path, path), `${path}\n`);
      git(lease.path, 'add', path);
      git(lease.path, 'commit', '-m', `${path} fixture`);
    }

    expect(
      await Effect.runPromise(
        inspectProvenance(service, owner(repo, 'manager-1', 'agent-commit-bounds'), lease),
      ),
    ).toMatchObject({
      changedPaths: ['first.txt', 'second.txt'],
      provenance: {
        bounds: { maxFirstParentCommits: 1 },
        dirtyPaths: [],
        reason: 'bounds_exceeded',
        status: 'unavailable',
      },
    });
  });

  test('creates a fresh manager-namespaced detached review checkout pinned to an immutable worker head', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const worker = await Effect.runPromise(
      service.create({
        agentId: 'agent-source',
        branchPointSha,
        managerId: 'manager-review',
        repo,
      }),
    );
    writeFileSync(join(worker.path, 'reviewed.txt'), 'reviewed\n');
    writeFileSync(join(worker.path, '.gitignore'), 'ignored-scratch.txt\n');
    git(worker.path, 'add', 'reviewed.txt', '.gitignore');
    git(worker.path, 'commit', '-m', 'reviewed fixture');
    const reviewedHeadSha = git(worker.path, 'rev-parse', 'HEAD');

    const lease = await Effect.runPromise(
      provisionReview(service, {
        managerId: 'manager-review',
        repo,
        reviewedHeadSha,
        verificationId: 'verify-one',
      }),
    );
    expect(lease.path).toBe(
      join(primary, '.worktrees', 'pardes', 'manager-review', 'reviews', 'verify-one'),
    );
    expect(git(lease.path, 'rev-parse', 'HEAD')).toBe(reviewedHeadSha);
    expect(git(lease.path, 'branch', '--show-current')).toBe('');
    expect(
      await Effect.runPromise(
        service.inspectDetachedReviewCheckout(
          { managerId: 'manager-review', repo, verificationId: 'verify-one' },
          lease,
        ),
      ),
    ).toEqual({ dirty: false, headSha: reviewedHeadSha, path: lease.path });

    writeFileSync(join(worker.path, 'later.txt'), 'later\n');
    git(worker.path, 'add', 'later.txt');
    git(worker.path, 'commit', '-m', 'later fixture');
    expect(git(worker.path, 'rev-parse', 'HEAD')).not.toBe(reviewedHeadSha);
    expect(git(lease.path, 'rev-parse', 'HEAD')).toBe(reviewedHeadSha);
    writeFileSync(join(lease.path, 'unexpected.txt'), 'same-user mutation remains observable\n');
    expect(
      await Effect.runPromise(
        service.inspectDetachedReviewCheckout(
          { managerId: 'manager-review', repo, verificationId: 'verify-one' },
          lease,
        ),
      ),
    ).toEqual({ dirty: true, headSha: reviewedHeadSha, path: lease.path });
    git(lease.path, 'add', 'unexpected.txt');
    git(lease.path, 'commit', '-m', 'disposable verifier scratch commit');
    writeFileSync(join(lease.path, 'untracked-scratch.txt'), 'discard me\n');
    writeFileSync(join(lease.path, 'ignored-scratch.txt'), 'discard ignored scratch too\n');
    const latestSourceHeadSha = git(worker.path, 'rev-parse', 'HEAD');
    const refreshed = await Effect.runPromise(
      service.refreshDetachedReviewCheckout(
        { managerId: 'manager-review', repo, verificationId: 'verify-one' },
        lease,
        latestSourceHeadSha,
      ),
    );
    expect(refreshed).toMatchObject({ path: lease.path, reviewedHeadSha: latestSourceHeadSha });
    expect(
      await Effect.runPromise(
        service.inspectDetachedReviewCheckout(
          { managerId: 'manager-review', repo, verificationId: 'verify-one' },
          refreshed,
        ),
      ),
    ).toEqual({ dirty: false, headSha: latestSourceHeadSha, path: lease.path });
    expect(existsSync(join(lease.path, 'unexpected.txt'))).toBe(false);
    expect(existsSync(join(lease.path, 'untracked-scratch.txt'))).toBe(false);
    expect(existsSync(join(lease.path, 'ignored-scratch.txt'))).toBe(false);

    writeFileSync(
      join(lease.path, 'discardable-verifier-scratch.txt'),
      'discard only detached review scratch\n',
    );
    await Effect.runPromise(
      service.discardDetachedReviewCheckout(
        { managerId: 'manager-review', repo, verificationId: 'verify-one' },
        refreshed,
      ),
    );
    expect(existsSync(lease.path)).toBe(false);
    expect(existsSync(worker.path)).toBe(true);
    expect(git(worker.path, 'rev-parse', 'HEAD')).toBe(latestSourceHeadSha);

    const reprovisioned = await Effect.runPromise(
      service.refreshDetachedReviewCheckout(
        { managerId: 'manager-review', repo, verificationId: 'verify-one' },
        refreshed,
        latestSourceHeadSha,
      ),
    );
    expect(
      await Effect.runPromise(
        service.inspectDetachedReviewCheckout(
          { managerId: 'manager-review', repo, verificationId: 'verify-one' },
          reprovisioned,
        ),
      ),
    ).toEqual({ dirty: false, headSha: latestSourceHeadSha, path: lease.path });
  });

  test('rejects writing-worktree aliases before detached review reset, clean, or removal', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const worker = await Effect.runPromise(
      service.create({
        agentId: 'agent-source',
        branchPointSha,
        managerId: 'manager-review',
        repo,
      }),
    );
    writeFileSync(
      join(worker.path, 'writer-preserved.txt'),
      'writer lease must never become disposable review scratch\n',
    );
    const aliasedReviewLease = {
      createdAt: worker.createdAt,
      managerId: worker.managerId,
      path: worker.path,
      reviewedHeadSha: branchPointSha,
      verificationId: worker.agentId,
    };
    const owner = { managerId: 'manager-review', repo, verificationId: 'agent-source' };

    const refreshFailure = await Effect.runPromise(
      service
        .refreshDetachedReviewCheckout(owner, aliasedReviewLease, branchPointSha)
        .pipe(Effect.flip),
    );
    expect(refreshFailure).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'detached review checkout path does not match its managed namespace',
    });
    const discardFailure = await Effect.runPromise(
      service.discardDetachedReviewCheckout(owner, aliasedReviewLease).pipe(Effect.flip),
    );
    expect(discardFailure).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'detached review checkout path does not match its managed namespace',
    });
    expect(existsSync(join(worker.path, 'writer-preserved.txt'))).toBe(true);
    expect(git(worker.path, 'rev-parse', 'HEAD')).toBe(branchPointSha);
  });

  test('refuses destructive detached-review operations after the checkout becomes branch-attached', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const reviewedHeadSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const owner = { managerId: 'manager-review', repo, verificationId: 'verify-attached' };
    const lease = await Effect.runPromise(provisionReview(service, { ...owner, reviewedHeadSha }));
    git(lease.path, 'switch', '-c', 'malicious-review-branch');
    writeFileSync(join(lease.path, 'branch-attached-preserved.txt'), 'do not clean or remove\n');

    const refreshFailure = await Effect.runPromise(
      service.refreshDetachedReviewCheckout(owner, lease, reviewedHeadSha).pipe(Effect.flip),
    );
    expect(refreshFailure).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'detached review checkout is attached to a branch',
    });
    const discardFailure = await Effect.runPromise(
      service.discardDetachedReviewCheckout(owner, lease).pipe(Effect.flip),
    );
    expect(discardFailure).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'detached review checkout is attached to a branch',
    });
    const reprovisionFailure = await Effect.runPromise(
      service.provisionDetachedReviewCheckout(owner, lease).pipe(Effect.flip),
    );
    expect(reprovisionFailure).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'detached review checkout is attached to a branch',
    });
    expect(existsSync(join(lease.path, 'branch-attached-preserved.txt'))).toBe(true);
  });

  test('reports both sides of committed renames and representative ordinary changes', async () => {
    const primary = fixtureRepository();
    writeFileSync(join(primary, 'rename-source.txt'), 'rename fixture\n');
    writeFileSync(join(primary, 'modified.txt'), 'before\n');
    writeFileSync(join(primary, 'deleted.txt'), 'deleted\n');
    git(primary, 'add', '.');
    git(primary, 'commit', '-m', 'audit baseline');

    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-audit', branchPointSha, managerId: 'manager-1', repo }),
    );
    const changedPaths = [
      'added.txt',
      'deleted.txt',
      'modified.txt',
      'rename-destination.txt',
      'rename-source.txt',
    ];

    git(lease.path, 'mv', 'rename-source.txt', 'rename-destination.txt');
    writeFileSync(join(lease.path, 'modified.txt'), 'after\n');
    rmSync(join(lease.path, 'deleted.txt'));
    writeFileSync(join(lease.path, 'added.txt'), 'added\n');
    expect(
      await Effect.runPromise(service.inspect(owner(repo, 'manager-1', 'agent-audit'), lease)),
    ).toMatchObject({ changedPaths, dirty: true, headSha: branchPointSha, path: lease.path });

    git(lease.path, 'add', '-A');
    git(lease.path, 'commit', '-m', 'audit changes');
    const auditedHeadSha = git(lease.path, 'rev-parse', 'HEAD');
    expect(
      await Effect.runPromise(service.inspect(owner(repo, 'manager-1', 'agent-audit'), lease)),
    ).toMatchObject({ changedPaths, dirty: false, headSha: auditedHeadSha, path: lease.path });
  });

  test('rejects dot path segments before mutating managed worktrees', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const registeredBefore = git(primary, 'worktree', 'list', '--porcelain');
    const cases = [
      { agentId: 'agent-safe', field: 'managerId', managerId: '.' },
      { agentId: 'agent-safe', field: 'managerId', managerId: '..' },
      { agentId: '.', field: 'agentId', managerId: 'manager-safe' },
      { agentId: '..', field: 'agentId', managerId: 'manager-safe' },
      { agentId: 'reviews', field: 'agentId', managerId: 'manager-safe' },
    ] as const;

    for (const input of cases) {
      const failure = await Effect.runPromise(
        service.create({ ...input, branchPointSha, repo }).pipe(Effect.flip),
      );
      expect(failure).toMatchObject({ _tag: 'InvalidWorktreeInputError', field: input.field });
      expect(existsSync(join(primary, '.worktrees'))).toBe(false);
      expect(git(primary, 'for-each-ref', '--format=%(refname)', 'refs/heads/pardes')).toBe('');
      expect(git(primary, 'worktree', 'list', '--porcelain')).toBe(registeredBefore);
    }
  });

  test('rejects dot path segments in retained owners before Git inspection', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = {
      agentId: 'agent-safe',
      branch: managedWorktreeBranch('manager-safe', 'agent-safe'),
      branchPointSha,
      createdAt: new Date(0).toISOString(),
      managerId: 'manager-safe',
      path: join(primary, '.worktrees', 'pardes', 'manager-safe', 'agent-safe'),
    };
    const cases = [
      owner(repo, '.', 'agent-safe'),
      owner(repo, '..', 'agent-safe'),
      owner(repo, 'manager-safe', '.'),
      owner(repo, 'manager-safe', '..'),
    ];

    for (const retainedOwner of cases) {
      const failure = await Effect.runPromise(
        service.inspect(retainedOwner, lease).pipe(Effect.flip),
      );
      expect(failure).toMatchObject({
        _tag: 'InvalidManagedLeaseError',
        reason: 'owner namespace is invalid',
      });
    }
  });

  test('rejects corrupt retained lease namespaces before inspecting redirected Git paths', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-retained', branchPointSha, managerId: 'manager-1', repo }),
    );
    const expectedOwner = owner(repo, 'manager-1', 'agent-retained');
    const corruptions: ReadonlyArray<Partial<typeof lease>> = [
      { managerId: 'manager-2' },
      { agentId: 'agent-other' },
      { path: primary },
      { branch: 'pardes/manager-2/agent-retained' },
      { branchPointSha: 'HEAD' },
    ];

    for (const corruption of corruptions) {
      const failure = await Effect.runPromise(
        service.inspect(expectedOwner, { ...lease, ...corruption }).pipe(Effect.flip),
      );
      expect(failure._tag).toBe('InvalidManagedLeaseError');
    }
  });

  test('rejects cross-agent forgery of another readable lease before audit or cleanup', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const source = await Effect.runPromise(
      service.create({
        agentId: 'agent-source',
        branchPointSha,
        managerId: 'manager-1',
        name: 'Readable Ownership',
        repo,
      }),
    );
    const forged = { ...source, agentId: 'agent-borrower' };
    const borrower = owner(repo, 'manager-1', 'agent-borrower');

    const inspectionFailure = await Effect.runPromise(
      service.inspect(borrower, forged).pipe(Effect.flip),
    );
    const cleanupFailure = await Effect.runPromise(
      service.inspectForCleanup(borrower, forged).pipe(Effect.flip),
    );
    for (const failure of [inspectionFailure, cleanupFailure]) {
      expect(failure).toMatchObject({
        _tag: 'InvalidManagedLeaseError',
        reason: 'worktree path and branch do not match their managed namespace',
      });
    }
    expect(existsSync(source.path)).toBe(true);
  });

  test('rejects a redirected managed ancestor before creating an outside worktree', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const outside = mkdtempSync(join(tmpdir(), 'pardes-worktree-outside-'));
    temporaryDirectories.push(outside);
    symlinkSync(outside, join(primary, '.worktrees'));
    const branch = managedWorktreeBranch('manager-1', 'agent-ancestor');
    const outsideTarget = join(outside, 'pardes', 'manager-1', 'agent-ancestor');
    const registeredBefore = git(primary, 'worktree', 'list', '--porcelain');

    const failure = await Effect.runPromise(
      service
        .create({ agentId: 'agent-ancestor', branchPointSha, managerId: 'manager-1', repo })
        .pipe(Effect.flip),
    );

    expect(failure).toMatchObject({ _tag: 'InvalidWorktreeInputError', field: 'path' });
    expect(existsSync(outsideTarget)).toBe(false);
    expect(git(primary, 'branch', '--list', branch)).toBe('');
    expect(git(primary, 'worktree', 'list', '--porcelain')).toBe(registeredBefore);
    expect(git(primary, 'worktree', 'list', '--porcelain')).not.toContain(
      `worktree ${outsideTarget}`,
    );
  });

  test('rejects an existing symbolic agent target before creating its branch', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const outside = mkdtempSync(join(tmpdir(), 'pardes-worktree-target-'));
    temporaryDirectories.push(outside);
    const target = join(primary, '.worktrees', 'pardes', 'manager-1', 'agent-target');
    mkdirSync(join(primary, '.worktrees', 'pardes', 'manager-1'), { recursive: true });
    symlinkSync(outside, target);
    const branch = managedWorktreeBranch('manager-1', 'agent-target');
    const registeredBefore = git(primary, 'worktree', 'list', '--porcelain');

    const failure = await Effect.runPromise(
      service
        .create({ agentId: 'agent-target', branchPointSha, managerId: 'manager-1', repo })
        .pipe(Effect.flip),
    );

    expect(failure).toMatchObject({ _tag: 'InvalidWorktreeInputError', field: 'path' });
    expect(git(primary, 'branch', '--list', branch)).toBe('');
    expect(git(primary, 'worktree', 'list', '--porcelain')).toBe(registeredBefore);
  });

  test('rejects a physically redirected managed worktree before Git inspection', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({ agentId: 'agent-redirected', branchPointSha, managerId: 'manager-1', repo }),
    );
    rmSync(lease.path, { force: true, recursive: true });
    symlinkSync(primary, lease.path);

    const failure = await Effect.runPromise(
      service.inspect(owner(repo, 'manager-1', 'agent-redirected'), lease).pipe(Effect.flip),
    );
    expect(failure).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'worktree path is redirected',
    });
  });

  test('classifies and cleans safe merged worktree and branch artifacts', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-cleanup-clean',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    const retainedOwner = owner(repo, 'manager-1', 'agent-cleanup-clean');

    expect(await Effect.runPromise(service.inspectForCleanup(retainedOwner, lease))).toEqual({
      branch: 'present_merged',
      changedPaths: [],
      worktree: 'present_clean',
    });
    expect(await Effect.runPromise(service.cleanup(retainedOwner, lease))).toEqual({
      branch: 'present_merged',
      branchOutcome: 'deleted_merged',
      changedPaths: [],
      worktree: 'present_clean',
      worktreeOutcome: 'removed_clean',
    });
    expect(existsSync(lease.path)).toBe(false);
    expect(git(primary, 'branch', '--list', lease.branch)).toBe('');
  });

  test('requires separate force intent for dirty discard and unmerged branch-history deletion', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-cleanup-dirty',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    const retainedOwner = owner(repo, 'manager-1', 'agent-cleanup-dirty');
    writeFileSync(join(lease.path, 'committed.txt'), 'unmerged history\n');
    git(lease.path, 'add', 'committed.txt');
    git(lease.path, 'commit', '-m', 'unmerged cleanup fixture');
    writeFileSync(join(lease.path, 'dirty.txt'), 'discard only with force\n');

    expect(await Effect.runPromise(service.inspectForCleanup(retainedOwner, lease))).toEqual({
      branch: 'present_unmerged',
      changedPaths: ['committed.txt', 'dirty.txt'],
      worktree: 'present_dirty',
    });
    const rejected = await Effect.runPromise(
      service.cleanup(retainedOwner, lease).pipe(Effect.flip),
    );
    expect(rejected._tag).toBe('DirtyWorktreeError');
    expect(existsSync(lease.path)).toBe(true);
    expect(git(primary, 'branch', '--list', lease.branch)).toContain(lease.branch);

    expect(
      await Effect.runPromise(service.cleanup(retainedOwner, lease, { forceDiscardDirty: true })),
    ).toMatchObject({
      branchOutcome: 'preserved_unmerged',
      worktreeOutcome: 'discarded_dirty',
    });
    expect(existsSync(lease.path)).toBe(false);
    expect(git(primary, 'branch', '--list', lease.branch)).toContain(lease.branch);

    expect(
      await Effect.runPromise(
        service.cleanup(retainedOwner, lease, { forceDeleteUnmergedBranch: true }),
      ),
    ).toMatchObject({
      branch: 'present_unmerged',
      branchOutcome: 'deleted_unmerged',
      worktree: 'already_missing',
      worktreeOutcome: 'already_missing',
    });
    expect(git(primary, 'branch', '--list', lease.branch)).toBe('');
  });

  test('reconciles a manually removed managed worktree registration while preserving unmerged history', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-cleanup-missing',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    const retainedOwner = owner(repo, 'manager-1', 'agent-cleanup-missing');
    writeFileSync(join(lease.path, 'retained.txt'), 'retain branch history\n');
    git(lease.path, 'add', 'retained.txt');
    git(lease.path, 'commit', '-m', 'retained history fixture');
    rmSync(lease.path, { force: true, recursive: true });

    expect(await Effect.runPromise(service.inspectForCleanup(retainedOwner, lease))).toEqual({
      branch: 'present_unmerged',
      changedPaths: [],
      worktree: 'already_missing',
    });
    expect(await Effect.runPromise(service.cleanup(retainedOwner, lease))).toMatchObject({
      branchOutcome: 'preserved_unmerged',
      worktreeOutcome: 'already_missing',
    });
    expect(git(primary, 'worktree', 'list', '--porcelain')).not.toContain(lease.path);
    expect(git(primary, 'branch', '--list', lease.branch)).toContain(lease.branch);
  });

  test('refuses corrupt cleanup namespaces without deleting arbitrary paths or managed artifacts', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService();
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-cleanup-safe',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    const outside = mkdtempSync(join(tmpdir(), 'pardes-worktree-cleanup-outside-'));
    temporaryDirectories.push(outside);
    writeFileSync(join(outside, 'keep.txt'), 'must remain\n');
    const retainedOwner = owner(repo, 'manager-1', 'agent-cleanup-safe');

    const arbitraryPath = await Effect.runPromise(
      service
        .cleanup(
          retainedOwner,
          { ...lease, path: outside },
          {
            forceDeleteUnmergedBranch: true,
            forceDiscardDirty: true,
          },
        )
        .pipe(Effect.flip),
    );
    expect(arbitraryPath).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'worktree path and branch do not match their managed namespace',
    });
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(lease.path)).toBe(true);
    expect(git(primary, 'branch', '--list', lease.branch)).toContain(lease.branch);

    const traversal = await Effect.runPromise(
      service
        .cleanup(owner(repo, '..', 'agent-cleanup-safe'), lease, {
          forceDeleteUnmergedBranch: true,
          forceDiscardDirty: true,
        })
        .pipe(Effect.flip),
    );
    expect(traversal).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'owner namespace is invalid',
    });
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(lease.path)).toBe(true);
  });

  test('holds the repository-scoped lock before cleanup mutation', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService({ lockRetries: 1, lockRetryDelay: '1 millis' });
    const lease = await Effect.runPromise(
      service.create({
        agentId: 'agent-cleanup-lock',
        branchPointSha,
        managerId: 'manager-1',
        repo,
      }),
    );
    const retainedOwner = owner(repo, 'manager-1', 'agent-cleanup-lock');
    const lock = join(repo.gitCommonDir, 'pardes-worktrees.lock');
    mkdirSync(lock);

    const busy = await Effect.runPromise(service.cleanup(retainedOwner, lease).pipe(Effect.flip));
    expect(busy).toMatchObject({ _tag: 'WorktreeLockError', busy: true });
    expect(existsSync(lease.path)).toBe(true);
    expect(git(primary, 'branch', '--list', lease.branch)).toContain(lease.branch);
  });

  test('rejects symbolic branch points and reports a busy repository lock', async () => {
    const primary = fixtureRepository();
    const repo = await Effect.runPromise(discoverRepository(primary));
    const branchPointSha = git(primary, 'rev-parse', 'HEAD');
    const service = makeManagedWorktreeService({ lockRetries: 1, lockRetryDelay: '1 millis' });

    const symbolic = await Effect.runPromise(
      service
        .create({ agentId: 'agent-symbolic', branchPointSha: 'HEAD', managerId: 'manager-1', repo })
        .pipe(Effect.flip),
    );
    expect(symbolic._tag).toBe('InvalidWorktreeInputError');

    const lock = join(repo.gitCommonDir, 'pardes-worktrees.lock');
    mkdirSync(lock);
    const busy = await Effect.runPromise(
      service
        .create({ agentId: 'agent-busy', branchPointSha, managerId: 'manager-1', repo })
        .pipe(Effect.flip),
    );
    expect(busy._tag).toBe('WorktreeLockError');
    if (busy._tag !== 'WorktreeLockError')
      throw new Error(`Expected a lock error, received ${busy._tag}`);
    expect(busy.busy).toBe(true);
  });
});
