import { Data } from 'effect';
import type { ReportExcerptField } from './schemas.ts';

export type ReportArtifactErrorReason =
  | 'invalid_id'
  | 'not_found'
  | 'redirected'
  | 'unusual'
  | 'too_large'
  | 'invalid_json'
  | 'invalid_schema'
  | 'unavailable';

export class ReportArtifactError extends Data.TaggedError('ReportArtifactError')<{
  readonly reportId: string;
  readonly reason: ReportArtifactErrorReason;
  readonly cause?: unknown;
}> {}

export class ReportArtifactWriteError extends Data.TaggedError('ReportArtifactWriteError')<{
  readonly reportId: string;
  readonly cause: unknown;
}> {}

export class ReportWriteLimitExceededError extends Data.TaggedError(
  'ReportWriteLimitExceededError',
)<{
  readonly field: 'summary' | 'details';
}> {}

export class ReportInputValidationError extends Data.TaggedError('ReportInputValidationError')<{
  readonly boundary: 'report_get';
  readonly cause: string;
}> {}

export class ReportFieldUnavailableError extends Data.TaggedError('ReportFieldUnavailableError')<{
  readonly reportId: string;
  readonly field: ReportExcerptField;
}> {}
