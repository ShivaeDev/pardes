import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test } from 'vitest';
import pardesManager, { isNormalUserInputSource } from './index.ts';
import { requiredValue } from './test-support.ts';

const temporaryDirectories: string[] = [];
const originalStateDir = process.env.PARDES_PI_STATE_DIR;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
  if (originalStateDir === undefined) delete process.env.PARDES_PI_STATE_DIR;
  else process.env.PARDES_PI_STATE_DIR = originalStateDir;
});

function registeredEvents(factory: (pi: ExtensionAPI) => void): ReadonlyArray<string> {
  const events: string[] = [];
  factory({
    on(event: string) {
      events.push(event);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    registerTool() {},
  } as unknown as ExtensionAPI);
  return events;
}

describe('Pardes package extension registration', () => {
  test('installs coordinating-manager compaction plus report-delivery settlement observation', () => {
    const events = registeredEvents(pardesManager);

    expect(events.filter((event) => event === 'session_before_compact')).toHaveLength(2);
    expect(events.filter((event) => event === 'session_compact')).toHaveLength(2);
    expect(events).toContain('input');
  });

  test('uses the supported input source field only for normal user messages', () => {
    expect(isNormalUserInputSource('interactive')).toBe(true);
    expect(isNormalUserInputSource('rpc')).toBe(true);
    expect(isNormalUserInputSource('extension')).toBe(false);
  });

  test('routes /pardes config to the persisted presentation owner without manager activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-config-command-'));
    temporaryDirectories.push(root);
    process.env.PARDES_PI_STATE_DIR = root;
    let pardesCommand: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    pardesManager({
      on() {},
      registerCommand(
        name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) {
        if (name === 'pardes') pardesCommand = options.handler;
      },
      registerMessageRenderer() {},
      registerShortcut() {},
      registerTool() {},
    } as unknown as ExtensionAPI);
    const notifications: unknown[] = [];
    const ctx = {
      hasUI: false,
      ui: { notify: (...args: unknown[]) => notifications.push(args) },
    } as unknown as ExtensionCommandContext;

    await requiredValue(pardesCommand)('config', ctx);

    expect(notifications).toEqual([['Pardes verbose tool results: off.', 'info']]);
  });
});
