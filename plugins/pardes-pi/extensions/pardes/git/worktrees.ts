import { appendFile, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Clock, Context, type Duration, Effect, Exit, Layer, Schedule } from 'effect';
import {
  DirtyWorktreeError,
  InvalidManagedLeaseError,
  InvalidWorktreeInputError,
  WorktreeError,
  WorktreeLockError,
} from './errors.ts';
import type { DetachedReviewCheckoutLease, RepoState, WorktreeLease } from './schemas.ts';
import { runGit } from './transport.ts';

const MANAGED_EXCLUDE = '/.worktrees/pardes/';
const DETACHED_REVIEW_CHECKOUTS_DIRECTORY = 'reviews';
const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40,64}$/;

export interface CreateWorktreeInput {
  readonly repo: RepoState;
  readonly managerId: string;
  readonly agentId: string;
  readonly branchPointSha: string;
}

export interface CreateDetachedReviewCheckoutInput {
  readonly repo: RepoState;
  readonly managerId: string;
  readonly verificationId: string;
  readonly reviewedHeadSha: string;
}

export interface DetachedReviewCheckoutOwner {
  readonly repo: RepoState;
  readonly managerId: string;
  readonly verificationId: string;
}

export interface DetachedReviewCheckoutInspection {
  readonly path: string;
  readonly headSha: string;
  readonly dirty: boolean;
}

export interface WorktreeInspection {
  readonly path: string;
  readonly headSha: string;
  readonly dirty: boolean;
  readonly changedPaths: ReadonlyArray<string>;
}

export type ManagedWorktreeCleanupState = 'present_clean' | 'present_dirty' | 'already_missing';
export type ManagedBranchCleanupState = 'present_merged' | 'present_unmerged' | 'already_missing';

export interface ManagedLeaseCleanupInspection {
  readonly worktree: ManagedWorktreeCleanupState;
  readonly branch: ManagedBranchCleanupState;
  readonly changedPaths: ReadonlyArray<string>;
}

export interface ManagedLeaseCleanupIntent {
  readonly forceDiscardDirty?: boolean;
  readonly forceDeleteUnmergedBranch?: boolean;
}

export interface ManagedLeaseCleanupOutcome extends ManagedLeaseCleanupInspection {
  readonly worktreeOutcome: 'removed_clean' | 'discarded_dirty' | 'already_missing';
  readonly branchOutcome:
    | 'deleted_merged'
    | 'deleted_unmerged'
    | 'preserved_unmerged'
    | 'already_missing';
}

export interface ManagedLeaseOwner {
  readonly repo: RepoState;
  readonly managerId: string;
  readonly agentId: string;
}

export interface ManagedWorktreeShape {
  readonly create: (
    input: CreateWorktreeInput,
  ) => Effect.Effect<WorktreeLease, WorktreeServiceError>;
  readonly prepareDetachedReviewCheckout: (
    input: CreateDetachedReviewCheckoutInput,
  ) => Effect.Effect<DetachedReviewCheckoutLease, WorktreeServiceError>;
  readonly provisionDetachedReviewCheckout: (
    owner: DetachedReviewCheckoutOwner,
    lease: DetachedReviewCheckoutLease,
  ) => Effect.Effect<void, WorktreeServiceError>;
  readonly refreshDetachedReviewCheckout: (
    owner: DetachedReviewCheckoutOwner,
    lease: DetachedReviewCheckoutLease,
    reviewedHeadSha: string,
  ) => Effect.Effect<DetachedReviewCheckoutLease, WorktreeServiceError>;
  readonly discardDetachedReviewCheckout: (
    owner: DetachedReviewCheckoutOwner,
    lease: DetachedReviewCheckoutLease,
  ) => Effect.Effect<void, WorktreeServiceError>;
  readonly inspectDetachedReviewCheckout: (
    owner: DetachedReviewCheckoutOwner,
    lease: DetachedReviewCheckoutLease,
  ) => Effect.Effect<DetachedReviewCheckoutInspection, WorktreeServiceError>;
  readonly inspect: (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
  ) => Effect.Effect<WorktreeInspection, WorktreeServiceError>;
  readonly inspectForCleanup: (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
  ) => Effect.Effect<ManagedLeaseCleanupInspection, WorktreeServiceError>;
  readonly cleanup: (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
    intent?: ManagedLeaseCleanupIntent,
  ) => Effect.Effect<ManagedLeaseCleanupOutcome, WorktreeServiceError>;
  readonly removeIfClean: (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
  ) => Effect.Effect<void, WorktreeServiceError>;
}

