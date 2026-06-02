import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { type Component, truncateToWidth } from '@earendil-works/pi-tui';

const CHILD_TOOL_CALL_PREVIEW_MAX_CHARS = 180;
const CHILD_TOOL_CALL_VALUE_MAX_CHARS = 48;
const CHILD_TOOL_RESULT_SUMMARY_MAX_CHARS = 160;
const CHILD_TOOL_RESULT_VERBOSE_MAX_CHARS = 1_600;
const CHILD_TOOL_RESULT_VERBOSE_MAX_LINES = 12;
const CHILD_TOOL_RESULT_EXPANDED_MAX_CHARS = 4_000;
const CHILD_TOOL_RESULT_EXPANDED_MAX_LINES = 40;
const DEEP_SEA_BACKGROUND = '\u001b[48;2;6;24;43m';
const RESET_BACKGROUND = '\u001b[49m';
const RESET_FOREGROUND = '\u001b[39m';
// Preserve line feeds for verbose rendering while removing terminal-active content.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal rendering intentionally strips control ranges.
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

interface ChildToolRenderContext {
  readonly isError: boolean;
}

interface ChildToolCallPreviewField {
  readonly name: string;
  readonly value: unknown;
  readonly mode?: 'value' | 'length';
}

function foreground(red: number, green: number, blue: number, text: string): string {
  return `\u001b[38;2;${red};${green};${blue}m${text}${RESET_FOREGROUND}`;
}

const rowPalette = {
  call: (text: string) => foreground(132, 223, 255, text),
  error: (text: string) => foreground(255, 156, 163, text),
  muted: (text: string) => foreground(139, 169, 196, text),
  parameter: (text: string) => foreground(168, 202, 255, text),
  result: (text: string) => foreground(226, 239, 255, text),
};

function truncatePreview(text: string, maxChars: number): string {
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : `${characters.slice(0, maxChars - 1).join('')}…`;
}

function escapedString(value: string): string {
  const escaped = JSON.stringify(truncatePreview(value, CHILD_TOOL_CALL_VALUE_MAX_CHARS));
  return escaped.replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function valueLength(value: unknown): string {
  if (typeof value === 'string') return `<${value.length} chars>`;
  if (Array.isArray(value)) return `<${value.length} items>`;
  if (value !== null && typeof value === 'object') return `<${Object.keys(value).length} fields>`;
  return `<${String(value).length} chars>`;
}

function previewValue({ value, mode = 'value' }: ChildToolCallPreviewField): string | undefined {
  if (value === undefined) return undefined;
  if (mode === 'length') return valueLength(value);
  if (typeof value === 'string') return escapedString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  if (Array.isArray(value)) return `<${value.length} items>`;
  if (typeof value === 'object') return `<${Object.keys(value).length} fields>`;
  return escapedString(String(value));
}

function childToolCallPreview(
  toolName: string,
  fields: ReadonlyArray<ChildToolCallPreviewField>,
): string {
  const renderedFields = fields.flatMap((field) => {
    const value = previewValue(field);
    return value === undefined ? [] : [`${field.name}=${value}`];
  });
  return truncatePreview(
    `${toolName}(${renderedFields.join(', ')})`,
    CHILD_TOOL_CALL_PREVIEW_MAX_CHARS,
  );
}

function verboseResultsEnabled(): boolean {
  try {
    const root = process.env.PARDES_PI_STATE_DIR || join(homedir(), '.pi', 'agent', 'pardes');
    const parsed = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('renderer' in parsed)) return false;
    const renderer = parsed.renderer;
    return (
      typeof renderer === 'object' &&
      renderer !== null &&
      'verboseResults' in renderer &&
      renderer.verboseResults === true
    );
  } catch {
    return false;
  }
}

function resultText(result: AgentToolResult<unknown>): string {
  const text = result.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  if (text) return text;
  return result.content.some((part) => part.type === 'image')
    ? '(image result)'
    : '(no textual result)';
}

function sanitizedResultText(result: AgentToolResult<unknown>): string {
  return stripVTControlCharacters(resultText(result))
    .replace(/\r\n?/g, '\n')
    .replace(TERMINAL_CONTROL_CHARACTERS, ' ');
}

function compactResultSummary(result: AgentToolResult<unknown>): string {
  const summary = sanitizedResultText(result).replace(/\s+/g, ' ').trim();
  return truncatePreview(summary || '(no textual result)', CHILD_TOOL_RESULT_SUMMARY_MAX_CHARS);
}

function verboseResultLines(
  result: AgentToolResult<unknown>,
  maxChars: number,
  maxLines: number,
): string[] {
  const source = sanitizedResultText(result).trimEnd() || '(no textual result)';
  const characterBounded = truncatePreview(source, maxChars);
  const sourceLines = characterBounded.split('\n');
  const truncated = characterBounded !== source || sourceLines.length > maxLines;
  const lines = sourceLines.slice(0, maxLines);
  if (truncated) {
    const marker = '… (terminal result preview bounded)';
    if (lines.length === maxLines) lines[maxLines - 1] = marker;
    else lines.push(marker);
  }
  return lines;
}

function styledCall(theme: Theme, toolName: string, preview: string): string {
  return `${rowPalette.call(theme.bold(toolName))}${rowPalette.parameter(preview.slice(toolName.length))}`;
}

class ChildToolText implements Component {
  constructor(private readonly lines: ReadonlyArray<string>) {}

  invalidate(): void {}

  render(width: number): string[] {
    const renderWidth = Math.max(0, Math.floor(width));
    if (renderWidth === 0 || this.lines.length === 0) return [];
    const ellipsis = `${DEEP_SEA_BACKGROUND}${rowPalette.muted('…')}`;
    return this.lines.map(
      (line) =>
        `${DEEP_SEA_BACKGROUND}${truncateToWidth(line, renderWidth, ellipsis, true)}${RESET_BACKGROUND}`,
    );
  }
}

export function renderChildToolCall(
  theme: Theme,
  toolName: string,
  fields: ReadonlyArray<ChildToolCallPreviewField>,
  resultOwnsRow = false,
): Component {
  if (resultOwnsRow) return new ChildToolText([]);
  const preview = childToolCallPreview(toolName, fields);
  return new ChildToolText([styledCall(theme, toolName, preview)]);
}

export function renderChildToolResult(
  theme: Theme,
  toolName: string,
  fields: ReadonlyArray<ChildToolCallPreviewField>,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  context: ChildToolRenderContext,
): Component {
  if (options.isPartial) return new ChildToolText([]);
  const preview = childToolCallPreview(toolName, fields);
  const call = styledCall(theme, toolName, preview);
  const summary = compactResultSummary(result);
  const isError = context.isError || /^error\b/i.test(summary);
  const resultStyle = isError ? rowPalette.error : rowPalette.result;
  if (!verboseResultsEnabled() && !options.expanded) {
    return new ChildToolText([`${call}${rowPalette.muted(' → ')}${resultStyle(summary)}`]);
  }
  return new ChildToolText([
    call,
    rowPalette.muted(isError ? 'error' : 'result'),
    ...verboseResultLines(
      result,
      options.expanded ? CHILD_TOOL_RESULT_EXPANDED_MAX_CHARS : CHILD_TOOL_RESULT_VERBOSE_MAX_CHARS,
      options.expanded ? CHILD_TOOL_RESULT_EXPANDED_MAX_LINES : CHILD_TOOL_RESULT_VERBOSE_MAX_LINES,
    ).map(resultStyle),
  ]);
}
