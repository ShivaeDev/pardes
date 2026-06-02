import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type Keybinding,
  type KeybindingsManager,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

export const QUESTION_CUSTOM_LABEL = 'Type a custom answer…';
export const QUESTION_DIALOG_MAX_VISIBLE_OPTIONS = 5;
export const QUESTION_PROMPT_MAX_CHARS = 1_000;
export const QUESTION_OPTION_LABEL_MAX_CHARS = 256;
export const QUESTION_OPTION_DESCRIPTION_MAX_CHARS = 1_000;
export const QUESTION_OPTIONS_MAX_ITEMS = 12;
export const QUESTION_CUSTOM_ANSWER_MAX_CHARS = 4_000;

const QUESTION_MAX_LINES = 3;
const OPTION_LABEL_MAX_LINES = 2;
const OPTION_DESCRIPTION_MAX_LINES = 2;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal question sanitization intentionally strips control ranges.
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface QuestionDialogOption {
  readonly label: string;
  readonly description?: string;
}

export type QuestionDialogChoice =
  | { readonly kind: 'option'; readonly index: number; readonly value: string }
  | { readonly kind: 'custom' };

export interface QuestionDialogPalette {
  readonly accent: (text: string) => string;
  readonly bold: (text: string) => string;
  readonly text: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly border: (text: string) => string;
  readonly borderMuted: (text: string) => string;
  readonly selected: (text: string) => string;
}

interface DisplayOption extends QuestionDialogOption {
  readonly custom: boolean;
}

interface QuestionDialogOptions {
  readonly question: string;
  readonly options: ReadonlyArray<QuestionDialogOption>;
  readonly allowCustom: boolean;
  readonly palette: QuestionDialogPalette;
  readonly keybindings: KeybindingsManager;
  readonly requestRender: () => void;
  readonly onDone: (choice: QuestionDialogChoice | null) => void;
}

function boundedInertText(text: string, maxChars: number): string {
  const sanitized = text.replace(TERMINAL_CONTROL_CHARACTERS, ' ');
  return sanitized.length <= maxChars ? sanitized : `${sanitized.slice(0, maxChars - 1)}…`;
}

function sanitizeQuestionPrompt(question: string): string {
  return boundedInertText(question, QUESTION_PROMPT_MAX_CHARS);
}

export function sanitizeQuestionOptionLabel(label: string): string {
  return boundedInertText(label, QUESTION_OPTION_LABEL_MAX_CHARS);
}

function sanitizeQuestionOption(option: QuestionDialogOption): QuestionDialogOption {
  return {
    label: sanitizeQuestionOptionLabel(option.label),
    ...(option.description === undefined
      ? {}
      : {
          description: boundedInertText(option.description, QUESTION_OPTION_DESCRIPTION_MAX_CHARS),
        }),
  };
}

export function sanitizeQuestionCustomAnswer(answer: string): string | undefined {
  const sanitized = answer.replace(TERMINAL_CONTROL_CHARACTERS, ' ').trim();
  return sanitized.length <= QUESTION_CUSTOM_ANSWER_MAX_CHARS ? sanitized : undefined;
}

