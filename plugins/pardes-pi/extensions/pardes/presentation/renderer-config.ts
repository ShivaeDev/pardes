import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ExtensionContext,
  getSettingsListTheme,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { Container, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui';
import { Data, Effect, Option, Schema } from 'effect';

const PARDES_RENDERER_CONFIG_FILE = 'config.json';
const VERBOSE_RESULTS_SETTING = 'renderer.verboseResults';

const PardesRendererConfigSchema = Schema.Struct({
  renderer: Schema.Struct({
    verboseResults: Schema.Boolean,
  }),
});

export interface PardesRendererConfig {
  readonly renderer: {
    readonly verboseResults: boolean;
  };
}

export const DEFAULT_PARDES_RENDERER_CONFIG: PardesRendererConfig = {
  renderer: { verboseResults: false },
};

export class PardesRendererConfigError extends Data.TaggedError('PardesRendererConfigError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

function configRoot(): string {
  return process.env.PARDES_PI_STATE_DIR || join(homedir(), '.pi', 'agent', 'pardes');
}

export function pardesRendererConfigPath(): string {
  return join(configRoot(), PARDES_RENDERER_CONFIG_FILE);
}

function decodeRendererConfig(input: unknown): PardesRendererConfig | undefined {
  const decoded = Schema.decodeUnknownOption(PardesRendererConfigSchema)(input);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

/** Read one user-level presentation preference. Invalid or absent files fail closed to compact mode. */
export function loadPardesRendererConfig(): PardesRendererConfig {
  try {
    return (
      decodeRendererConfig(JSON.parse(readFileSync(pardesRendererConfigPath(), 'utf8'))) ??
      DEFAULT_PARDES_RENDERER_CONFIG
    );
  } catch {
    return DEFAULT_PARDES_RENDERER_CONFIG;
  }
}

/** Persist the user-level presentation preference atomically, outside manager workflow state. */
export function savePardesRendererConfig(
  config: PardesRendererConfig,
): Effect.Effect<void, PardesRendererConfigError> {
  return Effect.try({
    catch: (cause) => new PardesRendererConfigError({ cause, operation: 'save renderer config' }),
    try: () => {
      const root = configRoot();
      const target = pardesRendererConfigPath();
      const temporary = `${target}.${randomUUID()}.tmp`;
      mkdirSync(root, { recursive: true });
      try {
        writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  });
}

function configOverlayHeader(theme: Theme): Text {
  return new Text(
    `${theme.fg('accent', theme.bold('Pardes configuration'))}\n${theme.fg('dim', 'Presentation preferences for Pardes-owned tool rows')}`,
    1,
    0,
  );
}

/** Small centered terminal UI for user-level Pardes presentation configuration. */
export async function showPardesRendererConfigOverlay(ctx: ExtensionContext): Promise<void> {
  const current = loadPardesRendererConfig();
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Pardes verbose tool results: ${current.renderer.verboseResults ? 'on' : 'off'}.`,
      'info',
    );
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const items: SettingItem[] = [
        {
          currentValue: current.renderer.verboseResults ? 'on' : 'off',
          description:
            'Off keeps completed Pardes tool rows to one dense bounded line. On shows a readable bounded multi-line result. Pi tool expansion still reveals additional bounded detail.',
          id: VERBOSE_RESULTS_SETTING,
          label: 'Verbose tool results',
          values: ['off', 'on'],
        },
      ];
      const container = new Container();
      container.addChild(configOverlayHeader(theme));
      const settings = new SettingsList(
        items,
        items.length,
        getSettingsListTheme(),
        (id, newValue) => {
          if (id !== VERBOSE_RESULTS_SETTING) return;
          const next: PardesRendererConfig = {
            renderer: { verboseResults: newValue === 'on' },
          };
          try {
            Effect.runSync(savePardesRendererConfig(next));
          } catch {
            settings.updateValue(
              VERBOSE_RESULTS_SETTING,
              loadPardesRendererConfig().renderer.verboseResults ? 'on' : 'off',
            );
            ctx.ui.notify('Unable to save Pardes renderer configuration.', 'error');
            tui.requestRender();
          }
        },
        () => done(),
      );
      container.addChild(settings);
      return {
        handleInput(data: string) {
          settings.handleInput(data);
          tui.requestRender();
        },
        invalidate() {
          container.invalidate();
        },
        render(width: number) {
          return container.render(width);
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: 'center', margin: 1, maxHeight: 10, width: 56 },
    },
  );
}
