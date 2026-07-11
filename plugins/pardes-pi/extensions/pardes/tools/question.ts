import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  AUTONOMOUS_INBOX_PATH,
  INBOX_TWO_PATH_GUIDANCE,
  type ManagerController,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
} from '../manager/index.ts';
import {
  QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
  QUESTION_OPTION_LABEL_MAX_CHARS,
  QUESTION_OPTIONS_MAX_ITEMS,
  QUESTION_PROMPT_MAX_CHARS,
  sanitizeQuestionOptionLabel,
  selectPardesQuestionOption,
} from '../presentation/index.ts';
import { registerPardesTool, runTool, textResult } from './registration.ts';

interface QuestionInput {
  readonly options: Array<{ readonly description?: string; readonly label: string }>;
  readonly question: string;
}

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

export function registerQuestionTool(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description: `Unified user-judgment path: ask one genuine decision or free-form question. Options may be empty and a custom answer is always available. If a delivered Pardes attention cursor exists when the dialog opens, question binds that exact cursor and consumes only it after a non-blank answer; cancellation, failure, or blank input preserves it, and queued suffix attention is never consumed. ${INBOX_TWO_PATH_GUIDANCE}`,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return textResult('Error: question requires an interactive UI.');
      if (signal?.aborted)
        return textResult(
          'Question was aborted before it opened. No Pardes attention cursor was consumed.',
          {
            aborted: true,
            submitted: false,
          },
        );

      const started = await runTool(manager.beginInboxHandoffIfAvailable(ctx));
      if (!started.ok) return textResult(`Error: ${started.error}`);
      const handoff = started.value;
      let cursorSettled = false;
      let disarmAttempted = false;
      const disarm = async () => {
        if (!handoff) return { ok: true as const, value: false };
        disarmAttempted = true;
        return await runTool(manager.disarmInboxHandoff(handoff, ctx));
      };
      const preserveCursor = async (message: string, details: Record<string, unknown>) => {
        const disarmed = await disarm();
        if (!disarmed.ok) return textResult(`Error: ${disarmed.error}`, details);
        return textResult(message, {
          ...details,
          ...(handoff === undefined
            ? {}
            : {
                cursor: handoff.cursor,
                cursorPreserved: true,
                handoffDisarmed: disarmed.value,
              }),
          submitted: false,
        });
      };

      try {
        const selection = await selectPardesQuestionOption(
          ctx,
          params.question,
          params.options,
          signal,
        );
        if (!selection)
          return await preserveCursor('User cancelled the question.', { answer: null });

        let answer: string | undefined;
        let custom: boolean;
        if (selection.kind === 'custom') {
          answer = selection.value;
          if (answer === undefined) {
            answer = await ctx.ui.input(
              params.options.length === 0 ? params.question : 'Custom answer',
              params.options.length === 0 ? 'Type your answer' : params.question,
              signal === undefined ? undefined : { signal },
            );
          }
          custom = true;
        } else {
          answer = sanitizeQuestionOptionLabel(
            params.options[selection.index]?.label ?? selection.value,
          );
          custom = false;
        }

        if (!answer?.trim())
          return await preserveCursor(
            'User submitted no answer. The question remains unresolved.',
            {
              answer: null,
            },
          );

        let acknowledgement:
          | {
              readonly acknowledgedCount: number;
              readonly cursor?: string;
              readonly pendingCount: number;
              readonly queuedSuffixCount: number;
              readonly staleCursor: boolean;
              readonly reason: string;
            }
          | undefined;
        if (handoff) {
          const submitted = await runTool(manager.submitInboxHandoff(handoff, ctx));
          if (!submitted.ok) {
            return textResult(
              `Error: ${submitted.error}\nThe user answer was submitted, but the bound Pardes attention cursor remains pending.`,
              { answer, cursor: handoff.cursor, cursorPreserved: true, custom, submitted: true },
            );
          }
          acknowledgement = submitted.value;
        }

        const answerText = custom ? `User answered: ${answer}` : `User selected: ${answer}`;
        if (acknowledgement?.staleCursor) {
          const disarmed = await disarm();
          if (!disarmed.ok) return textResult(`Error: ${disarmed.error}`);
          return textResult(
            `${answerText}\nThe bound Pardes attention cursor became stale. No later queued attention was consumed.`,
            {
              ...acknowledgement,
              answer,
              cursorPreserved: true,
              custom,
              handoffDisarmed: disarmed.value,
              submitted: true,
            },
          );
        }
        cursorSettled = acknowledgement !== undefined;
        return textResult(answerText, {
          ...(acknowledgement ?? {}),
          answer,
          custom,
          submitted: true,
        });
      } finally {
        if (handoff && !cursorSettled && !disarmAttempted) await disarm();
      }
    },
    label: 'Question',
    name: 'question',
    parameters: Type.Object(
      {
        options: Type.Array(QuestionOption, {
          description:
            'Concrete choices for the user; use an empty array for a pure free-form prompt',
          maxItems: QUESTION_OPTIONS_MAX_ITEMS,
          minItems: 0,
        }),
        question: Type.String({
          description: 'Decision, blocker, or free-form prompt to ask the user',
          maxLength: QUESTION_PROMPT_MAX_CHARS,
          minLength: 1,
        }),
      },
      { additionalProperties: false },
    ),
    prepareArguments(args) {
      if (!args || typeof args !== 'object' || !('allowCustom' in args))
        return args as QuestionInput;
      const { allowCustom: _allowCustom, ...current } = args as Record<string, unknown>;
      return current as unknown as QuestionInput;
    },
    preview: (args) => [
      { mode: 'length', name: 'question', value: args.question },
      { mode: 'length', name: 'options', value: args.options },
    ],
    promptGuidelines: [
      AUTONOMOUS_INBOX_PATH,
      USER_JUDGMENT_INBOX_PATH,
      USER_JUDGMENT_HANDOFF_PATH,
      'Use question for structured or free-form user judgment. Pass options: [] for pure free-form input; custom input is always available.',
    ],
    promptSnippet:
      'Ask one structured or free-form user question and safely resolve any cursor delivered when it opens',
  });
}
