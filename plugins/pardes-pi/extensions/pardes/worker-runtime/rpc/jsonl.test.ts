import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { attachWorkerRpcJsonl, MAX_WORKER_RPC_JSONL_LINE_LENGTH } from './jsonl.ts';

function fixture(maxLineLength?: number) {
  const stdout = new PassThrough();
  const values: unknown[] = [];
  const errors: string[] = [];
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
    expect(errors).toEqual(['Invalid JSON RPC line']);
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
    expect(errors).toEqual(['RPC JSONL line exceeded the decoding limit']);
  });

  test('rejects oversized delimited records without dropping the next record', () => {
    const { stdout, values, errors } = fixture(8);

    stdout.end('xxxxxxxxx\n{"ok":1}\n');

    expect(values).toEqual([{ ok: 1 }]);
    expect(errors).toEqual(['RPC JSONL line exceeded the decoding limit']);
  });
});
