import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';
import {
  type AttentionHandoffDialogResult,
  type AttentionHandoffPalette,
  inputPardesAttentionFeedback,
  PardesAttentionHandoffDialog,
  sanitizeAttentionHandoffPrompt,
} from './attention-dialog.ts';

const plain = (text: string) => text;
const palette: AttentionHandoffPalette = {
  accent: plain,
  bold: plain,
  border: plain,
  borderMuted: plain,
  dim: plain,
  muted: plain,
  warning: plain,
};

function dialog(prompt = 'Please review the durable blocker.') {
  const results: AttentionHandoffDialogResult[] = [];
  let renders = 0;
  const component = new PardesAttentionHandoffDialog({
    onDone: (result) => results.push(result),
    palette,
    prompt,
    requestRender: () => {
      renders += 1;
    },
  });
  return { component, renders: () => renders, results };
}

describe('Pardes attention handoff input', () => {
  test('renders a visually distinct compact frame around one input row', () => {
    const { component } = dialog();
    const lines = component.render(56);

    expect(lines).toHaveLength(5);
    expect(lines[0]?.startsWith('╭ ✦ Pardes attention handoff ')).toBe(true);
    expect(lines[1]).toContain('Please review the durable blocker.');
    expect(lines[2]).toContain('> ');
    expect(lines[3]).toContain('enter submit · escape keep pending');
    expect(lines.at(-1)?.startsWith('╰ ✦ ')).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 56)).toBe(true);
  });

  test('submits one-line feedback and treats escape as cursor-preserving cancellation', () => {
    const submitted = dialog();
    submitted.component.handleInput('Ship the bounded slice');
    submitted.component.handleInput('\r');
    expect(submitted.results).toEqual([{ feedback: 'Ship the bounded slice', kind: 'submitted' }]);
    expect(submitted.renders()).toBe(2);

    const cancelled = dialog();
    cancelled.component.handleInput('\x1b');
    expect(cancelled.results).toEqual([{ kind: 'cancelled' }]);
  });

  test('keeps model-authored terminal control text inert and bounded', () => {
    const prompt = `review\n\u001b[31m${'x'.repeat(400)}`;
    const sanitized = sanitizeAttentionHandoffPrompt(prompt);
    const lines = dialog(prompt).component.render(24);

    expect(sanitized).not.toContain('\n');
    expect(sanitized).not.toContain('\u001b');
    expect(sanitized.endsWith('…')).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  test('dismisses custom input on abort and forwards the supported signal to RPC fallback input', async () => {
    const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
    const customAbort = new AbortController();
    const custom = {
      ui: {
        custom: async (
          factory: (
            tui: { requestRender: () => void },
            theme: unknown,
            keybindings: unknown,
            done: (value: unknown) => void,
          ) => unknown,
        ) =>
          await new Promise((resolve) => {
            factory({ requestRender: () => {} }, theme, {}, resolve);
            customAbort.abort();
          }),
      },
    } as unknown as ExtensionContext;
    expect(await inputPardesAttentionFeedback(custom, 'Review this', customAbort.signal)).toEqual({
      kind: 'cancelled',
    });

    const fallbackAbort = new AbortController();
    const fallback = {
      ui: {
        custom: async () => undefined,
        input: async (
          _title: string,
          _placeholder: string,
          options?: { readonly signal?: AbortSignal },
        ) => {
          expect(options?.signal).toBe(fallbackAbort.signal);
          return undefined;
        },
      },
    } as unknown as ExtensionContext;
    expect(
      await inputPardesAttentionFeedback(fallback, 'Review this', fallbackAbort.signal),
    ).toEqual({ kind: 'cancelled' });
  });
});
