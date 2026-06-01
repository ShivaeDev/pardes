import { describe, expect, test } from 'vitest';
import { RemoteBaselineError } from '../git/index.ts';
import { GitHubCommandError } from '../github/index.ts';
import {
  ReportArtifactError,
  ReportArtifactWriteError,
  ReportWriteLimitExceededError,
} from '../reporting/index.ts';
import {
  AgentReportHandoffRejectedError,
  formatPardesError,
  InboxEventNotFoundError,
  PluginActivationBlockedError,
  renderModelFacingGitHubCommandOperation,
  WorkstreamNotFoundError,
} from './errors.ts';
import { ManagerInputValidationError } from './inputs.ts';

function githubCommandError(
  command: string,
  args: ReadonlyArray<string>,
  cause: unknown = new Error('external diagnostic'),
) {
  return new GitHubCommandError({ args, cause, command, cwd: '/tmp/repo' });
}

describe('Pardes error formatting', () => {
  test('formats expected GitHub operations with concise allowlisted labels', () => {
    const operations = [
      ['gh', ['pr', 'create', '--body', 'hidden'], 'gh pr create'],
      ['gh', ['pr', 'edit', '42', '--body', 'hidden'], 'gh pr edit'],
      ['gh', ['pr', 'list', '--json', 'body'], 'gh pr list'],
      ['gh', ['pr', 'view', '42', '--json', 'body'], 'gh pr view'],
      ['git', ['push', 'origin', 'secret-ref'], 'git push'],
    ] as const;

    for (const [command, args, label] of operations) {
      expect(renderModelFacingGitHubCommandOperation(command, args)).toBe(label);
      expect(formatPardesError(githubCommandError(command, args))).toBe(
        `GitHub publication command failed: ${label}`,
      );
    }
  });

  test('omits GitHub PR body content, tokens, and external diagnostics', () => {
    const body = 'secret body marker '.repeat(500);
    const token = 'ghp_secret-token-marker';
    const diagnostic = 'external stderr secret marker';
    const formatted = formatPardesError(
      githubCommandError(
        'gh',
        ['pr', 'create', '--title', token, '--body', body, '--head', 'pardes/private'],
        new Error(diagnostic),
      ),
    );

    expect(formatted).toBe('GitHub publication command failed: gh pr create');
    expect(formatted).not.toContain(body);
    expect(formatted).not.toContain(token);
    expect(formatted).not.toContain(diagnostic);
  });

  test('uses a bounded generic fallback without echoing hostile arbitrary tokens', () => {
    const hostileCommand = 'malicious-command-'.repeat(500);
    const hostileToken = 'hostile-token-'.repeat(1_000);
    const formatted = formatPardesError(
      githubCommandError(hostileCommand, [hostileToken, '--body', hostileToken]),
    );

    expect(formatted).toBe('GitHub publication command failed: unrecognized operation');
    expect(formatted.length).toBeLessThan(80);
    expect(formatted).not.toContain(hostileCommand);
    expect(formatted).not.toContain(hostileToken);
  });

  test('retains raw structured GitHub command arguments for external diagnostics', () => {
    const args = ['pr', 'edit', '42', '--body', 'raw diagnostic body'] as const;
    const cause = new Error('raw diagnostic cause');
    const error = githubCommandError('gh', args, cause);

    expect(error.command).toBe('gh');
    expect(error.cwd).toBe('/tmp/repo');
    expect(error.args).toBe(args);
    expect(error.cause).toBe(cause);
    expect(formatPardesError(error)).not.toContain('raw diagnostic body');
  });

  test('renders remote-baseline failures through bounded allowlisted reasons', () => {
    const diagnostic = 'private remote diagnostic '.repeat(500);
    const messages = {
      fetch_failed: 'Cannot resolve worker baseline: could not fetch the selected origin baseline.',
      invalid_override: 'Cannot resolve worker baseline: invalid branch override.',
      missing_default_branch: 'Cannot resolve worker baseline: origin default branch is missing.',
      missing_remote: 'Cannot resolve worker baseline: configured remote origin is missing.',
      non_commit_resolution:
        'Cannot resolve worker baseline: selected origin ref did not resolve to one immutable commit.',
    } as const;

    for (const [reason, expected] of Object.entries(messages)) {
      const formatted = formatPardesError(
        new RemoteBaselineError({ cause: diagnostic, reason: reason as keyof typeof messages }),
      );
      expect(formatted).toBe(expected);
      expect(formatted).not.toContain(diagnostic);
      expect(formatted.length).toBeLessThan(120);
    }
  });

  test('keeps raw report adapter diagnostics out of model-facing lookup and persistence failures', () => {
    const diagnostic = {
      contents: 'private durable report detail',
      path: '/tmp/private/report.json',
    };
    const lookup = formatPardesError(
      new ReportArtifactError({
        cause: diagnostic,
        reason: 'invalid_schema',
        reportId: 'report-123',
      }),
    );
    const write = formatPardesError(
      new ReportArtifactWriteError({ cause: diagnostic, reportId: 'report-123' }),
    );
    const writeCap = formatPardesError(new ReportWriteLimitExceededError({ field: 'details' }));

    expect(lookup).toBe('Cannot read durable report report-123: invalid_schema.');
    expect(write).toBe('Could not persist durable child report artifact.');
    expect(writeCap).toBe('Durable child report details field exceeds its configured write cap.');
    expect(`${lookup}\n${write}\n${writeCap}`).not.toContain('/tmp/private');
    expect(`${lookup}\n${write}\n${writeCap}`).not.toContain('private durable report detail');
  });

  test('formats durable-report handoff state rejections through bounded allowlisted reasons', () => {
    expect(
      formatPardesError(
        new AgentReportHandoffRejectedError({
          reason: 'target_not_idle',
          targetAgentId: 'agent-123',
        }),
      ),
    ).toBe('Cannot hand off durable report to agent-123: retained target is not idle.');
    expect(
      formatPardesError(
        new AgentReportHandoffRejectedError({
          reason: 'target_not_attached',
          targetAgentId: 'agent-123',
        }),
      ),
    ).toBe('Cannot hand off durable report to agent-123: retained target runtime is not attached.');
    expect(
      formatPardesError(
        new AgentReportHandoffRejectedError({
          reason: 'source_not_managed',
          targetAgentId: 'agent-123',
        }),
      ),
    ).toBe(
      'Cannot hand off durable report: artifact source is not a retained manager-owned agent.',
    );
    expect(
      formatPardesError(
        new AgentReportHandoffRejectedError({
          reason: 'source_role_unsupported',
          targetAgentId: 'agent-123',
        }),
      ),
    ).toBe('Cannot hand off durable report: artifact source is not a worker or advisory verifier.');
  });

  test('formats plugin-activation lifecycle blocks as bounded manual operator guidance', () => {
    const formatted = formatPardesError(
      new PluginActivationBlockedError({
        operation: 'agent_reload',
        reason: 'snapshot_invalid',
        status: 'changed',
      }),
    );

    expect(formatted).toBe(
      "Cannot run agent_reload: this manager's pinned child-runtime snapshot is unavailable. Coordinate a manual manager reload activation point; Pardes did not fetch, pull, or reload plugin sources automatically.",
    );
    expect(formatted).not.toContain('/tmp/private/plugin-checkout');
  });

  test('formats pending-inbox direct-read failures without exposing diagnostics', () => {
    expect(formatPardesError(new InboxEventNotFoundError({ eventId: 'event-123' }))).toBe(
      'Unknown pending inbox event: event-123',
    );
    expect(
      formatPardesError(
        new ManagerInputValidationError({
          boundary: 'inbox_get',
          cause: 'private schema diagnostic',
        }),
      ),
    ).toBe('Invalid inbox_get input.');
  });

  test('preserves formatting for other typed errors', () => {
    expect(formatPardesError(new WorkstreamNotFoundError({ workstreamId: 'ws-123' }))).toBe(
      'Unknown workstream: ws-123',
    );
  });
});
