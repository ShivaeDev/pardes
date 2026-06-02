import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { type Component, KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';
import {
  QUESTION_CUSTOM_LABEL,
  QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
  QUESTION_OPTION_LABEL_MAX_CHARS,
  QUESTION_OPTIONS_MAX_ITEMS,
  QUESTION_PROMPT_MAX_CHARS,
} from '../presentation/index.ts';
import { requiredValue } from '../test-support.ts';
import { registerQuestionTool } from './question.ts';

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly details?: unknown;
}

interface RegisteredQuestionTool {
  readonly parameters: {
    readonly properties: {
      readonly question: { readonly minLength?: number; readonly maxLength?: number };
      readonly options: {
        readonly minItems?: number;
        readonly maxItems?: number;
        readonly items: {
          readonly properties: {
            readonly label: { readonly minLength?: number; readonly maxLength?: number };
            readonly description: { readonly maxLength?: number };
          };
        };
      };
    };
  };
  readonly execute: (
    toolCallId: string,
    params: {
      readonly question: string;
      readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
      readonly allowCustom?: boolean;
    },
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) => Promise<ToolResult>;
}

const signal = new AbortController().signal;
const onUpdate = (_update: unknown) => {};
const theme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function questionTool(): RegisteredQuestionTool {
  let question: RegisteredQuestionTool | undefined;
  registerQuestionTool({
    registerTool(tool: unknown) {
      question = tool as RegisteredQuestionTool;
    },
  } as unknown as ExtensionAPI);
  return requiredValue(question);
}

function interactiveContext(inputs: ReadonlyArray<string>, answer?: string): ExtensionContext {
  return {
    hasUI: true,
    ui: {
      custom: async (
        factory: (
          tui: { requestRender: () => void },
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: unknown) => void,
        ) => Component,
      ) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender: () => {} },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          );
          for (const input of inputs) component.handleInput?.(input);
        }),
      input: async () => answer,
    },
  } as unknown as ExtensionContext;
}

