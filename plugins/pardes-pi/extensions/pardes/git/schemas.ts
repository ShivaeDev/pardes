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

/** Persisted detached review checkout pinned to one immutable worker head. */
export const DetachedReviewCheckoutLeaseSchema = Schema.Struct({
  createdAt: NonEmptyString,
  managerId: NonEmptyString,
  path: NonEmptyString,
  reviewedHeadSha: NonEmptyString,
  verificationId: NonEmptyString,
});
export type DetachedReviewCheckoutLease = typeof DetachedReviewCheckoutLeaseSchema.Type;
