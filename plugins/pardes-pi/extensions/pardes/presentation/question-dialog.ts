import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type Focusable,
  Input,
  type Keybinding,
  type KeybindingsManager,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

export const QUESTION_CUSTOM_LABEL = 'Type a custom answer…';
export const QUESTION_DIALOG_MAX_VISIBLE_OPTIONS = 5;
export const QUESTION_PROMPT_MAX_CHARS = 1_000;
export const QUESTION_ANSWER_MAX_CHARS = 4_000;
export const QUESTION_OPTION_LABEL_MAX_CHARS = 256;
export const QUESTION_OPTION_DESCRIPTION_MAX_CHARS = 1_000;
export const QUESTION_OPTIONS_MAX_ITEMS = 12;

const OPTION_LABEL_MAX_LINES = 2;
const OPTION_DESCRIPTION_MAX_LINES = 2;
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal question sanitization intentionally strips control ranges.
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface QuestionDialogOption {
  readonly label: string;
  readonly description?: string;
}

export type QuestionDialogChoice =
  | { readonly kind: 'option'; readonly index: number; readonly value: string }
  | {
      readonly kind: 'custom';
      readonly value?: string;
      readonly exceededMaxChars?: boolean;
    };

export interface QuestionDialogPalette {
  readonly accent: (text: string) => string;
  readonly bold: (text: string) => string;
  readonly text: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly warning: (text: string) => string;
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

/** Keep user-authored answers terminal-inert without changing ordinary Unicode text. */
export function sanitizeQuestionAnswer(answer: string): string {
  return answer.replace(TERMINAL_CONTROL_CHARACTERS, ' ');
}

function truncateQuestionAnswer(answer: string, maxChars = QUESTION_ANSWER_MAX_CHARS): string {
  const truncated = answer.slice(0, maxChars);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
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

function displayValue(option: QuestionDialogOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

interface FallbackQuestionChoice {
  readonly label: string;
  readonly choice: QuestionDialogChoice;
}

function fallbackQuestionChoices(
  options: ReadonlyArray<QuestionDialogOption>,
): ReadonlyArray<FallbackQuestionChoice> {
  const choices: ReadonlyArray<FallbackQuestionChoice> = [
    ...options.map((option, index) => {
      const value = displayValue(option);
      return { choice: { index, kind: 'option', value }, label: value } as const;
    }),
    { choice: { kind: 'custom' }, label: QUESTION_CUSTOM_LABEL },
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
    warning: (text) => theme.fg('warning', text),
  };
}

function boundedWrappedLines(text: string, width: number, maxLines: number): string[] {
  const lines = wrapTextWithAnsi(text, Math.max(1, width));
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  visible[maxLines - 1] = truncateToWidth(`${visible[maxLines - 1]}…`, Math.max(1, width), '…');
  return visible;
}

export class PardesQuestionDialog implements Component, Focusable {
  private readonly question: string;
  private readonly options: ReadonlyArray<DisplayOption>;
  private readonly palette: QuestionDialogPalette;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly onDone: (choice: QuestionDialogChoice | null) => void;
  private readonly customInput = new Input();
  private selectedIndex = 0;
  private _focused = false;
  private customInputExceededMaxChars = false;
  private bracketedPasteBuffer: string | undefined;
  private bracketedPasteContent = '';

  constructor(options: QuestionDialogOptions) {
    this.question = sanitizeQuestionPrompt(options.question);
    this.options = [
      ...options.options.map((option) => ({ ...sanitizeQuestionOption(option), custom: false })),
      { custom: true, label: QUESTION_CUSTOM_LABEL },
    ];
    this.palette = options.palette;
    this.keybindings = options.keybindings;
    this.requestRender = options.requestRender;
    this.onDone = options.onDone;
    this.customInput.onSubmit = (value) =>
      this.onDone({
        ...(this.customInputExceededMaxChars ? { exceededMaxChars: true } : {}),
        kind: 'custom',
        value,
      });
    this.customInput.onEscape = () => this.onDone(null);
    this.updateInputFocus();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.updateInputFocus();
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
    for (const line of wrapTextWithAnsi(this.question, contentWidth)) {
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
    for (const line of wrapTextWithAnsi(this.helpText(), contentWidth)) {
      lines.push(this.frame(this.palette.dim(line), renderWidth));
    }
    lines.push(this.bottomBorder(renderWidth));
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, 'tui.select.cancel')) {
      this.onDone(null);
      return;
    }
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
          ? {
              ...(this.customInputExceededMaxChars ? { exceededMaxChars: true } : {}),
              kind: 'custom',
              value: this.customInput.getValue(),
            }
          : { index: this.selectedIndex, kind: 'option', value: displayValue(selected) },
      );
      return;
    }
    if (this.options[this.selectedIndex]?.custom) {
      this.handleCustomInput(data);
      this.requestRender();
    }
  }

