import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlugins, touchedPlugins } from './bump-core';

const roots: string[] = [];

function fixture(): string {
  const root = join(tmpdir(), `pardes-bump-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, '.agents/plugins'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      plugins: [{ name: 'claude-plugin', source: './plugins/claude-plugin' }],
    }),
  );
  writeFileSync(
    join(root, '.agents/plugins/marketplace.json'),
    JSON.stringify({
      plugins: [
        {
          name: 'codex-plugin',
          source: { path: './plugins/codex-plugin', source: 'local' },
        },
      ],
    }),
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('loadPlugins', () => {
  it('loads Claude and Codex plugins with their own manifest paths', () => {
    expect(loadPlugins(fixture())).toEqual([
      {
        manifestPath: 'plugins/claude-plugin/.claude-plugin/plugin.json',
        name: 'claude-plugin',
        path: 'plugins/claude-plugin',
      },
      {
        manifestPath: 'plugins/codex-plugin/.codex-plugin/plugin.json',
        name: 'codex-plugin',
        path: 'plugins/codex-plugin',
      },
    ]);
  });

  it('rejects unsafe names because tags and changelog paths are keyed by plugin name', () => {
    const root = fixture();
    writeFileSync(
      join(root, '.agents/plugins/marketplace.json'),
      JSON.stringify({
        plugins: [
          {
            name: '../escape',
            source: { path: './plugins/codex-plugin', source: 'local' },
          },
        ],
      }),
    );

    expect(() => loadPlugins(root)).toThrow('plugin name must be a lowercase slug');
  });

  it('rejects duplicate names because tags and changelogs are keyed by plugin name', () => {
    const root = fixture();
    writeFileSync(
      join(root, '.agents/plugins/marketplace.json'),
      JSON.stringify({
        plugins: [
          {
            name: 'claude-plugin',
            source: { path: './plugins/codex-plugin', source: 'local' },
          },
        ],
      }),
    );

    expect(() => loadPlugins(root)).toThrow('duplicate plugin name claude-plugin');
  });
});

describe('touchedPlugins', () => {
  it('returns every changed plugin across catalogs and ignores bot-owned manifest-only edits', () => {
    const plugins = loadPlugins(fixture());

    expect(
      touchedPlugins(plugins, [
        'plugins/claude-plugin/skills/example/SKILL.md',
        'plugins/codex-plugin/skills/example/SKILL.md',
        'plugins/codex-plugin/.codex-plugin/plugin.json',
      ]).map((plugin) => plugin.name),
    ).toEqual(['claude-plugin', 'codex-plugin']);

    expect(
      touchedPlugins(plugins, [
        'plugins/claude-plugin/.claude-plugin/plugin.json',
        'plugins/codex-plugin/.codex-plugin/plugin.json',
      ]),
    ).toEqual([]);
  });
});
