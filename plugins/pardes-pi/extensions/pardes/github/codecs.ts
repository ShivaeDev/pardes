import { Effect, Schema } from 'effect';
import { GitHubResponseError } from './errors.ts';

function responseError(operation: string, cause: unknown): GitHubResponseError {
  return new GitHubResponseError({ cause, operation });
}

function parseJson(operation: string, source: string): Effect.Effect<unknown, GitHubResponseError> {
  return Effect.try({
    catch: (cause) => responseError(operation, cause),
    try: () => JSON.parse(source) as unknown,
  });
}

/** Decode untrusted GitHub CLI JSON through an explicit schema boundary. */
export function decodeGitHubJson<A, I, R>(
  operation: string,
  schema: Schema.Codec<A, I, R>,
  source: string,
): Effect.Effect<A, GitHubResponseError, R> {
  return parseJson(operation, source).pipe(
    Effect.flatMap((input) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.mapError((cause) => responseError(operation, cause)),
      ),
    ),
  );
}
