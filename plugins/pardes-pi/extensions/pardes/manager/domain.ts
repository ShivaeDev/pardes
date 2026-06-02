import { Effect, Schema, SchemaGetter } from 'effect';
import {
  DetachedReviewCheckoutLeaseSchema,
  type RepoState,
  RepoStateSchema,
  WorktreeLeaseSchema,
} from '../git/index.ts';
import {
  GitHubDiscussionCursorSchema,
  GitHubDiscussionPaginationGapsSchema,
  GitHubWatcherFailureDiagnosticSchema,
  ManagedPublishedReviewBranchSchema,
  PersistedPublishedReviewBranchSchema,
} from '../github/index.ts';
import { AgentReportReferenceSchema, ReportIdSchema } from '../reporting/index.ts';

export type { RepoState, WorktreeLease } from '../git/index.ts';
export { RepoStateSchema, WorktreeLeaseSchema } from '../git/index.ts';
export type { AgentReport } from '../reporting/index.ts';
export { AgentReportSchema } from '../reporting/index.ts';

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const FullCommitShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/));
export const WorkerTitleSchema = NonEmptyString.check(Schema.isMaxLength(80));

export const WorkstreamStatusSchema = Schema.Literals([
  'planned',
  'active',
  'complete',
  'cancelled',
]);
export type WorkstreamStatus = typeof WorkstreamStatusSchema.Type;

export const WorkstreamSchema = Schema.Struct({
  createdAt: NonEmptyString,
  id: NonEmptyString,
  objective: NonEmptyString,
  status: WorkstreamStatusSchema,
  title: NonEmptyString,
  updatedAt: NonEmptyString,
});
export type Workstream = typeof WorkstreamSchema.Type;

export const AgentGitAuditTriggerSchema = Schema.Literals([
  'completion',
  'stop',
  'auto_stop',
  'publication',
  'auto_sync',
]);
export type AgentGitAuditTrigger = typeof AgentGitAuditTriggerSchema.Type;

const AgentGitAuditSucceededSchema = Schema.Struct({
  checkedAt: NonEmptyString,
  dirty: Schema.Boolean,
  status: Schema.Literal('succeeded'),
  trigger: AgentGitAuditTriggerSchema,
});

const AgentGitAuditFailedSchema = Schema.Struct({
  checkedAt: NonEmptyString,
  failureSummary: NonEmptyString.check(Schema.isMaxLength(240)),
  status: Schema.Literal('failed'),
  trigger: AgentGitAuditTriggerSchema,
});

export const AgentGitAuditSchema = Schema.Union([
  AgentGitAuditSucceededSchema,
  AgentGitAuditFailedSchema,
]);
export type AgentGitAudit = typeof AgentGitAuditSchema.Type;

export const AgentLeaseCleanupSchema = Schema.Struct({
  branchOutcome: Schema.Literals([
    'deleted_merged',
    'deleted_unmerged',
    'preserved_unmerged',
    'already_missing',
  ]),
  cleanedAt: NonEmptyString,
  revival: Schema.Literal('disabled_no_worktree'),
  session: Schema.Literal('preserved_history_only'),
  worktreeOutcome: Schema.Literals(['removed_clean', 'discarded_dirty', 'already_missing']),
});
export type AgentLeaseCleanup = typeof AgentLeaseCleanupSchema.Type;

