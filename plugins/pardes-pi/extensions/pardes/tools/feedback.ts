import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  executeFeedbackTool,
  FEEDBACK_TOOL_DESCRIPTION,
  type FeedbackSource,
  feedbackToolParameters,
} from '../feedback/index.ts';
import type { ManagerController } from '../manager/index.ts';
import { registerPardesTool, textResult } from './registration.ts';

export function registerManagerFeedbackTool(
  pi: ExtensionAPI,
  manager: Pick<ManagerController, 'snapshot'>,
): void {
  registerPardesTool(pi, {
    description: FEEDBACK_TOOL_DESCRIPTION,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = manager.snapshot();
      const source: FeedbackSource = {
        ...(state === undefined
          ? {}
          : { managerId: state.managerId, repositoryKey: state.repo.key }),
        role: 'manager',
      };
      try {
        const recorded = await executeFeedbackTool(params.text, source, ctx);
        return textResult(`Feedback recorded as ${recorded.id}.`, {
          pardesFeedback: { id: recorded.id, type: 'recorded' },
        });
      } catch {
        throw new Error('Pardes could not record feedback in global state.');
      }
    },
    label: 'Record Feedback',
    name: 'feedback',
    parameters: feedbackToolParameters,
    preview: (args) => [{ mode: 'length', name: 'text', value: args.text }],
    promptGuidelines: [
      'Use feedback to preserve anything about Pardes that is frustrating, confusing, broken, annoying, or wasteful; do not wait for a harness-specific bug or force a category.',
    ],
    promptSnippet:
      'Record any frustrating, confusing, broken, annoying, or wasteful Pardes experience',
  });
}
