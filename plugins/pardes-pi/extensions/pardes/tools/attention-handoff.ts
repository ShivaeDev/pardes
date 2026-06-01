import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagerController } from '../manager/index.ts';
import {
  ATTENTION_HANDOFF_FEEDBACK_MAX_CHARS,
  ATTENTION_HANDOFF_PROMPT_MAX_CHARS,
  inputPardesAttentionFeedback,
} from '../presentation/index.ts';
import { registerPardesTool, runTool, textResult } from './registration.ts';

export function registerAttentionHandoffTool(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      'Surface the one active delivered Pardes attention cursor to the user with a compact free-form input. Submission resumes this manager conversation and acknowledges only that cursor. Escape preserves pending attention.',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return textResult('Error: await_user_feedback requires an interactive UI.');
      if (signal?.aborted)
        return textResult(
          'Feedback handoff was aborted before it surfaced. No Pardes attention cursor was consumed.',
          { aborted: true, submitted: false },
        );
      const started = await runTool(manager.beginInboxHandoff(ctx));
      if (!started.ok) return textResult(`Error: ${started.error}`);

      let submitted = false;
      let disarmAttempted = false;
      const disarm = async () => {
        disarmAttempted = true;
        return await runTool(manager.disarmInboxHandoff(started.value, ctx));
      };
      const preserveCursorWithoutHandoff = async (message: string) => {
        const disarmed = await disarm();
        if (!disarmed.ok) return textResult(`Error: ${disarmed.error}`);
        return textResult(message, {
          cursor: started.value.cursor,
          cursorPreserved: true,
          handoffDisarmed: disarmed.value,
          submitted: false,
        });
      };

      try {
        const result = await inputPardesAttentionFeedback(ctx, params.prompt, signal);
        if (result.kind === 'cancelled') {
          return await preserveCursorWithoutHandoff(
            'User cancelled the feedback handoff. The delivered Pardes attention cursor remains pending.',
          );
        }
        const feedback = result.feedback.trim();
        if (!feedback) {
          return await preserveCursorWithoutHandoff(
            'User submitted no feedback. The delivered Pardes attention cursor remains pending.',
          );
        }
        if (feedback.length > ATTENTION_HANDOFF_FEEDBACK_MAX_CHARS) {
          return await preserveCursorWithoutHandoff(
            `User feedback exceeded the ${ATTENTION_HANDOFF_FEEDBACK_MAX_CHARS}-character handoff bound. The delivered Pardes attention cursor remains pending.`,
          );
        }

        const acknowledged = await runTool(manager.submitInboxHandoff(started.value, ctx));
        if (!acknowledged.ok) return textResult(`Error: ${acknowledged.error}`);
        submitted = true;
        if (acknowledged.value.staleCursor) {
          return textResult(
            'User feedback was submitted, but the presented Pardes cursor was stale. No later queued attention was consumed.\nUser feedback: ' +
              feedback,
            {
              ...acknowledged.value,
              submitted: true,
            },
          );
        }
        return textResult(`User feedback: ${feedback}`, { ...acknowledged.value, submitted: true });
      } finally {
        if (!submitted && !disarmAttempted) await disarm();
      }
    },
    label: 'Await User Feedback',
    name: 'await_user_feedback',
    parameters: Type.Object(
      {
        prompt: Type.String({
          description: 'Compact one-line question or requested feedback for the user',
          maxLength: ATTENTION_HANDOFF_PROMPT_MAX_CHARS,
          minLength: 1,
        }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [{ mode: 'length', name: 'prompt', value: args.prompt }],
    promptGuidelines: [
      'Use await_user_feedback only when durable Pardes attention requires user judgment; do not use it for autonomous acknowledgements.',
    ],
    promptSnippet: 'Pause for user feedback on the active delivered Pardes attention cursor',
  });
}
