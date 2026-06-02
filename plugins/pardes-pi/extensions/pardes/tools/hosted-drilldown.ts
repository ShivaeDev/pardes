import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  GITHUB_DISCUSSION_DRILLDOWN_PAGE_SIZE,
  GITHUB_HOSTED_DRILLDOWN_EXCERPT_MAX_CHARS,
  GITHUB_HOSTED_DRILLDOWN_MAX_CHECKS,
  GITHUB_HOSTED_DRILLDOWN_MAX_PAGE,
  type GitHubCiLogExcerpt,
  type GitHubDiscussionBodyExcerptPage,
  type GitHubFailingChecksInspection,
} from '../github/index.ts';
import type { ManagerController } from '../manager/index.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';

function failingChecksLines(inspection: GitHubFailingChecksInspection): string {
  return [
    `github CI drill-down: opt-in read-only hosted check metadata · reviewGateId:${JSON.stringify(inspection.pullRequestId)} · PR:#${inspection.pullRequestNumber}`,
    `exactHeadSha:${inspection.exactHeadSha}`,
    ...inspection.failingChecks.map(
      (check) =>
        `failing check · runId:${check.runId} · jobId:${check.jobId} · status:${JSON.stringify(check.status)} · conclusion:${JSON.stringify(check.conclusion)} · name:${JSON.stringify(check.name)} · url:${JSON.stringify(check.url)}`,
    ),
    `bounds: first ${inspection.bounds.maxChecks} server-selected checks · observed:${inspection.observedCheckCount} [${inspection.omittedCheckCountAccuracy}] · mapped failures:${inspection.failingChecks.length} · unmapped failures:${inspection.unmappedFailingCheckCount} · no logs or bodies loaded`,
  ].join('\n');
}

function ciLogExcerptMetadata(excerpt: GitHubCiLogExcerpt) {
  const { excerpt: _excerpt, ...metadata } = excerpt;
  return metadata;
}

function ciLogExcerptLines(excerpt: GitHubCiLogExcerpt): string {
  return [
    `[${excerpt.trust}]`,
    `github CI log drill-down: opt-in read-only redacted excerpt · reviewGateId:${JSON.stringify(excerpt.pullRequestId)} · PR:#${excerpt.pullRequestNumber}`,
    `provenance: exactHeadSha:${excerpt.exactHeadSha} · runId:${excerpt.runId} · jobId:${excerpt.jobId} · url:${JSON.stringify(excerpt.url)}`,
    `pagination: page:${excerpt.page} · maxChars:${excerpt.maxChars} · excerptChars:${excerpt.excerptChars} · hasMore:${excerpt.hasMore}`,
    `excerpt(JSON string): ${JSON.stringify(excerpt.excerpt)}`,
    'boundary: explicit known failing run/job only · redacted bounded excerpt only · no rerun, cancel, approve, merge, or mutation capability',
  ].join('\n');
}

function discussionExcerptMetadata(page: GitHubDiscussionBodyExcerptPage) {
  return {
    ...page,
    items: page.items.map(({ excerpt: _excerpt, ...metadata }) => metadata),
  };
}

function discussionExcerptLines(page: GitHubDiscussionBodyExcerptPage): string {
  return [
    `[${page.trust}]`,
    `github discussion drill-down: opt-in read-only redacted body excerpts · reviewGateId:${JSON.stringify(page.pullRequestId)} · PR:#${page.pullRequestNumber} · surface:${page.surface}`,
    `pagination: page:${page.page} · items:${page.items.length}/${page.bounds.itemsPerPage} · hasMore:${page.hasMore}`,
    ...page.items.map(
      (item) =>
        `item id:${item.id} · author:${JSON.stringify(item.author)} · bodyChars:${item.bodyChars} · excerptChars:${item.excerptChars} · hasMore:${item.hasMore} · excerpt(JSON string): ${JSON.stringify(item.excerpt)}`,
    ),
    `bounds: first ${page.bounds.itemsPerPage} items on this explicit page · first ${page.bounds.maxExcerptCharsPerItem} redacted chars per item · no routing, approve, merge, or mutation capability`,
  ].join('\n');
}

