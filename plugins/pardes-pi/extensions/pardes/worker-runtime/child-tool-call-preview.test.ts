import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, test } from 'vitest';
import { requiredValue } from '../test-support.ts';
import { renderChildToolCall, renderChildToolResult } from './child-tool-call-preview.ts';

const temporaryDirectories: string[] = [];
const originalStateDir = process.env.PARDES_PI_STATE_DIR;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
  if (originalStateDir === undefined) delete process.env.PARDES_PI_STATE_DIR;
  else process.env.PARDES_PI_STATE_DIR = originalStateDir;
});

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

describe('child Pardes terminal rendering', () => {
  test('visibly escapes bidi controls in call parameters and results without mutating execute content', () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-child-renderer-'));
    temporaryDirectories.push(root);
    process.env.PARDES_PI_STATE_DIR = root;
    const fields = [{ name: 'value', value: 'left\u202eright\u2066\u200f' }];
    const source = 'result left\u202eright\u2066 \u200fend';
    const result = { content: [{ text: source, type: 'text' as const }], details: undefined };

    const call = requiredValue(renderChildToolCall(theme, 'child_tool', fields).render(240)[0]);
    const renderedResult = requiredValue(
      renderChildToolResult(
        theme,
        'child_tool',
        fields,
        result,
        { expanded: false, isPartial: false },
        { isError: false },
      ).render(240)[0],
    );
    const callText = stripVTControlCharacters(call);
    const resultText = stripVTControlCharacters(renderedResult);

    expect(callText).toContain('child_tool(value="left\\u202eright\\u2066\\u200f")');
    expect(resultText).toContain(' → result left\\u202eright\\u2066 \\u200fend');
    for (const bidi of ['\u202e', '\u2066', '\u200f']) {
      expect(callText).not.toContain(bidi);
      expect(resultText).not.toContain(bidi);
    }
    expect(visibleWidth(call)).toBeLessThanOrEqual(240);
    expect(visibleWidth(renderedResult)).toBeLessThanOrEqual(240);
    expect(result.content[0].text).toBe(source);
  });

  test('reserves narrow settled compact space for a long report call error suffix', () => {
    const root = mkdtempSync(join(tmpdir(), 'pardes-child-renderer-'));
    temporaryDirectories.push(root);
    process.env.PARDES_PI_STATE_DIR = root;
    const width = 76;
    const line = requiredValue(
      renderChildToolResult(
        theme,
        'report_to_manager',
        [
          { name: 'status', value: 'blocked' },
          { mode: 'length', name: 'summary', value: 'summary'.repeat(100) },
          { mode: 'length', name: 'details', value: 'details'.repeat(1_000) },
        ],
        {
          content: [{ text: 'Error: owning manager report delivery failed', type: 'text' }],
          details: undefined,
        },
        { expanded: false, isPartial: false },
        { isError: false },
      ).render(width)[0],
    );
    const visible = stripVTControlCharacters(line);

    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(visible).toContain('report_to_manager(');
    expect(visible).toContain(' → Error: owning manager');
  });
});
