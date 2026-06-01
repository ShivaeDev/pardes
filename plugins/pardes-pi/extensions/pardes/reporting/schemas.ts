import { Schema } from 'effect';

export const REPORT_ID_MAX_LENGTH = 100;
export const REPORT_ID_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9_-]*$';
export const REPORT_EXCERPT_DEFAULT_MAX_CHARS = 4_000;
export const REPORT_EXCERPT_MAX_CHARS = 12_000;
export const REPORT_EXCERPT_MAX_OFFSET = 128 * 1_024 * 1_024;
export const REPORT_REFERENCE_SUMMARY_MAX_CHARS = 240;
/** Optional manager-authored handoff context stays subordinate to one bounded report excerpt. */
export const REPORT_HANDOFF_NOTE_MAX_CHARS = 1_000;
/** Concise durable summaries remain useful for retrieval without becoming bulk-log sinks. */
export const REPORT_SUMMARY_MAX_CHARS = 4_000;
/** Detailed local artifacts may be multi-megabyte, but one report write is still bounded. */
export const REPORT_DETAILS_MAX_CHARS = 4 * 1_024 * 1_024;

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const BoundedMetadataString = NonEmptyString.check(Schema.isMaxLength(100));
const BoundedReportSummary = NonEmptyString.check(Schema.isMaxLength(REPORT_SUMMARY_MAX_CHARS));
const BoundedReportDetails = Schema.String.check(Schema.isMaxLength(REPORT_DETAILS_MAX_CHARS));
export const ReportHandoffNoteSchema = NonEmptyString.check(
  Schema.isMaxLength(REPORT_HANDOFF_NOTE_MAX_CHARS),
);

/** Path-free manager-scoped durable artifact identifier. */
export const ReportIdSchema = NonEmptyString.check(
  Schema.isMaxLength(REPORT_ID_MAX_LENGTH),
  Schema.isPattern(new RegExp(REPORT_ID_PATTERN)),
);
export type ReportId = typeof ReportIdSchema.Type;

export const AgentReportStatusSchema = Schema.Literals(['progress', 'completed', 'blocked']);
export type AgentReportStatus = typeof AgentReportStatusSchema.Type;

const AgentReportFields = {
  agentId: BoundedMetadataString,
  createdAt: BoundedMetadataString,
  details: Schema.optionalKey(Schema.String),
  id: ReportIdSchema,
  status: AgentReportStatusSchema,
  summary: NonEmptyString,
} as const;

/** Lossless readable local artifact. Historical artifacts remain readable behind the allocation breaker. */
export const AgentReportSchema = Schema.Struct(AgentReportFields);
export type AgentReport = typeof AgentReportSchema.Type;

/** Write-side report policy. Keep separate from reads so retained historical artifacts remain retrievable. */
export const AgentReportWriteSchema = Schema.Struct({
  ...AgentReportFields,
  details: Schema.optionalKey(BoundedReportDetails),
  summary: BoundedReportSummary,
});

/** Bounded durable pointer embedded in an agent projection; never contains report details. */
export const AgentReportReferenceSchema = Schema.Struct({
  createdAt: BoundedMetadataString,
  reportId: ReportIdSchema,
  status: AgentReportStatusSchema,
  summaryTruncated: Schema.Boolean,
});
export type AgentReportReference = typeof AgentReportReferenceSchema.Type;

export const ReportExcerptFieldSchema = Schema.Literals(['summary', 'details']);
export type ReportExcerptField = typeof ReportExcerptFieldSchema.Type;

export const ReportExcerptRequestFields = {
  field: Schema.optionalKey(ReportExcerptFieldSchema),
  maxChars: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(REPORT_EXCERPT_MAX_CHARS),
    ),
  ),
  offset: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(REPORT_EXCERPT_MAX_OFFSET),
    ),
  ),
  reportId: ReportIdSchema,
} as const;

export const ReportGetInputSchema = Schema.Struct(ReportExcerptRequestFields);
export type ReportGetInput = typeof ReportGetInputSchema.Type;

export interface AgentReportCreateInput {
  readonly agentId: string;
  readonly status: AgentReportStatus;
  readonly summary: string;
  readonly details?: string;
  readonly createdAt: string;
}

export interface ReportExcerpt {
  readonly reportId: ReportId;
  readonly agentId: string;
  readonly status: AgentReportStatus;
  readonly field: ReportExcerptField;
  readonly offset: number;
  readonly returnedChars: number;
  readonly totalChars: number;
  readonly hasMore: boolean;
  readonly excerpt: string;
}

export type ReportExcerptMetadata = Omit<ReportExcerpt, 'excerpt'>;