export type WorktreeServiceError =
  | WorktreeError
  | WorktreeLockError
  | InvalidWorktreeInputError
  | InvalidManagedLeaseError
  | DirtyWorktreeError;

export class ManagedWorktrees extends Context.Service<ManagedWorktrees, ManagedWorktreeShape>()(
  'pardes/ManagedWorktrees',
) {}

interface WorktreeServiceOptions {
  readonly lockRetryDelay?: Duration.Input;
  readonly lockRetries?: number;
}

function fsError(operation: string, path: string, cause: unknown): WorktreeError {
  return new WorktreeError({ cause, operation, path });
}

function fsEffect<A>(
  operation: string,
  path: string,
  run: () => PromiseLike<A>,
): Effect.Effect<A, WorktreeError> {
  return Effect.tryPromise({
    catch: (cause) => fsError(operation, path, cause),
    try: run,
  });
}

function git(repoPath: string, args: ReadonlyArray<string>) {
  return runGit(repoPath, args).pipe(
    Effect.mapError(
      (cause) => new WorktreeError({ cause, operation: `git ${args.join(' ')}`, path: repoPath }),
    ),
  );
}

const isRegisteredWorktreePath = Effect.fnUntraced(function* (repo: RepoState, path: string) {
  const listed = yield* git(repo.primaryCheckout, ['worktree', 'list', '--porcelain', '-z']);
  return listed.stdout.split('\0').includes(`worktree ${path}`);
});

function invalid(field: string, message: string): InvalidWorktreeInputError {
  return new InvalidWorktreeInputError({ field, message });
}

function isSafeManagedSegment(value: string): boolean {
  return value !== '.' && value !== '..' && SAFE_SEGMENT.test(value);
}

function assertSafeSegment(
  field: string,
  value: string,
): Effect.Effect<void, InvalidWorktreeInputError> {
  return isSafeManagedSegment(value)
    ? Effect.void
    : Effect.fail(
        invalid(
          field,
          'must contain only letters, numbers, dots, underscores, or hyphens and must not be . or ..',
        ),
      );
}

function leasePath(repo: RepoState, managerId: string, ownerId: string): string {
  return join(repo.primaryCheckout, '.worktrees', 'pardes', managerId, ownerId);
}

function detachedReviewCheckoutPath(
  repo: RepoState,
  managerId: string,
  verificationId: string,
): string {
  return join(
    repo.primaryCheckout,
    '.worktrees',
    'pardes',
    managerId,
    DETACHED_REVIEW_CHECKOUTS_DIRECTORY,
    verificationId,
  );
}

export function managedWorktreeBranch(managerId: string, agentId: string): string {
  return `pardes/${managerId.slice(0, 8)}/${agentId}`;
}

function invalidLease(reason: string): InvalidManagedLeaseError {
  return new InvalidManagedLeaseError({ reason });
}

