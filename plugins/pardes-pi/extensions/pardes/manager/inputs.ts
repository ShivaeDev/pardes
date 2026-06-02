import { Data, Effect, Schema } from 'effect';
import {
  REMOTE_BASELINE_BRANCH_MAX_LENGTH,
  REMOTE_BASELINE_BRANCH_PATTERN,
  RemoteBaselineBranchSchema,
} from '../git/index.ts';
import {
  PULL_REQUEST_BODY_MAX_LENGTH,
  PULL_REQUEST_BRANCH_PATTERN,
  PULL_REQUEST_TITLE_MAX_LENGTH,
  PullRequestBrowserModeSchema,
  pullRequestBrowserOptionsAreCompatible,
  PullRequestBodySchema as SharedPullRequestBodySchema,
  PullRequestBranchSchema as SharedPullRequestBranchSchema,
  PullRequestTitleSchema as SharedPullRequestTitleSchema,
} from '../github/index.ts';
import { ReportExcerptRequestFields, ReportHandoffNoteSchema } from '../reporting/index.ts';
import { WorkerTitleSchema } from './domain.ts';

export const MANAGER_INPUT_ID_MAX_LENGTH = 100;
export const MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH = PULL_REQUEST_TITLE_MAX_LENGTH;
export const MANAGER_INPUT_LONG_TEXT_MAX_LENGTH = PULL_REQUEST_BODY_MAX_LENGTH;
export const MANAGER_INPUT_VALIDATION_ERROR_MAX_LENGTH = 1_000;
export const MANAGER_INPUT_ID_PATTERN = '^[a-zA-Z0-9._-]+$';
export const MANAGER_INPUT_BASELINE_BRANCH_MAX_LENGTH = REMOTE_BASELINE_BRANCH_MAX_LENGTH;
export const MANAGER_INPUT_BASELINE_BRANCH_PATTERN = REMOTE_BASELINE_BRANCH_PATTERN;
export const MANAGER_INPUT_PULL_REQUEST_BRANCH_PATTERN = PULL_REQUEST_BRANCH_PATTERN;

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1));
const ShortTextSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH),
);
const LongTextSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(MANAGER_INPUT_LONG_TEXT_MAX_LENGTH),
);

