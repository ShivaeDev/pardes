import { Option, Schema } from 'effect';
import { REPORT_DETAILS_MAX_CHARS, REPORT_SUMMARY_MAX_CHARS } from '../../reporting/index.ts';
import {
  type WorkerProtocolDiagnostic,
  workerCompactionFailure,
  workerProtocolDiagnostic,
} from '../diagnostics.ts';

export interface WorkerRpcResponse {
  readonly type: 'response';
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly error?: string;
  readonly data?: unknown;
}

const NullableNumber = Schema.Union([Schema.Number, Schema.Null]);
const WorkerQueueModeSchema = Schema.Literals(['all', 'one-at-a-time']);
const WorkerCompactionReasonSchema = Schema.Literals(['manual', 'threshold', 'overflow']);
const WorkerRpcEnvelopeSchema = Schema.Struct({
  type: Schema.String,
});
const WorkerRpcSuccessResponseSchema = Schema.Struct({
  command: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.String),
  success: Schema.Literal(true),
  type: Schema.Literal('response'),
});
const WorkerRpcFailureResponseSchema = Schema.Struct({
  command: Schema.String,
  error: Schema.String,
  id: Schema.optionalKey(Schema.String),
  success: Schema.Literal(false),
  type: Schema.Literal('response'),
});
const WorkerRpcResponseSchema = Schema.Union([
  WorkerRpcSuccessResponseSchema,
  WorkerRpcFailureResponseSchema,
]);
const WorkerRpcResponseCorrelationSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('response'),
});
const WorkerRpcStateSchema = Schema.Struct({
  autoCompactionEnabled: Schema.Boolean,
  followUpMode: WorkerQueueModeSchema,
  isCompacting: Schema.Boolean,
  isStreaming: Schema.Boolean,
  pendingMessageCount: Schema.Number,
  sessionFile: Schema.optionalKey(Schema.String),
  steeringMode: WorkerQueueModeSchema,
});
const WorkerAgentStartEventSchema = Schema.Struct({
  type: Schema.Literal('agent_start'),
});
const WorkerAgentEndEventSchema = Schema.Struct({
  type: Schema.Literal('agent_end'),
});
const WorkerRpcMessageSchema = Schema.Struct({
  content: Schema.Unknown,
  role: Schema.String,
});
const WorkerAssistantMessageSchema = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  role: Schema.Literal('assistant'),
});
const WorkerAssistantTextContentSchema = Schema.Struct({
  text: Schema.String,
  type: Schema.Literal('text'),
});
const WorkerMessageStartEventSchema = Schema.Struct({
  message: WorkerRpcMessageSchema,
  type: Schema.Literal('message_start'),
});
const WorkerMessageEndEventSchema = Schema.Struct({
  message: WorkerRpcMessageSchema,
  type: Schema.Literal('message_end'),
});
const WorkerMessageUpdateEventSchema = Schema.Struct({
  assistantMessageEvent: Schema.Unknown,
  type: Schema.Literal('message_update'),
});
const WorkerAssistantMessageEventEnvelopeSchema = Schema.Struct({
  type: Schema.String,
});
const WorkerAssistantTextStartEventSchema = Schema.Struct({
  type: Schema.Literal('text_start'),
});
const WorkerAssistantTextDeltaEventSchema = Schema.Struct({
  delta: Schema.String,
  type: Schema.Literal('text_delta'),
});
const WorkerAssistantTextEndEventSchema = Schema.Struct({
  content: Schema.String,
  type: Schema.Literal('text_end'),
});
const WorkerToolExecutionStartEventSchema = Schema.Struct({
  args: Schema.Unknown,
  toolName: Schema.String,
  type: Schema.Literal('tool_execution_start'),
});
const WorkerToolExecutionEndEventSchema = Schema.Struct({
  isError: Schema.Boolean,
  result: Schema.Unknown,
  toolName: Schema.String,
  type: Schema.Literal('tool_execution_end'),
});
const WorkerQueueUpdateEventSchema = Schema.Struct({
  followUp: Schema.Array(Schema.String),
  steering: Schema.Array(Schema.String),
  type: Schema.Literal('queue_update'),
});
const WorkerCompactionStartEventSchema = Schema.Struct({
  reason: WorkerCompactionReasonSchema,
  type: Schema.Literal('compaction_start'),
});
const WorkerCompactionResultSchema = Schema.Struct({
  details: Schema.optionalKey(Schema.Unknown),
  firstKeptEntryId: Schema.String,
  summary: Schema.String,
  tokensBefore: Schema.Number,
});
const WorkerCompactionEndEventSchema = Schema.Struct({
  aborted: Schema.Boolean,
  errorMessage: Schema.optionalKey(Schema.String),
  reason: WorkerCompactionReasonSchema,
  result: Schema.optionalKey(Schema.Union([WorkerCompactionResultSchema, Schema.Null])),
  type: Schema.Literal('compaction_end'),
  willRetry: Schema.Boolean,
});
const PardesWorkerToolResultSchema = Schema.Struct({
  details: Schema.Struct({
    pardesWorker: Schema.Unknown,
  }),
});
const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const PardesReportPayloadSchema = Schema.Struct({
  details: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(REPORT_DETAILS_MAX_CHARS))),
  status: Schema.Literals(['progress', 'completed', 'blocked']),
  summary: NonEmptyString.check(Schema.isMaxLength(REPORT_SUMMARY_MAX_CHARS)),
  type: Schema.Literal('report'),
});
const PardesQuestionPayloadSchema = Schema.Struct({
  context: Schema.optionalKey(Schema.String),
  question: NonEmptyString,
  type: Schema.Literal('question'),
});
const WorkerSessionStatsSchema = Schema.Struct({
  contextUsage: Schema.optionalKey(
    Schema.Struct({
      contextWindow: Schema.Number,
      percent: NullableNumber,
      tokens: NullableNumber,
    }),
  ),
  cost: Schema.Number,
  tokens: Schema.Struct({
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    input: Schema.Number,
    output: Schema.Number,
    total: Schema.Number,
  }),
  toolCalls: Schema.Number,
  totalMessages: Schema.Number,
});

