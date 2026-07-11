import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  PULL_REQUEST_BODY_MAX_LENGTH,
  PULL_REQUEST_BRANCH_MAX_LENGTH,
  PULL_REQUEST_TITLE_MAX_LENGTH,
} from '../github/index.ts';
import type { ManagerController, PullRequestCreateResult } from '../manager/index.ts';
import { MANAGER_INPUT_PULL_REQUEST_BRANCH_PATTERN } from '../manager/index.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';

function localTrackingText(tracking: PullRequestCreateResult['localTracking']): string {
  if (tracking.status === 'failed')
    return ` Local tracking: origin/${tracking.remoteBranch} failed safely; remote publication remains verified.`;
  return ` Local tracking: ${tracking.localBranch} -> ${tracking.remote}/${tracking.remoteBranch}${tracking.status === 'already_configured' ? ' (already configured)' : ''}.`;
}

function browserHandoffText(handoff: PullRequestCreateResult['browserHandoff']): string {
  if (handoff.status === 'not_requested') return ' Browser handoff: none.';
  if (handoff.status === 'failed')
    return ` Browser handoff: ${handoff.requestedMode} failed safely.`;
  if (handoff.openedMode === handoff.requestedMode)
    return ` Browser handoff: opened ${handoff.openedMode}.`;
  return ` Browser handoff: opened ${handoff.openedMode} portable fallback for requested ${handoff.requestedMode}.`;
}

export function registerPullRequestTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      "Audit an active-workstream managed worker's committed changes, push its exact SHA to a managed remote review branch, verify the hosted head, configure the retained local branch to track that remote branch, and create or update a GitHub review gate. Browser handoff is explicit: none, background, or foreground. Rejects completed or otherwise non-active workstreams. Never merges.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.createPullRequest(params, ctx));
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const published = result.value;
      return textResult(
        `${published.action === 'created' ? 'Created' : 'Updated'} PR #${published.pullRequest.number}: ${published.pullRequest.url}.${localTrackingText(published.localTracking)}${browserHandoffText(published.browserHandoff)}`,
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
          description:
            'Reviewer-first pull-request body with concise Why / How / Decisions / Callouts content',
          maxLength: PULL_REQUEST_BODY_MAX_LENGTH,
          minLength: 1,
        }),
        browserMode: Type.Optional(
          Type.Union(
            [Type.Literal('none'), Type.Literal('background'), Type.Literal('foreground')],
            {
              description:
                "Browser handoff mode. Defaults to 'none'. 'background' uses macOS open -g and a safe ordinary opener fallback elsewhere; 'foreground' uses the safe ordinary platform opener.",
            },
          ),
        ),
        openInBrowser: Type.Optional(
          Type.Boolean({
            description:
              "Compatibility alias for older callers. true means browserMode 'foreground'; false means 'none'. Do not combine it with browserMode.",
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
      { name: 'browserMode', value: args.browserMode },
      { name: 'openInBrowser', value: args.openInBrowser },
    ],
    promptSnippet: 'Publish a committed Pardes worker branch as a pull-request review gate',
  });
}
