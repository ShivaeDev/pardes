import { Effect, Exit, Option } from 'effect';
import { describe, expect, test } from 'vitest';
import { REPORT_DETAILS_MAX_CHARS, REPORT_SUMMARY_MAX_CHARS } from '../../reporting/index.ts';
import { CHILD_QUESTION_CONTEXT_MAX_CHARS, CHILD_QUESTION_MAX_CHARS } from '../child-profile.ts';
import {
  renderWorkerCompactionFailure,
  renderWorkerProtocolDiagnostic,
  type WorkerCompactionFailure,
  type WorkerProtocolDiagnostic,
} from '../diagnostics.ts';
import { boundedProtocolErrorMessage, rpcPayloadDiagnostic, WorkerRpcWire } from './codecs.ts';

describe('worker RPC wire schema', () => {
  test('keeps tolerant envelope dispatch separate from targeted response decoding', () => {
    const unrelated = WorkerRpcWire.decodeEnvelope({ payload: 'ignored', type: 'future_event' });
    expect(Option.isSome(unrelated)).toBe(true);
    if (Option.isSome(unrelated)) expect(unrelated.value.type).toBe('future_event');

    expect(
      Option.isSome(
        WorkerRpcWire.decodeResponse({
          command: 'prompt',
          id: 'request-1',
          success: true,
          type: 'response',
        }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        WorkerRpcWire.decodeResponse({
          command: 'prompt',
          id: 'request-1',
          success: 'yes',
          type: 'response',
        }),
      ),
    ).toBe(true);
    expect(
      Option.isSome(
        WorkerRpcWire.decodeResponseCorrelation({
          command: 'prompt',
          id: 'request-1',
          success: 'yes',
          type: 'response',
        }),
      ),
    ).toBe(true);
  });

  test('rejects malformed sampled state through the Effect error channel', async () => {
    const state = {
      autoCompactionEnabled: true,
      followUpMode: 'one-at-a-time',
      isCompacting: false,
      isStreaming: false,
      pendingMessageCount: 0,
      sessionFile: '/tmp/session.jsonl',
      steeringMode: 'one-at-a-time',
    } as const;
    expect(await Effect.runPromise(WorkerRpcWire.decodeState(state))).toEqual(state);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          WorkerRpcWire.decodeState({ ...state, steeringMode: 'future' }),
        ),
      ),
    ).toBe(true);
  });

  test('accepts bounded child report payloads and rejects over-cap summary or details fields', () => {
    const bounded = {
      details: 'd'.repeat(REPORT_DETAILS_MAX_CHARS),
      status: 'completed',
      summary: 's'.repeat(REPORT_SUMMARY_MAX_CHARS),
      type: 'report',
    } as const;

    expect(Option.isSome(WorkerRpcWire.decodePardesReportPayload(bounded))).toBe(true);
    expect(
      Option.isNone(
        WorkerRpcWire.decodePardesReportPayload({ ...bounded, summary: `${bounded.summary}s` }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        WorkerRpcWire.decodePardesReportPayload({ ...bounded, details: `${bounded.details}d` }),
      ),
    ).toBe(true);
  });

  test('reduces oversized child compaction error fields without dropping the completion edge', () => {
    const decoded = WorkerRpcWire.decodeCompactionEndEvent({
      aborted: true,
      errorMessage: 'x'.repeat(4_097),
      reason: 'overflow',
      result: null,
      type: 'compaction_end',
      willRetry: false,
    });

    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) throw new Error('Expected decoded compaction completion');
    expect(decoded.value).toMatchObject({
      failure: {
        omittedChars: 4_097,
        originalChars: 4_097,
        reason: 'child_compaction_error_message_omitted',
        shownChars: 0,
      },
      type: 'compaction_end',
    });
    expect(decoded.value).not.toHaveProperty('errorMessage');
  });

  test('degrades malformed compaction failure counts to unknown accounting at render time', () => {
    const malformed = {
      omittedChars: -1,
      originalChars: -1,
      reason: 'child_compaction_error_message_omitted',
      shownChars: 99,
    } as unknown as WorkerCompactionFailure;

    expect(renderWorkerCompactionFailure(malformed)).toContain(
      'chars(original=unknown, shown=0, omitted=unknown)',
    );
  });

  test('codes targeted payload failures without clipping software-authored labels', () => {
    const withoutFramingMetadata = rpcPayloadDiagnostic('Invalid text_delta RPC event');
    expect(withoutFramingMetadata).toEqual({
      countAccuracy: 'unknown',
      message: 'Invalid text_delta RPC event',
      reason: 'invalid_rpc_payload',
      shownChars: 0,
    });
    expect(renderWorkerProtocolDiagnostic(withoutFramingMetadata)).toContain(
      'chars(original=unknown, shown=0, omitted=unknown)',
    );
    expect(rpcPayloadDiagnostic('Invalid text_delta RPC event', 123)).toEqual({
      countAccuracy: 'exact',
      message: 'Invalid text_delta RPC event',
      omittedChars: 123,
      originalChars: 123,
      reason: 'invalid_rpc_payload',
      shownChars: 0,
    });
  });

  test('renders canonical labels instead of forged typed diagnostic reasons or prose', () => {
    const forgedProtocol = {
      countAccuracy: 'exact',
      message: 'token=private-forged-protocol-message',
      omittedChars: 31,
      originalChars: 31,
      reason: 'token=private-forged-protocol-reason',
      shownChars: 0,
    } as unknown as WorkerProtocolDiagnostic;
    const forgedCompaction = {
      omittedChars: 29,
      originalChars: 29,
      reason: 'token=private-forged-compaction-reason',
      shownChars: 0,
    } as unknown as WorkerCompactionFailure;

    expect(renderWorkerProtocolDiagnostic(forgedProtocol)).toBe(
      '[unknown_protocol_diagnostic] Worker protocol diagnostic reason was not recognized; arbitrary text was omitted. chars(original=31, shown=0, omitted=31).',
    );
    expect(renderWorkerCompactionFailure(forgedCompaction)).toBe(
      '[child_compaction_error_message_omitted] Child-authored compaction diagnostic text omitted. chars(original=29, shown=0, omitted=29).',
    );
  });

  test('degrades malformed counted diagnostics to unknown accounting at render time', () => {
    for (const counts of [
      { omittedChars: undefined, originalChars: undefined, shownChars: 0 },
      { omittedChars: 1, originalChars: 1, shownChars: 99 },
      { omittedChars: -1, originalChars: -1, shownChars: 0 },
      { omittedChars: 1.5, originalChars: 1.5, shownChars: 0 },
      { countAccuracy: 'forged', omittedChars: 1, originalChars: 1, shownChars: 0 },
      {
        omittedChars: Number.POSITIVE_INFINITY,
        originalChars: Number.POSITIVE_INFINITY,
        shownChars: 0,
      },
    ]) {
      const incoherent = {
        countAccuracy: 'exact',
        message: 'Fixed software label.',
        reason: 'invalid_json',
        ...counts,
      } as unknown as WorkerProtocolDiagnostic;
      const rendered = renderWorkerProtocolDiagnostic(incoherent);

      expect(rendered).toContain('chars(original=unknown, shown=0, omitted=unknown)');
      expect(rendered).not.toContain('undefined');
      expect(rendered).not.toContain('Infinity');
    }
  });

  test('accepts bounded child questions and rejects oversized question or context fields', () => {
    const bounded = {
      context: 'c'.repeat(CHILD_QUESTION_CONTEXT_MAX_CHARS),
      question: 'q'.repeat(CHILD_QUESTION_MAX_CHARS),
      type: 'question',
    } as const;

    expect(Option.isSome(WorkerRpcWire.decodePardesQuestionPayload(bounded))).toBe(true);
    expect(
      Option.isNone(
        WorkerRpcWire.decodePardesQuestionPayload({
          ...bounded,
          question: `${bounded.question}q`,
        }),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        WorkerRpcWire.decodePardesQuestionPayload({
          ...bounded,
          context: `${bounded.context}c`,
        }),
      ),
    ).toBe(true);
  });

  test('bounds protocol error previews', () => {
    expect(boundedProtocolErrorMessage('short error')).toBe('short error');
    const bounded = boundedProtocolErrorMessage('x'.repeat(300));
    expect(bounded).toHaveLength(240);
    expect(bounded.endsWith('…')).toBe(true);
  });
});
