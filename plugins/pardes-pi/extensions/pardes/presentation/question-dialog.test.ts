import {
  CURSOR_MARKER,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';
import {
  PardesQuestionDialog,
  QUESTION_CUSTOM_LABEL,
  QUESTION_PROMPT_MAX_CHARS,
  type QuestionDialogOption,
  type QuestionDialogPalette,
} from './question-dialog.ts';

const plain = (text: string) => text;
const plainPalette: QuestionDialogPalette = {
  accent: plain,
  bold: plain,
  border: plain,
  borderMuted: plain,
  dim: plain,
  muted: plain,
  selected: plain,
  text: plain,
};

const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const ansiPalette: QuestionDialogPalette = {
  accent: ansi(36),
  bold: ansi(1),
  border: ansi(35),
  borderMuted: ansi(90),
  dim: ansi(2),
  muted: ansi(90),
  selected: ansi(44),
  text: ansi(37),
};

function createDialog({
  question = 'Which baseline should the worker use?',
  options = [
    { description: 'Start from the immutable remote baseline.', label: 'Use origin/main' },
    { description: 'Include local-only commits.', label: 'Use local HEAD' },
  ],
  palette = plainPalette,
  keybindings = new KeybindingsManager(TUI_KEYBINDINGS),
}: {
  readonly question?: string;
  readonly options?: ReadonlyArray<QuestionDialogOption>;
  readonly palette?: QuestionDialogPalette;
  readonly keybindings?: KeybindingsManager;
} = {}) {
  const choices: unknown[] = [];
  let renderRequests = 0;
  const dialog = new PardesQuestionDialog({
    keybindings,
    onDone: (choice) => choices.push(choice),
    options,
    palette,
    question,
    requestRender: () => {
      renderRequests += 1;
    },
  });
  return { choices, dialog, renderRequests: () => renderRequests };
}

describe('Pardes question decision dialog', () => {
  test('frames the complete decision surface and gives each option a scannable selected hierarchy', () => {
    const { dialog } = createDialog();
    const lines = dialog.render(62);
    const text = lines.join('\n');

    expect(lines[0]?.startsWith('╭ Pardes question ')).toBe(true);
    expect(lines.at(-1)?.startsWith('╰')).toBe(true);
    expect(text).toContain('│ Pardes decision');
    expect(text).toContain('│ Which baseline should the worker use?');
    expect(text).toContain('│ ▶ 1. Use origin/main');
    expect(text).toContain('│      Start from the immutable remote baseline.');
    expect(text).toContain('│   2. Use local HEAD');
    expect(text).toContain(`│   3. ${QUESTION_CUSTOM_LABEL}`);
    expect(text).toContain('up/down navigate · type custom answer · enter');
    expect(text).toContain('submit/select · escape cancel');
    expect(lines.filter((line) => /^│ +│$/.test(line)).length).toBeGreaterThanOrEqual(2);
  });

  test('uses injected Pi keybindings for navigation, selection, paging, and cancellation', () => {
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.select.cancel': 'ctrl+q',
      'tui.select.confirm': 'ctrl+x',
      'tui.select.down': 'ctrl+n',
      'tui.select.up': 'ctrl+p',
    });
    const { choices, dialog, renderRequests } = createDialog({ keybindings });

    dialog.handleInput('\x0e');
    expect(dialog.render(62).join('\n')).toContain('│ ▶ 2. Use local HEAD');
    expect(renderRequests()).toBe(1);
    dialog.handleInput('\x18');
    expect(choices).toEqual([
      { index: 1, kind: 'option', value: 'Use local HEAD — Include local-only commits.' },
    ]);

    const many = createDialog({
      options: Array.from({ length: 12 }, (_, index) => ({ label: `Option ${index + 1}` })),
    });
    many.dialog.handleInput('\x1b[6~');
    expect(many.dialog.render(62).join('\n')).toContain('▶ 6. Option 6');
    expect(many.dialog.render(62).join('\n')).toContain('Showing 4–8 of 13');
    many.dialog.handleInput('\x1b');
    expect(many.choices).toEqual([null]);
  });

  test('makes the custom row directly editable without hiding the question or options', () => {
    const { choices, dialog } = createDialog();

    dialog.handleInput('\x1b[B');
    dialog.handleInput('\x1b[B');
    dialog.handleInput('release/next');
    dialog.focused = true;
    const editing = dialog.render(62).join('\n');
    expect(editing).toContain('Which baseline should the worker use?');
    expect(editing).toContain('Use origin/main');
    expect(editing).toContain('Use local HEAD');
    expect(editing).toContain(QUESTION_CUSTOM_LABEL);
    expect(editing).toContain('release/next');
    expect(editing).toContain(CURSOR_MARKER);

    dialog.handleInput('\r');
    expect(choices).toEqual([{ kind: 'custom', value: 'release/next' }]);
  });

  test('starts a free-form-only question on the editable custom row', () => {
    const { choices, dialog } = createDialog({ options: [] });

    dialog.handleInput('free-form answer');
    expect(dialog.render(48).join('\n')).toContain('free-form answer');
    dialog.handleInput('\r');
    expect(choices).toEqual([{ kind: 'custom', value: 'free-form answer' }]);
  });

  test('wraps and displays the full bounded question instead of truncating it to three lines', () => {
    const question = `${'Long decision context '.repeat(12)}final-visible-sentinel`;
    const { dialog } = createDialog({ question });
    const lines = dialog.render(30);
    const text = lines.join('\n');

    expect(text).toContain('final-visible-sentinel');
    expect(lines.findIndex((line) => line.startsWith('├'))).toBeGreaterThan(6);
  });

  test('keeps model-authored terminal controls inert inside the framed dialog', () => {
    const { dialog } = createDialog({
      options: [{ description: 'Use\u009b the release baseline.', label: 'Deploy\u0007 now' }],
      question: 'Proceed?\n\u001b[31mship',
    });
    const lines = dialog.render(62);
    const text = lines.join('\n');

    // biome-ignore lint/suspicious/noControlCharactersInRegex: The test explicitly rejects terminal control ranges.
    expect(lines.every((line) => !/[\u0000-\u001f\u007f-\u009f]/.test(line))).toBe(true);
    expect(text).toContain('Proceed?  [31mship');
    expect(text).toContain('Deploy  now');
    expect(text).toContain('Use  the release baseline.');
  });

  test('bounds long ANSI-styled content and large option sets at narrow terminal widths', () => {
    const styled = (text: string) => `\x1b[31m${text}\x1b[0m`;
    const options = Array.from({ length: 30 }, (_, index) => ({
      description: styled(`Description ${index + 1} ${'detail '.repeat(80)}`),
      label: styled(`Option ${index + 1} ${'界'.repeat(80)}`),
    }));
    const { dialog } = createDialog({ options, palette: ansiPalette });

    for (const width of [1, 8, 24, 48]) {
      const lines = dialog.render(width);
      expect(lines.length).toBeLessThanOrEqual(QUESTION_PROMPT_MAX_CHARS + 40);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(dialog.render(48).join('\n')).toContain('Showing 1–5 of 31');
  });
});
