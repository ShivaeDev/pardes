import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import {
  BROWSER_OPEN_MAX_BUFFER_BYTES,
  BROWSER_OPEN_TIMEOUT_MILLIS,
  type BrowserOpenInvocation,
  type BrowserOpenRunnerShape,
  makeBrowserHandoff,
  makeExecFileBrowserOpenRunner,
  type SafeBrowserOpenFailureMetadata,
} from './browser-handoff.ts';

function recordingRunner(failure?: SafeBrowserOpenFailureMetadata) {
  const invocations: BrowserOpenInvocation[] = [];
  const runner: BrowserOpenRunnerShape = {
    run: (invocation) => {
      invocations.push(invocation);
      return failure === undefined ? Effect.void : Effect.fail(failure);
    },
  };
  return { invocations, runner };
}

const url = 'https://github.com/acme/project/pull/42?fixture=one;touch%20never-shell';

describe('PR browser handoff', () => {
  test('bounds shell-free opener ingestion and completion time', () => {
    expect(BROWSER_OPEN_MAX_BUFFER_BYTES).toBe(64 * 1024);
    expect(BROWSER_OPEN_TIMEOUT_MILLIS).toBe(10_000);
  });

  test('does not launch an opener for explicit none mode', async () => {
    const fixture = recordingRunner();
    const browser = makeBrowserHandoff({ platform: 'darwin', runner: fixture.runner });

    expect(await Effect.runPromise(browser.handoff(url, 'none'))).toEqual({
      requestedMode: 'none',
      status: 'not_requested',
    });
    expect(fixture.invocations).toEqual([]);
  });

  test('uses macOS open -g with the PR URL retained as one argv token for background mode', async () => {
    const fixture = recordingRunner();
    const browser = makeBrowserHandoff({ platform: 'darwin', runner: fixture.runner });

    expect(await Effect.runPromise(browser.handoff(url, 'background'))).toEqual({
      openedMode: 'background',
      requestedMode: 'background',
      status: 'opened',
    });
    expect(fixture.invocations).toEqual([{ args: ['-g', url], command: 'open' }]);
  });

  test('uses the shell-free ordinary opener as a portable background fallback', async () => {
    const fixture = recordingRunner();
    const browser = makeBrowserHandoff({ platform: 'linux', runner: fixture.runner });

    expect(await Effect.runPromise(browser.handoff(url, 'background'))).toEqual({
      openedMode: 'foreground',
      requestedMode: 'background',
      status: 'opened',
    });
    expect(fixture.invocations).toEqual([{ args: [url], command: 'xdg-open' }]);
  });

  test('uses the Windows shell-free protocol handler for ordinary foreground handoff', async () => {
    const fixture = recordingRunner();
    const browser = makeBrowserHandoff({ platform: 'win32', runner: fixture.runner });

    expect(await Effect.runPromise(browser.handoff(url, 'foreground'))).toEqual({
      openedMode: 'foreground',
      requestedMode: 'foreground',
      status: 'opened',
    });
    expect(fixture.invocations).toEqual([
      { args: ['url.dll,FileProtocolHandler', url], command: 'rundll32.exe' },
    ]);
  });

  test('returns only safe structured opener failure metadata', async () => {
    const failure = await Effect.runPromise(
      makeExecFileBrowserOpenRunner()
        .run({ args: [url], command: 'pardes-browser-opener-that-does-not-exist' })
        .pipe(Effect.flip),
    );

    expect(failure).toEqual({ code: 'ENOENT', kind: 'browser_open_failed' });
    expect(JSON.stringify(failure)).not.toContain(url);
    expect(JSON.stringify(failure)).not.toContain('pardes-browser-opener-that-does-not-exist');
  });
});