export type WorkerRpcState = typeof WorkerRpcStateSchema.Type;
export type WorkerAssistantMessage = typeof WorkerAssistantMessageSchema.Type;

const decodeRawCompactionEndEvent = Schema.decodeUnknownOption(WorkerCompactionEndEventSchema);

/** Reduce child-authored failure text immediately while preserving the lifecycle completion edge. */
function decodeCompactionEndEvent(input: unknown) {
  return Option.map(decodeRawCompactionEndEvent(input), ({ errorMessage, ...event }) => ({
    ...event,
    ...(errorMessage === undefined
      ? {}
      : { failure: workerCompactionFailure(errorMessage.length) }),
  }));
}

/** Non-throwing wire codecs for the supervisor's tolerant event dispatcher. */
export const WorkerRpcWire = {
  decodeAgentEndEvent: Schema.decodeUnknownOption(WorkerAgentEndEventSchema),
  decodeAgentStartEvent: Schema.decodeUnknownOption(WorkerAgentStartEventSchema),
  decodeAssistantMessage: Schema.decodeUnknownOption(WorkerAssistantMessageSchema),
  decodeAssistantMessageEventEnvelope: Schema.decodeUnknownOption(
    WorkerAssistantMessageEventEnvelopeSchema,
  ),
  decodeAssistantTextContent: Schema.decodeUnknownOption(WorkerAssistantTextContentSchema),
  decodeAssistantTextDeltaEvent: Schema.decodeUnknownOption(WorkerAssistantTextDeltaEventSchema),
  decodeAssistantTextEndEvent: Schema.decodeUnknownOption(WorkerAssistantTextEndEventSchema),
  decodeAssistantTextStartEvent: Schema.decodeUnknownOption(WorkerAssistantTextStartEventSchema),
  decodeCompactionEndEvent,
  decodeCompactionStartEvent: Schema.decodeUnknownOption(WorkerCompactionStartEventSchema),
  decodeEnvelope: Schema.decodeUnknownOption(WorkerRpcEnvelopeSchema),
  decodeMessageEndEvent: Schema.decodeUnknownOption(WorkerMessageEndEventSchema),
  decodeMessageStartEvent: Schema.decodeUnknownOption(WorkerMessageStartEventSchema),
  decodeMessageUpdateEvent: Schema.decodeUnknownOption(WorkerMessageUpdateEventSchema),
  decodePardesQuestionPayload: Schema.decodeUnknownOption(PardesQuestionPayloadSchema),
  decodePardesReportPayload: Schema.decodeUnknownOption(PardesReportPayloadSchema),
  decodePardesWorkerToolResult: Schema.decodeUnknownOption(PardesWorkerToolResultSchema),
  decodeQueueUpdateEvent: Schema.decodeUnknownOption(WorkerQueueUpdateEventSchema),
  decodeResponse: Schema.decodeUnknownOption(WorkerRpcResponseSchema),
  decodeResponseCorrelation: Schema.decodeUnknownOption(WorkerRpcResponseCorrelationSchema),
  decodeSessionStats: Schema.decodeUnknownEffect(WorkerSessionStatsSchema),
  decodeState: Schema.decodeUnknownEffect(WorkerRpcStateSchema),
  decodeToolExecutionEndEvent: Schema.decodeUnknownOption(WorkerToolExecutionEndEventSchema),
  decodeToolExecutionStartEvent: Schema.decodeUnknownOption(WorkerToolExecutionStartEventSchema),
} as const;

/** Project one software-authored targeted-codec label without carrying rejected child payload text. */
export function rpcPayloadDiagnostic(
  message: string,
  originalChars?: number,
): WorkerProtocolDiagnostic {
  return originalChars === undefined
    ? workerProtocolDiagnostic('invalid_rpc_payload', message)
    : workerProtocolDiagnostic('invalid_rpc_payload', message, originalChars);
}
