import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { type Component, KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import type { ManagerController } from '../manager/index.ts';
import {
  QUESTION_ANSWER_MAX_CHARS,
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
  readonly description: string;
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
      readonly allowCustom?: unknown;
    };
  };
  readonly prepareArguments?: (args: unknown) => unknown;
  readonly execute: (
    toolCallId: string,
    params: {
      readonly question: string;
      readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
    },
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) => Promise<ToolResult>;
}

interface Handoff {
  readonly cursor: string;
  readonly surfacedAt: string;
  readonly token: string;
  readonly wakeToken: string;
}

const signal = new AbortController().signal;
const onUpdate = (_update: unknown) => {};
const theme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function managerFixture({ delivered = false, stale = false, submitFails = false } = {}) {
  let begins = 0;
  const disarmed: Handoff[] = [];
  const submitted: Handoff[] = [];
  const manager = {
    beginInboxHandoffIfAvailable: (_ctx?: ExtensionContext) =>
      Effect.sync(() => {
        begins += 1;
        return delivered
          ? {
              cursor: 'event-delivered',
              surfacedAt: '2026-07-11T00:00:00.000Z',
              token: `question-${begins}`,
              wakeToken: 'wake-delivered',
            }
          : undefined;
      }),
    disarmInboxHandoff: (handoff: Handoff) =>
      Effect.sync(() => {
        disarmed.push(handoff);
        return true;
      }),
    submitInboxHandoff: (handoff: Handoff) =>
      Effect.gen(function* () {
        submitted.push(handoff);
        if (submitFails) return yield* Effect.fail(new Error('cursor submit failed'));
        return {
          acknowledgedCount: stale ? 0 : 1,
          cursor: handoff.cursor,
          pendingCount: 1,
          queuedSuffixCount: 1,
          reason: 'question_answer_submitted' as const,
          staleCursor: stale,
        };
      }),
  } as unknown as ManagerController;
  return { begins: () => begins, disarmed, manager, submitted };
}

function questionTool(manager = managerFixture().manager): RegisteredQuestionTool {
  let question: RegisteredQuestionTool | undefined;
  registerQuestionTool(
    {
      registerTool(tool: unknown) {
        question = tool as RegisteredQuestionTool;
      },
    } as unknown as ExtensionAPI,
    manager,
  );
  return requiredValue(question);
}

function interactiveContext(
  inputs: ReadonlyArray<string>,
  options: { readonly onOpen?: () => void } = {},
): ExtensionContext {
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
          options.onOpen?.();
          for (const input of inputs) component.handleInput?.(input);
        }),
    },
  } as unknown as ExtensionContext;
}

