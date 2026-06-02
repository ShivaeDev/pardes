import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  AUTONOMOUS_INBOX_PATH,
  INBOX_TWO_PATH_GUIDANCE,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
} from '../manager/index.ts';
import {
  QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
  QUESTION_OPTION_LABEL_MAX_CHARS,
  QUESTION_OPTIONS_MAX_ITEMS,
  QUESTION_PROMPT_MAX_CHARS,
  sanitizeQuestionCustomAnswer,
  sanitizeQuestionOptionLabel,
  selectPardesQuestionOption,
} from '../presentation/index.ts';
import { registerPardesTool, textResult } from './registration.ts';

const QuestionOption = Type.Object(
  {
    description: Type.Optional(
      Type.String({
        description: 'Optional context for this option',
        maxLength: QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
      }),
    ),
    label: Type.String({
      description: 'Short answer shown to the user',
      maxLength: QUESTION_OPTION_LABEL_MAX_CHARS,
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

export function registerQuestionTool(pi: ExtensionAPI): void {
  registerPardesTool(pi, {
    description: `Structured user-judgment path: ask the user a genuine decision question with options. Use for forks and blockers, not routine confirmations. If durable Pardes attention led here, do not acknowledge its active cursor first; this tool does not consume that cursor. ${INBOX_TWO_PATH_GUIDANCE}`,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return textResult('Error: question requires an interactive UI.');
      const selection = await selectPardesQuestionOption(
        ctx,
        params.question,
        params.options,
        params.allowCustom !== false,
      );
      if (!selection) return textResult('User cancelled the question.', { answer: null });
      if (selection.kind === 'custom') {
        const answer = sanitizeQuestionCustomAnswer((await ctx.ui.input('Custom answer')) ?? '');
        return answer
          ? textResult(`User answered: ${answer}`, { answer, custom: true })
          : textResult('User cancelled the question.', { answer: null });
      }
      const answer = sanitizeQuestionOptionLabel(
        params.options[selection.index]?.label ?? selection.value,
      );
      return textResult(`User selected: ${answer}`, { answer, custom: false });
    },
    label: 'Question',
    name: 'question',
    parameters: Type.Object(
      {
        allowCustom: Type.Optional(
          Type.Boolean({ description: 'Offer a free-form response. Default true.' }),
        ),
        options: Type.Array(QuestionOption, {
          description: 'Concrete options for the user',
          maxItems: QUESTION_OPTIONS_MAX_ITEMS,
          minItems: 1,
        }),
        question: Type.String({
          description: 'Decision or blocker to ask the user about',
          maxLength: QUESTION_PROMPT_MAX_CHARS,
          minLength: 1,
        }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { mode: 'length', name: 'question', value: args.question },
      { mode: 'length', name: 'options', value: args.options },
      { name: 'allowCustom', value: args.allowCustom },
    ],
    promptGuidelines: [
      AUTONOMOUS_INBOX_PATH,
      USER_JUDGMENT_INBOX_PATH,
      USER_JUDGMENT_HANDOFF_PATH,
      'For structured user judgment, surface the issue with question while any active Pardes attention cursor remains open until response.',
    ],
    promptSnippet:
      'Ask a structured user-judgment question while leaving any active Pardes attention cursor open until response',
  });
}
