import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bumpVersion,
  manifestVersion,
  nextVersionIntroductionCommit,
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

function commitManifest(root: string, raw: string, message: string): string {
  const manifest = join(root, 'plugins/example/.claude-plugin/plugin.json');
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, raw);
  git(root, ['add', '--', 'plugins/example/.claude-plugin/plugin.json']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
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
    expect(script.indexOf('validateBumpCommit();')).toBeLessThan(script.indexOf("git(['push'"));
    expect(workflow).toContain('run: bun install --frozen-lockfile');
    expect(workflow).toContain('astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b');
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
