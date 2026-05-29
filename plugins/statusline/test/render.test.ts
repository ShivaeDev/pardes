import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { C, fg } from '../src/lib/ansi';
import { renderMain } from '../src/render/main';
import { renderSubagent } from '../src/render/subagent';
import type { StatusInput, SubagentInput, SubagentRowOverride } from '../src/types';

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'),
  );
}

// Pin both the auto-compact window and the buffer so the fixtures render
// deterministically (the "/365k" numbers = 400k wall − 35k buffer) regardless
// of the ambient env. The buffer is cleared so effectiveWindow uses its default.
const WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const BUFFER_KEY = 'CLAUDE_STATUSLINE_COMPACT_BUFFER';
let savedWindow: string | undefined;
let savedBuffer: string | undefined;
beforeEach(() => {
  savedWindow = process.env[WINDOW_KEY];
  savedBuffer = process.env[BUFFER_KEY];
  process.env[WINDOW_KEY] = '400000';
  delete process.env[BUFFER_KEY];
});
afterEach(() => {
  if (savedWindow === undefined) delete process.env[WINDOW_KEY];
  else process.env[WINDOW_KEY] = savedWindow;
  if (savedBuffer === undefined) delete process.env[BUFFER_KEY];
  else process.env[BUFFER_KEY] = savedBuffer;
});

describe('renderMain', () => {
  it('renders exactly two lines', () => {
    const out = renderMain(fixture<StatusInput>('main.json'));
    expect(out.split('\n')).toHaveLength(2);
  });

  it('scales the context bar to the usable window (compact wall minus buffer)', () => {
    const out = renderMain(fixture<StatusInput>('main.json'));
    // 400k wall − 35k buffer = 365k usable; 182431 / 365000 ≈ 50%.
    expect(out).toContain('182k/365k');
    expect(out).toContain('50%');
  });

  it('includes identity, model and economics on line one', () => {
    const [line1] = renderMain(fixture<StatusInput>('main.json')).split('\n');
    expect(line1).toContain('example-org/widget');
    expect(line1).toContain('O4.8');
    expect(line1).toContain('$1.84');
  });

  it('never throws and stays two lines on an empty payload', () => {
    expect(renderMain({}).split('\n')).toHaveLength(2);
  });
});

describe('renderSubagent', () => {
  function rows(input: SubagentInput): SubagentRowOverride[] {
    const out = renderSubagent(input);
    return out ? out.split('\n').map((l) => JSON.parse(l) as SubagentRowOverride) : [];
  }

  it('emits one valid {id, content} line per task with an id', () => {
    const parsed = rows(fixture<SubagentInput>('subagent.json'));
    expect(parsed).toHaveLength(4);
    for (const r of parsed) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.content).toBe('string');
    }
  });

  it("skips tasks without an id (keeps Claude Code's default row)", () => {
    const parsed = rows({
      columns: 120,
      tasks: [{ name: 'anon', status: 'running', tokenCount: 5 }],
    });
    expect(parsed).toHaveLength(0);
  });

  it('draws a context bar in the wide tier', () => {
    const [first] = rows(fixture<SubagentInput>('subagent.json'));
    expect(first?.content).toContain('142k/365k');
    expect(first?.content).toContain('░'); // bar track present
  });

  it('drops the bar in the minimal tier but keeps tokens/percent', () => {
    const narrow = { ...fixture<SubagentInput>('subagent.json'), columns: 40 };
    const [first] = rows(narrow);
    expect(first?.content).toContain('142k/365k');
    expect(first?.content).not.toContain('░');
  });

  it('clamps the numerator to the window so a 1M-session agent never reads used > total', () => {
    // Wall is 400k − 35k = 365k usable. A subagent that ran in a 1M parent can
    // legitimately blow past that; the label must clamp, not show "500k/365k".
    const [first] = rows({
      columns: 120,
      tasks: [{ id: 'big', status: 'running', tokenCount: 500_000, tokenSamples: [500_000] }],
    });
    expect(first?.content).toContain('365k/365k');
    expect(first?.content).toContain('100%');
    expect(first?.content).not.toContain('500k/');
  });

  it('scales the bar to CLAUDE_STATUSLINE_SUBAGENT_WINDOW when a parent window is threaded through', () => {
    // The threaded window is a *full* window, so the auto-compact buffer is
    // still subtracted: 1M − 35k = 965k usable; 500k / 965k ≈ 52%. Clear the
    // ambient auto-compact wall (set in beforeEach) so the threaded full window
    // is what gets buffered — the wall would otherwise take precedence.
    const savedSub = process.env.CLAUDE_STATUSLINE_SUBAGENT_WINDOW;
    const savedWall = process.env[WINDOW_KEY];
    process.env.CLAUDE_STATUSLINE_SUBAGENT_WINDOW = '1000000';
    delete process.env[WINDOW_KEY];
    try {
      const [first] = rows({
        columns: 120,
        tasks: [{ id: 'big', status: 'running', tokenCount: 500_000, tokenSamples: [500_000] }],
      });
      expect(first?.content).toContain('500k/965k');
      expect(first?.content).toContain('52%');
    } finally {
      if (savedSub === undefined) delete process.env.CLAUDE_STATUSLINE_SUBAGENT_WINDOW;
      else process.env.CLAUDE_STATUSLINE_SUBAGENT_WINDOW = savedSub;
      if (savedWall === undefined) delete process.env[WINDOW_KEY];
      else process.env[WINDOW_KEY] = savedWall;
    }
  });

  it('renders the sparkline at a fixed width regardless of sample count', () => {
    // The spark is the only segment wrapped in C.tokens; isolate that exact
    // wrapper so the context bar's block glyphs don't pollute the count.
    const open = fg(C.tokens, ' ').split(' ')[0] ?? '';
    const sparkCells = (content: string) => {
      const start = content.indexOf(open);
      if (start < 0) return 0;
      const body = content.slice(start + open.length);
      let n = 0;
      for (const ch of body) {
        if (!'▁▂▃▄▅▆▇█'.includes(ch)) break;
        n++;
      }
      return n;
    };
    const [few, many] = rows({
      columns: 120, // wide tier: spark width 24
      tasks: [
        { id: 'few', status: 'running', tokenCount: 5000, tokenSamples: [5000] },
        {
          id: 'many',
          status: 'running',
          tokenCount: 50000,
          tokenSamples: Array.from({ length: 40 }, (_, i) => i * 1000),
        },
      ],
    });
    expect(sparkCells(few?.content ?? '')).toBe(24);
    expect(sparkCells(many?.content ?? '')).toBe(24);
  });
});
