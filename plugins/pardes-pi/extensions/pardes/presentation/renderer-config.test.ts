import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ExtensionContext, initTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_PARDES_RENDERER_CONFIG,
  loadPardesRendererConfig,
  pardesRendererConfigPath,
  savePardesRendererConfig,
  showPardesRendererConfigOverlay,
} from './renderer-config.ts';

const temporaryDirectories: string[] = [];
const originalStateDir = process.env.PARDES_PI_STATE_DIR;

initTheme(undefined, false);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
  if (originalStateDir === undefined) delete process.env.PARDES_PI_STATE_DIR;
  else process.env.PARDES_PI_STATE_DIR = originalStateDir;
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pardes-renderer-config-'));
  temporaryDirectories.push(root);
  process.env.PARDES_PI_STATE_DIR = root;
  return root;
}

function theme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
}

describe('Pardes renderer configuration', () => {
  test('defaults closed to compact mode for absent or malformed user-level config', () => {
    const root = fixtureRoot();

    expect(pardesRendererConfigPath()).toBe(join(root, 'config.json'));
    expect(loadPardesRendererConfig()).toEqual(DEFAULT_PARDES_RENDERER_CONFIG);

    writeFileSync(pardesRendererConfigPath(), '{"renderer":{"verboseResults":"yes"}}\n');
    expect(loadPardesRendererConfig()).toEqual(DEFAULT_PARDES_RENDERER_CONFIG);
  });

  test('persists one user-level presentation preference outside manager workflow state', async () => {
    fixtureRoot();

    await Effect.runPromise(savePardesRendererConfig({ renderer: { verboseResults: true } }));

    expect(loadPardesRendererConfig()).toEqual({ renderer: { verboseResults: true } });
  });

  test('opens a small centered overlay and retains a non-interactive projection fallback', async () => {
    fixtureRoot();
    const options: unknown[] = [];
    let rendered = '';
    let component:
      | { handleInput: (data: string) => void; render: (width: number) => string[] }
      | undefined;
    const interactive = {
      hasUI: true,
      ui: {
        custom: async (
          factory: (
            tui: { requestRender: () => void },
            theme: Theme,
            keybindings: unknown,
            done: () => void,
          ) => { handleInput: (data: string) => void; render: (width: number) => string[] },
          receivedOptions: unknown,
        ) => {
          options.push(receivedOptions);
          component = factory({ requestRender() {} }, theme(), {}, () => {});
          rendered = component.render(56).join('\n');
        },
      },
    } as unknown as ExtensionContext;

    await showPardesRendererConfigOverlay(interactive);

    expect(options).toEqual([
      {
        overlay: true,
        overlayOptions: { anchor: 'center', margin: 1, maxHeight: 10, width: 56 },
      },
    ]);
    expect(rendered).toContain('Pardes configuration');
    expect(rendered).toContain('Verbose tool results');
    expect(rendered).toContain('off');
    component?.handleInput('\r');
    expect(loadPardesRendererConfig()).toEqual({ renderer: { verboseResults: true } });

    const notifications: unknown[] = [];
    const headless = {
      hasUI: false,
      ui: { notify: (...args: unknown[]) => notifications.push(args) },
    } as unknown as ExtensionContext;
    await showPardesRendererConfigOverlay(headless);
    expect(notifications).toEqual([['Pardes verbose tool results: on.', 'info']]);
  });
});