export function registerHostedDrilldownTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description: `Explicitly inspect bounded structural failing-check metadata for one known Pardes pull-request review gate at its exact audited SHA. Returns first-${GITHUB_HOSTED_DRILLDOWN_MAX_CHECKS} check metadata with run/job ids and URLs. Opt-in read-only network access only; never loads logs or bodies and exposes no rerun, cancel, approve, merge, or mutation operation.`,
    async execute(_toolCallId, params) {
      const result = await runTool(manager.inspectPullRequestFailingChecks(params));
      return result.ok
        ? textResult(failingChecksLines(result.value), result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Inspect Pull Request Failing Checks',
    name: 'pull_request_ci_inspect',
    parameters: Type.Object(
      {
        pullRequestId: managerId('Known review-gate id copied from Pardes review status'),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [{ name: 'pullRequestId', value: args.pullRequestId }],
    promptSnippet:
      'Inspect structural failing-check metadata for one known review gate without loading logs',
  });

  registerPardesTool(pi, {
    description:
      'Explicitly retrieve one paginated bounded redacted CI log excerpt for one known failing run/job copied from pull_request_ci_inspect. Re-proves the run/job against the state-known review gate exact audited SHA before loading the log. Opt-in read-only network access only; never reruns, cancels, approves, merges, or mutates.',
    async execute(_toolCallId, params) {
      const result = await runTool(manager.getPullRequestCiLogExcerpt(params));
      return result.ok
        ? textResult(ciLogExcerptLines(result.value), ciLogExcerptMetadata(result.value))
        : textResult(`Error: ${result.error}`);
    },
    label: 'Get Pull Request CI Log Excerpt',
    name: 'pull_request_ci_log_excerpt_get',
    parameters: Type.Object(
      {
        jobId: Type.Integer({
          description: 'Known failing job id copied from pull_request_ci_inspect',
          minimum: 1,
        }),
        maxChars: Type.Optional(
          Type.Integer({
            description: `Maximum redacted excerpt characters returned, hard-capped at ${GITHUB_HOSTED_DRILLDOWN_EXCERPT_MAX_CHARS}.`,
            maximum: GITHUB_HOSTED_DRILLDOWN_EXCERPT_MAX_CHARS,
            minimum: 1,
          }),
        ),
        page: Type.Optional(
          Type.Integer({
            description: 'One-based excerpt page. Defaults to 1.',
            maximum: GITHUB_HOSTED_DRILLDOWN_MAX_PAGE,
            minimum: 1,
          }),
        ),
        pullRequestId: managerId('Known review-gate id copied from Pardes review status'),
        runId: Type.Integer({
          description: 'Known failing run id copied from pull_request_ci_inspect',
          minimum: 1,
        }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'pullRequestId', value: args.pullRequestId },
      { name: 'runId', value: args.runId },
      { name: 'jobId', value: args.jobId },
      { name: 'page', value: args.page },
      { name: 'maxChars', value: args.maxChars },
    ],
    promptSnippet:
      'Retrieve one paginated bounded redacted excerpt for a known failing CI run/job only',
  });

  registerPardesTool(pi, {
    description: `Explicitly retrieve one provenance-labelled page of bounded redacted external GitHub discussion body excerpts for one known Pardes review gate and one selected surface. Returns first-${GITHUB_DISCUSSION_DRILLDOWN_PAGE_SIZE} items on that page only. Opt-in read-only network access only; never default-loads bodies, routes feedback, approves, merges, or mutates.`,
    async execute(_toolCallId, params) {
      const result = await runTool(manager.getPullRequestDiscussionBodyExcerpts(params));
      return result.ok
        ? textResult(discussionExcerptLines(result.value), discussionExcerptMetadata(result.value))
        : textResult(`Error: ${result.error}`);
    },
    label: 'Get Pull Request Discussion Excerpts',
    name: 'pull_request_discussion_excerpt_get',
    parameters: Type.Object(
      {
        page: Type.Optional(
          Type.Integer({
            description: 'One-based hosted discussion page. Defaults to 1.',
            maximum: GITHUB_HOSTED_DRILLDOWN_MAX_PAGE,
            minimum: 1,
          }),
        ),
        pullRequestId: managerId('Known review-gate id copied from Pardes review status'),
        surface: Type.Union(
          [
            Type.Literal('issue_comment'),
            Type.Literal('review'),
            Type.Literal('inline_review_comment'),
          ],
          { description: 'Explicit external discussion provenance surface' },
        ),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'pullRequestId', value: args.pullRequestId },
      { name: 'surface', value: args.surface },
      { name: 'page', value: args.page },
    ],
    promptSnippet:
      'Retrieve one provenance-labelled bounded redacted discussion-body page only when explicitly needed',
  });
}
