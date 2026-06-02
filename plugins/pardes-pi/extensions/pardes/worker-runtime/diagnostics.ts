export const WORKER_STDERR_TAIL_MAX_CHARS = 4_000;

export type WorkerProtocolDiagnosticReason =
  | 'invalid_json'
  | 'line_length_breaker'
  | 'invalid_response'
  | 'invalid_rpc_payload'
  | 'runtime_process_error';

export type WorkerDiagnosticCountAccuracy = 'exact' | 'lower_bound';

export interface WorkerTextCounts {
  readonly originalChars: number;
  readonly shownChars: number;
  readonly omittedChars: number;
}

export interface WorkerProtocolDiagnostic extends WorkerTextCounts {
  readonly reason: WorkerProtocolDiagnosticReason;
  /** Fixed software-authored inert description. Never include child-authored record content. */
  readonly message: string;
  readonly countAccuracy: WorkerDiagnosticCountAccuracy;
}

export interface WorkerStderrTail extends WorkerTextCounts {
  /** Terminal-only subprocess preview. Never persist this tail in manager state or artifacts. */
  readonly tail: string;
  readonly omissionReason?: 'stderr_tail_limit';
}

export function workerProtocolDiagnostic(
  reason: WorkerProtocolDiagnosticReason,
  message: string,
  originalChars = 0,
  countAccuracy: WorkerDiagnosticCountAccuracy = 'exact',
): WorkerProtocolDiagnostic {
  return {
    countAccuracy,
    message,
    omittedChars: originalChars,
    originalChars,
    reason,
    shownChars: 0,
  };
}

export function renderWorkerProtocolDiagnostic(diagnostic: WorkerProtocolDiagnostic): string {
  const original =
    diagnostic.countAccuracy === 'lower_bound'
      ? `>=${diagnostic.originalChars}`
      : String(diagnostic.originalChars);
  const omitted =
    diagnostic.countAccuracy === 'lower_bound'
      ? `>=${diagnostic.omittedChars}`
      : String(diagnostic.omittedChars);
  return `[${diagnostic.reason}] ${diagnostic.message} chars(original=${original}, shown=${diagnostic.shownChars}, omitted=${omitted}).`;
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
