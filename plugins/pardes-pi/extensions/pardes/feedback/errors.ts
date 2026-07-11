import { Data } from 'effect';

export class FeedbackStoreError extends Data.TaggedError('FeedbackStoreError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class FeedbackNotFoundError extends Data.TaggedError('FeedbackNotFoundError')<{
  readonly feedbackId: string;
}> {}
