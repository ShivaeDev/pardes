import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import pardesManager, { isNormalUserInputSource } from './index.ts';

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
  test('installs coordinating-manager compaction from the package root extension', () => {
    const events = registeredEvents(pardesManager);

    expect(events.filter((event) => event === 'session_before_compact')).toEqual([
      'session_before_compact',
    ]);
    expect(events).toContain('session_compact');
    expect(events).toContain('input');
  });

  test('uses the supported input source field only for normal user messages', () => {
    expect(isNormalUserInputSource('interactive')).toBe(true);
    expect(isNormalUserInputSource('rpc')).toBe(true);
    expect(isNormalUserInputSource('extension')).toBe(false);
  });
});
