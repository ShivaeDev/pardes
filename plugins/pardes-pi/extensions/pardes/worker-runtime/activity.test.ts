import { describe, expect, test } from 'vitest';
import {
  appendActivityLine,
  appendAssistantActivity,
  closeAssistantActivity,
  createWorkerActivityState,
  normalizeActivityLine,
  summarizeToolInvocation,
  visibleAssistantText,
  type WorkerActivityState,
} from './activity.ts';

function projectTool(
  state: WorkerActivityState,
  toolName: string,
  args: unknown,
): WorkerActivityState {
  return appendActivityLine(state, summarizeToolInvocation(toolName, args));
}

describe('worker activity projection', () => {
  test('keeps only the last 5 normalized activity lines without mutating prior state', () => {
    const initial = createWorkerActivityState();
    let state = initial;
    for (let index = 1; index <= 7; index++) state = appendActivityLine(state, ` line-${index} `);

    expect(initial).toEqual(createWorkerActivityState());
    expect(state.recentActivityLines).toEqual(['line-3', 'line-4', 'line-5', 'line-6', 'line-7']);
    expect(appendActivityLine(state, ' \n\t ')).toBe(state);
  });

  test('normalizes whitespace and truncates projected rows at exactly 240 characters', () => {
    expect(normalizeActivityLine('  hello \n\t world  ')).toBe('hello world');
    const normalized = normalizeActivityLine('x'.repeat(241));
    expect(normalized).toBe(`${'x'.repeat(239)}…`);
    expect(normalized).toHaveLength(240);
  });

  test('summarizes common tool intent while omitting transcript-like argument bodies', () => {
    const projected = (toolName: string, args: unknown) =>
      projectTool(createWorkerActivityState(), toolName, args).recentActivityLines[0];
    const summaries = [
      projected('bash', { command: 'printf   hello\nworld' }),
      projected('read', { offset: 40, path: 'src/input.ts' }),
      projected('write', { content: 'SECRET write body', path: 'src/output.ts' }),
      projected('edit', {
        edits: [{ newText: 'SECRET new', oldText: 'SECRET old' }],
        path: 'src/output.ts',
      }),
      projected('grep', { path: 'src', pattern: 'TODO   marker' }),
      projected('find', { pattern: '*.ts' }),
      projected('ls', {}),
      projected('report_to_manager', {
        details: 'SECRET details',
        status: 'progress',
        summary: 'Implemented   slice',
      }),
      projected('ask_manager', { context: 'SECRET context', question: 'Need   approval?' }),
    ];

    expect(summaries).toEqual([
      '› bash: printf hello world',
      '› read: src/input.ts',
      '› write: src/output.ts',
      '› edit: src/output.ts',
      '› grep: TODO marker · src',
      '› find: *.ts · .',
      '› ls: .',
      '› report_to_manager: progress · Implemented slice',
      '› ask_manager: Need approval?',
    ]);
    expect(summaries.join('\n')).not.toContain('SECRET');
    expect(summarizeToolInvocation('read', {})).toBe('› read: (path omitted)');
    expect(summarizeToolInvocation('bash', undefined)).toBe('› bash: (command omitted)');
  });

  test('bounds unknown tool arguments to three shallow summaries', () => {
    expect(
      summarizeToolInvocation('custom_tool', {
        action: 'inspect',
        count: 3,
        enabled: false,
        ignored: 'fourth',
      }),
    ).toBe('› custom_tool: action=inspect · count=3 · enabled=false');
    expect(
      summarizeToolInvocation('custom_tool', {
        items: [1, 2],
        nothing: null,
        payload: { secret: 'SECRET nested body' },
      }),
    ).toBe('› custom_tool: items=[2 items] · nothing=null · payload={…}');
    expect(summarizeToolInvocation('custom_tool', { omitted: undefined })).toBe(
      '› custom_tool: (invoked)',
    );
    expect(summarizeToolInvocation('custom_tool', 'not metadata')).toBe('› custom_tool: (invoked)');
  });

  test('decodes only visible assistant text blocks from wire-compatible messages', () => {
    expect(
      visibleAssistantText({
        content: [
          { thinking: 'SECRET thinking trace', type: 'thinking' },
          { text: 'first visible', type: 'text' },
          { arguments: { path: 'SECRET' }, name: 'read', type: 'toolCall' },
          { text: 'second visible', type: 'text' },
          { text: 17, type: 'text' },
        ],
        role: 'assistant',
      }),
    ).toBe('first visible\nsecond visible');
    expect(
      visibleAssistantText({
        content: [{ thinking: 'SECRET', type: 'thinking' }],
        role: 'assistant',
      }),
    ).toBeUndefined();
    expect(visibleAssistantText({ content: [{ text: '', type: 'text' }], role: 'assistant' })).toBe(
      '',
    );
  });

  test('accumulates one streaming row and preserves a marker when raw stream capture truncates', () => {
    const initial = createWorkerActivityState();
    const first = appendAssistantActivity(initial, '  streamed ');
    const accumulated = appendAssistantActivity(first, ' visible\n response  ');

    expect(initial).toEqual(createWorkerActivityState());
    expect(first.recentActivityLines).toEqual(['streamed']);
    expect(accumulated.recentActivityLines).toEqual(['streamed visible response']);
    expect(accumulated.assistantActivityOpen).toBe(true);

    const truncated = appendAssistantActivity(accumulated, 'x'.repeat(2_000));
    expect(truncated.assistantActivityLine).toHaveLength(960);
    expect(truncated.assistantActivityTruncated).toBe(true);
    expect(truncated.recentActivityLines).toHaveLength(1);
    expect(truncated.recentActivityLines[0]).toHaveLength(240);
    expect(truncated.recentActivityLines[0]?.endsWith('…')).toBe(true);
    expect(appendAssistantActivity(truncated, 'ignored after truncation')).toEqual(truncated);

    const whitespaceTruncated = appendAssistantActivity(
      createWorkerActivityState(),
      ' '.repeat(961),
    );
    expect(whitespaceTruncated.recentActivityLines).toEqual(['…']);
    expect(whitespaceTruncated.assistantActivityTruncated).toBe(true);
  });

  test('closes streaming capture without removing its row so the next stream appends', () => {
    const streaming = appendAssistantActivity(createWorkerActivityState(), 'visible response');
    const closed = closeAssistantActivity(streaming);

    expect(closed).toEqual({
      assistantActivityLine: '',
      assistantActivityOpen: false,
      assistantActivityTruncated: false,
      recentActivityLines: ['visible response'],
    });
    expect(appendAssistantActivity(closed, 'next response').recentActivityLines).toEqual([
      'visible response',
      'next response',
    ]);
  });
});