const validateManagedWorktreeLeaseIdentity = Effect.fnUntraced(function* (
  owner: ManagedLeaseOwner,
  lease: WorktreeLease,
) {
  if (
    !isSafeManagedSegment(owner.managerId) ||
    !isSafeManagedSegment(owner.agentId) ||
    owner.agentId === DETACHED_REVIEW_CHECKOUTS_DIRECTORY
  ) {
    return yield* invalidLease('owner namespace is invalid');
  }
  if (lease.managerId !== owner.managerId)
    return yield* invalidLease('manager namespace does not match its owner');
  if (lease.agentId !== owner.agentId)
    return yield* invalidLease('agent namespace does not match its owner');
  if (lease.path !== leasePath(owner.repo, owner.managerId, owner.agentId)) {
    return yield* invalidLease('worktree path does not match its managed namespace');
  }
  if (lease.branch !== managedWorktreeBranch(owner.managerId, owner.agentId)) {
    return yield* invalidLease('branch does not match its managed namespace');
  }
  if (!FULL_COMMIT_SHA.test(lease.branchPointSha)) {
    return yield* invalidLease('branch point is not an immutable commit SHA');
  }
});

export const validateManagedWorktreeLease = Effect.fnUntraced(function* (
  owner: ManagedLeaseOwner,
  lease: WorktreeLease,
) {
  yield* validateManagedWorktreeLeaseIdentity(owner, lease);
  const physicalPath = yield* Effect.tryPromise({
    catch: () => invalidLease('worktree path cannot be verified'),
    try: () => realpath(lease.path),
  });
  if (physicalPath !== lease.path) return yield* invalidLease('worktree path is redirected');
});

const validateDetachedReviewCheckoutLeaseIdentity = Effect.fnUntraced(function* (
  owner: DetachedReviewCheckoutOwner,
  lease: DetachedReviewCheckoutLease,
) {
  if (!isSafeManagedSegment(owner.managerId) || !isSafeManagedSegment(owner.verificationId)) {
    return yield* invalidLease('detached review checkout owner namespace is invalid');
  }
  if (lease.managerId !== owner.managerId)
    return yield* invalidLease(
      'detached review checkout manager namespace does not match its owner',
    );
  if (lease.verificationId !== owner.verificationId)
    return yield* invalidLease('detached review checkout namespace does not match its owner');
  if (
    lease.path !== detachedReviewCheckoutPath(owner.repo, owner.managerId, owner.verificationId)
  ) {
    return yield* invalidLease(
      'detached review checkout path does not match its managed namespace',
    );
  }
  if (!FULL_COMMIT_SHA.test(lease.reviewedHeadSha))
    return yield* invalidLease('detached review checkout head is not an immutable commit SHA');
});

