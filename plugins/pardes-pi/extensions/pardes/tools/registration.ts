import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { type Static, type TSchema, Type } from 'typebox';
import {
  formatPardesError,
  MANAGER_INPUT_ID_MAX_LENGTH,
  MANAGER_INPUT_ID_PATTERN,
} from '../manager/index.ts';
import {
  type PardesToolCallPreviewField,
  renderPardesToolCall,
  renderPardesToolResult,
} from '../presentation/index.ts';

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function textResult(text: string, details?: unknown) {
  return { content: [{ text, type: 'text' as const }], details };
}

type PardesToolDefinition<TParams extends TSchema, TDetails, TState> = Omit<
  ToolDefinition<TParams, TDetails, TState>,
  'executionMode' | 'renderCall' | 'renderResult' | 'renderShell'
> & {
  readonly preview: (args: Static<TParams>) => ReadonlyArray<PardesToolCallPreviewField>;
};

/** Register one sequential model-visible Pardes tool with the canonical bounded call preview. */
export function registerPardesTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  tool: PardesToolDefinition<TParams, TDetails, TState>,
): void {
  const { preview, ...definition } = tool;
  pi.registerTool({
    ...definition,
    executionMode: 'sequential',
    renderCall(args, theme, context) {
      return renderPardesToolCall(theme, definition.name, preview(args), !context.isPartial);
    },
    renderResult(result, options, theme, context) {
      return renderPardesToolResult(
        theme,
        definition.name,
        preview(context.args),
        result,
        options,
        context,
      );
    },
    renderShell: 'self',
  });
}

export function managerId(description?: string) {
  return Type.String({
    maxLength: MANAGER_INPUT_ID_MAX_LENGTH,
    minLength: 1,
    pattern: MANAGER_INPUT_ID_PATTERN,
    ...(description === undefined ? {} : { description }),
  });
}

export async function runTool<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }
> {
  try {
    return { ok: true, value: await Effect.runPromise(effect) };
  } catch (error) {
    return { error: formatPardesError(error), ok: false };
  }
}
