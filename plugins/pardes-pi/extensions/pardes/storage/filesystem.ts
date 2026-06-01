import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { Effect } from 'effect';
import { type StoreError, storeError } from './errors.ts';

export function fsPromise<A>(
  operation: string,
  path: string,
  run: () => PromiseLike<A>,
): Effect.Effect<A, StoreError> {
  return Effect.tryPromise({
    catch: (cause) => storeError(operation, path, cause),
    try: run,
  });
}

export function ensureDirectory(operation: string, path: string): Effect.Effect<void, StoreError> {
  return fsPromise(operation, path, () => mkdir(path, { recursive: true })).pipe(Effect.asVoid);
}

/** Write one JSON artifact through a sibling temp file and remove that temp file on every exit. */
export const writeJsonAtomically = Effect.fnUntraced(function* (
  path: string,
  contents: string,
  artifact: string,
) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => `${path}.${randomUUID()}.tmp`),
    (temporaryPath) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* fsPromise(`write temporary ${artifact}`, temporaryPath, () =>
            writeFile(temporaryPath, contents, 'utf8'),
          );
          yield* fsPromise(`replace ${artifact}`, path, () => rename(temporaryPath, path));
        }),
      ),
    (temporaryPath) =>
      fsPromise(`remove temporary ${artifact}`, temporaryPath, () =>
        rm(temporaryPath, { force: true }),
      ).pipe(Effect.ignore),
  );
});
