import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import type { WorkerProtocolDiagnostic } from '../diagnostics.ts';
import { attachWorkerRpcJsonl, MAX_WORKER_RPC_JSONL_LINE_LENGTH } from './jsonl.ts';

function fixture(maxLineLength?: number) {
  const stdout = new PassThrough();
  const values: unknown[] = [];
  const errors: WorkerProtocolDiagnostic[] = [];
  attachWorkerRpcJsonl(stdout, {
    ...(maxLineLength === undefined ? {} : { maxLineLength }),
    onProtocolError: (message) => {
      errors.push(message);
    },
    onValue: (value) => {
      values.push(value);
    },
  });
  return { errors, stdout, values };
}

describe('worker RPC JSONL decoder', () => {
  test('decodes fragmented UTF-8, CRLF, blank, and final unterminated records', async () => {
    const { stdout, values, errors } = fixture();
    const encoded = Buffer.from('{"message":"héllo"}\r\n\n{"final":true}', 'utf8');
    const split = encoded.indexOf(Buffer.from('é')) + 1;

    stdout.write(encoded.subarray(0, split));
    stdout.write(encoded.subarray(split));
    const ended = once(stdout, 'end');
    stdout.end();
    await ended;

    expect(values).toEqual([{ message: 'héllo' }, { final: true }]);
    expect(errors).toEqual([]);
  });

  test('projects malformed records and continues decoding later records', () => {
    const { stdout, values, errors } = fixture();

    stdout.end('{"invalid":\n{"valid":true}\n');

    expect(values).toEqual([{ valid: true }]);
    expect(errors).toEqual([
      {
        countAccuracy: 'exact',
        message: 'RPC JSONL record was not valid JSON; record content was discarded.',
        omittedChars: 11,
        originalChars: 11,
        reason: 'invalid_json',
        shownChars: 0,
      },
    ]);
  });

  test('accepts a legitimate multi-megabyte local report record and continues decoding', () => {
    const { stdout, values, errors } = fixture();
    const details = `worker-authored details ${'d'.repeat(4 * 1_024 * 1_024)} tail`;
    const report = {
      isError: false,
      result: {
        details: {
          pardesWorker: { details, status: 'completed', summary: 'done', type: 'report' },
        },
      },
      toolName: 'report_to_manager',
      type: 'tool_execution_end',
    };
    const encoded = JSON.stringify(report);

    expect(encoded.length).toBeGreaterThan(1_000_000);
    expect(encoded.length).toBeLessThan(MAX_WORKER_RPC_JSONL_LINE_LENGTH);
    stdout.end(`${encoded}\n{"type":"agent_end","messages":[]}\n`);

    expect(errors).toEqual([]);
    expect(values).toHaveLength(2);
    expect((values[0] as typeof report).result.details.pardesWorker.details).toBe(details);
    expect(values[1]).toEqual({ messages: [], type: 'agent_end' });
  });

  test('bounds unterminated records, discards through their delimiter, and resumes decoding', () => {
    const { stdout, values, errors } = fixture(8);

    stdout.write('xxxxxxxxx');
    stdout.write('still oversized');
    stdout.end('\n{"ok":1}\n');

    expect(values).toEqual([{ ok: 1 }]);
    expect(errors).toEqual([
      {
        countAccuracy: 'exact',
        message:
          'RPC JSONL record exceeded the 8-character transport framing breaker; record content was discarded through its delimiter.',
        omittedChars: 24,
        originalChars: 24,
        reason: 'line_length_breaker',
        shownChars: 0,
      },
    ]);
  });

  test('excludes CRLF framing from oversized counts across chunk fragmentation', () => {
    for (const chunks of [
      ['xxxxxxxxx\r\n'],
      ['xxxxxxxxx', '\r\n'],
      ['xxxxxxxxx\r', '\n'],
      ['xxxxxxxxx', '\r', '\n'],
    ]) {
      const { stdout, values, errors } = fixture(8);

      for (const chunk of chunks) stdout.write(chunk);
      stdout.end('{"ok":1}\n');

      expect(values, JSON.stringify(chunks)).toEqual([{ ok: 1 }]);
      expect(errors, JSON.stringify(chunks)).toEqual([
        {
          countAccuracy: 'exact',
          message:
            'RPC JSONL record exceeded the 8-character transport framing breaker; record content was discarded through its delimiter.',
          omittedChars: 9,
          originalChars: 9,
          reason: 'line_length_breaker',
          shownChars: 0,
        },
      ]);
    }
  });

  test('reports a lower bound when an oversized record ends without a delimiter', async () => {
    const { stdout, values, errors } = fixture(8);

    const ended = once(stdout, 'end');
    stdout.end('unterminated oversized record');
    await ended;

    expect(values).toEqual([]);
    expect(errors).toEqual([
      {
        countAccuracy: 'lower_bound',
        message:
          'RPC JSONL record exceeded the 8-character transport framing breaker; record content was discarded through its delimiter.',
        omittedChars: 29,
        originalChars: 29,
        reason: 'line_length_breaker',
        shownChars: 0,
      },
    ]);
  });

  test('rejects oversized delimited records without dropping the next record', () => {
    const { stdout, values, errors } = fixture(8);

    stdout.end('xxxxxxxxx\n{"ok":1}\n');

    expect(values).toEqual([{ ok: 1 }]);
    expect(errors).toEqual([
      {
        countAccuracy: 'exact',
        message:
          'RPC JSONL record exceeded the 8-character transport framing breaker; record content was discarded through its delimiter.',
        omittedChars: 9,
        originalChars: 9,
        reason: 'line_length_breaker',
        shownChars: 0,
      },
    ]);
  });
});
