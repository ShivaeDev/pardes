import { Data } from 'effect';

/** Raw filesystem diagnostics stay structured here; model-facing rendering is owned by the caller. */
export class StoreError extends Data.TaggedError('StoreError')<{
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export function storeError(operation: string, path: string, cause: unknown): StoreError {
  return new StoreError({ cause, operation, path });
}
