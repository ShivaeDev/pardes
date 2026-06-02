import { Option, Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  classifyGitHubWatcherFailure,
  GitHubCommandError,
  GitHubResponseError,
  GitHubWatcherFailureDiagnosticSchema,
  GitHubWatcherInputError,
  GitHubWatcherTimeoutError,
} from './index.ts';

function commandFailure(cause: unknown) {
  return new GitHubCommandError({ args: ['pr', 'view', '42'], cause, command: 'gh', cwd: '/tmp' });
}

describe('GitHub watcher diagnostics', () => {
  test('classifies useful watcher causes through canonical bounded summaries', () => {
    expect(
      classifyGitHubWatcherFailure(new GitHubWatcherTimeoutError({ timeout: '1 second' })),
    ).toMatchObject({ kind: 'command_timed_out' });
    expect(
      classifyGitHubWatcherFailure(commandFailure(new Error('network unavailable'))),
    ).toMatchObject({ kind: 'command_failed' });
    expect(
      classifyGitHubWatcherFailure(
        commandFailure({ stderr: 'HTTP 401: authentication required; run gh auth login' }),
      ),
    ).toMatchObject({ kind: 'authentication_likely' });
    expect(
      classifyGitHubWatcherFailure(
        commandFailure({ stderr: 'HTTP 403: secondary rate limit exceeded' }),
      ),
    ).toMatchObject({ kind: 'rate_limit_likely' });
    expect(
      classifyGitHubWatcherFailure(new GitHubResponseError({ cause: {}, operation: 'view' })),
    ).toMatchObject({ kind: 'metadata_invalid' });
    expect(classifyGitHubWatcherFailure(new GitHubWatcherInputError({ cause: {} }))).toMatchObject({
      kind: 'association_invalid',
    });
    expect(
      classifyGitHubWatcherFailure({
        _tag: 'GitHubCommandError',
        cause: 'network unavailable',
        diagnosticHint: 'ghp_untrusted_hint',
      }),
    ).toMatchObject({ kind: 'command_failed' });
    expect(classifyGitHubWatcherFailure({ _tag: 'ForwardCompatibleTypedError' })).toMatchObject({
      kind: 'unexpected_typed_error',
    });
    expect(classifyGitHubWatcherFailure(new Error('untyped'))).toMatchObject({
      kind: 'unexpected_error',
    });
  });

  test('never carries tokens, arbitrary stderr, response bodies, or logs into the durable diagnosis', () => {
    const token = 'ghp_private-token-marker';
    const stderr = `HTTP 401 authentication failed ${token} ${'verbose log body '.repeat(1_000)}`;
    const diagnostic = classifyGitHubWatcherFailure(commandFailure({ stderr }));
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toEqual({
      kind: 'authentication_likely',
      summary: 'GitHub CLI authentication likely failed; run gh auth status.',
    });
    expect(serialized.length).toBeLessThan(140);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('verbose log body');
    expect(serialized).not.toContain(stderr);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(GitHubWatcherFailureDiagnosticSchema)({
          kind: 'authentication_likely',
          summary: stderr,
        }),
      ),
    ).toBe(true);
  });
});
