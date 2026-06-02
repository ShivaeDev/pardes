import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  test('ignores hostile host-global signing, hooks, and init-template configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-hostile-global-git-'));
    const globalConfig = join(root, 'host-global.gitconfig');
    const hooks = join(root, 'hooks');
    const hookMarker = join(root, 'hook-ran');
    const signer = join(root, 'signer');
    const signerMarker = join(root, 'signer-ran');
    const template = join(root, 'template');
    const templateMarker = 'host-template-marker';
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    mkdirSync(hooks);
    mkdirSync(template);
    writeFileSync(join(template, templateMarker), 'must not copy\n');
    writeFileSync(
      join(hooks, 'pre-commit'),
      `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\nexit 1\n`,
    );
    writeFileSync(signer, `#!/bin/sh\ntouch ${JSON.stringify(signerMarker)}\nexit 1\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    chmodSync(signer, 0o755);
    writeFileSync(
      globalConfig,
      [
        '[commit]',
        '\tgpgSign = true',
        '[core]',
        `\thooksPath = ${hooks}`,
        '[gpg]',
        `\tprogram = ${signer}`,
        '[init]',
        `\ttemplateDir = ${template}`,
        '',
      ].join('\n'),
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const repo = join(root, 'project');
      runGitFixture(root, 'init', '-b', 'main', repo);
      runGitFixture(repo, 'config', 'user.email', 'pardes@example.test');
      runGitFixture(repo, 'config', 'user.name', 'Pardes Test');
      runGitFixture(repo, 'config', 'fixture.local', 'preserved');
      writeFileSync(join(repo, 'README.md'), 'fixture\n');
      runGitFixture(repo, 'add', 'README.md');
      runGitFixture(repo, 'commit', '-m', 'fixture');

      expect(runGitFixture(repo, 'config', '--get', 'fixture.local')).toBe('preserved');
      expect(existsSync(join(repo, '.git', templateMarker))).toBe(false);
      expect(existsSync(hookMarker)).toBe(false);
      expect(existsSync(signerMarker)).toBe(false);
      expect(readGitFixtureDiagnosticsForTest()).toBe('');
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('ignores inherited repository-targeting Git environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-hostile-repository-git-env-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    const previousGitDir = process.env.GIT_DIR;
    try {
      runGitFixture(root, 'init', '-b', 'main', first);
      runGitFixture(root, 'init', '-b', 'main', second);
      process.env.GIT_DIR = join(second, '.git');

      expect(runGitFixture(first, 'rev-parse', '--git-dir')).toBe('.git');
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      rmSync(root, { force: true, recursive: true });
    }
  });

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
