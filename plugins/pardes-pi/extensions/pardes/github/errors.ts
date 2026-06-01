import { Data } from 'effect';

/** Raw argv diagnostics stay structured here; model-facing rendering must redact them. */
export class GitHubCommandError extends Data.TaggedError('GitHubCommandError')<{
  readonly command: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly cause: unknown;
}> {}

export class GitHubResponseError extends Data.TaggedError('GitHubResponseError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class GitHubPublicationInputError extends Data.TaggedError('GitHubPublicationInputError')<{
  readonly cause: unknown;
}> {}

export class GitHubSyncInputError extends Data.TaggedError('GitHubSyncInputError')<{
  readonly cause: unknown;
}> {}

export class GitHubWatcherInputError extends Data.TaggedError('GitHubWatcherInputError')<{
  readonly cause: unknown;
}> {}
