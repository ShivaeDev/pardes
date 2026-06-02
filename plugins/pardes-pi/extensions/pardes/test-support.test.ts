import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  copyGitTemplate,
  GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS,
  readGitFixtureDiagnosticsForTest,
  runGitFixture,
  runGitFixtureWithOptions,
} from './test-support.ts';

function fixtureFailure(run: () => unknown): Error {
  try {
    run();
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
  throw new Error('Expected fixture helper failure.');
}

function omittedDiagnosticChars(diagnostics: string): number {
  const match = /^\[\.\.\. (\d+) earlier diagnostic chars omitted \.\.\.\]\n/.exec(diagnostics);
  if (!match?.[1]) throw new Error('Expected bounded diagnostic omission marker.');
  return Number(match[1]);
}

describe('Git fixture test support', () => {
  test('times out stalled Git commands boundedly with actionable captured diagnostics', () => {
    const timeoutMs = 25;
    const failure = fixtureFailure(() =>
      runGitFixtureWithOptions(tmpdir(), ['-c', 'alias.wait=!while :; do :; done', 'wait'], {
        timeoutMs,
      }),
    );

    expect(failure.cause).toMatchObject({ code: 'ETIMEDOUT' });
    expect(failure.message).toContain(
      `timeout: exceeded ${timeoutMs}ms; investigate a stalled Git fixture command`,
    );
    expect(readGitFixtureDiagnosticsForTest()).toContain('spawn error: spawnSync git ETIMEDOUT');
  });

  test('preserves a spawn error cause when the fixture cwd has disappeared', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pardes-missing-fixture-cwd-'));
    rmSync(cwd, { recursive: true });

    const failure = fixtureFailure(() => runGitFixture(cwd, 'status'));

    expect(failure.cause).toMatchObject({ code: 'ENOENT' });
    expect(failure.message).toContain('spawn error: spawnSync git ENOENT');
    expect(failure.message).not.toContain('TypeError');
  });

  test('removes a partial destination root when template copy fails', () => {
    const prefix = `pardes-copy-failure-${randomUUID()}-`;
    const roots = () => readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix));
    const before = roots();

    expect(() => copyGitTemplate(join(tmpdir(), 'missing-git-fixture-template'), prefix)).toThrow();

    expect(roots()).toEqual(before);
  });

  test('strictly caps retained diagnostics and accounts for cumulative omission', () => {
    const warn = () => runGitFixture(tmpdir(), '-c', "alias.warn=!printf '%070000d' 0 >&2", 'warn');

    warn();
    const first = readGitFixtureDiagnosticsForTest();
    const firstOmitted = omittedDiagnosticChars(first);
    expect(first.length).toBeLessThanOrEqual(GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS);

    warn();
    const second = readGitFixtureDiagnosticsForTest();
    expect(second.length).toBeLessThanOrEqual(GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS);
    expect(omittedDiagnosticChars(second)).toBeGreaterThan(firstOmitted);
  });
});
