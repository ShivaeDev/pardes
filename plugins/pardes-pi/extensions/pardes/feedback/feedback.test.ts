import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import { runFeedbackCli, terminalSafeJson } from './cli.ts';
import {
  claimFeedbackForWatch,
  feedbackRegistryPaths,
  getFeedback,
  listFeedback,
  markFeedbackAddressed,
  submitFeedback,
} from './store.ts';
import {
  childFeedbackSourceFromEnvironment,
  executeFeedbackTool,
  FEEDBACK_TOOL_DESCRIPTION,
  feedbackProvenance,
  feedbackToolParameters,
} from './tool.ts';

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pardes-feedback-'));
  temporaryDirectories.push(root);
  return root;
}

function provenance(index: number) {
  const role: 'writer' | 'advisory_verifier' = index % 2 === 0 ? 'writer' : 'advisory_verifier';
  return {
    agentId: `agent-${index}`,
    managerId: `manager-${index % 2}`,
    pardesVersion: '0.0.0',
    repositoryKey: `repo-${index % 3}`,
    role,
    sessionId: `session-${index}`,
    verificationId: `verify-${index}`,
    workstreamId: `workstream-${index % 4}`,
  };
}

function sessionContext(sessionId: string) {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as Pick<ExtensionContext, 'sessionManager'>;
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('global feedback registry', () => {
  test('persists concurrent submissions as distinct immutable atomic JSON records', async () => {
    const root = temporaryRoot();
    const count = 80;
    const submissions = await Effect.runPromise(
      Effect.all(
        Array.from({ length: count }, (_, index) =>
          submitFeedback(`feedback ${index}`, provenance(index), root),
        ),
        { concurrency: 'unbounded' },
      ),
    );
    const paths = feedbackRegistryPaths(root);
    const names = readdirSync(paths.submissions);

    expect(new Set(submissions.map(({ id }) => id)).size).toBe(count);
    expect(names).toHaveLength(count);
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);
    for (const submission of submissions) {
      const path = join(paths.submissions, `${submission.id}.json`);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(submission);
      expect(statSync(path).mode & 0o222).toBe(0);
    }
  });

  test('keeps addressed triage separate, durable, idempotent, and leaves the submission unchanged', async () => {
    const root = temporaryRoot();
    const submission = await Effect.runPromise(
      submitFeedback('original friction', provenance(1), root),
    );
    const path = join(feedbackRegistryPaths(root).submissions, `${submission.id}.json`);
    const before = readFileSync(path);
    const [left, right] = await Promise.all([
      Effect.runPromise(markFeedbackAddressed(submission.id, root)),
      Effect.runPromise(markFeedbackAddressed(submission.id, root)),
    ]);
    const entry = await Effect.runPromise(getFeedback(submission.id, root));

    expect(left.feedbackId).toBe(submission.id);
    expect(right).toEqual(left);
    expect(entry.triage).toEqual(left);
    expect(readFileSync(path)).toEqual(before);
    expect(
      JSON.parse(
        readFileSync(join(feedbackRegistryPaths(root).triage, `${submission.id}.json`), 'utf8'),
      ),
    ).toMatchObject({
      feedbackId: submission.id,
      status: 'addressed',
    });
  });

  test('filters globally by addressed state and bounded provenance dimensions', async () => {
    const root = temporaryRoot();
    const first = await Effect.runPromise(submitFeedback('needle first', provenance(0), root));
    await Effect.runPromise(submitFeedback('other', provenance(1), root));
    await Effect.runPromise(submitFeedback('needle third', provenance(2), root));
    await Effect.runPromise(markFeedbackAddressed(first.id, root));

    expect(
      (await Effect.runPromise(listFeedback({ addressed: true }, root))).map(
        (entry) => entry.submission.id,
      ),
    ).toEqual([first.id]);
    expect(
      await Effect.runPromise(
        listFeedback(
          {
            addressed: false,
            repositoryKey: 'repo-2',
            role: 'writer',
            text: 'needle',
            workstreamId: 'workstream-2',
          },
          root,
        ),
      ),
    ).toHaveLength(1);
    expect(await Effect.runPromise(listFeedback({ agentId: 'missing' }, root))).toEqual([]);
  });
});

