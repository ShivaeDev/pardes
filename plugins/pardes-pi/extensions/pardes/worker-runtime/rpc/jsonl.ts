import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * Last-resort transport breaker measured in decoded UTF-16 code units.
 *
 * Pi emits whole lifecycle envelopes as well as compact deltas. A legitimate
 * multi-megabyte local report can therefore appear inside a larger tool-result
 * or message record before the durable artifact is persisted. Keep framing
 * generous and separate from report or presentation policy while still
 * preventing an unterminated or absurd child record from growing memory
 * without bound.
 */
export const MAX_WORKER_RPC_JSONL_LINE_LENGTH = 64 * 1_024 * 1_024;

export interface WorkerRpcJsonlCallbacks {
  readonly onValue: (value: unknown) => void;
  readonly onProtocolError: (message: string) => void;
  readonly maxLineLength?: number;
}

/**
 * Attach the tolerant streaming JSONL decoder used at the child Pi stdout
 * boundary. Invalid records are projected as protocol errors and do not stop
 * later well-formed records from reaching the supervisor.
 */
export function attachWorkerRpcJsonl(
  stdout: Pick<Readable, 'on'>,
  callbacks: WorkerRpcJsonlCallbacks,
): void {
  const decoder = new StringDecoder('utf8');
  const maxLineLength = callbacks.maxLineLength ?? MAX_WORKER_RPC_JSONL_LINE_LENGTH;
  let buffer = '';
  let discardingOversizedLine = false;

  const consume = (line: string) => {
    if (!line) return;
    if (line.length > maxLineLength) {
      callbacks.onProtocolError('RPC JSONL line exceeded the decoding limit');
      return;
    }
    try {
      callbacks.onValue(JSON.parse(line) as unknown);
    } catch {
      callbacks.onProtocolError('Invalid JSON RPC line');
    }
  };

  const push = (text: string) => {
    buffer += text;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (discardingOversizedLine) {
        if (newline === -1) {
          buffer = '';
          return;
        }
        buffer = buffer.slice(newline + 1);
        discardingOversizedLine = false;
        continue;
      }
      if (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        consume(line);
        continue;
      }
      if (buffer.length > maxLineLength) {
        buffer = '';
        discardingOversizedLine = true;
        callbacks.onProtocolError('RPC JSONL line exceeded the decoding limit');
      }
      return;
    }
  };

  stdout.on('data', (chunk: Buffer | string) => {
    push(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  });
  stdout.on('end', () => {
    push(decoder.end());
    if (discardingOversizedLine || !buffer) return;
    consume(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    buffer = '';
  });
}
