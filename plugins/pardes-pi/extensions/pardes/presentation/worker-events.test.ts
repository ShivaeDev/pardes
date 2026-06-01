import { stripVTControlCharacters } from 'node:util';
import { type ExtensionAPI, initTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { registerManagerPresentation } from './index.ts';
import { registerWorkerEventRenderer, renderWorkerEvent } from './worker-events.ts';

initTheme(undefined, false);

function plainTheme(): Theme {
  return {
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
}

function render(
  details: unknown,
  expanded = false,
  content = '[Pardes worker event] agent-123: **Worker summary**',
) {
  const component = renderWorkerEvent(
    {
      content,
      customType: 'pardes-worker-event',
      details,
      display: true,
      role: 'custom',
      timestamp: 0,
    },
    { expanded },
    plainTheme(),
  );
  if (!component)
    throw new Error('Expected the Pardes worker-event renderer to return a component.');
  return stripVTControlCharacters(component.render(240).join('\n'));
}

describe('Pardes worker-event renderer', () => {
  test('public composition registers the worker-event adapter and returns a dashboard owner', () => {
    const registrations: Array<{ readonly customType: string; readonly renderer: unknown }> = [];
    const pi = {
      registerMessageRenderer(customType: string, renderer: unknown) {
        registrations.push({ customType, renderer });
      },
    } as Pick<ExtensionAPI, 'registerMessageRenderer'>;

    const presentation = registerManagerPresentation(pi);

    expect(registrations).toEqual([
      { customType: 'pardes-worker-event', renderer: renderWorkerEvent },
    ]);
    expect(typeof presentation.updateDashboard).toBe('function');
    expect(typeof presentation.showDashboardOverlay).toBe('function');
  });

  test('registers only for pardes-worker-event messages', () => {
    const registrations: Array<{ readonly customType: string; readonly renderer: unknown }> = [];
    const pi = {
      registerMessageRenderer(customType: string, renderer: unknown) {
        registrations.push({ customType, renderer });
      },
    } as Pick<ExtensionAPI, 'registerMessageRenderer'>;

    registerWorkerEventRenderer(pi);

    expect(registrations).toEqual([
      { customType: 'pardes-worker-event', renderer: renderWorkerEvent },
    ]);
  });

  test('renders a compact status header and Markdown body without repeating the legacy label', () => {
    const text = render({
      agentId: 'agent-123',
      reportId: 'report-456',
      status: 'completed',
      type: 'report',
    });

    expect(text).toContain('✓ Pardes worker · COMPLETED · agent-123');
    expect(text).toContain('agent-123: Worker summary');
    expect(text).not.toContain('[Pardes worker event]');
    expect(text).not.toContain('Metadata');
  });

  test('shows only bounded allowlisted metadata when expanded and omits durable report details', () => {
    const durableDetails = 'durable report detail '.repeat(100);
    const text = render(
      {
        agentId: 'agent-123',
        context: 'question context must stay out of the renderer',
        details: durableDetails,
        reportId: 'report-456',
        status: 'blocked',
        stderr: 'stderr must stay out of the renderer',
        type: 'report',
      },
      true,
    );

    expect(text).toContain('! Pardes worker · BLOCKED · agent-123');
    expect(text).toContain('Metadata');
    expect(text).toContain('event: report');
    expect(text).toContain('report: report-456');
    expect(text).not.toContain('durable report detail');
    expect(text).not.toContain('question context');
    expect(text).not.toContain('stderr must stay out');
  });

  test('renders bounded tokenized inbox-wake metadata when expanded', () => {
    const text = render(
      {
        cursor: 'event-456',
        pendingCount: 4,
        queuedSuffixCount: 3,
        type: 'manager_inbox_wake',
        wakeToken: 'wake-123',
      },
      true,
      'Inspect the durable inbox.',
    );

    expect(text).toContain('! Pardes manager · INBOX WAKE');
    expect(text).toContain('wake: wake-123');
    expect(text).toContain('cursor: event-456');
    expect(text).toContain('pending: 4');
    expect(text).toContain('queued suffix: 3');
  });

  test('does not project retired scope-warning metadata', () => {
    const text = render(
      {
        agentId: 'agent-123',
        scopeViolations: ['one.ts', 'two.ts'],
        type: 'agent_scope_violation',
      },
      true,
    );

    expect(text).toContain('• Pardes worker · EVENT · agent-123');
    expect(text).not.toContain('SCOPE VIOLATION');
    expect(text).not.toContain('scope:');
  });
});
