import { stripVTControlCharacters } from 'node:util';
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { loadPardesRendererConfig, type PardesRendererConfig } from './renderer-config.ts';

export const PARDES_TOOL_CALL_PREVIEW_MAX_CHARS = 180;
export const PARDES_TOOL_CALL_VALUE_MAX_CHARS = 48;
export const PARDES_TOOL_RESULT_SUMMARY_MAX_CHARS = 160;
export const PARDES_TOOL_RESULT_VERBOSE_MAX_CHARS = 1_600;
export const PARDES_TOOL_RESULT_VERBOSE_MAX_LINES = 12;
export const PARDES_TOOL_RESULT_EXPANDED_MAX_CHARS = 4_000;
export const PARDES_TOOL_RESULT_EXPANDED_MAX_LINES = 40;

const DEEP_SEA_BACKGROUND = '\u001b[48;2;6;24;43m';
const RESET_BACKGROUND = '\u001b[49m';
const RESET_FOREGROUND = '\u001b[39m';
// Preserve line feeds for verbose rendering while removing terminal-active content.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal rendering intentionally strips control ranges.
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL_CHARACTERS = /\p{Bidi_Control}/gu;

type PreviewMode = 'value' | 'length' | 'redacted';

export interface PardesToolCallPreviewField {
  readonly name: string;
  readonly value: unknown;
  readonly mode?: PreviewMode;
}

interface PardesToolRenderContext {
  readonly isError: boolean;
}

