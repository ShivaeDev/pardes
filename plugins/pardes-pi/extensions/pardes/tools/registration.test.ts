import type { ExtensionAPI, Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';
import type { ManagerController } from '../manager/index.ts';
import {
  PARDES_TOOL_CALL_PREVIEW_MAX_CHARS,
  PARDES_TOOL_CALL_VALUE_MAX_CHARS,
  pardesToolCallPreview,
  renderPardesToolCall,
} from '../presentation/index.ts';
import { requiredValue } from '../test-support.ts';
import { registerAgentTools, registerQuestionTool, registerWorkstreamTools } from './index.ts';

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

describe('Pardes interactive tool-call previews', () => {
  test('escapes terminal control text and renders large or sensitive fields without their content', () => {
    const payload = 'do-not-render';
    const secret = 'ghp_private-token-marker';
    const preview = pardesToolCallPreview('safe_tool', [
      { name: 'line', value: 'quoted: "yes"\nnext\t\u001b[31m\u009b' },
      { mode: 'length', name: 'payload', value: payload },
      { mode: 'redacted', name: 'token', value: secret },
      { name: 'options', value: ['private-one', 'private-two'] },
      { name: 'missing', value: undefined },
    ]);

    expect(preview).toContain('line="quoted: \\"yes\\"\\nnext\\t\\u001b[31m\\u009b"');
    expect(preview).toContain(`payload=<${payload.length} chars>`);
    expect(preview).toContain('token=<redacted>');
    expect(preview).toContain('options=<2 items>');
    expect(preview).not.toContain('\n');
    expect(preview).not.toContain('\u001b');
    expect(preview).not.toContain('\u009b');
    expect(preview).not.toContain(payload);
    expect(preview).not.toContain(secret);
    expect(preview).not.toContain('private-one');
    expect(preview).not.toContain('missing');
  });

  test('visibly truncates the canonical preview and the rendered viewport to one hard-bounded line', () => {
    const preview = pardesToolCallPreview('bounded_tool', [
      { name: 'value', value: 'x'.repeat(500) },
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `field${index}`,
        value: `value-${index}`,
      })),
    ]);
    expect(Array.from(preview)).toHaveLength(PARDES_TOOL_CALL_PREVIEW_MAX_CHARS);
    expect(preview).toContain(`value="${'x'.repeat(PARDES_TOOL_CALL_VALUE_MAX_CHARS - 1)}…"`);
    expect(preview.endsWith('…')).toBe(true);

    const lines = renderPardesToolCall(theme, 'bounded_tool', [
      { name: 'value', value: 'x'.repeat(500) },
    ]).render(32);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(requiredValue(lines[0]))).toBeLessThanOrEqual(32);
    expect(lines[0]).toContain('...');
  });

  test('keeps retained-agent send rendering one-line and content-free for large routine messages', () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;
    registerAgentTools(pi, {} as ManagerController);
    const send = requiredValue(tools.find((tool) => tool.name === 'agent_send'));
    const secret = 'private-routine-guidance-'.repeat(100);

    const lines = requiredValue(send.renderCall)(
      { agentId: 'agent-123', behavior: 'auto', message: secret },
      theme,
      {} as never,
    ).render(72);

    expect(lines).toHaveLength(1);
    expect(visibleWidth(requiredValue(lines[0]))).toBeLessThanOrEqual(72);
    expect(lines[0]).toContain(`message=<${secret.length} chars>`);
    expect(lines[0]).toContain('behavior="auto"');
    expect(lines[0]).not.toContain('private-routine-guidance');
  });

  test('installs a one-line call renderer without result rendering for every interactive manager tool', () => {
    const tools: ToolDefinition[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;
    const manager = {} as ManagerController;

    registerQuestionTool(pi);
    registerWorkstreamTools(pi, manager);
    registerAgentTools(pi, manager);

    expect(tools).toHaveLength(23);
    for (const tool of tools) {
      expect(tool.executionMode, tool.name).toBe('sequential');
      expect(typeof tool.renderCall, tool.name).toBe('function');
      expect(tool.renderResult, tool.name).toBeUndefined();
      const component = requiredValue(tool.renderCall)(
        {
          action: 'inspect',
          agentId: 'agent-123',
          body: 'private body',
          eventId: 'event-123',
          message: 'private message',
          objective: 'private objective',
          options: [{ label: 'private option' }],
          question: 'private question',
          reportId: 'report-123',
          sourceAgentId: 'agent-123',
          task: 'private task',
          title: 'title',
          verificationId: 'verify-123',
          workstreamId: 'ws-123',
        },
        theme,
        {} as never,
      );
      const lines = component.render(48);
      expect(lines, tool.name).toHaveLength(1);
      expect(visibleWidth(requiredValue(lines[0])), tool.name).toBeLessThanOrEqual(48);
    }
  });
});
