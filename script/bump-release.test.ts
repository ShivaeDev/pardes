import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bumpVersion,
  changedReleasePaths,
  manifestTouches,
  manifestVersion,
  nextVersionIntroductionCommit,
  requirePullRequestTarget,
  scopedGitAuthKey,
  updateManifestVersion,
  versionIntroductionCommit,
} from './bump-release';

const roots: string[] = [];

function fixture(): string {
  const root = join(tmpdir(), `pardes-release-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commitFile(root: string, path: string, body: string, message: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  git(root, ['add', '--', path]);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function commitManifest(root: string, raw: string, message: string): string {
  return commitFile(root, 'plugins/example/.claude-plugin/plugin.json', raw, message);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('bumpVersion', () => {
  it('rejects an increment that leaves the bounded semver domain', () => {
    expect(() => bumpVersion('0.0.999999999', 'patch')).toThrow('invalid plugin semver');
  });
});

describe('updateManifestVersion', () => {
  it('updates exactly the top-level manifest version and preserves earlier nested fields', () => {
    const raw =
      '{\n  "metadata": { "version": "nested" },\n  "version": "1.2.3",\n  "name": "example"\n}\n';
    const updated = updateManifestVersion(raw, '1.2.3', '1.2.4');

    expect(JSON.parse(updated)).toEqual({
      metadata: { version: 'nested' },
      name: 'example',
      version: '1.2.4',
    });
    expect(updated).toContain('"metadata": { "version": "nested" }');
    expect(manifestVersion(updated)).toBe('1.2.4');
  });

  it('rejects a manifest whose top-level version does not match the expected current version', () => {
    expect(() => updateManifestVersion('{"version":"1.2.3"}', '1.2.2', '1.2.4')).toThrow(
      'plugin manifest is not at expected version 1.2.2',
    );
  });

  it('rejects duplicate top-level version fields', () => {
    expect(() =>
      updateManifestVersion('{"version":"1.2.3","version":"1.2.3"}', '1.2.3', '1.2.4'),
    ).toThrow('plugin manifest must have exactly one top-level version field');
  });
});

describe('inline publication gate', () => {
  it('runs ready without provider/publication credentials before pushing a bump branch', () => {
    const script = readFileSync(new URL('./bump.ts', import.meta.url), 'utf8');
    const workflow = readFileSync(
      new URL('../.github/workflows/version-bump.yml', import.meta.url),
      'utf8',
    );

    expect(script).toContain('delete env.GH_TOKEN;');
    expect(script).toContain('delete env.OPENCODE_API_KEY;');
    expect(script).toContain("execFileSync('bun', ['run', 'ready'], { env, stdio: 'inherit' });");
    expect(script.indexOf('validateBumpCommit();')).toBeLessThan(
      script.indexOf("gitPublish(['push'"),
    );
    expect(script).toContain('delete process.env.GH_TOKEN;');
    expect(script).toContain('delete process.env.OPENCODE_API_KEY;');
    expect(script).toContain('GIT_CONFIG_KEY_0: scopedGitAuthKey(');
    expect(script).toContain('requirePullRequestTarget(pullRequest, expectedHead);');
    expect(script).toContain("['merge-base', '--is-ancestor', mergeSha, 'origin/main']");
    expect(script).toContain('POST-MERGE SAME-PLUGIN RACE');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('DO NOT manually tag the raced merge');
    expect(workflow).toContain('are workflow-owned');
    expect(workflow).toContain('run: bun install --frozen-lockfile');
    expect(workflow).toContain('astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b');
  });
});

describe('requirePullRequestTarget', () => {
  const head = 'a'.repeat(40);

  it('requires main base and the exact published head', () => {
    expect(requirePullRequestTarget({ baseRefName: 'main', headRefOid: head }, head)).toBe(head);
    expect(() =>
      requirePullRequestTarget({ baseRefName: 'release', headRefOid: head }, head),
    ).toThrow('bump PR base must be main');
    expect(() =>
      requirePullRequestTarget({ baseRefName: 'main', headRefOid: 'b'.repeat(40) }, head),
    ).toThrow('does not match published head');
  });
});

describe('scopedGitAuthKey', () => {
  it('scopes publication auth to the proved HTTPS GitHub server', () => {
    expect(scopedGitAuthKey('https://github.com/ShivaeDev/pardes.git', 'https://github.com')).toBe(
      'http.https://github.com/.extraheader',
    );
    expect(() =>
      scopedGitAuthKey('https://evil.example/ShivaeDev/pardes.git', 'https://github.com'),
    ).toThrow('publication Git origin must stay on configured GitHub server');
    expect(() =>
      scopedGitAuthKey('git@github.com:ShivaeDev/pardes.git', 'https://github.com'),
    ).toThrow('publication Git origin/server must be absolute URLs');
  });
});

describe('manifestTouches', () => {
  it('reports version introductions and same-version touches for ownership checks', () => {
    const root = fixture();
    const base = commitManifest(root, '{"name":"example","version":"1.0.0"}\n', 'base');
    const release = commitManifest(root, '{"name":"example","version":"1.0.1"}\n', 'release');
    const metadata = commitManifest(
      root,
      '{"description":"manual metadata","name":"example","version":"1.0.1"}\n',
      'metadata',
    );

    expect(
      manifestTouches(root, base, 'HEAD', 'plugins/example/.claude-plugin/plugin.json'),
    ).toEqual([
      { from: '1.0.0', sha: release, to: '1.0.1' },
      { from: '1.0.1', sha: metadata, to: '1.0.1' },
    ]);
  });
});

describe('changedReleasePaths', () => {
  it('detects concurrent same-plugin advancement but ignores unrelated main advancement', () => {
    const root = fixture();
    const base = commitManifest(root, '{"name":"example","version":"1.0.0"}\n', 'base');
    const samePlugin = commitFile(root, 'plugins/example/source-b.txt', 'source B\n', 'source B');
    expect(changedReleasePaths(root, base, samePlugin, ['plugins/example'])).toEqual([
      'plugins/example/source-b.txt',
    ]);

    const unrelated = commitFile(root, 'README.md', 'unrelated\n', 'unrelated');
    expect(changedReleasePaths(root, samePlugin, unrelated, ['plugins/example'])).toEqual([]);
  });
});

describe('versionIntroductionCommit', () => {
  it('returns the landing commit that introduced a version, not a later same-version manifest touch', () => {
    const root = fixture();
    commitManifest(root, '{"name":"example","version":"1.0.0"}\n', 'initial');
    const landing = commitManifest(root, '{"name":"example","version":"1.0.1"}\n', 'release');
    commitManifest(
      root,
      '{"description":"later metadata touch","name":"example","version":"1.0.1"}\n',
      'metadata',
    );

    expect(
      versionIntroductionCommit(
        root,
        'HEAD',
        'plugins/example/.claude-plugin/plugin.json',
        '1.0.1',
      ),
    ).toBe(landing);
  });

  it('recovers the earliest post-source landing when a newer release exists', () => {
    const root = fixture();
    const source = commitManifest(root, '{"name":"example","version":"1.0.0"}\n', 'source');
    const landing = commitManifest(root, '{"name":"example","version":"1.0.1"}\n', 'first release');
    commitManifest(
      root,
      '{"description":"same version","name":"example","version":"1.0.1"}\n',
      'metadata',
    );
    commitManifest(root, '{"name":"example","version":"1.1.0"}\n', 'newer release');

    expect(
      nextVersionIntroductionCommit(
        root,
        source,
        'HEAD',
        'plugins/example/.claude-plugin/plugin.json',
        '1.0.0',
      ),
    ).toEqual({ sha: landing, version: '1.0.1' });
  });
});
