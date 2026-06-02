import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

type Manifest = {
  hooks?: string | string[];
};

it('does not register the automatically loaded standard hooks file twice', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../.claude-plugin/plugin.json', import.meta.url)), 'utf8'),
  ) as Manifest;
  const registeredHooks =
    typeof manifest.hooks === 'string' ? [manifest.hooks] : (manifest.hooks ?? []);

  expect(registeredHooks).not.toContain('./hooks/hooks.json');
});