describe('feedback provenance and model schema', () => {
  test('uses one required free-form text input and a deliberately broad description', () => {
    const parameters = feedbackToolParameters as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(parameters.properties)).toEqual(['text']);
    expect(parameters.required).toEqual(['text']);
    expect(FEEDBACK_TOOL_DESCRIPTION).toContain('frustrating');
    expect(FEEDBACK_TOOL_DESCRIPTION).toContain('confusing');
    expect(FEEDBACK_TOOL_DESCRIPTION).toContain('broken');
    expect(FEEDBACK_TOOL_DESCRIPTION).toContain('annoying');
    expect(FEEDBACK_TOOL_DESCRIPTION).toContain('wasteful');
    expect(FEEDBACK_TOOL_DESCRIPTION).toContain('not limited to harness bugs');
  });

  test('attaches only bounded explicit provenance and role-specific child identities', async () => {
    const root = temporaryRoot();
    const previous = process.env.PARDES_PI_STATE_DIR;
    process.env.PARDES_PI_STATE_DIR = root;
    try {
      const source = childFeedbackSourceFromEnvironment(
        {
          PARDES_FEEDBACK_AGENT_ID: 'verifier-agent',
          PARDES_FEEDBACK_MANAGER_ID: 'manager-one',
          PARDES_FEEDBACK_REPOSITORY_KEY: 'repo-one',
          PARDES_FEEDBACK_VERIFICATION_ID: 'verify-one',
          PARDES_FEEDBACK_WORKSTREAM_ID: 'stream-one',
          SECRET_TOKEN: 'must-not-be-captured',
        },
        'advisory_verifier',
      );
      const result = await executeFeedbackTool(
        'review was confusing',
        source,
        sessionContext('session-one'),
      );
      const entry = await Effect.runPromise(getFeedback(result.id, root));
      expect(entry.submission.provenance).toEqual({
        agentId: 'verifier-agent',
        managerId: 'manager-one',
        pardesVersion: '0.0.0',
        repositoryKey: 'repo-one',
        role: 'advisory_verifier',
        sessionId: 'session-one',
        verificationId: 'verify-one',
        workstreamId: 'stream-one',
      });
      expect(JSON.stringify(entry)).not.toContain('SECRET_TOKEN');
      expect(JSON.stringify(entry)).not.toContain('must-not-be-captured');
      expect(
        feedbackProvenance(
          { managerId: 'm'.repeat(700), role: 'manager' },
          sessionContext('s'.repeat(700)),
        ).managerId,
      ).toHaveLength(512);
    } finally {
      if (previous === undefined) delete process.env.PARDES_PI_STATE_DIR;
      else process.env.PARDES_PI_STATE_DIR = previous;
    }
  });
});

describe('feedback CLI', () => {
  test('offers discoverable help, filtering, safe display, and separate addressed-state commands', async () => {
    const root = temporaryRoot();
    const dangerous = `line\n\u001b[31mred\u202eoverride`;
    const first = await Effect.runPromise(submitFeedback(dangerous, provenance(0), root));
    await Effect.runPromise(submitFeedback('ordinary', provenance(1), root));
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      error: (line: string) => errors.push(line),
      out: (line: string) => output.push(line),
    };

    expect(await runFeedbackCli(['help'], io, { root })).toBe(0);
    expect(output.join('\n')).toContain('watch');
    expect(output.join('\n')).toContain('address');
    output.length = 0;
    expect(await runFeedbackCli(['list', '--role', 'writer', '--text', 'line'], io, { root })).toBe(
      0,
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toContain(first.id);
    expect(output[0]).not.toContain('\u001b');
    expect(output[0]).not.toContain('\u202e');
    expect(output[0]).toContain('\\u202e');
    output.length = 0;
    expect(await runFeedbackCli(['address', first.id], io, { root })).toBe(0);
    expect(await runFeedbackCli(['list', '--addressed', 'yes', '--json'], io, { root })).toBe(0);
    expect(output.at(-1)).toContain(first.id);
    expect(errors).toEqual([]);
    expect(terminalSafeJson({ text: dangerous })).not.toContain('\u202e');
  });

  test('uses durable atomic watch receipts to survive duplicate scans, concurrent watchers, and restarts', async () => {
    const root = temporaryRoot();
    const old = await Effect.runPromise(submitFeedback('already present', provenance(0), root));
    const output: string[] = [];
    const io = { error: () => {}, out: (line: string) => output.push(line) };

    await runFeedbackCli(['watch', '--once', '--cursor', 'triage'], io, { root });
    expect(output).toEqual([]);
    const fresh = await Effect.runPromise(submitFeedback('new entry', provenance(1), root));
    await Promise.all([
      runFeedbackCli(['watch', '--once', '--cursor', 'triage'], io, { root }),
      runFeedbackCli(['watch', '--once', '--cursor', 'triage'], io, { root }),
    ]);
    expect(output.filter((line) => line.includes(fresh.id))).toHaveLength(1);
    expect(output.some((line) => line.includes(old.id))).toBe(false);

    await runFeedbackCli(['watch', '--once', '--cursor', 'triage'], io, { root });
    expect(output.filter((line) => line.includes(fresh.id))).toHaveLength(1);
    const claims = await Promise.all(
      Array.from({ length: 12 }, () =>
        Effect.runPromise(claimFeedbackForWatch('other-cursor', fresh.id, root)),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