export const ManagerInputIdSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(MANAGER_INPUT_ID_MAX_LENGTH),
  Schema.isPattern(new RegExp(MANAGER_INPUT_ID_PATTERN)),
);
export const WorkstreamTitleSchema = ShortTextSchema;
export const WorkstreamObjectiveSchema = LongTextSchema;
export const AgentTaskSchema = LongTextSchema;
export const AgentMessageSchema = LongTextSchema;
export const AgentModelOverrideSchema = ShortTextSchema;
export const AgentBaselineBranchSchema = RemoteBaselineBranchSchema;
export const PullRequestTitleSchema = SharedPullRequestTitleSchema;
export const PullRequestBodySchema = SharedPullRequestBodySchema;
export const PullRequestBranchSchema = SharedPullRequestBranchSchema;
export const AgentSendBehaviorSchema = Schema.Literals(['auto', 'prompt', 'steer', 'followUp']);
export const AgentThinkingLevelSchema = Schema.Literals([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const WorkstreamIdInputSchema = Schema.Struct({
  workstreamId: ManagerInputIdSchema,
});
export type WorkstreamIdInput = typeof WorkstreamIdInputSchema.Type;

export const InboxGetInputSchema = Schema.Struct({
  eventId: ManagerInputIdSchema,
});
export type InboxGetInput = typeof InboxGetInputSchema.Type;

export const InboxAcknowledgeInputSchema = Schema.Struct({
  cursor: Schema.optionalKey(ManagerInputIdSchema),
});
export type InboxAcknowledgeInput = typeof InboxAcknowledgeInputSchema.Type;

export const AgentIdInputSchema = Schema.Struct({
  agentId: ManagerInputIdSchema,
});
export type AgentIdInput = typeof AgentIdInputSchema.Type;

export const WorkstreamCreateInputSchema = Schema.Struct({
  objective: WorkstreamObjectiveSchema,
  title: WorkstreamTitleSchema,
});
export type WorkstreamCreateInput = typeof WorkstreamCreateInputSchema.Type;

export const PullRequestCreateInputSchema = Schema.Struct({
  agentId: ManagerInputIdSchema,
  baseBranch: PullRequestBranchSchema,
  body: PullRequestBodySchema,
  browserMode: Schema.optionalKey(PullRequestBrowserModeSchema),
  openInBrowser: Schema.optionalKey(Schema.Boolean),
  title: PullRequestTitleSchema,
  workstreamId: ManagerInputIdSchema,
}).check(
  Schema.makeFilter(pullRequestBrowserOptionsAreCompatible, {
    description: 'browserMode agrees with the compatibility openInBrowser alias when both are set',
  }),
);
export type PullRequestCreateInput = typeof PullRequestCreateInputSchema.Type;

export const AgentSpawnInputSchema = Schema.Struct({
  baselineBranch: Schema.optionalKey(AgentBaselineBranchSchema),
  model: Schema.optionalKey(AgentModelOverrideSchema),
  task: AgentTaskSchema,
  thinkingLevel: Schema.optionalKey(AgentThinkingLevelSchema),
  title: Schema.optionalKey(WorkerTitleSchema),
  workstreamId: ManagerInputIdSchema,
});
export type AgentSpawnInput = typeof AgentSpawnInputSchema.Type;

export const AgentSendInputSchema = Schema.Struct({
  agentId: ManagerInputIdSchema,
  behavior: Schema.optionalKey(AgentSendBehaviorSchema),
  message: AgentMessageSchema,
});
export type AgentSendInput = typeof AgentSendInputSchema.Type;

export const AgentSendReportInputSchema = Schema.Struct({
  agentId: ManagerInputIdSchema,
  ...ReportExcerptRequestFields,
  message: Schema.optionalKey(ReportHandoffNoteSchema),
});
export type AgentSendReportInput = typeof AgentSendReportInputSchema.Type;

export const AgentReviveInputSchema = Schema.Struct({
  agentId: ManagerInputIdSchema,
  message: AgentMessageSchema,
});
export type AgentReviveInput = typeof AgentReviveInputSchema.Type;

export const AgentLeaseCleanupInputSchema = Schema.Struct({
  action: Schema.Literals(['inspect', 'cleanup']),
  agentId: ManagerInputIdSchema,
  forceDeleteUnmergedBranch: Schema.optionalKey(Schema.Boolean),
  forceDiscardDirty: Schema.optionalKey(Schema.Boolean),
});
export type AgentLeaseCleanupInput = typeof AgentLeaseCleanupInputSchema.Type;

export const VerificationRequestInputSchema = Schema.Struct({
  model: Schema.optionalKey(AgentModelOverrideSchema),
  sourceAgentId: ManagerInputIdSchema,
  task: Schema.optionalKey(AgentTaskSchema),
  thinkingLevel: Schema.optionalKey(AgentThinkingLevelSchema),
});
export type VerificationRequestInput = typeof VerificationRequestInputSchema.Type;

export const VerificationIdInputSchema = Schema.Struct({
  verificationId: ManagerInputIdSchema,
});
export type VerificationIdInput = typeof VerificationIdInputSchema.Type;

export class ManagerInputValidationError extends Data.TaggedError('ManagerInputValidationError')<{
  readonly boundary: string;
  readonly cause: string;
}> {}

function boundedValidationCause(cause: unknown): string {
  const representation = cause instanceof Error ? cause.message : String(cause);
  const normalized =
    representation.replace(/\s+/g, ' ').trim() || 'Manager input failed schema validation.';
  return normalized.length <= MANAGER_INPUT_VALIDATION_ERROR_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, MANAGER_INPUT_VALIDATION_ERROR_MAX_LENGTH - 1)}…`;
}

export function decodeManagerInput<A, I, R>(
  boundary: string,
  schema: Schema.Codec<A, I, R>,
  input: unknown,
): Effect.Effect<A, ManagerInputValidationError, R> {
  return Schema.decodeUnknownEffect(schema, { errors: 'all', onExcessProperty: 'error' })(
    input,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ManagerInputValidationError({ boundary, cause: boundedValidationCause(cause) }),
    ),
  );
}

export const decodeWorkstreamIdInput = (input: unknown) =>
  decodeManagerInput('workstream_id', WorkstreamIdInputSchema, input);
export const decodeInboxGetInput = (input: unknown) =>
  decodeManagerInput('inbox_get', InboxGetInputSchema, input);
export const decodeInboxAcknowledgeInput = (input: unknown) =>
  decodeManagerInput('inbox_acknowledge', InboxAcknowledgeInputSchema, input);
export const decodeAgentIdInput = (input: unknown) =>
  decodeManagerInput('agent_id', AgentIdInputSchema, input);
export const decodeWorkstreamCreateInput = (input: unknown) =>
  decodeManagerInput('workstream_create', WorkstreamCreateInputSchema, input);
export const decodePullRequestCreateInput = (input: unknown) =>
  decodeManagerInput('pull_request_create', PullRequestCreateInputSchema, input);
export const decodeAgentSpawnInput = (input: unknown) =>
  decodeManagerInput('agent_spawn', AgentSpawnInputSchema, input);
export const decodeAgentSendInput = (input: unknown) =>
  decodeManagerInput('agent_send', AgentSendInputSchema, input);
export const decodeAgentSendReportInput = (input: unknown) =>
  decodeManagerInput('agent_send_report', AgentSendReportInputSchema, input);
export const decodeAgentReviveInput = (input: unknown) =>
  decodeManagerInput('agent_revive', AgentReviveInputSchema, input);
export const decodeAgentLeaseCleanupInput = (input: unknown) =>
  decodeManagerInput('agent_lease_cleanup', AgentLeaseCleanupInputSchema, input);
export const decodeVerificationRequestInput = (input: unknown) =>
  decodeManagerInput('verification_request', VerificationRequestInputSchema, input);
export const decodeVerificationIdInput = (input: unknown) =>
  decodeManagerInput('verification_id', VerificationIdInputSchema, input);
export const decodeVerificationRefreshInput = (input: unknown) =>
  decodeManagerInput('verification_refresh', VerificationIdInputSchema, input);
