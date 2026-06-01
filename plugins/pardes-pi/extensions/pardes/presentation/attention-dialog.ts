import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type Focusable,
  Input,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';

export const ATTENTION_HANDOFF_PROMPT_MAX_CHARS = 256;
export const ATTENTION_HANDOFF_FEEDBACK_MAX_CHARS = 4_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal prompt sanitization intentionally strips control ranges.
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export type AttentionHandoffDialogResult =
  | { readonly kind: 'submitted'; readonly feedback: string }
  | { readonly kind: 'cancelled' };

export interface AttentionHandoffPalette {
  readonly accent: (text: string) => string;
  readonly warning: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly border: (text: string) => string;
  readonly borderMuted: (text: string) => string;
  readonly bold: (text: string) => string;
}

interface AttentionHandoffDialogOptions {
  readonly prompt: string;
  readonly palette: AttentionHandoffPalette;
  readonly requestRender: () => void;
  readonly onDone: (result: AttentionHandoffDialogResult) => void;
}

/** Keep model-authored prompt text inert before placing it in terminal-rendered UI. */
export function sanitizeAttentionHandoffPrompt(prompt: string): string {
  const normalized = prompt.replace(TERMINAL_CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= ATTENTION_HANDOFF_PROMPT_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, ATTENTION_HANDOFF_PROMPT_MAX_CHARS - 1)}…`;
}

function themePalette(theme: Theme): AttentionHandoffPalette {
  return {
    accent: (text) => theme.fg('accent', text),
    bold: (text) => theme.bold(text),
    border: (text) => theme.fg('borderAccent', text),
    borderMuted: (text) => theme.fg('borderMuted', text),
    dim: (text) => theme.fg('dim', text),
    muted: (text) => theme.fg('muted', text),
    warning: (text) => theme.fg('warning', text),
  };
}

/** Compact Pardes-owned one-line feedback input. The chat report remains above it. */
export class PardesAttentionHandoffDialog implements Component, Focusable {
  private readonly prompt: string;
  private readonly palette: AttentionHandoffPalette;
  private readonly requestRender: () => void;
  private readonly input = new Input();

  constructor(options: AttentionHandoffDialogOptions) {
    this.prompt = sanitizeAttentionHandoffPrompt(options.prompt);
    this.palette = options.palette;
    this.requestRender = options.requestRender;
    this.input.onSubmit = (feedback) => options.onDone({ feedback, kind: 'submitted' });
    this.input.onEscape = () => options.onDone({ kind: 'cancelled' });
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(0, Math.floor(width));
    if (renderWidth === 0) return [];
    const inputWidth = Math.max(1, renderWidth - 4);
    const inputLine = this.input.render(inputWidth)[0] ?? '';
    return [
      this.borderLine('╭', ' ✦ Pardes attention handoff ', '╮', renderWidth, this.palette.border),
      this.frame(
        this.palette.warning(this.palette.bold(this.prompt || 'Manager needs your feedback.')),
        renderWidth,
      ),
      this.frame(this.palette.accent(inputLine), renderWidth),
      this.frame(this.palette.dim('enter submit · escape keep pending'), renderWidth),
      this.borderLine('╰', ' ✦ ', '╯', renderWidth, this.palette.borderMuted),
    ];
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.requestRender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private borderLine(
    left: string,
    label: string,
    right: string,
    width: number,
    style: (text: string) => string,
  ): string {
    if (width === 1) return style(left);
    const innerWidth = width - 2;
    const inner = truncateToWidth(
      `${label}${'─'.repeat(Math.max(0, innerWidth - visibleWidth(label)))}`,
      innerWidth,
      '',
    );
    return style(`${left}${inner}${right}`);
  }

  private frame(content: string, width: number): string {
    if (width === 1) return this.palette.borderMuted('│');
    const innerWidth = width - 2;
    const padded = truncateToWidth(` ${content}`, innerWidth, '', true);
    return `${this.palette.borderMuted('│')}${padded}${this.palette.borderMuted('│')}`;
  }
}

export async function inputPardesAttentionFeedback(
  ctx: ExtensionContext,
  prompt: string,
  signal?: AbortSignal,
): Promise<AttentionHandoffDialogResult> {
  const sanitizedPrompt = sanitizeAttentionHandoffPrompt(prompt);
  let removeAbortListener = () => {};
  try {
    const result = await ctx.ui.custom<AttentionHandoffDialogResult | undefined>(
      (tui, theme, _keybindings, done) => {
        let finished = false;
        const finish = (result: AttentionHandoffDialogResult) => {
          if (finished) return;
          finished = true;
          removeAbortListener();
          done(result);
        };
        const onAbort = () => finish({ kind: 'cancelled' });
        if (signal?.aborted) onAbort();
        else {
          signal?.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
        }
        return new PardesAttentionHandoffDialog({
          onDone: finish,
          palette: themePalette(theme),
          prompt: sanitizedPrompt,
          requestRender: () => tui.requestRender(),
        });
      },
    );
    if (result !== undefined) return result;
  } finally {
    removeAbortListener();
  }

  // RPC mode has a supported dialog sub-protocol but no interactive custom TUI.
  const feedback = await ctx.ui.input(
    'Pardes attention handoff',
    sanitizedPrompt,
    signal === undefined ? undefined : { signal },
  );
  return feedback === undefined ? { kind: 'cancelled' } : { feedback, kind: 'submitted' };
}
