import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  PULL_REQUEST_BODY_MAX_LENGTH,
  PULL_REQUEST_BRANCH_MAX_LENGTH,
  PULL_REQUEST_TITLE_MAX_LENGTH,
} from '../github/index.ts';
import type { ManagerController } from '../manager/index.ts';
import { MANAGER_INPUT_PULL_REQUEST_BRANCH_PATTERN } from '../manager/index.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';

export function registerPullRequestTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      "Audit an active-workstream managed worker's committed changes, push its managed branch to origin, and create or update a GitHub review gate. Rejects completed or otherwise non-active workstreams. Never merges.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.createPullRequest(params, ctx));
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const published = result.value;
      const browser = published.openedInBrowser ? ' Opened in browser.' : '';
      return textResult(
        `${published.action === 'created' ? 'Created' : 'Updated'} PR #${published.pullRequest.number}: ${published.pullRequest.url}.${browser}`,
        published,
      );
    },
    label: 'Publish Pull Request',
    name: 'pull_request_create',
    parameters: Type.Object(
      {
        agentId: managerId('Worker agent id belonging to the workstream'),
        baseBranch: Type.String({
          description: 'Explicit target branch, such as main',
          maxLength: PULL_REQUEST_BRANCH_MAX_LENGTH,
          minLength: 1,
          pattern: MANAGER_INPUT_PULL_REQUEST_BRANCH_PATTERN,
        }),
        body: Type.String({
          description: 'Pull-request body with summary and validation',
          maxLength: PULL_REQUEST_BODY_MAX_LENGTH,
          minLength: 1,
        }),
        openInBrowser: Type.Optional(
          Type.Boolean({
            description:
              "Explicitly hand the published PR off to the user's browser. Defaults to false.",
          }),
        ),
        title: Type.String({
          description: 'Pull-request title',
          maxLength: PULL_REQUEST_TITLE_MAX_LENGTH,
          minLength: 1,
        }),
        workstreamId: managerId('Owning workstream id'),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'workstreamId', value: args.workstreamId },
      { name: 'agentId', value: args.agentId },
      { name: 'title', value: args.title },
      { mode: 'length', name: 'body', value: args.body },
      { name: 'baseBranch', value: args.baseBranch },
      { name: 'openInBrowser', value: args.openInBrowser },
    ],
    promptSnippet: 'Publish a committed Pardes worker branch as a pull-request review gate',
  });
}
