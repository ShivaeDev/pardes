import { Effect, Exit, Option } from 'effect';
import { describe, expect, test } from 'vitest';
import { REPORT_DETAILS_MAX_CHARS, REPORT_SUMMARY_MAX_CHARS } from '../../reporting/index.ts';
import { boundedProtocolErrorMessage, WorkerRpcWire } from './codecs.ts';

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

  test('bounds protocol error previews', () => {
    expect(boundedProtocolErrorMessage('short error')).toBe('short error');
    const bounded = boundedProtocolErrorMessage('x'.repeat(300));
    expect(bounded).toHaveLength(240);
    expect(bounded.endsWith('…')).toBe(true);
  });
});