export const validateDetachedReviewCheckoutLease = Effect.fnUntraced(function* (
  owner: DetachedReviewCheckoutOwner,
  lease: DetachedReviewCheckoutLease,
) {
  yield* validateDetachedReviewCheckoutLeaseIdentity(owner, lease);
  const physicalPath = yield* Effect.tryPromise({
    catch: () => invalidLease('detached review checkout path cannot be verified'),
    try: () => realpath(lease.path),
  });
  if (physicalPath !== lease.path)
    return yield* invalidLease('detached review checkout path is redirected');
  if (!(yield* isRegisteredWorktreePath(owner.repo, lease.path)))
    return yield* invalidLease('detached review checkout is not a registered worktree');
  const branch = (yield* git(lease.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (branch !== 'HEAD')
    return yield* invalidLease('detached review checkout is attached to a branch');
});

function lockPath(repo: RepoState): string {
  return join(repo.gitCommonDir, 'pardes-worktrees.lock');
}

function errorCode(cause: unknown): string | undefined {
  return cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
}

function lstatIfExists(operation: string, path: string) {
  return fsEffect(operation, path, () =>
    lstat(path).catch((cause: unknown) => {
      if (errorCode(cause) === 'ENOENT') return undefined;
      throw cause;
    }),
  );
}

const validatePhysicalDirectory = Effect.fnUntraced(function* (
  field: string,
  path: string,
  description: string,
) {
  const stats = yield* fsEffect(`inspect ${description}`, path, () => lstat(path));
  if (stats.isSymbolicLink())
    return yield* invalid(field, `${description} must not be a symbolic link`);
  if (!stats.isDirectory()) return yield* invalid(field, `${description} must be a directory`);
  const physicalPath = yield* fsEffect(`resolve ${description}`, path, () => realpath(path));
  if (physicalPath !== path)
    return yield* invalid(field, `${description} must be a physical canonical path`);
});

const ensureManagedWorktreeParent = Effect.fnUntraced(function* (
  repo: RepoState,
  ancestorSegments: ReadonlyArray<string>,
  target: string,
) {
  yield* validatePhysicalDirectory(
    'repo.primaryCheckout',
    repo.primaryCheckout,
    'primary checkout',
  );
  let parent = repo.primaryCheckout;
  for (const segment of ancestorSegments) {
    parent = join(parent, segment);
    if ((yield* lstatIfExists('inspect managed worktree ancestor', parent)) === undefined) {
      yield* fsEffect('create managed worktree ancestor', parent, () => mkdir(parent));
    }
    yield* validatePhysicalDirectory('path', parent, 'managed worktree ancestor');
  }
  const targetStats = yield* lstatIfExists('inspect managed worktree target', target);
  if (targetStats?.isSymbolicLink())
    return yield* invalid('path', 'managed worktree target must not be a symbolic link');
});

const ensureWritingWorktreeParent = (repo: RepoState, managerId: string, agentId: string) =>
  ensureManagedWorktreeParent(
    repo,
    ['.worktrees', 'pardes', managerId],
    leasePath(repo, managerId, agentId),
  );

const ensureDetachedReviewCheckoutParent = (
  repo: RepoState,
  managerId: string,
  verificationId: string,
) =>
  ensureManagedWorktreeParent(
    repo,
    ['.worktrees', 'pardes', managerId, DETACHED_REVIEW_CHECKOUTS_DIRECTORY],
    detachedReviewCheckoutPath(repo, managerId, verificationId),
  );

function acquireRepositoryLock(repo: RepoState, retryDelay: Duration.Input, retries: number) {
  const path = lockPath(repo);
  return Effect.tryPromise({
    catch: (cause) =>
      new WorktreeLockError({ busy: errorCode(cause) === 'EEXIST', cause, lockPath: path }),
    try: () => mkdir(path),
  }).pipe(
    Effect.retry(
      Schedule.both(Schedule.spaced(retryDelay), Schedule.recurs(retries)).pipe(
        Schedule.setInputType<WorktreeLockError>(),
        Schedule.while(({ input }) => input.busy),
      ),
    ),
  );
}

function releaseRepositoryLock(repo: RepoState) {
  const path = lockPath(repo);
  return fsEffect('release repository worktree lock', path, () =>
    rm(path, { force: true, recursive: true }),
  ).pipe(Effect.orDie);
}

function withRepositoryLock<A, E, R>(
  repo: RepoState,
  retryDelay: Duration.Input,
  retries: number,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.acquireRelease(acquireRepositoryLock(repo, retryDelay, retries), () =>
      releaseRepositoryLock(repo),
    ).pipe(Effect.flatMap(() => effect)),
  );
}

const ensureManagedRootExcluded = Effect.fnUntraced(function* (repo: RepoState) {
  const excludePath = join(repo.gitCommonDir, 'info', 'exclude');
  yield* fsEffect('create Git info directory', dirname(excludePath), () =>
    mkdir(dirname(excludePath), { recursive: true }),
  );
  const existing = yield* fsEffect('read Git exclude file', excludePath, () =>
    readFile(excludePath, 'utf8').catch((cause: unknown) => {
      if (errorCode(cause) === 'ENOENT') return '';
      throw cause;
    }),
  );
  if (existing.split(/\r?\n/).includes(MANAGED_EXCLUDE)) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  yield* fsEffect('append managed worktree exclusion', excludePath, () =>
    appendFile(excludePath, `${prefix}${MANAGED_EXCLUDE}\n`, 'utf8'),
  );
});

function parsePorcelainChangedPaths(output: string): ReadonlyArray<string> {
  const records = output.split('\0');
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    paths.add(record.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const original = records[++index];
      if (original) paths.add(original);
    }
  }
  return [...paths].sort();
}