  invalidate(): void {
    this.customInput.invalidate();
  }

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

    if (option.custom) {
      if (selected) {
        const inputWidth = Math.max(1, contentWidth - visibleWidth(continuation));
        const inputLine = this.customInput.render(inputWidth)[0] ?? '';
        lines.push(
          this.frame(this.palette.accent(`${continuation}${inputLine}`), renderWidth, true),
        );
        if (this.customInputExceededMaxChars) {
          for (const warning of wrapTextWithAnsi(
            `Answer exceeds ${QUESTION_ANSWER_MAX_CHARS} characters and will be rejected.`,
            available,
          )) {
            lines.push(
              this.frame(this.palette.warning(`${continuation}${warning}`), renderWidth, true),
            );
          }
        }
      } else if (this.customInput.getValue()) {
        for (const valueLine of boundedWrappedLines(
          this.customInput.getValue(),
          available,
          OPTION_DESCRIPTION_MAX_LINES,
        )) {
          lines.push(this.frame(this.palette.muted(`${continuation}${valueLine}`), renderWidth));
        }
      }
      return lines;
    }

    if (option.description) {
      const descriptionWidth = Math.max(1, contentWidth - visibleWidth(continuation));
      for (const description of boundedWrappedLines(
        option.description,
        descriptionWidth,
        OPTION_DESCRIPTION_MAX_LINES,
      )) {
        lines.push(
          this.frame(this.palette.muted(`${continuation}${description}`), renderWidth, selected),
        );
      }
    }

