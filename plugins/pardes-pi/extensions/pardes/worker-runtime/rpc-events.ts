import { Option } from 'effect';
import {
  appendActivityLine,
  appendAssistantActivity,
  closeAssistantActivity,
  summarizeToolInvocation,
  visibleAssistantText,
} from './activity.ts';
import type { WorkerRpcRecordMetadata } from './diagnostics.ts';
import {
  type RetainedWorkerRuntime,
  recalibratingContextStats,
  runtimeEventOwnership,
  type WorkerCompactionCompletion,
  type WorkerStatus,
  type WorkerSupervisorEvent,
} from './retained-runtime.ts';
import { WorkerRpcWire } from './rpc/codecs.ts';

export interface WorkerRpcEventHandlerOptions {
  readonly now: () => number;
  readonly notify: (event: WorkerSupervisorEvent) => void;
  readonly notifyProtocolError: (
    runtime: RetainedWorkerRuntime,
    message: string,
    originalChars: number,
  ) => void;
  readonly emitTelemetry: (runtime: RetainedWorkerRuntime) => void;
  readonly setStatus: (runtime: RetainedWorkerRuntime, status: WorkerStatus) => void;
}

/** Interpret tolerant inbound Pi RPC notifications for one retained conversation. */
export function makeWorkerRpcEventHandler(options: WorkerRpcEventHandlerOptions) {
  const { emitTelemetry, notify, notifyProtocolError, now, setStatus } = options;

  return (
    runtime: RetainedWorkerRuntime,
    event: unknown,
    record: WorkerRpcRecordMetadata,
  ): void => {
    const invalidPayload = (message: string) =>
      notifyProtocolError(runtime, message, record.originalChars);
    const envelope = WorkerRpcWire.decodeEnvelope(event);
    if (Option.isNone(envelope)) return;

    if (envelope.value.type === 'message_start') {
      const decoded = WorkerRpcWire.decodeMessageStartEvent(event);
      if (Option.isNone(decoded)) {
        invalidPayload('Invalid message_start RPC event');
        return;
      }
      if (decoded.value.message.role !== 'assistant') return;
      const message = WorkerRpcWire.decodeAssistantMessage(decoded.value.message);
      if (Option.isNone(message)) {
        invalidPayload('Invalid assistant message_start RPC event');
        return;
      }
      runtime.activity = closeAssistantActivity(runtime.activity);
      runtime.assistantActivitySawDelta = false;
      runtime.assistantActivityCapturedText = false;
      return;
    }

    if (envelope.value.type === 'message_update') {
      const decoded = WorkerRpcWire.decodeMessageUpdateEvent(event);
      if (Option.isNone(decoded)) {
        invalidPayload('Invalid message_update RPC event');
        return;
      }
      const updateEnvelope = WorkerRpcWire.decodeAssistantMessageEventEnvelope(
        decoded.value.assistantMessageEvent,
      );
      if (Option.isNone(updateEnvelope)) {
        invalidPayload('Invalid assistant message_update RPC event');
        return;
      }
      if (updateEnvelope.value.type === 'text_start') {
        if (
          Option.isNone(
            WorkerRpcWire.decodeAssistantTextStartEvent(decoded.value.assistantMessageEvent),
          )
        ) {
          invalidPayload('Invalid text_start RPC event');
          return;
        }
        runtime.assistantActivitySawDelta = false;
        if (runtime.assistantActivityCapturedText)
          runtime.activity = appendAssistantActivity(runtime.activity, '\n');
        return;
      }
      if (updateEnvelope.value.type === 'text_delta') {
        const update = WorkerRpcWire.decodeAssistantTextDeltaEvent(
          decoded.value.assistantMessageEvent,
        );
        if (Option.isNone(update)) {
          invalidPayload('Invalid text_delta RPC event');
          return;
        }
        runtime.activity = appendAssistantActivity(runtime.activity, update.value.delta);
        runtime.assistantActivitySawDelta = true;
        runtime.assistantActivityCapturedText = true;
        emitTelemetry(runtime);
        return;
      }
      if (updateEnvelope.value.type === 'text_end') {
        const update = WorkerRpcWire.decodeAssistantTextEndEvent(
          decoded.value.assistantMessageEvent,
        );
        if (Option.isNone(update)) {
          invalidPayload('Invalid text_end RPC event');
          return;
        }
        if (!runtime.assistantActivitySawDelta) {
          runtime.activity = appendAssistantActivity(runtime.activity, update.value.content);
          runtime.assistantActivityCapturedText = true;
          emitTelemetry(runtime);
        }
        return;
      }
      return;
    }

    if (envelope.value.type === 'message_end') {
      const decoded = WorkerRpcWire.decodeMessageEndEvent(event);
      if (Option.isNone(decoded)) {
        invalidPayload('Invalid message_end RPC event');
        return;
      }
      if (decoded.value.message.role !== 'assistant') return;
      const message = WorkerRpcWire.decodeAssistantMessage(decoded.value.message);
      if (Option.isNone(message)) {
        invalidPayload('Invalid assistant message_end RPC event');
        return;
      }
      const text = visibleAssistantText(message.value);
      if (!runtime.assistantActivityCapturedText && text) {
        runtime.activity = appendAssistantActivity(runtime.activity, text);
        emitTelemetry(runtime);
      }
      runtime.activity = closeAssistantActivity(runtime.activity);
      return;
    }

    if (envelope.value.type === 'tool_execution_start') {
      const decoded = WorkerRpcWire.decodeToolExecutionStartEvent(event);
      if (Option.isNone(decoded)) {
        invalidPayload('Invalid tool_execution_start RPC event');
        return;
      }
      runtime.activity = closeAssistantActivity(runtime.activity);
      runtime.activity = appendActivityLine(
        runtime.activity,
        summarizeToolInvocation(decoded.value.toolName, decoded.value.args),
      );
      emitTelemetry(runtime);
      return;
    }

    if (envelope.value.type === 'agent_start') {
      if (Option.isNone(WorkerRpcWire.decodeAgentStartEvent(event))) {
        invalidPayload('Invalid agent_start RPC event');
        return;
      }
      runtime.isStreaming = true;
      setStatus(runtime, 'running');
      return;
    }

    if (envelope.value.type === 'agent_end') {
      if (Option.isNone(WorkerRpcWire.decodeAgentEndEvent(event))) {
        invalidPayload('Invalid agent_end RPC event');
        return;
      }
      runtime.isStreaming = false;
      setStatus(runtime, 'idle');
      return;
    }

    if (envelope.value.type === 'queue_update') {
      const decoded = WorkerRpcWire.decodeQueueUpdateEvent(event);
      if (Option.isNone(decoded)) {
        invalidPayload('Invalid queue_update RPC event');
        return;
      }
      runtime.steeringQueueCount = decoded.value.steering.length;
      runtime.followUpQueueCount = decoded.value.followUp.length;
      runtime.pendingMessageCount = runtime.steeringQueueCount + runtime.followUpQueueCount;
      emitTelemetry(runtime);
      return;
    }

    if (envelope.value.type === 'compaction_start') {
      const decoded = WorkerRpcWire.decodeCompactionStartEvent(event);
      if (Option.isNone(decoded)) {
        invalidPayload('Invalid compaction_start RPC event');
        return;
      }
      runtime.isCompacting = true;
      runtime.compactionReason = decoded.value.reason;
      runtime.compactionStartedAt = now();
      emitTelemetry(runtime);
      return;
    }

    if (envelope.value.type === 'compaction_end') {
      const decoded = WorkerRpcWire.decodeCompactionEndEvent(event);
      if (Option.isNone(decoded)) {
        invalidPayload('Invalid compaction_end RPC event');
        return;
      }
      const compaction: WorkerCompactionCompletion = {
        aborted: decoded.value.aborted,
        reason: decoded.value.reason,
        succeeded: decoded.value.result !== undefined && decoded.value.result !== null,
        willRetry: decoded.value.willRetry,
        ...(decoded.value.result && { tokensBefore: decoded.value.result.tokensBefore }),
        ...(decoded.value.failure === undefined ? {} : { failure: decoded.value.failure }),
        completedAt: now(),
      };
      runtime.isCompacting = false;
      runtime.compactionReason = undefined;
      runtime.compactionStartedAt = undefined;
      runtime.lastCompaction = compaction;
      runtime.completedCompactionCount += 1;
      if (compaction.succeeded) runtime.stats = recalibratingContextStats(runtime.stats);
      emitTelemetry(runtime);
      notify({
        agentId: runtime.input.agentId,
        compaction,
        type: 'compaction_completed',
        ...runtimeEventOwnership(runtime),
      });
      return;
    }

    if (envelope.value.type !== 'tool_execution_end') return;
    const decoded = WorkerRpcWire.decodeToolExecutionEndEvent(event);
    if (Option.isNone(decoded)) {
      invalidPayload('Invalid tool_execution_end RPC event');
      return;
    }
    if (
      decoded.value.isError ||
      (decoded.value.toolName !== 'report_to_manager' && decoded.value.toolName !== 'ask_manager')
    )
      return;
    const result = WorkerRpcWire.decodePardesWorkerToolResult(decoded.value.result);
    if (Option.isNone(result)) {
      invalidPayload('Invalid manager-handoff Pardes payload');
      return;
    }
    if (decoded.value.toolName === 'report_to_manager') {
      const payload = WorkerRpcWire.decodePardesReportPayload(result.value.details.pardesWorker);
      if (Option.isNone(payload)) {
        invalidPayload('Invalid report_to_manager Pardes payload');
        return;
      }
      notify({
        agentId: runtime.input.agentId,
        details: payload.value.details,
        status: payload.value.status,
        summary: payload.value.summary,
        type: 'report',
        ...runtimeEventOwnership(runtime),
      });
      return;
    }
    const payload = WorkerRpcWire.decodePardesQuestionPayload(result.value.details.pardesWorker);
    if (Option.isNone(payload)) {
      invalidPayload('Invalid ask_manager Pardes payload');
      return;
    }
    notify({
      agentId: runtime.input.agentId,
      context: payload.value.context,
      question: payload.value.question,
      type: 'question',
      ...runtimeEventOwnership(runtime),
    });
  };
}
