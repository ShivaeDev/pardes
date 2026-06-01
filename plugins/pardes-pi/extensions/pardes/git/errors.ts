import { Data } from 'effect';

/** Raw argv diagnostics stay structured here; model-facing rendering is owned by the caller. */
export class GitCommandError extends Data.TaggedError('GitCommandError')<{
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly cause: unknown;
}> {}

export class RepositoryError extends Data.TaggedError('RepositoryError')<{
  readonly operation: string;
  readonly cwd: string;
  readonly cause: unknown;
}> {}

export type RemoteBaselineFailure =
  | 'missing_remote'
  | 'missing_default_branch'
  | 'fetch_failed'
  | 'invalid_override'
  | 'non_commit_resolution';

/** Raw Git diagnostics remain nested; model-facing rendering allowlists the bounded reason. */
export class RemoteBaselineError extends Data.TaggedError('RemoteBaselineError')<{
  readonly reason: RemoteBaselineFailure;
  readonly cause?: unknown;
}> {}

export class WorktreeError extends Data.TaggedError('WorktreeError')<{
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export class WorktreeLockError extends Data.TaggedError('WorktreeLockError')<{
  readonly lockPath: string;
  readonly busy: boolean;
  readonly cause: unknown;
}> {}

export class InvalidWorktreeInputError extends Data.TaggedError('InvalidWorktreeInputError')<{
  readonly field: string;
  readonly message: string;
}> {}

export class InvalidManagedLeaseError extends Data.TaggedError('InvalidManagedLeaseError')<{
  readonly reason: string;
}> {}

export class DirtyWorktreeError extends Data.TaggedError('DirtyWorktreeError')<{
  readonly path: string;
  readonly changedPaths: ReadonlyArray<string>;
}> {}