    return lines;
  }

  private handleCustomInput(data: string): void {
    if (this.bracketedPasteBuffer !== undefined) {
      this.consumeBracketedPaste(data);
      return;
    }

    const startIndex = data.indexOf(BRACKETED_PASTE_START);
    if (startIndex < 0) {
      this.handleUnpastedCustomInput(data);
      return;
    }

    const beforePaste = data.slice(0, startIndex);
    if (beforePaste) this.handleUnpastedCustomInput(beforePaste);
    this.bracketedPasteBuffer = '';
    this.bracketedPasteContent = '';
    this.consumeBracketedPaste(data.slice(startIndex + BRACKETED_PASTE_START.length));
  }

  private handleUnpastedCustomInput(data: string): void {
    const valueLength = this.customInput.getValue().length;
    if (
      data.search(TERMINAL_CONTROL_CHARACTERS) < 0 &&
      valueLength + data.length > QUESTION_ANSWER_MAX_CHARS
    ) {
      this.customInputExceededMaxChars = true;
      const available = Math.max(0, QUESTION_ANSWER_MAX_CHARS - valueLength);
      if (available > 0) this.customInput.handleInput(truncateQuestionAnswer(data, available));
      return;
    }
    this.customInput.handleInput(data);
    this.enforceCustomInputBound();
  }

  private consumeBracketedPaste(data: string): void {
    if (this.bracketedPasteBuffer === undefined) return;
    const combined = this.bracketedPasteBuffer + data;
    const endIndex = combined.indexOf(BRACKETED_PASTE_END);
    if (endIndex >= 0) {
      this.appendBracketedPasteContent(combined.slice(0, endIndex));
      const remaining = combined.slice(endIndex + BRACKETED_PASTE_END.length);
      const pasted = this.bracketedPasteContent;
      this.bracketedPasteBuffer = undefined;
      this.bracketedPasteContent = '';
      this.customInput.handleInput(`${BRACKETED_PASTE_START}${pasted}${BRACKETED_PASTE_END}`);
      this.enforceCustomInputBound();
      if (remaining) this.handleCustomInput(remaining);
      return;
    }

    const retainedChars = Math.min(BRACKETED_PASTE_END.length - 1, combined.length);
    this.appendBracketedPasteContent(combined.slice(0, combined.length - retainedChars));
    this.bracketedPasteBuffer = combined.slice(combined.length - retainedChars);
  }

  private appendBracketedPasteContent(content: string): void {
    const sanitized = sanitizeQuestionAnswer(content);
    const available = QUESTION_ANSWER_MAX_CHARS - this.bracketedPasteContent.length;
    if (sanitized.length > available) this.customInputExceededMaxChars = true;
    if (available > 0) this.bracketedPasteContent += truncateQuestionAnswer(sanitized, available);
  }

  private enforceCustomInputBound(): void {
    const value = this.customInput.getValue();
    const sanitized = sanitizeQuestionAnswer(value);
    if (sanitized !== value) this.customInput.setValue(sanitized);
    if (sanitized.length <= QUESTION_ANSWER_MAX_CHARS) return;
    this.customInputExceededMaxChars = true;
    this.customInput.setValue(truncateQuestionAnswer(sanitized));
  }

  private moveSelection(delta: number): void {
    this.selectedIndex = (this.selectedIndex + delta + this.options.length) % this.options.length;
    this.updateInputFocus();
    this.requestRender();
  }

  private pageSelection(delta: number): void {
    const next = this.selectedIndex + delta * QUESTION_DIALOG_MAX_VISIBLE_OPTIONS;
    this.selectedIndex = Math.max(0, Math.min(next, this.options.length - 1));
    this.updateInputFocus();
    this.requestRender();
  }

  private updateInputFocus(): void {
    this.customInput.focused = this._focused && this.options[this.selectedIndex]?.custom === true;
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
    return `${up}/${down} navigate · type custom answer · ${confirm} submit/select · ${cancel} cancel`;
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
 * fallback. A free-form-only question goes directly to the RPC input fallback.
 */
export async function selectPardesQuestionOption(
  ctx: ExtensionContext,
  question: string,
  options: ReadonlyArray<QuestionDialogOption>,
  signal?: AbortSignal,
): Promise<QuestionDialogChoice | null> {
  const sanitizedQuestion = sanitizeQuestionPrompt(question);
  const sanitizedOptions = options.map(sanitizeQuestionOption);
  let removeAbortListener = () => {};
  try {
    const choice = await ctx.ui.custom<QuestionDialogChoice | null | undefined>(
      (tui, theme, keybindings, done) => {
        let finished = false;
        const finish = (result: QuestionDialogChoice | null) => {
          if (finished) return;
          finished = true;
          removeAbortListener();
          done(result);
        };
        const onAbort = () => finish(null);
        if (signal?.aborted) onAbort();
        else {
          signal?.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
        }
        return new PardesQuestionDialog({
          keybindings,
          onDone: finish,
          options: sanitizedOptions,
          palette: themePalette(theme),
          question: sanitizedQuestion,
          requestRender: () => tui.requestRender(),
        });
      },
    );
    if (choice !== undefined) return choice;
  } finally {
    removeAbortListener();
  }

  if (sanitizedOptions.length === 0) return { kind: 'custom' };
  const fallbackChoices = fallbackQuestionChoices(sanitizedOptions);
  const selected = await ctx.ui.select(
    sanitizedQuestion,
    fallbackChoices.map(({ label }) => label),
    signal === undefined ? undefined : { signal },
  );
  if (!selected) return null;
  return fallbackChoices.find(({ label }) => label === selected)?.choice ?? null;
}