export const AgentRecordSchema = Schema.Struct({
  changedPaths: Schema.optionalKey(Schema.Array(NonEmptyString)),
  createdAt: NonEmptyString,
  gitAudit: Schema.optionalKey(AgentGitAuditSchema),
  id: NonEmptyString,
  lastError: Schema.optionalKey(NonEmptyString),
  latestReport: Schema.optionalKey(AgentReportReferenceSchema),
  leaseCleanup: Schema.optionalKey(AgentLeaseCleanupSchema),
  model: NonEmptyString,
  /** Stable manager-owned remote branch reservation; the manager-scoped worktree branch remains local. */
  publishedReviewBranch: Schema.optionalKey(ManagedPublishedReviewBranchSchema),
  /** Exact SHA for a transient remote ownership anchor retained until reservation finalization cleanup. */
  publishedReviewBranchClaimSha: Schema.optionalKey(FullCommitShaSchema),
  /** Durable two-phase marker: the candidate is owned locally but its create-only remote claim is unsettled. */
  publishedReviewBranchPending: Schema.optionalKey(Schema.Boolean),
  role: Schema.Literals(['explorer', 'worker', 'verifier']),
  sessionDir: NonEmptyString,
  sessionFile: Schema.optionalKey(NonEmptyString),
  status: Schema.Literals(['starting', 'running', 'idle', 'stopped', 'crashed']),
  task: NonEmptyString,
  thinkingLevel: Schema.Literals(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  title: Schema.optionalKey(WorkerTitleSchema),
  updatedAt: NonEmptyString,
  workstreamId: NonEmptyString,
  worktree: Schema.optionalKey(WorktreeLeaseSchema),
});
export type AgentRecord = typeof AgentRecordSchema.Type;

export const VERIFICATION_ATTEMPT_HISTORY_MAX = 12;

export const VerificationEvidenceStatusSchema = Schema.Literals(['current', 'stale']);
export type VerificationEvidenceStatus = typeof VerificationEvidenceStatusSchema.Type;

export const VerificationStatusSchema = Schema.Literals([
  'starting',
  'running',
  'idle',
  'completed',
  'blocked',
  'crashed',
  'stopped',
]);
export type VerificationStatus = typeof VerificationStatusSchema.Type;

const VerificationCurrentAttemptFields = {
  evidenceStatus: VerificationEvidenceStatusSchema,
  latestReport: Schema.optionalKey(AgentReportReferenceSchema),
  reviewCheckout: DetachedReviewCheckoutLeaseSchema,
  reviewedHeadSha: FullCommitShaSchema,
  sourceBranchPointSha: FullCommitShaSchema,
  staleAt: Schema.optionalKey(NonEmptyString),
  staleReason: Schema.optionalKey(NonEmptyString.check(Schema.isMaxLength(240))),
  status: VerificationStatusSchema,
};

const VerificationRecordIdentityFields = {
  id: NonEmptyString,
  model: NonEmptyString,
  sourceAgentId: NonEmptyString,
  task: NonEmptyString,
  thinkingLevel: Schema.Literals(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  verifierAgentId: NonEmptyString,
  workstreamId: NonEmptyString,
};

export const VerificationAttemptSchema = Schema.Struct({
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ...VerificationCurrentAttemptFields,
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
});
export type VerificationAttempt = typeof VerificationAttemptSchema.Type;

const CanonicalVerificationRecordSchema = Schema.Struct({
  ...VerificationRecordIdentityFields,
  attempts: Schema.Array(VerificationAttemptSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(VERIFICATION_ATTEMPT_HISTORY_MAX),
  ),
  createdAt: NonEmptyString,
  scratchCleanupPending: Schema.optionalKey(Schema.Boolean),
  updatedAt: NonEmptyString,
});

/** Schema-v1 snapshots before attempt lineage retain one current attempt at record level. */
const LegacyVerificationRecordSchema = Schema.Struct({
  ...VerificationRecordIdentityFields,
  ...VerificationCurrentAttemptFields,
  attempts: Schema.optionalKey(Schema.Never),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
});

type LegacyVerificationRecord = typeof LegacyVerificationRecordSchema.Type;

function migrateLegacyVerificationRecord(
  record: LegacyVerificationRecord,
): typeof CanonicalVerificationRecordSchema.Encoded {
  const {
    id,
    sourceAgentId,
    verifierAgentId,
    workstreamId,
    task,
    model,
    thinkingLevel,
    createdAt,
    updatedAt,
    attempts: _attempts,
    ...current
  } = record;
  return {
    attempts: [{ attempt: 1, ...current, createdAt, updatedAt }],
    createdAt,
    id,
    model,
    sourceAgentId,
    task,
    thinkingLevel,
    updatedAt,
    verifierAgentId,
    workstreamId,
  };
}

/**
 * Bounded durable advisory-review projection; report bodies remain separate
 * artifacts. The latest lineage attempt is the sole current-evidence source.
 * The encoded-side union conservatively restores schema-v1 snapshots written
 * before lineage existed and drops transitional duplicated current fields.
 */
export const VerificationRecordSchema = Schema.Union([
  CanonicalVerificationRecordSchema,
  LegacyVerificationRecordSchema,
]).pipe(
  Schema.decodeTo(CanonicalVerificationRecordSchema, {
    decode: SchemaGetter.transform((record) =>
      record.attempts === undefined ? migrateLegacyVerificationRecord(record) : record,
    ),
    encode: SchemaGetter.transform((record) => record),
  }),
);
export type VerificationRecord = typeof VerificationRecordSchema.Type;

export function currentVerificationAttempt(verification: VerificationRecord): VerificationAttempt {
  const attempt = verification.attempts.at(-1);
  if (!attempt) throw new Error('Verification record has no attempts');
  return attempt;
}

export function currentVerificationTerminalReportStatus(
  verification: VerificationRecord | undefined,
): 'completed' | 'blocked' | undefined {
  const status = verification && currentVerificationAttempt(verification).latestReport?.status;
  return status === 'completed' || status === 'blocked' ? status : undefined;
}

export const PullRequestObservationSchema = Schema.Struct({
  ci: Schema.Literals(['unknown', 'pending', 'passing', 'failing']),
  mergeable: Schema.Literals(['unknown', 'mergeable', 'conflicting']),
  number: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  reviewDecision: Schema.Literals(['unknown', 'approved', 'changes_requested', 'review_required']),
  status: Schema.Literals(['open', 'merged', 'closed']),
});
export type PullRequestObservation = typeof PullRequestObservationSchema.Type;

export const PullRequestRecordSchema = Schema.Struct({
  agentId: NonEmptyString,
  baseBranch: Schema.optionalKey(NonEmptyString),
  createdAt: NonEmptyString,
  discussionCursor: Schema.optionalKey(GitHubDiscussionCursorSchema),
  discussionPaginationGaps: Schema.optionalKey(GitHubDiscussionPaginationGapsSchema),
  draft: Schema.optionalKey(Schema.Boolean),
  headBranch: Schema.optionalKey(PersistedPublishedReviewBranchSchema),
  headDivergedAt: Schema.optionalKey(NonEmptyString),
  id: NonEmptyString,
  lastPushedHeadSha: Schema.optionalKey(FullCommitShaSchema),
  number: Schema.optionalKey(Schema.Number),
  observation: Schema.optionalKey(PullRequestObservationSchema),
  /** Exact software-audited path snapshot captured with the last successful immutable-head publication. */
  publishedChangedPaths: Schema.optionalKey(Schema.Array(NonEmptyString)),
  status: Schema.Literals(['open', 'merged', 'closed']),
  title: Schema.optionalKey(NonEmptyString),
  updatedAt: NonEmptyString,
  url: NonEmptyString,
  watcherFailedAt: Schema.optionalKey(NonEmptyString),
  watcherFailure: Schema.optionalKey(GitHubWatcherFailureDiagnosticSchema),
  workstreamId: NonEmptyString,
});
export type PullRequestRecord = typeof PullRequestRecordSchema.Type;

export const ManagerEventSchema = Schema.Struct({
  agentId: Schema.optionalKey(NonEmptyString),
  createdAt: NonEmptyString,
  id: NonEmptyString,
  /** Presentation cursors stop before this row until its bounded software outcome is durable. */
  presentationBlocked: Schema.optionalKey(Schema.Boolean),
  pullRequestId: Schema.optionalKey(NonEmptyString),
  reportId: Schema.optionalKey(ReportIdSchema),
  reportPreviewTruncated: Schema.optionalKey(Schema.Boolean),
  summary: NonEmptyString,
  type: NonEmptyString,
  verificationId: Schema.optionalKey(NonEmptyString),
  workstreamId: Schema.optionalKey(NonEmptyString),
});
export type ManagerEvent = typeof ManagerEventSchema.Type;

/** Durable cursor for the one compact Pi presentation released for an inbox batch. */
export const InboxWakeSchema = Schema.Struct({
  createdAt: NonEmptyString,
  cursor: NonEmptyString,
  pendingCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  token: NonEmptyString,
});
export type InboxWake = typeof InboxWakeSchema.Type;

/** Durable marker that the delivered cursor was explicitly surfaced for user feedback. */
export const InboxHandoffSchema = Schema.Struct({
  cursor: NonEmptyString,
  surfacedAt: NonEmptyString,
  /** Optional only so state written before marker identities were added still restores safely. */
  token: Schema.optionalKey(NonEmptyString),
});
export type InboxHandoff = typeof InboxHandoffSchema.Type;

export const ManagerStateSchema = Schema.Struct({
  agents: Schema.Record(Schema.String, AgentRecordSchema),
  inbox: Schema.Array(ManagerEventSchema),
  inboxHandoff: Schema.optionalKey(InboxHandoffSchema),
  inboxWake: Schema.optionalKey(InboxWakeSchema),
  managerId: NonEmptyString,
  pullRequests: Schema.Record(Schema.String, PullRequestRecordSchema),
  repo: RepoStateSchema,
  revision: Schema.Number,
  schemaVersion: Schema.Literal(1),
  verifications: Schema.Record(Schema.String, VerificationRecordSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  workstreams: Schema.Record(Schema.String, WorkstreamSchema),
});
export type ManagerState = typeof ManagerStateSchema.Type;

export const ManagerActivationSchema = Schema.Struct({
  enabled: Schema.Boolean,
  managerId: Schema.optionalKey(NonEmptyString),
  stateDir: Schema.optionalKey(NonEmptyString),
});
export type ManagerActivation = typeof ManagerActivationSchema.Type;

export function initialManagerState(managerId: string, repo: RepoState): ManagerState {
  return {
    agents: {},
    inbox: [],
    managerId,
    pullRequests: {},
    repo,
    revision: 0,
    schemaVersion: 1,
    verifications: {},
    workstreams: {},
  };
}