interface ResultBounds {
  readonly maxChars: number;
  readonly maxLines: number;
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

function escapedUnicodeCharacter(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

function escapeBidiControls(text: string): string {
  return text.replace(BIDI_CONTROL_CHARACTERS, escapedUnicodeCharacter);
}

function escapedString(value: string): string {
  const escaped = JSON.stringify(truncatePreview(value, PARDES_TOOL_CALL_VALUE_MAX_CHARS));
  return escapeBidiControls(
    escaped.replace(/[\u007f-\u009f\u2028\u2029]/g, escapedUnicodeCharacter),
  );
}

function valueLength(value: unknown): string {
  if (typeof value === 'string') return `<${value.length} chars>`;
  if (Array.isArray(value)) return `<${value.length} items>`;
  if (value !== null && typeof value === 'object') return `<${Object.keys(value).length} fields>`;
  return `<${String(value).length} chars>`;
}

function previewValue({ value, mode = 'value' }: PardesToolCallPreviewField): string | undefined {
  if (value === undefined) return undefined;
  if (mode === 'redacted') return '<redacted>';
  if (mode === 'length') return valueLength(value);
  if (typeof value === 'string') return escapedString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  if (Array.isArray(value)) return `<${value.length} items>`;
  if (typeof value === 'object') return `<${Object.keys(value).length} fields>`;
  return escapedString(String(value));
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
  return escapeBidiControls(
    stripVTControlCharacters(resultText(result))
      .replace(/\r\n?/g, '\n')
      .replace(TERMINAL_CONTROL_CHARACTERS, ' '),
  );
}

function compactResultSummary(result: AgentToolResult<unknown>): string {
  const summary = sanitizedResultText(result).replace(/\s+/g, ' ').trim();
  return truncatePreview(summary || '(no textual result)', PARDES_TOOL_RESULT_SUMMARY_MAX_CHARS);
}

function verboseResultLines(
  result: AgentToolResult<unknown>,
  { maxChars, maxLines }: ResultBounds,
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

function boundedToolLine(line: string, width: number): string {
  const ellipsis = `${DEEP_SEA_BACKGROUND}${rowPalette.muted('…')}`;
  return `${DEEP_SEA_BACKGROUND}${truncateToWidth(line, width, ellipsis, true)}${RESET_BACKGROUND}`;
}

function truncateToolSegment(text: string, width: number): string {
  const ellipsis = `${DEEP_SEA_BACKGROUND}${rowPalette.muted('…')}`;
  return `${truncateToWidth(text, width, ellipsis)}${DEEP_SEA_BACKGROUND}`;
}

/** One self-shell tool component: no default Pi box padding and no Pardes-owned blank rows. */
class PardesToolText implements Component {
  constructor(private readonly lines: ReadonlyArray<string>) {}

  invalidate(): void {}

  render(width: number): string[] {
    const renderWidth = Math.max(0, Math.floor(width));
    if (renderWidth === 0 || this.lines.length === 0) return [];
    return this.lines.map((line) => boundedToolLine(line, renderWidth));
  }
}

/** Independently bound settled call and result segments so one dense row keeps result orientation. */
class PardesCompactToolText implements Component {
  constructor(
    private readonly call: string,
    private readonly result: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const renderWidth = Math.max(0, Math.floor(width));
    if (renderWidth === 0) return [];
    const separator = rowPalette.muted(' → ');
    const separatorWidth = visibleWidth(separator);
    if (renderWidth <= separatorWidth)
      return [boundedToolLine(`${this.call}${separator}${this.result}`, renderWidth)];

    const availableWidth = renderWidth - separatorWidth;
    let callWidth = Math.floor(availableWidth / 2);
    let resultWidth = availableWidth - callWidth;
    const callVisibleWidth = visibleWidth(this.call);
    const resultVisibleWidth = visibleWidth(this.result);
    if (callVisibleWidth < callWidth) {
      resultWidth += callWidth - callVisibleWidth;
      callWidth = callVisibleWidth;
    }
    if (resultVisibleWidth < resultWidth) {
      callWidth += resultWidth - resultVisibleWidth;
      resultWidth = resultVisibleWidth;
    }
    return [
      boundedToolLine(
        `${truncateToolSegment(this.call, callWidth)}${separator}${truncateToolSegment(this.result, resultWidth)}`,
        renderWidth,
      ),
    ];
  }
}

export function pardesToolCallPreview(
  toolName: string,
  fields: ReadonlyArray<PardesToolCallPreviewField>,
): string {
  const renderedFields = fields.flatMap((field) => {
    const value = previewValue(field);
    return value === undefined ? [] : [`${field.name}=${value}`];
  });
  return truncatePreview(
    `${toolName}(${renderedFields.join(', ')})`,
    PARDES_TOOL_CALL_PREVIEW_MAX_CHARS,
  );
}

export function renderPardesToolCall(
  theme: Theme,
  toolName: string,
  fields: ReadonlyArray<PardesToolCallPreviewField>,
  resultOwnsRow = false,
): Component {
  if (resultOwnsRow) return new PardesToolText([]);
  const preview = pardesToolCallPreview(toolName, fields);
  return new PardesToolText([styledCall(theme, toolName, preview)]);
}

/** Render only terminal presentation. Execute content and details remain untouched and model-visible. */
export function renderPardesToolResult(
  theme: Theme,
  toolName: string,
  fields: ReadonlyArray<PardesToolCallPreviewField>,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  context: PardesToolRenderContext,
  config: PardesRendererConfig = loadPardesRendererConfig(),
): Component {
  if (options.isPartial) return new PardesToolText([]);
  const preview = pardesToolCallPreview(toolName, fields);
  const call = styledCall(theme, toolName, preview);
  const summary = compactResultSummary(result);
  const isError = context.isError || /^error\b/i.test(summary);
  const resultStyle = isError ? rowPalette.error : rowPalette.result;
  if (!config.renderer.verboseResults && !options.expanded) {
    return new PardesCompactToolText(call, resultStyle(summary));
  }

  const bounds = options.expanded
    ? {
        maxChars: PARDES_TOOL_RESULT_EXPANDED_MAX_CHARS,
        maxLines: PARDES_TOOL_RESULT_EXPANDED_MAX_LINES,
      }
    : {
        maxChars: PARDES_TOOL_RESULT_VERBOSE_MAX_CHARS,
        maxLines: PARDES_TOOL_RESULT_VERBOSE_MAX_LINES,
      };
  return new PardesToolText([
    call,
    rowPalette.muted(isError ? 'error' : 'result'),
    ...verboseResultLines(result, bounds).map(resultStyle),
  ]);
}