describe('question tool execution semantics', () => {
  test('advertises bounded model-visible question fields and option count', () => {
    const properties = questionTool().parameters.properties;

    expect(properties.question).toMatchObject({
      maxLength: QUESTION_PROMPT_MAX_CHARS,
      minLength: 1,
    });
    expect(properties.options).toMatchObject({ maxItems: QUESTION_OPTIONS_MAX_ITEMS, minItems: 1 });
    expect(properties.options.items.properties.label).toMatchObject({
      maxLength: QUESTION_OPTION_LABEL_MAX_CHARS,
      minLength: 1,
    });
    expect(properties.options.items.properties.description).toMatchObject({
      maxLength: QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
    });
  });

  test('returns the original option label after selecting a described option in the Pardes dialog', async () => {
    const result = await questionTool().execute(
      'call-1',
      {
        options: [
          { description: 'Use the immutable remote baseline.', label: 'Origin' },
          { description: 'Include local-only commits.', label: 'Local HEAD' },
        ],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      interactiveContext(['\x1b[B', '\r']),
    );

    expect(result).toEqual({
      content: [{ text: 'User selected: Local HEAD', type: 'text' }],
      details: { answer: 'Local HEAD', custom: false },
    });
  });

  test('preserves full custom responses and cancellation behavior', async () => {
    const custom = await questionTool().execute(
      'call-1',
      {
        options: [{ label: 'Origin' }],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      interactiveContext(['\x1b[B', '\r'], '  use release/next  '),
    );
    expect(custom).toEqual({
      content: [{ text: 'User answered:   use release/next  ', type: 'text' }],
      details: { answer: '  use release/next  ', custom: true },
    });

    const cancelled = await questionTool().execute(
      'call-2',
      {
        options: [{ label: 'Origin' }],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      interactiveContext(['\x1b']),
    );
    expect(cancelled).toEqual({
      content: [{ text: 'User cancelled the question.', type: 'text' }],
      details: { answer: null },
    });

    const blank = await questionTool().execute(
      'call-3',
      {
        options: [{ label: 'Origin' }],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      interactiveContext(['\x1b[B', '\r'], '   '),
    );
    expect(blank).toEqual({
      content: [{ text: 'User cancelled the question.', type: 'text' }],
      details: { answer: null },
    });
  });

  test('returns a full oversized custom response without clipping or presentation sanitation', async () => {
    const oversized = `  safe\u001b-${'x'.repeat(4_001)}  `;
    const result = await questionTool().execute(
      'call-1',
      {
        options: [{ label: 'Origin' }],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      interactiveContext(['\x1b[B', '\r'], oversized),
    );

    expect(result).toEqual({
      content: [{ text: `User answered: ${oversized}`, type: 'text' }],
      details: { answer: oversized, custom: true },
    });
  });

  test('falls back to Pi dialog methods when custom components are unavailable in RPC mode', async () => {
    const selectCalls: unknown[] = [];
    const inputCalls: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        input: async (...args: unknown[]) => {
          inputCalls.push(args);
          return 'RPC answer';
        },
        select: async (...args: unknown[]) => {
          selectCalls.push(args);
          return QUESTION_CUSTOM_LABEL;
        },
      },
    } as unknown as ExtensionContext;

    const result = await questionTool().execute(
      'call-1',
      {
        options: [{ description: 'Use the remote baseline.', label: 'Origin' }],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      ctx,
    );

    expect(selectCalls).toEqual([
      ['Choose a baseline', ['Origin — Use the remote baseline.', QUESTION_CUSTOM_LABEL]],
    ]);
    expect(inputCalls).toEqual([['Custom answer']]);
    expect(result).toEqual({
      content: [{ text: 'User answered: RPC answer', type: 'text' }],
      details: { answer: 'RPC answer', custom: true },
    });
  });

  test('disambiguates colliding RPC fallback labels while preserving the selected option index', async () => {
    const selectCalls: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (...args: unknown[]) => {
          selectCalls.push(args);
          return '2. A — B';
        },
      },
    } as unknown as ExtensionContext;

    const result = await questionTool().execute(
      'call-1',
      {
        allowCustom: false,
        options: [{ label: 'A — B' }, { description: 'B', label: 'A' }],
        question: 'Choose a release path',
      },
      signal,
      onUpdate,
      ctx,
    );

    expect(selectCalls).toEqual([['Choose a release path', ['1. A — B', '2. A — B']]]);
    expect(result).toEqual({
      content: [{ text: 'User selected: A', type: 'text' }],
      details: { answer: 'A', custom: false },
    });
  });

  test('does not confuse a same-named RPC fallback option with the custom-answer row', async () => {
    const selectCalls: unknown[] = [];
    const inputCalls: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        input: async (...args: unknown[]) => {
          inputCalls.push(args);
          return 'must not be requested';
        },
        select: async (...args: unknown[]) => {
          selectCalls.push(args);
          return `1. ${QUESTION_CUSTOM_LABEL}`;
        },
      },
    } as unknown as ExtensionContext;

    const result = await questionTool().execute(
      'call-1',
      {
        options: [{ label: QUESTION_CUSTOM_LABEL }],
        question: 'Choose a response',
      },
      signal,
      onUpdate,
      ctx,
    );

    expect(selectCalls).toEqual([
      ['Choose a response', [`1. ${QUESTION_CUSTOM_LABEL}`, `2. ${QUESTION_CUSTOM_LABEL}`]],
    ]);
    expect(inputCalls).toEqual([]);
    expect(result).toEqual({
      content: [{ text: `User selected: ${QUESTION_CUSTOM_LABEL}`, type: 'text' }],
      details: { answer: QUESTION_CUSTOM_LABEL, custom: false },
    });
  });

  test('sanitizes model-authored controls before the Pi dialog fallback and selected-option result', async () => {
    const selectCalls: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (...args: unknown[]) => {
          selectCalls.push(args);
          return 'Origin [31m — Use remote';
        },
      },
    } as unknown as ExtensionContext;

    const result = await questionTool().execute(
      'call-1',
      {
        allowCustom: false,
        options: [{ description: 'Use\u009bremote', label: 'Origin\u001b[31m' }],
        question: 'Choose\nbaseline\u0007',
      },
      signal,
      onUpdate,
      ctx,
    );

    expect(selectCalls).toEqual([['Choose baseline ', ['Origin [31m — Use remote']]]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: The test explicitly rejects terminal control ranges.
    expect(JSON.stringify(selectCalls)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(result).toEqual({
      content: [{ text: 'User selected: Origin [31m', type: 'text' }],
      details: { answer: 'Origin [31m', custom: false },
    });
  });

  test('keeps the non-interactive error and allowCustom false contract unchanged', async () => {
    const noUi = await questionTool().execute(
      'call-1',
      {
        options: [{ label: 'Origin' }],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      { hasUI: false } as ExtensionContext,
    );
    expect(noUi).toEqual({
      content: [{ text: 'Error: question requires an interactive UI.', type: 'text' }],
      details: undefined,
    });

    const selectCalls: unknown[] = [];
    const fallback = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (...args: unknown[]) => {
          selectCalls.push(args);
          return 'Origin';
        },
      },
    } as unknown as ExtensionContext;
    const selected = await questionTool().execute(
      'call-2',
      {
        allowCustom: false,
        options: [{ label: 'Origin' }],
        question: 'Choose a baseline',
      },
      signal,
      onUpdate,
      fallback,
    );

    expect(selectCalls).toEqual([['Choose a baseline', ['Origin']]]);
    expect(selected).toEqual({
      content: [{ text: 'User selected: Origin', type: 'text' }],
      details: { answer: 'Origin', custom: false },
    });
  });
});