function displayValue(option: QuestionDialogOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

interface FallbackQuestionChoice {
  readonly label: string;
  readonly choice: QuestionDialogChoice;
}

function fallbackQuestionChoices(
  options: ReadonlyArray<QuestionDialogOption>,
  allowCustom: boolean,
): ReadonlyArray<FallbackQuestionChoice> {
  const choices: ReadonlyArray<FallbackQuestionChoice> = [
    ...options.map((option, index) => {
      const value = displayValue(option);
      return { choice: { index, kind: 'option', value }, label: value } as const;
    }),
    ...(allowCustom ? [{ choice: { kind: 'custom' } as const, label: QUESTION_CUSTOM_LABEL }] : []),
  ];
  if (new Set(choices.map(({ label }) => label)).size === choices.length) return choices;
  return choices.map(({ label, choice }, index) => ({ choice, label: `${index + 1}. ${label}` }));
}

function themePalette(theme: Theme): QuestionDialogPalette {
  return {
    accent: (text) => theme.fg('accent', text),
    bold: (text) => theme.bold(text),
    border: (text) => theme.fg('borderAccent', text),
    borderMuted: (text) => theme.fg('borderMuted', text),
    dim: (text) => theme.fg('dim', text),
    muted: (text) => theme.fg('muted', text),
    selected: (text) => theme.bg('selectedBg', text),
    text: (text) => theme.fg('text', text),
  };
}

function boundedWrappedLines(text: string, width: number, maxLines: number): string[] {
  const lines = wrapTextWithAnsi(text, Math.max(1, width));
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  visible[maxLines - 1] = truncateToWidth(`${visible[maxLines - 1]}…`, Math.max(1, width), '…');
  return visible;
}

export class PardesQuestionDialog implements Component {
  private readonly question: string;
  private readonly options: ReadonlyArray<DisplayOption>;
  private readonly palette: QuestionDialogPalette;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly onDone: (choice: QuestionDialogChoice | null) => void;
  private selectedIndex = 0;

  constructor(options: QuestionDialogOptions) {
    this.question = sanitizeQuestionPrompt(options.question);
    this.options = [
      ...options.options.map((option) => ({ ...sanitizeQuestionOption(option), custom: false })),
      ...(options.allowCustom ? [{ custom: true, label: QUESTION_CUSTOM_LABEL }] : []),
    ];
    this.palette = options.palette;
    this.keybindings = options.keybindings;
    this.requestRender = options.requestRender;
    this.onDone = options.onDone;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(0, Math.floor(width));
    if (renderWidth === 0) return [];

    const lines: string[] = [];
    const contentWidth = Math.max(1, renderWidth - 4);
    const [start, end] = this.visibleRange();

    lines.push(this.topBorder(renderWidth));
    lines.push(this.frame(this.palette.accent(this.palette.bold('Pardes decision')), renderWidth));
    lines.push(this.frame('', renderWidth));
    for (const line of boundedWrappedLines(this.question, contentWidth, QUESTION_MAX_LINES)) {
      lines.push(this.frame(this.palette.text(line), renderWidth));
    }
    lines.push(this.separator(renderWidth));

    for (let index = start; index < end; index += 1) {
      const option = this.options[index];
      if (!option) continue;
      lines.push(...this.optionLines(option, index, contentWidth, renderWidth));
      if (index < end - 1) lines.push(this.frame('', renderWidth));
    }

    if (this.options.length > QUESTION_DIALOG_MAX_VISIBLE_OPTIONS) {
      lines.push(this.frame('', renderWidth));
      lines.push(
        this.frame(
          this.palette.dim(`Showing ${start + 1}–${end} of ${this.options.length}`),
          renderWidth,
        ),
      );
    }

    lines.push(this.separator(renderWidth));
    lines.push(this.frame(this.palette.dim(this.helpText()), renderWidth));
    lines.push(this.bottomBorder(renderWidth));
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, 'tui.select.up')) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.down')) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.pageUp')) {
      this.pageSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.pageDown')) {
      this.pageSelection(1);
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.confirm')) {
      const selected = this.options[this.selectedIndex];
      if (!selected) return;
      this.onDone(
        selected.custom
          ? { kind: 'custom' }
          : { index: this.selectedIndex, kind: 'option', value: displayValue(selected) },
      );
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.cancel')) this.onDone(null);
  }

  invalidate(): void {}

  private optionLines(
    option: DisplayOption,
    index: number,
    contentWidth: number,
    renderWidth: number,
  ): string[] {
    const selected = index === this.selectedIndex;
    const marker = selected ? '▶ ' : '  ';
    const prefix = `${marker}${index + 1}. `;
    const continuation = ' '.repeat(visibleWidth(prefix));
    const available = Math.max(1, contentWidth - visibleWidth(prefix));
    const labels = boundedWrappedLines(option.label, available, OPTION_LABEL_MAX_LINES);
    const lines = labels.map((label, labelIndex) => {
      const content = `${labelIndex === 0 ? prefix : continuation}${label}`;
      return this.frame(
        selected ? this.palette.accent(this.palette.bold(content)) : this.palette.text(content),
        renderWidth,
        selected,
      );
    });

    if (option.description) {
      const descriptionPrefix = ' '.repeat(visibleWidth(prefix));
      const descriptionWidth = Math.max(1, contentWidth - visibleWidth(descriptionPrefix));
      for (const description of boundedWrappedLines(
        option.description,
        descriptionWidth,
        OPTION_DESCRIPTION_MAX_LINES,
      )) {
        lines.push(
          this.frame(
            this.palette.muted(`${descriptionPrefix}${description}`),
            renderWidth,
            selected,
          ),
        );
      }
    }

    return lines;
  }

  private moveSelection(delta: number): void {
    if (this.options.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.options.length) % this.options.length;
    this.requestRender();
  }

  private pageSelection(delta: number): void {
    if (this.options.length === 0) return;
    const next = this.selectedIndex + delta * QUESTION_DIALOG_MAX_VISIBLE_OPTIONS;
    this.selectedIndex = Math.max(0, Math.min(next, this.options.length - 1));
    this.requestRender();
  }

  private visibleRange(): readonly [number, number] {
    const visible = Math.min(this.options.length, QUESTION_DIALOG_MAX_VISIBLE_OPTIONS);
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(visible / 2), this.options.length - visible),
    );
    return [start, start + visible];
  }

  private helpText(): string {
    const up = this.bindingLabel('tui.select.up', 'up');
    const down = this.bindingLabel('tui.select.down', 'down');
    const confirm = this.bindingLabel('tui.select.confirm', 'enter');
    const cancel = this.bindingLabel('tui.select.cancel', 'escape');
    return `${up}/${down} navigate · ${confirm} select · ${cancel} cancel`;
  }

  private bindingLabel(keybinding: Keybinding, fallback: string): string {
    return this.keybindings.getKeys(keybinding)[0] ?? fallback;
  }

  private topBorder(width: number): string {
    return this.borderLine('╭', ' Pardes question ', '╮', width, this.palette.border);
  }

  private separator(width: number): string {
    return this.borderLine('├', '', '┤', width, this.palette.borderMuted);
  }

  private bottomBorder(width: number): string {
    return this.borderLine('╰', '', '╯', width, this.palette.border);
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

  private frame(content: string, width: number, selected = false): string {
    if (width === 1) return this.palette.borderMuted('│');
    const innerWidth = width - 2;
    const padded = truncateToWidth(` ${content}`, innerWidth, '', true);
    return `${this.palette.borderMuted('│')}${selected ? this.palette.selected(padded) : padded}${this.palette.borderMuted('│')}`;
  }
}

