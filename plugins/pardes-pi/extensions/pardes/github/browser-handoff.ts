import { execFile } from 'node:child_process';
import { Effect } from 'effect';
import type { PullRequestBrowserMode } from './schemas.ts';

export const BROWSER_OPEN_MAX_BUFFER_BYTES = 64 * 1024;
export const BROWSER_OPEN_TIMEOUT_MILLIS = 10_000;

export interface SafeBrowserOpenFailureMetadata {
  readonly kind: 'browser_open_failed';
  readonly code?: string | number;
  readonly signal?: string;
  readonly killed?: boolean;
}

export interface BrowserOpenInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface BrowserOpenRunnerShape {
  readonly run: (
    invocation: BrowserOpenInvocation,
  ) => Effect.Effect<void, SafeBrowserOpenFailureMetadata>;
}

type RequestedOpenMode = Exclude<PullRequestBrowserMode, 'none'>;

export type PullRequestBrowserHandoff =
  | { readonly requestedMode: 'none'; readonly status: 'not_requested' }
  | {
      readonly requestedMode: RequestedOpenMode;
      readonly openedMode: RequestedOpenMode;
      readonly status: 'opened';
    }
  | {
      readonly requestedMode: RequestedOpenMode;
      readonly attemptedMode: RequestedOpenMode;
      readonly failure: SafeBrowserOpenFailureMetadata;
      readonly status: 'failed';
    };

export interface BrowserHandoffShape {
  readonly handoff: (
    url: string,
    requestedMode: PullRequestBrowserMode,
  ) => Effect.Effect<PullRequestBrowserHandoff>;
}

function safeUnknownProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeBrowserOpenFailure(error: unknown): SafeBrowserOpenFailureMetadata {
  const code = safeUnknownProperty(error, 'code');
  const signal = safeUnknownProperty(error, 'signal');
  const killed = safeUnknownProperty(error, 'killed');
  return {
    kind: 'browser_open_failed',
    ...(typeof code === 'number' && Number.isSafeInteger(code)
      ? { code }
      : typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
        ? { code }
        : {}),
    ...(typeof signal === 'string' && /^[A-Z0-9_]{1,40}$/.test(signal) ? { signal } : {}),
    ...(typeof killed === 'boolean' ? { killed } : {}),
  };
}

/** Shell-free process adapter: the opener and URL are passed as fixed argv tokens. */
export function makeExecFileBrowserOpenRunner(): BrowserOpenRunnerShape {
  return {
    run: ({ args, command }) =>
      Effect.tryPromise({
        catch: safeBrowserOpenFailure,
        try: (signal) =>
          new Promise<void>((resolve, reject) => {
            execFile(
              command,
              args,
              {
                encoding: 'utf8',
                maxBuffer: BROWSER_OPEN_MAX_BUFFER_BYTES,
                shell: false,
                signal,
                timeout: BROWSER_OPEN_TIMEOUT_MILLIS,
                windowsHide: true,
              },
              (error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              },
            );
          }),
      }),
  };
}

function browserOpenPlan(
  url: string,
  requestedMode: RequestedOpenMode,
  platform: NodeJS.Platform,
): { readonly invocation: BrowserOpenInvocation; readonly openedMode: RequestedOpenMode } {
  if (platform === 'darwin') {
    return {
      invocation: { args: requestedMode === 'background' ? ['-g', url] : [url], command: 'open' },
      openedMode: requestedMode,
    };
  }
  if (platform === 'win32') {
    return {
      invocation: { args: ['url.dll,FileProtocolHandler', url], command: 'rundll32.exe' },
      openedMode: 'foreground',
    };
  }
  return {
    invocation: { args: [url], command: 'xdg-open' },
    openedMode: 'foreground',
  };
}

/**
 * Best-effort PR URL handoff. macOS supports a real background launch via `open -g`;
 * other platforms conservatively fall back to their shell-free ordinary opener.
 */
export function makeBrowserHandoff(
  options: { readonly platform?: NodeJS.Platform; readonly runner?: BrowserOpenRunnerShape } = {},
): BrowserHandoffShape {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? makeExecFileBrowserOpenRunner();
  return {
    handoff: (url, requestedMode) => {
      if (requestedMode === 'none')
        return Effect.succeed({ requestedMode, status: 'not_requested' });
      const plan = browserOpenPlan(url, requestedMode, platform);
      return runner.run(plan.invocation).pipe(
        Effect.match({
          onFailure: (failure) => ({
            attemptedMode: plan.openedMode,
            failure,
            requestedMode,
            status: 'failed' as const,
          }),
          onSuccess: () => ({
            openedMode: plan.openedMode,
            requestedMode,
            status: 'opened' as const,
          }),
        }),
      );
    },
  };
}