describe('question tool execution semantics', () => {
  test('exposes one bounded schema with empty options and no allowCustom field', () => {
    const tool = questionTool();
    const properties = tool.parameters.properties;

    expect(properties.question).toMatchObject({
      maxLength: QUESTION_PROMPT_MAX_CHARS,
      minLength: 1,
    });
    expect(properties.options).toMatchObject({ maxItems: QUESTION_OPTIONS_MAX_ITEMS, minItems: 0 });
    expect(properties.options.items.properties.label).toMatchObject({
      maxLength: QUESTION_OPTION_LABEL_MAX_CHARS,
      minLength: 1,
    });
    expect(properties.options.items.properties.description).toMatchObject({
      maxLength: QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
    });
    expect(properties.allowCustom).toBeUndefined();
    expect(tool.description).toContain(`${QUESTION_ANSWER_MAX_CHARS}-character limit`);
    expect(
      tool.prepareArguments?.({ allowCustom: false, options: [], question: 'Legacy call' }),
    ).toEqual({ options: [], question: 'Legacy call' });
  });

  test('returns a selected option without requiring a delivered attention cursor', async () => {
    const fixture = managerFixture();
    const result = await questionTool(fixture.manager).execute(
      'call-option',
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
      details: { answer: 'Local HEAD', custom: false, submitted: true },
    });
    expect(fixture.begins()).toBe(1);
    expect(fixture.submitted).toEqual([]);
  });

  test('edits and submits the custom row directly while preserving the full answer', async () => {
    const answer = `  use release/next ${'x'.repeat(QUESTION_ANSWER_MAX_CHARS - 40)}  `;
    const result = await questionTool().execute(
      'call-custom',
      { options: [{ label: 'Origin' }], question: 'Choose a baseline' },
      signal,
      onUpdate,
      interactiveContext(['\x1b[B', answer, '\r']),
    );

    expect(result).toEqual({
      content: [{ text: `User answered: ${answer}`, type: 'text' }],
      details: { answer, custom: true, submitted: true },
    });
  });

  test('rejects oversized TUI and RPC answers without consuming the bound cursor', async () => {
    const tuiFixture = managerFixture({ delivered: true });
    const tuiResult = await questionTool(tuiFixture.manager).execute(
      'call-tui-oversized',
      { options: [], question: 'Add bounded context' },
      signal,
      onUpdate,
      interactiveContext(['x'.repeat(QUESTION_ANSWER_MAX_CHARS + 1), '\r']),
    );
    expect(tuiResult.content[0]?.text).toContain(
      `exceeded the ${QUESTION_ANSWER_MAX_CHARS}-character limit`,
    );
    expect(tuiResult.details).toMatchObject({
      answer: null,
      cursor: 'event-delivered',
      cursorPreserved: true,
      maxChars: QUESTION_ANSWER_MAX_CHARS,
      rejected: 'answer_too_long',
      submitted: false,
    });
    expect(JSON.stringify(tuiResult).length).toBeLessThan(1_000);
    expect(JSON.stringify(tuiResult)).not.toContain('x'.repeat(100));
    expect(tuiFixture.submitted).toEqual([]);
    expect(tuiFixture.disarmed).toHaveLength(1);

    const rpcFixture = managerFixture({ delivered: true });
    const rpcResult = await questionTool(rpcFixture.manager).execute(
      'call-rpc-oversized',
      { options: [], question: 'Add bounded context' },
      signal,
      onUpdate,
      {
        hasUI: true,
        ui: {
          custom: async () => undefined,
          input: async () => '界'.repeat(QUESTION_ANSWER_MAX_CHARS + 1),
        },
      } as unknown as ExtensionContext,
    );
    expect(rpcResult.details).toMatchObject({
      cursor: 'event-delivered',
      cursorPreserved: true,
      rejected: 'answer_too_long',
      submitted: false,
    });
    expect(JSON.stringify(rpcResult).length).toBeLessThan(1_000);
    expect(rpcFixture.submitted).toEqual([]);
    expect(rpcFixture.disarmed).toHaveLength(1);
  });

  test('accepts corrected TUI typing and paste after editing an overshoot below the limit', async () => {
    const oversizedInputs = [
      'x'.repeat(QUESTION_ANSWER_MAX_CHARS + 1),
      `\x1b[200~${'x'.repeat(QUESTION_ANSWER_MAX_CHARS + 1)}\x1b[201~`,
    ];

    for (const [index, oversizedInput] of oversizedInputs.entries()) {
      const fixture = managerFixture({ delivered: true });
      const result = await questionTool(fixture.manager).execute(
        `call-corrected-${index}`,
        { options: [], question: 'Correct this bounded answer' },
        signal,
        onUpdate,
        interactiveContext([oversizedInput, '\x7f', '\r']),
      );

      expect(result.content[0]?.text).toBe(
        `User answered: ${'x'.repeat(QUESTION_ANSWER_MAX_CHARS - 1)}`,
      );
      expect(result.details).toMatchObject({
        acknowledgedCount: 1,
        answer: 'x'.repeat(QUESTION_ANSWER_MAX_CHARS - 1),
        cursor: 'event-delivered',
        staleCursor: false,
        submitted: true,
      });
      expect(result.details).not.toHaveProperty('cursorPreserved');
      expect(fixture.submitted).toHaveLength(1);
      expect(fixture.disarmed).toEqual([]);
    }
  });

  test('supports a pure free-form prompt with an empty options array', async () => {
    const result = await questionTool().execute(
      'call-free-form',
      { options: [], question: 'What should the release note say?' },
      signal,
      onUpdate,
      interactiveContext(['Ship the calm flow', '\r']),
    );

    expect(result.content[0]?.text).toBe('User answered: Ship the calm flow');
    expect(result.details).toEqual({
      answer: 'Ship the calm flow',
      custom: true,
      submitted: true,
    });
  });

  test('binds the delivered cursor at open and consumes only it after a submitted answer', async () => {
    const fixture = managerFixture({ delivered: true });
    let suffixQueued = false;
    const result = await questionTool(fixture.manager).execute(
      'call-cursor',
      { options: [{ label: 'Proceed' }], question: 'Proceed with the reviewed fix?' },
      signal,
      onUpdate,
      interactiveContext(['\r'], {
        onOpen: () => {
          suffixQueued = true;
        },
      }),
    );

    expect(suffixQueued).toBe(true);
    expect(fixture.submitted).toHaveLength(1);
    expect(fixture.submitted[0]).toMatchObject({ cursor: 'event-delivered', token: 'question-1' });
    expect(result.details).toMatchObject({
      acknowledgedCount: 1,
      answer: 'Proceed',
      cursor: 'event-delivered',
      pendingCount: 1,
      queuedSuffixCount: 1,
      staleCursor: false,
      submitted: true,
    });
    expect(fixture.disarmed).toEqual([]);
  });

  test('never consumes attention delivered after a cursor-free question opened', async () => {
    const fixture = managerFixture();
    let laterAttentionDelivered = false;
    const result = await questionTool(fixture.manager).execute(
      'call-later',
      { options: [], question: 'Any additional context?' },
      signal,
      onUpdate,
      interactiveContext(['No', '\r'], {
        onOpen: () => {
          laterAttentionDelivered = true;
        },
      }),
    );

    expect(laterAttentionDelivered).toBe(true);
    expect(result.details).toEqual({ answer: 'No', custom: true, submitted: true });
    expect(fixture.submitted).toEqual([]);
    expect(fixture.disarmed).toEqual([]);
  });

  test('preserves an opening cursor on cancel, blank input, and stale submission', async () => {
    const cancelledFixture = managerFixture({ delivered: true });
    const cancelled = await questionTool(cancelledFixture.manager).execute(
      'call-cancel',
      { options: [], question: 'Add context?' },
      signal,
      onUpdate,
      interactiveContext(['\x1b']),
    );
    expect(cancelled.content[0]?.text).toBe('User cancelled the question.');
    expect(cancelled.details).toMatchObject({
      answer: null,
      cursor: 'event-delivered',
      cursorPreserved: true,
      handoffDisarmed: true,
      submitted: false,
    });
    expect(cancelledFixture.disarmed).toHaveLength(1);

    const blankFixture = managerFixture({ delivered: true });
    const blank = await questionTool(blankFixture.manager).execute(
      'call-blank',
      { options: [], question: 'Add context?' },
      signal,
      onUpdate,
      interactiveContext(['   ', '\r']),
    );
    expect(blank.content[0]?.text).toContain('submitted no answer');
    expect(blank.details).toMatchObject({ cursorPreserved: true, submitted: false });
    expect(blankFixture.disarmed).toHaveLength(1);

    const staleFixture = managerFixture({ delivered: true, stale: true });
    const stale = await questionTool(staleFixture.manager).execute(
      'call-stale',
      { options: [{ label: 'Proceed' }], question: 'Proceed?' },
      signal,
      onUpdate,
      interactiveContext(['\r']),
    );
    expect(stale.content[0]?.text).toContain('No later queued attention was consumed.');
    expect(stale.details).toMatchObject({
      acknowledgedCount: 0,
      cursorPreserved: true,
      handoffDisarmed: true,
      staleCursor: true,
      submitted: true,
    });
    expect(staleFixture.disarmed).toHaveLength(1);
  });

  test('disarms the exact cursor marker when the TUI or cursor submission fails', async () => {
    const fixture = managerFixture({ delivered: true });
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => {
          throw new Error('dialog failed');
        },
      },
    } as unknown as ExtensionContext;

    await expect(
      questionTool(fixture.manager).execute(
        'call-failure',
        { options: [], question: 'Continue?' },
        signal,
        onUpdate,
        ctx,
      ),
    ).rejects.toThrow('dialog failed');
    expect(fixture.disarmed).toHaveLength(1);
    expect(fixture.submitted).toEqual([]);

    const submitFailure = managerFixture({ delivered: true, submitFails: true });
    const failed = await questionTool(submitFailure.manager).execute(
      'call-submit-failure',
      { options: [{ label: 'Proceed' }], question: 'Proceed?' },
      signal,
      onUpdate,
      interactiveContext(['\r']),
    );
    expect(failed.content[0]?.text).toContain('cursor submit failed');
    expect(failed.content[0]?.text).toContain('cursor remains pending');
    expect(failed.details).toMatchObject({
      answer: 'Proceed',
      cursor: 'event-delivered',
      cursorPreserved: true,
      submitted: true,
    });
    expect(submitFailure.disarmed).toHaveLength(1);
  });

  test('uses the supported RPC dialogs without an extra selection for pure free-form input', async () => {
    const selectCalls: unknown[] = [];
    const inputCalls: unknown[] = [];
    const answers = ['RPC free form', 'RPC custom'];
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        input: async (...args: unknown[]) => {
          inputCalls.push(args);
          return answers.shift();
        },
        select: async (...args: unknown[]) => {
          selectCalls.push(args);
          return QUESTION_CUSTOM_LABEL;
        },
      },
    } as unknown as ExtensionContext;
    const tool = questionTool();

    const freeForm = await tool.execute(
      'call-rpc-free',
      { options: [], question: 'Describe the desired outcome' },
      signal,
      onUpdate,
      ctx,
    );
    expect(selectCalls).toEqual([]);
    expect(freeForm.content[0]?.text).toBe('User answered: RPC free form');

    const custom = await tool.execute(
      'call-rpc-custom',
      { options: [{ label: 'Origin' }], question: 'Choose a baseline' },
      signal,
      onUpdate,
      ctx,
    );
    expect(selectCalls).toEqual([
      ['Choose a baseline', ['Origin', QUESTION_CUSTOM_LABEL], { signal }],
    ]);
    expect(custom.content[0]?.text).toBe('User answered: RPC custom');
    expect(inputCalls).toEqual([
      ['Describe the desired outcome', 'Type your answer', { signal }],
      ['Custom answer', 'Choose a baseline', { signal }],
    ]);
  });

  test('neutralizes RPC terminal controls while preserving ordinary Unicode text', async () => {
    const result = await questionTool().execute(
      'call-rpc-controls',
      { options: [], question: 'Provide Unicode context' },
      signal,
      onUpdate,
      {
        hasUI: true,
        ui: {
          custom: async () => undefined,
          input: async () => 'line\n安全🙂\x1b[31mRED',
        },
      } as unknown as ExtensionContext,
    );

    expect(result.content[0]?.text).toBe('User answered: line 安全🙂 [31mRED');
    expect(result.details).toMatchObject({
      answer: 'line 安全🙂 [31mRED',
      custom: true,
      submitted: true,
    });
    expect(JSON.stringify(result)).not.toContain('\\u001b');
  });

  test('keeps colliding RPC fallback labels mapped to their exact option index', async () => {
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
      'call-rpc-collision',
      {
        options: [{ label: 'A — B' }, { description: 'B', label: 'A' }],
        question: 'Choose a release path',
      },
      signal,
      onUpdate,
      ctx,
    );

    expect(selectCalls).toEqual([
      [
        'Choose a release path',
        ['1. A — B', '2. A — B', `3. ${QUESTION_CUSTOM_LABEL}`],
        { signal },
      ],
    ]);
    expect(result.content[0]?.text).toBe('User selected: A');
    expect(result.details).toMatchObject({ answer: 'A', custom: false, submitted: true });
  });

  test('does not bind a cursor without interactive UI or when already aborted', async () => {
    const fixture = managerFixture({ delivered: true });
    const noUi = await questionTool(fixture.manager).execute(
      'call-no-ui',
      { options: [], question: 'Continue?' },
      signal,
      onUpdate,
      { hasUI: false } as ExtensionContext,
    );
    expect(noUi.content[0]?.text).toBe('Error: question requires an interactive UI.');

    const aborted = new AbortController();
    aborted.abort();
    const abortedResult = await questionTool(fixture.manager).execute(
      'call-aborted',
      { options: [], question: 'Continue?' },
      aborted.signal,
      onUpdate,
      { hasUI: true } as ExtensionContext,
    );
    expect(abortedResult.details).toEqual({ aborted: true, submitted: false });
    expect(fixture.begins()).toBe(0);
  });
});