/**
 * Show the Pardes-owned dialog in interactive TUI mode. RPC mode degrades
 * `custom()` to `undefined`, so retain Pi's dialog protocol as a compatibility
 * fallback without changing public question semantics.
 */
export async function selectPardesQuestionOption(
  ctx: ExtensionContext,
  question: string,
  options: ReadonlyArray<QuestionDialogOption>,
  allowCustom: boolean,
): Promise<QuestionDialogChoice | null> {
  const sanitizedQuestion = sanitizeQuestionPrompt(question);
  const sanitizedOptions = options.map(sanitizeQuestionOption);
  const choice = await ctx.ui.custom<QuestionDialogChoice | null | undefined>(
    (tui, theme, keybindings, done) =>
      new PardesQuestionDialog({
        allowCustom,
        keybindings,
        onDone: done,
        options: sanitizedOptions,
        palette: themePalette(theme),
        question: sanitizedQuestion,
        requestRender: () => tui.requestRender(),
      }),
  );
  if (choice !== undefined) return choice;

  const fallbackChoices = fallbackQuestionChoices(sanitizedOptions, allowCustom);
  const selected = await ctx.ui.select(
    sanitizedQuestion,
    fallbackChoices.map(({ label }) => label),
  );
  if (!selected) return null;
  return fallbackChoices.find(({ label }) => label === selected)?.choice ?? null;
}
