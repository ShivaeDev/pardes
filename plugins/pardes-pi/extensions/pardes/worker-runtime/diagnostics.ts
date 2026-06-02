export const WORKER_STDERR_TAIL_MAX_CHARS = 4_000;

export type WorkerProtocolDiagnosticReason =
  | 'invalid_json'
  | 'line_length_breaker'
  | 'invalid_response'
  | 'invalid_rpc_payload'
  | 'legacy_adapter_text_omitted'
  | 'runtime_process_error';

export type WorkerDiagnosticCountAccuracy = 'exact' | 'lower_bound' | 'unknown';

export interface WorkerTextCounts {
  readonly originalChars: number;
  readonly shownChars: number;
  readonly omittedChars: number;
}

export interface WorkerRpcRecordMetadata {
  readonly originalChars: number;
}

interface WorkerProtocolDiagnosticFields {
  readonly reason: WorkerProtocolDiagnosticReason;
  /** Fixed software-authored inert description. Never include child-authored record content. */
  readonly message: string;
  readonly shownChars: 0;
}

export type WorkerProtocolDiagnostic =
  | (WorkerProtocolDiagnosticFields & {
      readonly countAccuracy: 'unknown';
    })
  | (WorkerProtocolDiagnosticFields & {
      readonly countAccuracy: 'exact' | 'lower_bound';
      readonly originalChars: number;
      readonly omittedChars: number;
    });

export interface WorkerCompactionFailure extends WorkerTextCounts {
  readonly reason: 'child_compaction_error_message_omitted';
}

export interface WorkerStderrTail extends WorkerTextCounts {
  /** Terminal-only subprocess preview. Never persist this tail in manager state or artifacts. */
  readonly tail: string;
  readonly omissionReason?: 'stderr_tail_limit';
}

export function workerProtocolDiagnostic(
  reason: WorkerProtocolDiagnosticReason,
  message: string,
): WorkerProtocolDiagnostic;
export function workerProtocolDiagnostic(
  reason: WorkerProtocolDiagnosticReason,
  message: string,
  originalChars: number,
  countAccuracy?: Exclude<WorkerDiagnosticCountAccuracy, 'unknown'>,
): WorkerProtocolDiagnostic;
export function workerProtocolDiagnostic(
  reason: WorkerProtocolDiagnosticReason,
  message: string,
  originalChars?: number,
  countAccuracy: WorkerDiagnosticCountAccuracy = originalChars === undefined ? 'unknown' : 'exact',
): WorkerProtocolDiagnostic {
  return originalChars === undefined || countAccuracy === 'unknown'
    ? { countAccuracy: 'unknown', message, reason, shownChars: 0 }
    : { countAccuracy, message, omittedChars: originalChars, originalChars, reason, shownChars: 0 };
}

function coherentBodyFreeCounts(counts: Partial<WorkerTextCounts>): counts is WorkerTextCounts {
  return (
    Number.isSafeInteger(counts.originalChars) &&
    (counts.originalChars ?? -1) >= 0 &&
    Number.isSafeInteger(counts.omittedChars) &&
    (counts.omittedChars ?? -1) >= 0 &&
    counts.shownChars === 0 &&
    counts.originalChars === (counts.shownChars ?? 0) + (counts.omittedChars ?? 0)
  );
}

function coherentCountedDiagnostic(
  diagnostic: WorkerProtocolDiagnostic,
): diagnostic is Extract<
  WorkerProtocolDiagnostic,
  { readonly countAccuracy: 'exact' | 'lower_bound' }
> {
  return (
    (diagnostic.countAccuracy === 'exact' || diagnostic.countAccuracy === 'lower_bound') &&
    coherentBodyFreeCounts(diagnostic)
  );
}

function canonicalWorkerProtocolDiagnostic(reason: unknown): {
  readonly message: string;
  readonly reason: string;
} {
  switch (reason) {
    case 'invalid_json':
      return {
        message: 'RPC JSONL record was not valid JSON; record content was discarded.',
        reason,
      };
    case 'line_length_breaker':
      return {
        message:
          'RPC JSONL record exceeded the transport framing breaker; record content was discarded through its delimiter.',
        reason,
      };
    case 'invalid_response':
      return {
        message: 'RPC response could not be correlated or decoded; response content was discarded.',
        reason,
      };
    case 'invalid_rpc_payload':
      return { message: 'RPC event payload was invalid; payload content was discarded.', reason };
    case 'legacy_adapter_text_omitted':
      return { message: 'Legacy protocol-error adapter text was omitted.', reason };
    case 'runtime_process_error':
      return {
        message: 'Retained child process emitted an error; arbitrary process text was omitted.',
        reason,
      };
    default:
      return {
        message:
          'Worker protocol diagnostic reason was not recognized; arbitrary text was omitted.',
        reason: 'unknown_protocol_diagnostic',
      };
  }
}

/** Render only canonical labels: adapter-provided prose is never durable manager text. */
export function renderWorkerProtocolDiagnostic(diagnostic: WorkerProtocolDiagnostic): string {
  const counted = coherentCountedDiagnostic(diagnostic);
  const canonical = canonicalWorkerProtocolDiagnostic(diagnostic.reason);
  const original = counted
    ? `${diagnostic.countAccuracy === 'lower_bound' ? '>=' : ''}${String(diagnostic.originalChars)}`
    : 'unknown';
  const omitted = counted
    ? `${diagnostic.countAccuracy === 'lower_bound' ? '>=' : ''}${String(diagnostic.omittedChars)}`
    : 'unknown';
  return `[${canonical.reason}] ${canonical.message} chars(original=${original}, shown=${counted ? diagnostic.shownChars : 0}, omitted=${omitted}).`;
}

export function workerCompactionFailure(originalChars: number): WorkerCompactionFailure {
  return {
    omittedChars: originalChars,
    originalChars,
    reason: 'child_compaction_error_message_omitted',
    shownChars: 0,
  };
}

export function renderWorkerCompactionFailure(failure: WorkerCompactionFailure): string {
  const counted = coherentBodyFreeCounts(failure);
  return `[child_compaction_error_message_omitted] Child-authored compaction diagnostic text omitted. chars(original=${counted ? failure.originalChars : 'unknown'}, shown=0, omitted=${counted ? failure.omittedChars : 'unknown'}).`;
}

export function appendWorkerStderrTail(current: WorkerStderrTail, chunk: string): WorkerStderrTail {
  const originalChars = current.originalChars + chunk.length;
  const tail = `${current.tail}${chunk}`.slice(-WORKER_STDERR_TAIL_MAX_CHARS);
  const shownChars = tail.length;
  const omittedChars = Math.max(0, originalChars - shownChars);
  return {
    omittedChars,
    originalChars,
    shownChars,
    tail,
    ...(omittedChars === 0 ? {} : { omissionReason: 'stderr_tail_limit' as const }),
  };
}

export function emptyWorkerStderrTail(): WorkerStderrTail {
  return { omittedChars: 0, originalChars: 0, shownChars: 0, tail: '' };
}
