import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type MarketplaceEntry = {
  name?: unknown;
  source?: unknown;
};

type Marketplace = {
  plugins?: unknown;
};

type Catalog = {
  manifestDirectory: string;
  marketplacePath: string;
};

export type Plugin = {
  manifestPath: string;
  name: string;
  path: string;
};

const CATALOGS: Catalog[] = [
  {
    manifestDirectory: '.claude-plugin',
    marketplacePath: '.claude-plugin/marketplace.json',
  },
  {
    manifestDirectory: '.codex-plugin',
    marketplacePath: '.agents/plugins/marketplace.json',
  },
];

function pluginPath(source: unknown, marketplacePath: string): string {
  const raw =
    typeof source === 'string'
      ? source
      : source &&
          typeof source === 'object' &&
          'source' in source &&
          source.source === 'local' &&
          'path' in source &&
          typeof source.path === 'string'
        ? source.path
        : null;
  if (!raw) throw new Error(`${marketplacePath}: plugin source must be a local path`);

  const normalized = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`${marketplacePath}: plugin source must stay inside the repository: ${raw}`);
  }
  return normalized;
}

export function loadPlugins(root = '.'): Plugin[] {
  const plugins: Plugin[] = [];
  const names = new Map<string, string>();
  for (const catalog of CATALOGS) {
    const marketplacePath = join(root, catalog.marketplacePath);
    if (!existsSync(marketplacePath)) continue;

    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as Marketplace;
    if (!Array.isArray(marketplace.plugins)) {
      throw new Error(`${catalog.marketplacePath}: plugins must be an array`);
    }
    for (const rawEntry of marketplace.plugins) {
      if (!rawEntry || typeof rawEntry !== 'object') {
        throw new Error(`${catalog.marketplacePath}: plugin entry must be an object`);
      }
      const entry = rawEntry as MarketplaceEntry;
      if (typeof entry.name !== 'string' || !entry.name) {
        throw new Error(`${catalog.marketplacePath}: plugin name must be a non-empty string`);
      }
      if (entry.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
        throw new Error(
          `${catalog.marketplacePath}: plugin name must be a lowercase slug: ${entry.name}`,
        );
      }
      const previous = names.get(entry.name);
      if (previous) {
        throw new Error(
          `duplicate plugin name ${entry.name}: ${previous} and ${catalog.marketplacePath}; ` +
            'release tags and changelog files require unique names',
        );
      }
      names.set(entry.name, catalog.marketplacePath);

      const path = pluginPath(entry.source, catalog.marketplacePath);
      plugins.push({
        manifestPath: join(path, catalog.manifestDirectory, 'plugin.json'),
        name: entry.name,
        path,
      });
    }
  }
  return plugins;
}

export function touchedPlugins(plugins: Plugin[], changed: string[]): Plugin[] {
  return plugins.filter((plugin) =>
    changed.some((file) => file.startsWith(`${plugin.path}/`) && file !== plugin.manifestPath),
  );
}
