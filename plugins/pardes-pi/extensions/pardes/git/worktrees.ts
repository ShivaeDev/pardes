import { appendFile, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Clock, Context, type Duration, Effect, Exit, Layer, Schedule } from 'effect';
import {
  DirtyWorktreeError,
  InvalidManagedLeaseError,
  InvalidWorktreeInputError,
  WorktreeError,
  WorktreeLockError,
} from './errors.ts';
import type { DetachedReviewCheckoutLease, RepoState, WorktreeLease } from './schemas.ts';
import { type RunGitOptions, runGit } from './transport.ts';

const MANAGED_EXCLUDE = '/.worktrees/pardes/';
const DETACHED_REVIEW_CHECKOUTS_DIRECTORY = 'reviews';
const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40,64}$/;

export interface CreateWorktreeInput {
  readonly repo: RepoState;
  readonly managerId: string;
  readonly agentId: string;
  readonly branchPointSha: string;
  readonly name?: string;
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

export const WORKTREE_PROVENANCE_MAX_FIRST_PARENT_COMMITS = 200;
export const WORKTREE_PROVENANCE_MAX_PATHS = 512;
export const WORKTREE_PROVENANCE_GIT_TIMEOUT_MS = 2_000;
export const WORKTREE_PROVENANCE_GIT_MAX_BUFFER_BYTES = 256 * 1_024;

export interface WorktreeLatestCommitDelta {
  readonly changedPaths: ReadonlyArray<string>;
  readonly commitSha: string;
  readonly kind: 'first_parent_non_merge' | 'merge_commit';
}

export interface WorktreeCommitProvenanceBounds {
  readonly maxFirstParentCommits: number;
  readonly maxPaths: number;
}

export type WorktreeCommitProvenanceUnavailableReason =
  | 'dirty_worktree'
  | 'worktree_not_registered'
  | 'branch_mismatch'
  | 'baseline_not_ancestor'
  | 'unsupported_graph'
  | 'bounds_exceeded'
  | 'inspection_failed';

export type WorktreeCommitProvenance =
  | {
      readonly status: 'available';
      readonly attribution: 'cooperative_first_parent';
      readonly bounds: WorktreeCommitProvenanceBounds;
      readonly branchPointSha: string;
      readonly headSha: string;
      readonly latestDelta?: WorktreeLatestCommitDelta;
      readonly mergeCommitCount: number;
      readonly mergePaths: ReadonlyArray<string>;
      readonly firstParentNonMergeCommitCount: number;
      readonly firstParentNonMergePaths: ReadonlyArray<string>;
      readonly totalBranchCommitCount: number;
      readonly totalBranchDeltaPaths: ReadonlyArray<string>;
    }
  | {
      readonly status: 'unavailable';
      readonly bounds: WorktreeCommitProvenanceBounds;
      readonly dirtyPaths: ReadonlyArray<string>;
      readonly observedBranch?: string;
      readonly reason: WorktreeCommitProvenanceUnavailableReason;
    };

const WORKTREE_PROVENANCE_BOUNDS: WorktreeCommitProvenanceBounds = {
  maxFirstParentCommits: WORKTREE_PROVENANCE_MAX_FIRST_PARENT_COMMITS,
  maxPaths: WORKTREE_PROVENANCE_MAX_PATHS,
};
export function unavailableWorktreeCommitProvenance(
  reason: WorktreeCommitProvenanceUnavailableReason,
  dirtyPaths: ReadonlyArray<string> = [],
  observedBranch?: string,
): WorktreeCommitProvenance {
  return {
    bounds: WORKTREE_PROVENANCE_BOUNDS,
    dirtyPaths,
    ...(observedBranch === undefined ? {} : { observedBranch }),
    reason,
    status: 'unavailable',
  };
}

export interface WorktreeInspection {
  readonly path: string;
  readonly headSha: string;
  readonly dirty: boolean;
  readonly changedPaths: ReadonlyArray<string>;
  readonly provenance?: WorktreeCommitProvenance;
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

export interface TrackPublishedReviewBranchInput {
  readonly headBranch: string;
  readonly headSha: string;
}

export type PublishedReviewBranchTrackingSuccess = {
  readonly localBranch: string;
  readonly remote: 'origin';
  readonly remoteBranch: string;
  readonly status: 'already_configured' | 'configured';
};

export type PublishedReviewBranchTrackingOutcome =
  | PublishedReviewBranchTrackingSuccess
  | {
      readonly reason: 'local_tracking_failed';
      readonly remote: 'origin';
      readonly remoteBranch: string;
      readonly status: 'failed';
    };

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
  /** Configure the retained local branch only after its exact remote review head was hosted-verified. */
  readonly trackPublishedReviewBranch: (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
    input: TrackPublishedReviewBranchInput,
  ) => Effect.Effect<PublishedReviewBranchTrackingSuccess, WorktreeServiceError>;
  /** Opt-in richer commit provenance for human/model audit drill-downs, never routine lifecycle checks. */
  readonly inspectWithProvenance?: (
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
  /** Narrow command adapter for published-review tracking. */
  readonly publishedReviewBranchGit?: typeof git;
  readonly lockRetries?: number;
  readonly provenanceGitMaxBufferBytes?: number;
  readonly provenanceGitTimeoutMs?: number;
  readonly provenanceMaxFirstParentCommits?: number;
  readonly provenanceMaxPaths?: number;
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

function git(repoPath: string, args: ReadonlyArray<string>, options?: RunGitOptions) {
  return runGit(repoPath, args, options).pipe(
    Effect.mapError(
      (cause) => new WorktreeError({ cause, operation: `git ${args.join(' ')}`, path: repoPath }),
    ),
  );
}

const isRegisteredWorktreePath = Effect.fnUntraced(function* (
  repo: RepoState,
  path: string,
  options?: RunGitOptions,
) {
  const listed = yield* git(
    repo.primaryCheckout,
    ['worktree', 'list', '--porcelain', '-z'],
    options,
  );
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

function leasePath(repo: RepoState, managerId: string, directoryName: string): string {
  return join(repo.primaryCheckout, '.worktrees', 'pardes', managerId, directoryName);
}

function readableLeasePath(
  repo: RepoState,
  managerId: string,
  agentId: string,
  directoryName: string,
): string {
  return join(repo.primaryCheckout, '.worktrees', 'pardes', managerId, agentId, directoryName);
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

const READABLE_WORKTREE_NAME_MAX_LENGTH = 64;
const READABLE_LOCAL_BRANCH = /^[a-z0-9]+(?:-[a-z0-9]+)*\/pardes\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FLAT_FALLBACK_LOCAL_BRANCH = /^[a-z0-9]+(?:-[a-z0-9]+)*-pardes-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readableWorktreeSlug(
  value: string,
  fallback: string,
  maxLength = READABLE_WORKTREE_NAME_MAX_LENGTH,
): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function shortWorktreeDisambiguator(value: string): string {
  return readableWorktreeSlug(value, 'worker', 8);
}

function readableWorktreeCandidates(
  name: string,
  agentId: string,
  managerId: string,
): ReadonlyArray<string> {
  const preferred = readableWorktreeSlug(name, 'workstream');
  const agent = shortWorktreeDisambiguator(agentId.replace(/^agent-/, ''));
  const manager = shortWorktreeDisambiguator(managerId);
  return [preferred, `${preferred}-${agent}`, `${preferred}-${agent}-${manager}`];
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
  const legacy =
    lease.path === leasePath(owner.repo, owner.managerId, owner.agentId) &&
    lease.branch === managedWorktreeBranch(owner.managerId, owner.agentId);
  const directoryName = basename(lease.path);
  const readable =
    isSafeManagedSegment(directoryName) &&
    directoryName !== DETACHED_REVIEW_CHECKOUTS_DIRECTORY &&
    lease.path === readableLeasePath(owner.repo, owner.managerId, owner.agentId, directoryName) &&
    ((READABLE_LOCAL_BRANCH.test(lease.branch) &&
      lease.branch.endsWith(`/pardes/${directoryName}`)) ||
      (FLAT_FALLBACK_LOCAL_BRANCH.test(lease.branch) &&
        lease.branch.endsWith(`-pardes-${directoryName}`)));
  if (!legacy && !readable) {
    return yield* invalidLease('worktree path and branch do not match their managed namespace');
  }
  if (!FULL_COMMIT_SHA.test(lease.branchPointSha)) {
    return yield* invalidLease('branch point is not an immutable commit SHA');
  }
});

const validateManagedWorktreeLeasePath = Effect.fnUntraced(function* (
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

export const validateManagedWorktreeLease = validateManagedWorktreeLeasePath;

/** Adapter-private physical Git checks; namespace validation remains filesystem-only. */
const validateInspectableManagedWorktreeLease = Effect.fnUntraced(function* (
  owner: ManagedLeaseOwner,
  lease: WorktreeLease,
  options: RunGitOptions,
) {
  yield* validateManagedWorktreeLease(owner, lease);
  if (!(yield* isRegisteredWorktreePath(owner.repo, lease.path, options)))
    return yield* invalidLease('managed writing checkout is not a registered worktree');
  const branch = yield* git(
    lease.path,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    options,
  ).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
    Effect.catch(() => invalidLease('managed writing checkout branch cannot be verified')),
  );
  if (branch !== lease.branch)
    return yield* invalidLease('managed writing checkout branch does not match its retained lease');
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

const ensureWritingWorktreeParent = (
  repo: RepoState,
  managerId: string,
  agentId: string,
  directoryName: string,
) =>
  ensureManagedWorktreeParent(
    repo,
    ['.worktrees', 'pardes', managerId, agentId],
    readableLeasePath(repo, managerId, agentId, directoryName),
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

interface FirstParentCommit {
  readonly commitSha: string;
  readonly parentCount: number;
}

function parseFirstParentCommits(output: string): ReadonlyArray<FirstParentCommit> {
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [commitSha, ...parents] = line.trim().split(/\s+/);
      if (!commitSha) throw new Error('Git returned an invalid first-parent commit row');
      return { commitSha, parentCount: parents.length };
    });
}

export function makeManagedWorktreeService(
  options: WorktreeServiceOptions = {},
): ManagedWorktreeShape {
  const retryDelay = options.lockRetryDelay ?? '25 millis';
  const retries = options.lockRetries ?? 80;
  const provenanceBounds: WorktreeCommitProvenanceBounds = {
    maxFirstParentCommits:
      options.provenanceMaxFirstParentCommits ?? WORKTREE_PROVENANCE_MAX_FIRST_PARENT_COMMITS,
    maxPaths: options.provenanceMaxPaths ?? WORKTREE_PROVENANCE_MAX_PATHS,
  };
  const provenanceGitOptions: RunGitOptions = {
    maxBuffer: options.provenanceGitMaxBufferBytes ?? WORKTREE_PROVENANCE_GIT_MAX_BUFFER_BYTES,
    timeoutMs: options.provenanceGitTimeoutMs ?? WORKTREE_PROVENANCE_GIT_TIMEOUT_MS,
  };
  const routineLeaseValidationGitOptions: RunGitOptions = {
    maxBuffer: WORKTREE_PROVENANCE_GIT_MAX_BUFFER_BYTES,
    timeoutMs: WORKTREE_PROVENANCE_GIT_TIMEOUT_MS,
  };
  const publishedReviewBranchGit = options.publishedReviewBranchGit ?? git;
  const provenanceUnavailable = (
    reason: WorktreeCommitProvenanceUnavailableReason,
    dirtyPaths: ReadonlyArray<string> = [],
    observedBranch?: string,
  ): WorktreeCommitProvenance => ({
    bounds: provenanceBounds,
    dirtyPaths,
    ...(observedBranch === undefined ? {} : { observedBranch }),
    reason,
    status: 'unavailable',
  });

  const inspectPresent = Effect.fnUntraced(function* (
    owner: ManagedLeaseOwner,
    lease: WorktreeLease,
    includeProvenance = false,
  ) {
    if (includeProvenance) yield* validateManagedWorktreeLease(owner, lease);
    else
      yield* validateInspectableManagedWorktreeLease(
        owner,
        lease,
        routineLeaseValidationGitOptions,
      );
    const gitOptions = includeProvenance ? provenanceGitOptions : undefined;
    const headSha = (yield* git(
      lease.path,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      gitOptions,
    )).stdout.trim();
    const status = yield* git(
      lease.path,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      gitOptions,
    );
    const dirtyPaths = parsePorcelainChangedPaths(status.stdout);
    const baseInspection = {
      changedPaths: dirtyPaths,
      dirty: dirtyPaths.length > 0,
      headSha,
      path: lease.path,
    };
    if (includeProvenance && dirtyPaths.length > 0)
      return {
        ...baseInspection,
        provenance: provenanceUnavailable('dirty_worktree', dirtyPaths),
      };
    const range = `${lease.branchPointSha}..${headSha}`;
    if (!includeProvenance) {
      const committed = yield* git(lease.path, ['diff', '--name-status', '-z', range]);
      return {
        ...baseInspection,
        changedPaths: [
          ...new Set([...dirtyPaths, ...parseCommittedChangedPaths(committed.stdout)]),
        ].sort(),
      };
    }
    let projectionInspection = baseInspection;
    const unavailable = (
      reason: WorktreeCommitProvenanceUnavailableReason,
      paths: ReadonlyArray<string> = [],
      observedBranch?: string,
    ) => ({
      ...projectionInspection,
      provenance: provenanceUnavailable(reason, paths, observedBranch),
    });
    if (!(yield* isRegisteredWorktreePath(owner.repo, lease.path, provenanceGitOptions)))
      return unavailable('worktree_not_registered');
    const branchResult = yield* git(
      lease.path,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      provenanceGitOptions,
    ).pipe(Effect.exit);
    if (Exit.isFailure(branchResult)) return unavailable('branch_mismatch');
    const observedBranch = branchResult.value.stdout.trim();
    if (observedBranch !== lease.branch) return unavailable('branch_mismatch', [], observedBranch);
    const ancestor = yield* git(
      lease.path,
      ['merge-base', '--is-ancestor', lease.branchPointSha, headSha],
      provenanceGitOptions,
    ).pipe(Effect.exit);
    if (Exit.isFailure(ancestor)) return unavailable('baseline_not_ancestor');
    const firstParentCommits = parseFirstParentCommits(
      (yield* git(
        lease.path,
        [
          'rev-list',
          '--first-parent',
          '--parents',
          `--max-count=${provenanceBounds.maxFirstParentCommits + 1}`,
          range,
        ],
        provenanceGitOptions,
      )).stdout,
    );
    if (firstParentCommits.length > provenanceBounds.maxFirstParentCommits)
      return unavailable('bounds_exceeded');
    if (firstParentCommits.some(({ parentCount }) => parentCount < 1 || parentCount > 2))
      return unavailable('unsupported_graph');
    const committed = yield* git(
      lease.path,
      ['diff', '--name-status', '-z', range],
      provenanceGitOptions,
    );
    const totalBranchDeltaPaths = parseCommittedChangedPaths(committed.stdout);
    projectionInspection = { ...baseInspection, changedPaths: totalBranchDeltaPaths };
    if (totalBranchDeltaPaths.length > provenanceBounds.maxPaths)
      return unavailable('bounds_exceeded');
    const totalBranchCommitCount = firstParentCommits.length;
    const mergeCommitCount = firstParentCommits.filter(
      ({ parentCount }) => parentCount === 2,
    ).length;
    const firstParentNonMergePaths = parseCommittedChangedPaths(
      (yield* git(
        lease.path,
        [
          'log',
          '--first-parent',
          '--no-merges',
          `--max-count=${provenanceBounds.maxFirstParentCommits}`,
          '--format=',
          '--name-status',
          '-z',
          range,
        ],
        provenanceGitOptions,
      )).stdout,
    );
    const mergePaths =
      mergeCommitCount === 0
        ? []
        : parseCommittedChangedPaths(
            (yield* git(
              lease.path,
              [
                'log',
                '--first-parent',
                '--merges',
                '--diff-merges=first-parent',
                `--max-count=${provenanceBounds.maxFirstParentCommits}`,
                '--format=',
                '--name-status',
                '-z',
                range,
              ],
              provenanceGitOptions,
            )).stdout,
          );
    const latestCommit = firstParentCommits[0];
    const latestDelta = latestCommit
      ? {
          changedPaths: parseCommittedChangedPaths(
            (yield* git(
              lease.path,
              [
                'diff',
                '--name-status',
                '-z',
                `${latestCommit.commitSha}^1`,
                latestCommit.commitSha,
              ],
              provenanceGitOptions,
            )).stdout,
          ),
          commitSha: latestCommit.commitSha,
          kind:
            latestCommit.parentCount === 2
              ? ('merge_commit' as const)
              : ('first_parent_non_merge' as const),
        }
      : undefined;
    if (
      firstParentNonMergePaths.length > provenanceBounds.maxPaths ||
      mergePaths.length > provenanceBounds.maxPaths ||
      (latestDelta?.changedPaths.length ?? 0) > provenanceBounds.maxPaths
    )
      return unavailable('bounds_exceeded');
    return {
      ...projectionInspection,
      provenance: {
        attribution: 'cooperative_first_parent' as const,
        bounds: provenanceBounds,
        branchPointSha: lease.branchPointSha,
        firstParentNonMergeCommitCount: totalBranchCommitCount - mergeCommitCount,
        firstParentNonMergePaths,
        headSha,
        ...(latestDelta === undefined ? {} : { latestDelta }),
        mergeCommitCount,
        mergePaths,
        status: 'available' as const,
        totalBranchCommitCount,
        totalBranchDeltaPaths,
      },
    };
  });

  const inspect: ManagedWorktreeShape['inspect'] = (owner, lease) => inspectPresent(owner, lease);

  const trackPublishedReviewBranch: ManagedWorktreeShape['trackPublishedReviewBranch'] = (
    owner,
    lease,
    input,
  ) =>
    withRepositoryLock(
      owner.repo,
      retryDelay,
      retries,
      Effect.gen(function* () {
        yield* validateInspectableManagedWorktreeLease(
          owner,
          lease,
          routineLeaseValidationGitOptions,
        );
        if (!FULL_COMMIT_SHA.test(input.headSha))
          return yield* invalid('headSha', 'must be an immutable commit SHA');
        yield* publishedReviewBranchGit(lease.path, [
          'check-ref-format',
          `refs/heads/${input.headBranch}`,
        ]);

        const remote = 'origin' as const;
        const remoteRef = `refs/remotes/${remote}/${input.headBranch}`;
        const observedRemoteRef = yield* publishedReviewBranchGit(
          lease.path,
          ['show-ref', '--verify', '--hash', remoteRef],
          routineLeaseValidationGitOptions,
        ).pipe(
          Effect.map(({ stdout }) => stdout.trim()),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (observedRemoteRef !== input.headSha) {
          yield* publishedReviewBranchGit(lease.path, [
            'update-ref',
            '--no-deref',
            remoteRef,
            input.headSha,
            observedRemoteRef ?? '',
          ]);
        }
        const materializedRemoteRef = (yield* publishedReviewBranchGit(
          lease.path,
          ['rev-parse', '--verify', `${remoteRef}^{commit}`],
          routineLeaseValidationGitOptions,
        )).stdout.trim();
        if (materializedRemoteRef !== input.headSha)
          return yield* invalidLease(
            'published remote-tracking ref does not match its verified SHA',
          );

        const expectedRemoteRef = `refs/heads/${input.headBranch}`;
        const readUpstream = Effect.fnUntraced(function* () {
          const configured = (yield* publishedReviewBranchGit(
            lease.path,
            [
              'for-each-ref',
              '--format=%(upstream:remotename)%00%(upstream:remoteref)',
              `refs/heads/${lease.branch}`,
            ],
            routineLeaseValidationGitOptions,
          )).stdout.trim();
          const separator = configured.indexOf('\0');
          return separator < 0
            ? { ref: '', remote: '' }
            : {
                ref: configured.slice(separator + 1),
                remote: configured.slice(0, separator),
              };
        });
        const before = yield* readUpstream();
        const alreadyConfigured = before.remote === remote && before.ref === expectedRemoteRef;
        if (!alreadyConfigured) {
          yield* publishedReviewBranchGit(lease.path, [
            'branch',
            `--set-upstream-to=${remote}/${input.headBranch}`,
            '--',
            lease.branch,
          ]);
        }
        const after = yield* readUpstream();
        if (after.remote !== remote || after.ref !== expectedRemoteRef)
          return yield* invalidLease('published review branch upstream could not be verified');
        const verifiedRemoteRef = (yield* publishedReviewBranchGit(
          lease.path,
          ['rev-parse', '--verify', `${remoteRef}^{commit}`],
          routineLeaseValidationGitOptions,
        )).stdout.trim();
        if (verifiedRemoteRef !== input.headSha)
          return yield* invalidLease('published remote-tracking ref changed during configuration');
        return {
          localBranch: lease.branch,
          remote,
          remoteBranch: input.headBranch,
          status: alreadyConfigured ? ('already_configured' as const) : ('configured' as const),
        };
      }),
    );

  const inspectWithProvenance: NonNullable<ManagedWorktreeShape['inspectWithProvenance']> = (
    owner,
    lease,
  ) => inspectPresent(owner, lease, true);

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
      if (!FULL_COMMIT_SHA.test(input.branchPointSha)) {
        return yield* invalid('branchPointSha', 'must be a full lowercase commit SHA');
      }
      const resolved = (yield* git(input.repo.primaryCheckout, [
        'rev-parse',
        '--verify',
        `${input.branchPointSha}^{commit}`,
      ])).stdout.trim();
      if (resolved !== input.branchPointSha)
        return yield* invalid('branchPointSha', 'must identify one immutable commit exactly');
      const configuredActor = yield* git(input.repo.primaryCheckout, [
        'config',
        '--get',
        'user.name',
      ]).pipe(
        Effect.map(({ stdout }) => stdout.trim()),
        Effect.catch(() => Effect.succeed('')),
      );
      const actor = readableWorktreeSlug(
        configuredActor || process.env.USER || process.env.LOGNAME || 'user',
        'user',
      );
      const selection = yield* withRepositoryLock(
        input.repo,
        retryDelay,
        retries,
        Effect.gen(function* () {
          yield* ensureManagedRootExcluded(input.repo);
          const namespaceRoot = `${actor}/pardes`;
          const actorRef = `refs/heads/${actor}`;
          const namespaceRootRef = `refs/heads/${namespaceRoot}`;
          const namespaceRefs = (yield* git(input.repo.primaryCheckout, [
            'for-each-ref',
            '--format=%(refname)',
            actorRef,
            namespaceRootRef,
          ])).stdout.split(/\r?\n/);
          const namespaceRootBlocked =
            namespaceRefs.includes(actorRef) || namespaceRefs.includes(namespaceRootRef);
          for (const directoryName of readableWorktreeCandidates(
            input.name ?? input.agentId,
            input.agentId,
            input.managerId,
          )) {
            const branch = namespaceRootBlocked
              ? `${actor}-pardes-${directoryName}`
              : `${namespaceRoot}/${directoryName}`;
            yield* git(input.repo.primaryCheckout, ['check-ref-format', '--branch', branch]).pipe(
              Effect.mapError(() => invalid('branch', 'must be a valid Git branch name')),
            );
            const ref = `refs/heads/${branch}`;
            const conflictingRef = (yield* git(input.repo.primaryCheckout, [
              'for-each-ref',
              '--format=%(refname)',
              ref,
            ])).stdout.trim();
            const path = readableLeasePath(
              input.repo,
              input.managerId,
              input.agentId,
              directoryName,
            );
            const target = yield* lstatIfExists('inspect managed worktree target', path);
            if (target?.isSymbolicLink())
              return yield* invalid('path', 'managed worktree target must not be a symbolic link');
            if (conflictingRef || target) continue;
            yield* ensureWritingWorktreeParent(
              input.repo,
              input.managerId,
              input.agentId,
              directoryName,
            );
            yield* git(input.repo.primaryCheckout, [
              'worktree',
              'add',
              '-b',
              branch,
              path,
              input.branchPointSha,
            ]);
            return { branch, path };
          }
          return yield* invalid('name', 'could not allocate a unique readable worktree name');
        }),
      );
      const millis = yield* Clock.currentTimeMillis;
      const lease = {
        agentId: input.agentId,
        branch: selection.branch,
        branchPointSha: input.branchPointSha,
        createdAt: new Date(millis).toISOString(),
        managerId: input.managerId,
        path: selection.path,
      };
      yield* validateInspectableManagedWorktreeLease(
        { agentId: input.agentId, managerId: input.managerId, repo: input.repo },
        lease,
        routineLeaseValidationGitOptions,
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
    inspectWithProvenance,
    prepareDetachedReviewCheckout,
    provisionDetachedReviewCheckout,
    refreshDetachedReviewCheckout,
    removeIfClean,
    trackPublishedReviewBranch,
  });
}

export const managedWorktreeLayer = Layer.succeed(ManagedWorktrees, makeManagedWorktreeService());
