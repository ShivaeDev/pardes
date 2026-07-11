import { Schema } from 'effect';

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const REMOTE_BASELINE_BRANCH_MAX_LENGTH = 255;
export const REMOTE_BASELINE_BRANCH_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$';

/** Lexical model-facing bound. The resolver applies Git-ref safety checks before argv construction. */
export const RemoteBaselineBranchSchema = NonEmptyString.check(
  Schema.isMaxLength(REMOTE_BASELINE_BRANCH_MAX_LENGTH),
  Schema.isPattern(new RegExp(REMOTE_BASELINE_BRANCH_PATTERN)),
);

/** Persisted repository anchor discovered through Git's common directory. */
export const RepoStateSchema = Schema.Struct({
  currentCheckout: NonEmptyString,
  gitCommonDir: NonEmptyString,
  key: NonEmptyString,
  primaryCheckout: NonEmptyString,
});
export type RepoState = typeof RepoStateSchema.Type;

/** Persisted lease identity. Semantic namespace and physical-path checks happen before use. */
export const WorktreeLeaseSchema = Schema.Struct({
  agentId: NonEmptyString,
  branch: NonEmptyString,
  branchPointSha: NonEmptyString,
  createdAt: NonEmptyString,
  managerId: NonEmptyString,
  path: NonEmptyString,
});
export type WorktreeLease = typeof WorktreeLeaseSchema.Type;

const FullCommitShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/));
const NonNegativeIntegerSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

export const WorktreeLatestCommitDeltaSchema = Schema.Struct({
  changedPaths: Schema.Array(NonEmptyString),
  commitSha: FullCommitShaSchema,
  kind: Schema.Literals(['first_parent_non_merge', 'merge_commit']),
});
export type WorktreeLatestCommitDelta = typeof WorktreeLatestCommitDeltaSchema.Type;

export const WorktreeCommitProvenanceBoundsSchema = Schema.Struct({
  maxFirstParentCommits: NonNegativeIntegerSchema,
  maxPaths: NonNegativeIntegerSchema,
});
export type WorktreeCommitProvenanceBounds = typeof WorktreeCommitProvenanceBoundsSchema.Type;

export const WorktreeCommitProvenanceUnavailableReasonSchema = Schema.Literals([
  'dirty_worktree',
  'worktree_not_registered',
  'branch_mismatch',
  'baseline_not_ancestor',
  'unsupported_graph',
  'bounds_exceeded',
  'inspection_failed',
]);
export type WorktreeCommitProvenanceUnavailableReason =
  typeof WorktreeCommitProvenanceUnavailableReasonSchema.Type;

/** Bounded cooperative first-parent evidence; merge-parent diffs are context, not authorship proof. */
export const WorktreeCommitProvenanceSchema = Schema.Union([
  Schema.Struct({
    attribution: Schema.Literal('cooperative_first_parent'),
    bounds: WorktreeCommitProvenanceBoundsSchema,
    branchPointSha: FullCommitShaSchema,
    firstParentNonMergeCommitCount: NonNegativeIntegerSchema,
    firstParentNonMergePaths: Schema.Array(NonEmptyString),
    headSha: FullCommitShaSchema,
    latestDelta: Schema.optionalKey(WorktreeLatestCommitDeltaSchema),
    mergeCommitCount: NonNegativeIntegerSchema,
    mergePaths: Schema.Array(NonEmptyString),
    status: Schema.Literal('available'),
    totalBranchCommitCount: NonNegativeIntegerSchema,
    totalBranchDeltaPaths: Schema.Array(NonEmptyString),
  }),
  Schema.Struct({
    bounds: WorktreeCommitProvenanceBoundsSchema,
    dirtyPaths: Schema.Array(NonEmptyString),
    observedBranch: Schema.optionalKey(NonEmptyString),
    reason: WorktreeCommitProvenanceUnavailableReasonSchema,
    status: Schema.Literal('unavailable'),
  }),
]).check(
  Schema.makeFilter((provenance) => {
    if (provenance.status === 'unavailable')
      return provenance.dirtyPaths.length <= provenance.bounds.maxPaths
        ? undefined
        : 'dirtyPaths exceeds its declared provenance bound';
    if (
      provenance.firstParentNonMergePaths.length > provenance.bounds.maxPaths ||
      provenance.mergePaths.length > provenance.bounds.maxPaths ||
      provenance.totalBranchDeltaPaths.length > provenance.bounds.maxPaths ||
      (provenance.latestDelta?.changedPaths.length ?? 0) > provenance.bounds.maxPaths
    )
      return 'available path evidence exceeds its declared provenance bound';
    if (provenance.totalBranchCommitCount > provenance.bounds.maxFirstParentCommits)
      return 'totalBranchCommitCount exceeds its declared provenance bound';
    if (
      provenance.firstParentNonMergeCommitCount + provenance.mergeCommitCount !==
      provenance.totalBranchCommitCount
    )
      return 'first-parent commit categories do not sum to totalBranchCommitCount';
    return provenance.latestDelta === undefined ||
      provenance.latestDelta.commitSha === provenance.headSha
      ? undefined
      : 'latestDelta.commitSha must match headSha';
  }),
);
export type WorktreeCommitProvenance = typeof WorktreeCommitProvenanceSchema.Type;

/** Persisted detached review checkout pinned to one immutable worker head. */
export const DetachedReviewCheckoutLeaseSchema = Schema.Struct({
  createdAt: NonEmptyString,
  managerId: NonEmptyString,
  path: NonEmptyString,
  reviewedHeadSha: NonEmptyString,
  verificationId: NonEmptyString,
});
export type DetachedReviewCheckoutLease = typeof DetachedReviewCheckoutLeaseSchema.Type;
