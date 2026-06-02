import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Effect } from 'effect';
import { type StoreError, storeError } from './errors.ts';
import { fsPromise } from './filesystem.ts';

/** Current manager projection must stay small enough for serialized read-modify-write mutation. */
export const STORAGE_STATE_WRITE_MAX_BYTES = 16 * 1_024 * 1_024;
/** Restore one older projection only behind a wider allocation breaker. */
export const STORAGE_STATE_ARTIFACT_MAX_BYTES = 64 * 1_024 * 1_024;
/** One append-only audit row may encode an accepted lossless detail, but not arbitrary bulk input. */
export const STORAGE_EVENT_WRITE_MAX_BYTES = 8 * 1_024 * 1_024;

function validateSerializedBytes(
  operation: string,
  path: string,
  source: string,
  maximum: number,
): Effect.Effect<void, StoreError> {
  const bytes = Buffer.byteLength(source, 'utf8');
  return bytes <= maximum
    ? Effect.void
    : Effect.fail(storeError(operation, path, `serialized artifact exceeds ${maximum} bytes`));
}

export function validateSerializedStateWrite(
  path: string,
  source: string,
): Effect.Effect<void, StoreError> {
  return validateSerializedBytes(
    'validate serialized state size',
    path,
    source,
    STORAGE_STATE_WRITE_MAX_BYTES,
  );
}

export function validateSerializedEventWrite(
  path: string,
  source: string,
): Effect.Effect<void, StoreError> {
  return validateSerializedBytes(
    'validate serialized event size',
    path,
    source,
    STORAGE_EVENT_WRITE_MAX_BYTES,
  );
}

/** Reject read-mostly legacy projections after the wider allocation breaker admits a bounded read. */
export function validateSerializedCurrentStateRead(
  path: string,
  source: string,
): Effect.Effect<void, StoreError> {
  return validateSerializedBytes(
    'reject oversized current state: operator storage recovery required',
    path,
    source,
    STORAGE_STATE_WRITE_MAX_BYTES,
  );
}

function noFollowReadOnlyFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

/** Open directly and read at most the inspected allocation plus one race-detection byte. */
export const readBoundedStateSource = Effect.fnUntraced(function* (path: string) {
  return yield* Effect.acquireUseRelease(
    fsPromise('open state', path, () => open(path, noFollowReadOnlyFlags())),
    (handle) =>
      Effect.gen(function* () {
        const stats = yield* fsPromise('inspect opened state', path, () => handle.stat());
        if (!stats.isFile())
          return yield* storeError(
            'validate state artifact type',
            path,
            'state artifact is not a direct file',
          );
        if (stats.size > STORAGE_STATE_ARTIFACT_MAX_BYTES)
          return yield* storeError(
            'validate state artifact size',
            path,
            `state artifact exceeds ${STORAGE_STATE_ARTIFACT_MAX_BYTES} bytes`,
          );
        const buffer = Buffer.alloc(stats.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = yield* fsPromise('read state', path, () =>
            handle.read(buffer, offset, buffer.length - offset, offset),
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > stats.size)
          return yield* storeError(
            'validate state artifact size',
            path,
            'state artifact grew while bounded read was in progress',
          );
        const source = buffer.subarray(0, offset).toString('utf8');
        yield* validateSerializedBytes(
          'validate state artifact size',
          path,
          source,
          STORAGE_STATE_ARTIFACT_MAX_BYTES,
        );
        return source;
      }),
    (handle) => fsPromise('close state', path, () => handle.close()).pipe(Effect.ignore),
  );
});