function parseCommittedChangedPaths(output: string): ReadonlyArray<string> {
  const records = output.split('\0');
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const status = records[index];
    if (!status) continue;
    const sourceOrPath = records[++index];
    if (sourceOrPath) paths.add(sourceOrPath);
    if (status.startsWith('R') || status.startsWith('C')) {
      const destination = records[++index];
      if (destination) paths.add(destination);
    }
  }
  return [...paths].sort();
}

export function makeManagedWorktreeService(
  options: WorktreeServiceOptions = {},
): ManagedWorktreeShape {
  const retryDelay = options.lockRetryDelay ?? '25 millis';
  const retries = options.lockRetries ?? 80;

  const inspectPresent = Effect.fnUntraced(function* (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
  ) {
    yield* validateManagedWorktreeLease(owner, lease);
    const headSha = (yield* git(lease.path, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ])).stdout.trim();
    const status = yield* git(lease.path, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const dirtyPaths = parsePorcelainChangedPaths(status.stdout);
    const committed = yield* git(lease.path, [
      'diff',
      '--name-status',
      '-z',
      `${lease.branchPointSha}...${headSha}`,
    ]);
    const changedPaths = [
      ...new Set([...dirtyPaths, ...parseCommittedChangedPaths(committed.stdout)]),
    ].sort();
    return { changedPaths, dirty: dirtyPaths.length > 0, headSha, path: lease.path };
  });

  const inspect: ManagedWorktreeShape['inspect'] = inspectPresent;

  const inspectBranch = Effect.fnUntraced(function* (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
  ) {
    yield* validateManagedWorktreeLeaseIdentity(owner, lease);
    const ref = `refs/heads/${lease.branch}`;
    const present = (yield* git(owner.repo.primaryCheckout, [
      'for-each-ref',
      '--format=%(refname)',
      ref,
    ])).stdout
      .split(/\r?\n/)
      .includes(ref);
    if (!present) return 'already_missing' as const;
    const merged = (yield* git(owner.repo.primaryCheckout, [
      'for-each-ref',
      '--merged=HEAD',
      '--format=%(refname)',
      ref,
    ])).stdout
      .split(/\r?\n/)
      .includes(ref);
    return merged ? ('present_merged' as const) : ('present_unmerged' as const);
  });

  const inspectForCleanupUnlocked = Effect.fnUntraced(function* (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
  ) {
    yield* validateManagedWorktreeLeaseIdentity(owner, lease);
    const stats = yield* lstatIfExists('inspect managed cleanup target', lease.path);
    const branch = yield* inspectBranch(owner, lease);
    if (stats === undefined)
      return {
        branch,
        changedPaths: [],
        worktree: 'already_missing',
      } satisfies ManagedLeaseCleanupInspection;
    const inspection = yield* inspectPresent(owner, lease);
    return {
      branch,
      changedPaths: inspection.changedPaths,
      worktree: inspection.dirty ? 'present_dirty' : 'present_clean',
    } satisfies ManagedLeaseCleanupInspection;
  });

  const inspectForCleanup: ManagedWorktreeShape['inspectForCleanup'] = inspectForCleanupUnlocked;

  const create: ManagedWorktreeShape['create'] = (input) =>
    Effect.gen(function* () {
      yield* assertSafeSegment('managerId', input.managerId);
      yield* assertSafeSegment('agentId', input.agentId);
      if (input.agentId === DETACHED_REVIEW_CHECKOUTS_DIRECTORY)
        return yield* invalid('agentId', 'is reserved for detached review checkouts');
      const branch = managedWorktreeBranch(input.managerId, input.agentId);
      if (!FULL_COMMIT_SHA.test(input.branchPointSha)) {
        return yield* invalid('branchPointSha', 'must be a full lowercase commit SHA');
      }
      yield* git(input.repo.primaryCheckout, ['check-ref-format', '--branch', branch]).pipe(
        Effect.mapError(() => invalid('branch', 'must be a valid Git branch name')),
      );
      const resolved = (yield* git(input.repo.primaryCheckout, [
        'rev-parse',
        '--verify',
        `${input.branchPointSha}^{commit}`,
      ])).stdout.trim();
      if (resolved !== input.branchPointSha)
        return yield* invalid('branchPointSha', 'must identify one immutable commit exactly');
      const path = leasePath(input.repo, input.managerId, input.agentId);
      yield* withRepositoryLock(
        input.repo,
        retryDelay,
        retries,
        Effect.gen(function* () {
          yield* ensureManagedRootExcluded(input.repo);
          yield* ensureWritingWorktreeParent(input.repo, input.managerId, input.agentId);
          yield* git(input.repo.primaryCheckout, [
            'worktree',
            'add',
            '-b',
            branch,
            path,
            input.branchPointSha,
          ]);
        }),
      );
      const millis = yield* Clock.currentTimeMillis;
      const lease = {
        agentId: input.agentId,
        branch,
        branchPointSha: input.branchPointSha,
        createdAt: new Date(millis).toISOString(),
        managerId: input.managerId,
        path,
      };
      yield* validateManagedWorktreeLease(
        { agentId: input.agentId, managerId: input.managerId, repo: input.repo },
        lease,
      );
      return lease;
    });

  const prepareDetachedReviewCheckout: ManagedWorktreeShape['prepareDetachedReviewCheckout'] =
    Effect.fnUntraced(function* (input) {
      yield* assertSafeSegment('managerId', input.managerId);
      yield* assertSafeSegment('verificationId', input.verificationId);
      if (!FULL_COMMIT_SHA.test(input.reviewedHeadSha))
        return yield* invalid('reviewedHeadSha', 'must be a full lowercase commit SHA');
      const resolved = (yield* git(input.repo.primaryCheckout, [
        'rev-parse',
        '--verify',
        `${input.reviewedHeadSha}^{commit}`,
      ])).stdout.trim();
      if (resolved !== input.reviewedHeadSha)
        return yield* invalid('reviewedHeadSha', 'must identify one immutable commit exactly');
      const millis = yield* Clock.currentTimeMillis;
      return {
        createdAt: new Date(millis).toISOString(),
        managerId: input.managerId,
        path: detachedReviewCheckoutPath(input.repo, input.managerId, input.verificationId),
        reviewedHeadSha: input.reviewedHeadSha,
        verificationId: input.verificationId,
      };
    });

  const provisionDetachedReviewCheckout: ManagedWorktreeShape['provisionDetachedReviewCheckout'] =
    Effect.fnUntraced(function* (owner, lease) {
      yield* validateDetachedReviewCheckoutLeaseIdentity(owner, lease);
      const resolved = (yield* git(owner.repo.primaryCheckout, [
        'rev-parse',
        '--verify',
        `${lease.reviewedHeadSha}^{commit}`,
      ])).stdout.trim();
      if (resolved !== lease.reviewedHeadSha)
        return yield* invalid('reviewedHeadSha', 'must identify one immutable commit exactly');
      const provisioning = yield* withRepositoryLock(
        owner.repo,
        retryDelay,
        retries,
        Effect.gen(function* () {
          yield* ensureManagedRootExcluded(owner.repo);
          yield* ensureDetachedReviewCheckoutParent(
            owner.repo,
            owner.managerId,
            owner.verificationId,
          );
          yield* git(owner.repo.primaryCheckout, [
            'worktree',
            'add',
            '--detach',
            lease.path,
            lease.reviewedHeadSha,
          ]);
        }),
      ).pipe(Effect.andThen(validateDetachedReviewCheckoutLease(owner, lease)), Effect.exit);
      if (Exit.isSuccess(provisioning)) return;
      const discarded = yield* discardDetachedReviewCheckout(owner, lease).pipe(Effect.exit);
      if (Exit.isFailure(discarded)) return yield* Effect.failCause(discarded.cause);
      return yield* Effect.failCause(provisioning.cause);
    });

  const inspectDetachedReviewCheckout: ManagedWorktreeShape['inspectDetachedReviewCheckout'] =
    Effect.fnUntraced(function* (owner, lease) {
      yield* validateDetachedReviewCheckoutLease(owner, lease);
      const headSha = (yield* git(lease.path, [
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ])).stdout.trim();
      const status = yield* git(lease.path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);
      return {
        dirty: parsePorcelainChangedPaths(status.stdout).length > 0,
        headSha,
        path: lease.path,
      };
    });

  const refreshDetachedReviewCheckout: ManagedWorktreeShape['refreshDetachedReviewCheckout'] = (
    owner,
    lease,
    reviewedHeadSha,
  ) =>
    Effect.gen(function* () {
      if (!FULL_COMMIT_SHA.test(reviewedHeadSha))
        return yield* invalid('reviewedHeadSha', 'must be a full lowercase commit SHA');
      const resolved = (yield* git(owner.repo.primaryCheckout, [
        'rev-parse',
        '--verify',
        `${reviewedHeadSha}^{commit}`,
      ])).stdout.trim();
      if (resolved !== reviewedHeadSha)
        return yield* invalid('reviewedHeadSha', 'must identify one immutable commit exactly');
      yield* withRepositoryLock(
        owner.repo,
        retryDelay,
        retries,
        Effect.gen(function* () {
          yield* validateDetachedReviewCheckoutLeaseIdentity(owner, lease);
          const stats = yield* lstatIfExists(
            'inspect detached review checkout refresh target',
            lease.path,
          );
          if (stats === undefined) {
            // A failed prior verifier provisioning attempt may have safely
            // discarded its detached scratch. Recreate only this namespaced
            // disposable checkout; writing-worker leases are never touched.
            if (yield* isRegisteredWorktreePath(owner.repo, lease.path)) {
              yield* git(owner.repo.primaryCheckout, ['worktree', 'remove', '--force', lease.path]);
            }
            yield* ensureManagedRootExcluded(owner.repo);
            yield* ensureDetachedReviewCheckoutParent(
              owner.repo,
              owner.managerId,
              owner.verificationId,
            );
            yield* git(owner.repo.primaryCheckout, [
              'worktree',
              'add',
              '--detach',
              lease.path,
              reviewedHeadSha,
            ]);
          } else {
            yield* validateDetachedReviewCheckoutLease(owner, lease);
            // Verifier checkouts are disposable scratch space, never publication
            // sources. Reset and clean only this detached checkout before moving it.
            yield* git(lease.path, ['reset', '--hard', lease.reviewedHeadSha]);
            yield* git(lease.path, ['clean', '-fdx']);
            yield* git(lease.path, ['checkout', '--detach', '--force', reviewedHeadSha]);
            yield* git(lease.path, ['reset', '--hard', reviewedHeadSha]);
            yield* git(lease.path, ['clean', '-fdx']);
          }
        }),
      );
      const millis = yield* Clock.currentTimeMillis;
      const refreshed = { ...lease, createdAt: new Date(millis).toISOString(), reviewedHeadSha };
      const inspection = yield* inspectDetachedReviewCheckout(owner, refreshed);
      if (inspection.headSha !== reviewedHeadSha || inspection.dirty)
        return yield* invalidLease(
          'refreshed detached review checkout is not clean at its immutable reviewed head',
        );
      return refreshed;
    });

  const discardDetachedReviewCheckout: ManagedWorktreeShape['discardDetachedReviewCheckout'] = (
    owner,
    lease,
  ) =>
    withRepositoryLock(
      owner.repo,
      retryDelay,
      retries,
      Effect.gen(function* () {
        yield* validateDetachedReviewCheckoutLeaseIdentity(owner, lease);
        const stats = yield* lstatIfExists(
          'inspect detached review checkout discard target',
          lease.path,
        );
        if (stats !== undefined) yield* validateDetachedReviewCheckoutLease(owner, lease);
        if (stats !== undefined || (yield* isRegisteredWorktreePath(owner.repo, lease.path))) {
          // Detached verifier checkouts are disposable scratch only. This
          // intentionally permits discarding verifier mutations and is never
          // used for writing-worker leases.
          yield* git(owner.repo.primaryCheckout, ['worktree', 'remove', '--force', lease.path]);
        }
      }),
    );

  const isRegisteredWorktree = Effect.fnUntraced(function* (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
  ) {
    yield* validateManagedWorktreeLeaseIdentity(owner, lease);
    return yield* isRegisteredWorktreePath(owner.repo, lease.path);
  });

  const cleanup: ManagedWorktreeShape['cleanup'] = (owner, lease, intent = {}) =>
    withRepositoryLock(
      owner.repo,
      retryDelay,
      retries,
      Effect.gen(function* () {
        const inspection = yield* inspectForCleanupUnlocked(owner, lease);
        if (inspection.worktree === 'present_dirty' && intent.forceDiscardDirty !== true) {
          return yield* new DirtyWorktreeError({
            changedPaths: inspection.changedPaths,
            path: lease.path,
          });
        }
        let worktreeOutcome: ManagedLeaseCleanupOutcome['worktreeOutcome'];
        if (inspection.worktree === 'present_clean') {
          yield* git(owner.repo.primaryCheckout, ['worktree', 'remove', lease.path]);
          worktreeOutcome = 'removed_clean';
        } else if (inspection.worktree === 'present_dirty') {
          yield* git(owner.repo.primaryCheckout, ['worktree', 'remove', '--force', lease.path]);
          worktreeOutcome = 'discarded_dirty';
        } else {
          if (yield* isRegisteredWorktree(owner, lease)) {
            yield* git(owner.repo.primaryCheckout, ['worktree', 'remove', '--force', lease.path]);
          }
          worktreeOutcome = 'already_missing';
        }

        let branchOutcome: ManagedLeaseCleanupOutcome['branchOutcome'];
        if (inspection.branch === 'present_merged') {
          yield* git(owner.repo.primaryCheckout, ['branch', '-d', '--', lease.branch]);
          branchOutcome = 'deleted_merged';
        } else if (
          inspection.branch === 'present_unmerged' &&
          intent.forceDeleteUnmergedBranch === true
        ) {
          yield* git(owner.repo.primaryCheckout, ['branch', '-D', '--', lease.branch]);
          branchOutcome = 'deleted_unmerged';
        } else if (inspection.branch === 'present_unmerged') {
          branchOutcome = 'preserved_unmerged';
        } else {
          branchOutcome = 'already_missing';
        }
        return {
          ...inspection,
          branchOutcome,
          worktreeOutcome,
        } satisfies ManagedLeaseCleanupOutcome;
      }),
    );

  const removeIfClean: ManagedWorktreeShape['removeIfClean'] = (owner, lease) =>
    cleanup(owner, lease).pipe(Effect.asVoid);

  return ManagedWorktrees.of({
    cleanup,
    create,
    discardDetachedReviewCheckout,
    inspect,
    inspectDetachedReviewCheckout,
    inspectForCleanup,
    prepareDetachedReviewCheckout,
    provisionDetachedReviewCheckout,
    refreshDetachedReviewCheckout,
    removeIfClean,
  });
}

export const managedWorktreeLayer = Layer.succeed(ManagedWorktrees, makeManagedWorktreeService());
