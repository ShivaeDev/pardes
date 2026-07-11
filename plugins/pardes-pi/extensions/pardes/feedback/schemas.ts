import { Schema } from 'effect';

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const BoundedIdentity = NonEmptyString.check(Schema.isMaxLength(512));

export const PARDES_VERSION = '0.0.0';
export const FEEDBACK_SCHEMA_VERSION = 1;
export const FEEDBACK_TEXT_MAX_BYTES = 4 * 1_024 * 1_024;

export const FeedbackRoleSchema = Schema.Literals(['manager', 'writer', 'advisory_verifier']);
export type FeedbackRole = typeof FeedbackRoleSchema.Type;

export const FeedbackProvenanceSchema = Schema.Struct({
  agentId: Schema.optionalKey(BoundedIdentity),
  managerId: Schema.optionalKey(BoundedIdentity),
  pardesVersion: BoundedIdentity,
  repositoryKey: Schema.optionalKey(BoundedIdentity),
  role: FeedbackRoleSchema,
  sessionId: Schema.optionalKey(BoundedIdentity),
  verificationId: Schema.optionalKey(BoundedIdentity),
  workstreamId: Schema.optionalKey(BoundedIdentity),
});
export type FeedbackProvenance = typeof FeedbackProvenanceSchema.Type;

export const FeedbackSubmissionSchema = Schema.Struct({
  createdAt: NonEmptyString,
  id: NonEmptyString.check(Schema.isPattern(/^feedback-[a-f0-9-]+$/)),
  provenance: FeedbackProvenanceSchema,
  schemaVersion: Schema.Literal(FEEDBACK_SCHEMA_VERSION),
  text: NonEmptyString,
});
export type FeedbackSubmission = typeof FeedbackSubmissionSchema.Type;

export const FeedbackTriageSchema = Schema.Struct({
  addressedAt: NonEmptyString,
  feedbackId: NonEmptyString.check(Schema.isPattern(/^feedback-[a-f0-9-]+$/)),
  schemaVersion: Schema.Literal(FEEDBACK_SCHEMA_VERSION),
  status: Schema.Literal('addressed'),
});
export type FeedbackTriage = typeof FeedbackTriageSchema.Type;

export const FeedbackWatchInitializationSchema = Schema.Struct({
  boundaryAt: NonEmptyString,
  cursor: NonEmptyString.check(Schema.isMaxLength(128)),
  includeExisting: Schema.Boolean,
  schemaVersion: Schema.Literal(FEEDBACK_SCHEMA_VERSION),
  status: Schema.Literals(['initializing', 'initialized']),
});
export type FeedbackWatchInitialization = typeof FeedbackWatchInitializationSchema.Type;

export interface FeedbackEntry {
  readonly submission: FeedbackSubmission;
  readonly triage?: FeedbackTriage;
}

export interface FeedbackFilter {
  readonly addressed?: boolean;
  readonly agentId?: string;
  readonly managerId?: string;
  readonly repositoryKey?: string;
  readonly role?: FeedbackRole;
  readonly since?: string;
  readonly text?: string;
  readonly verificationId?: string;
  readonly workstreamId?: string;
}

export function matchesFeedbackFilter(entry: FeedbackEntry, filter: FeedbackFilter): boolean {
  const { provenance } = entry.submission;
  if (filter.addressed !== undefined && (entry.triage !== undefined) !== filter.addressed)
    return false;
  if (filter.agentId !== undefined && provenance.agentId !== filter.agentId) return false;
  if (filter.managerId !== undefined && provenance.managerId !== filter.managerId) return false;
  if (filter.repositoryKey !== undefined && provenance.repositoryKey !== filter.repositoryKey)
    return false;
  if (filter.role !== undefined && provenance.role !== filter.role) return false;
  if (filter.since !== undefined && entry.submission.createdAt < filter.since) return false;
  if (filter.text !== undefined && !entry.submission.text.includes(filter.text)) return false;
  if (filter.verificationId !== undefined && provenance.verificationId !== filter.verificationId)
    return false;
  if (filter.workstreamId !== undefined && provenance.workstreamId !== filter.workstreamId)
    return false;
  return true;
}
