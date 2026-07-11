import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

function runProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      }),
    );
  });
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

  test('enforces owner-only modes and tightens existing registry permissions', async () => {
    const root = temporaryRoot();
    const submission = await Effect.runPromise(
      submitFeedback('private friction', provenance(0), root),
    );
    const paths = feedbackRegistryPaths(root);
    const submissionPath = join(paths.submissions, `${submission.id}.json`);

    for (const directory of [paths.directory, paths.submissions, paths.triage, paths.watchCursors])
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(submissionPath).mode & 0o777).toBe(0o400);

    chmodSync(paths.directory, 0o755);
    chmodSync(paths.submissions, 0o755);
    chmodSync(submissionPath, 0o444);
    await Effect.runPromise(listFeedback({}, root));
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.submissions).mode & 0o777).toBe(0o700);
    expect(statSync(submissionPath).mode & 0o777).toBe(0o400);
  });

  test('persists safely across truly separate concurrent writer processes', async () => {
    const root = temporaryRoot();
    const writer = join(root, 'writer.ts');
    const storeUrl = new URL('./store.ts', import.meta.url).href;
    const effectUrl = pathToFileURL(join(process.cwd(), 'node_modules/effect/dist/Effect.js')).href;
    writeFileSync(
      writer,
      `import * as Effect from ${JSON.stringify(effectUrl)};\nimport { submitFeedback } from ${JSON.stringify(storeUrl)};\nconst [root, index] = process.argv.slice(2);\nawait Effect.runPromise(submitFeedback('process ' + index, { pardesVersion: '0.0.0', role: 'writer', sessionId: 'session-' + index }, root));\n`,
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runProcess('bun', [writer, root, String(index)], { cwd: process.cwd() }),
      ),
    );
    expect(results.map(({ code }) => code)).toEqual(Array.from({ length: 12 }, () => 0));
    expect(await Effect.runPromise(listFeedback({}, root))).toHaveLength(12);
    expect(
      readdirSync(feedbackRegistryPaths(root).submissions).some((name) => name.endsWith('.tmp')),
    ).toBe(false);
  });

  test('fails closed on redirected or malformed registry artifacts', async () => {
    const symlinkRoot = temporaryRoot();
    await Effect.runPromise(submitFeedback('valid', provenance(0), symlinkRoot));
    const symlinkPaths = feedbackRegistryPaths(symlinkRoot);
    const redirected = join(symlinkRoot, 'redirected.json');
    writeFileSync(redirected, '{}\n');
    symlinkSync(redirected, join(symlinkPaths.submissions, 'feedback-deadbeef.json'));
    await expect(Effect.runPromise(listFeedback({}, symlinkRoot))).rejects.toMatchObject({
      _tag: 'FeedbackStoreError',
    });

    const malformedRoot = temporaryRoot();
    await Effect.runPromise(submitFeedback('valid', provenance(0), malformedRoot));
    writeFileSync(
      join(feedbackRegistryPaths(malformedRoot).submissions, 'feedback-deadbeef.json'),
      '{not-json}\n',
    );
    await expect(Effect.runPromise(listFeedback({}, malformedRoot))).rejects.toMatchObject({
      _tag: 'FeedbackStoreError',
    });

    const directoryRoot = temporaryRoot();
    await Effect.runPromise(submitFeedback('valid', provenance(0), directoryRoot));
    const directoryPaths = feedbackRegistryPaths(directoryRoot);
    rmSync(directoryPaths.triage, { recursive: true });
    mkdirSync(join(directoryRoot, 'redirected-triage'));
    symlinkSync(join(directoryRoot, 'redirected-triage'), directoryPaths.triage);
    await expect(Effect.runPromise(listFeedback({}, directoryRoot))).rejects.toMatchObject({
      _tag: 'FeedbackStoreError',
    });
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

      const emoji = '😀'.repeat(700);
      const astral = feedbackProvenance(
        { managerId: emoji, role: 'manager' },
        sessionContext(emoji),
      );
      expect(astral.managerId?.length).toBe(512);
      expect(astral.sessionId?.length).toBe(512);
      expect(astral.managerId?.endsWith('\ud83d')).toBe(false);
      const astralResult = await executeFeedbackTool(
        'astral provenance remains recordable',
        { managerId: emoji, role: 'manager' },
        sessionContext(emoji),
      );
      expect(
        (await Effect.runPromise(getFeedback(astralResult.id, root))).submission.provenance,
      ).toMatchObject({ managerId: astral.managerId, sessionId: astral.sessionId });
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
    expect(output.join('\n')).toContain('consumes every observed entry');
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

    errors.length = 0;
    expect(await runFeedbackCli(['list', '--since', '2026'], io, { root })).toBe(1);
    expect(errors[0]).toContain('canonical ISO timestamp');
    errors.length = 0;
    expect(
      await runFeedbackCli(['list', '--since', '2026-02-30T00:00:00.000Z'], io, { root }),
    ).toBe(1);
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

    const cursorDirectory = join(feedbackRegistryPaths(root).watchCursors, 'triage');
    expect(statSync(cursorDirectory).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(cursorDirectory).filter((name) => name.endsWith('.json')))
      expect(statSync(join(cursorDirectory, name)).mode & 0o777).toBe(0o400);
  });

  test('resumes an interrupted first-use initialization from one stable boundary', async () => {
    const root = temporaryRoot();
    const old = await Effect.runPromise(submitFeedback('old entry', provenance(0), root));
    const paths = feedbackRegistryPaths(root);
    const cursorDirectory = join(paths.watchCursors, 'interrupted');
    mkdirSync(cursorDirectory, { mode: 0o700, recursive: true });
    const boundaryAt = new Date().toISOString();
    writeFileSync(
      join(cursorDirectory, 'initializing.json'),
      `${JSON.stringify({ boundaryAt, cursor: 'interrupted', includeExisting: false, schemaVersion: 1, status: 'initializing' })}\n`,
      { mode: 0o400 },
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const fresh = await Effect.runPromise(submitFeedback('fresh entry', provenance(1), root));
    const output: string[] = [];
    const io = { error: () => {}, out: (line: string) => output.push(line) };

    expect(await runFeedbackCli(['watch', '--once', '--cursor', 'interrupted'], io, { root })).toBe(
      0,
    );
    expect(output.some((line) => line.includes(old.id))).toBe(false);
    expect(output.filter((line) => line.includes(fresh.id))).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(cursorDirectory, 'initialized.json'), 'utf8')),
    ).toMatchObject({ boundaryAt, status: 'initialized' });
  });

  test('records delivery after output so output failure and crash-lock recovery replay safely', async () => {
    const root = temporaryRoot();
    const first = await Effect.runPromise(submitFeedback('must replay', provenance(0), root));
    const errors: string[] = [];
    expect(
      await runFeedbackCli(
        ['watch', '--once', '--include-existing', '--cursor', 'replay'],
        {
          error: (line) => errors.push(line),
          out: () => {
            throw new Error('sink failed');
          },
        },
        { root },
      ),
    ).toBe(1);
    expect(errors[0]).toContain('sink failed');

    const output: string[] = [];
    const io = { error: () => {}, out: (line: string) => output.push(line) };
    expect(await runFeedbackCli(['watch', '--once', '--cursor', 'replay'], io, { root })).toBe(0);
    expect(output.filter((line) => line.includes(first.id))).toHaveLength(1);

    const second = await Effect.runPromise(submitFeedback('after crash', provenance(1), root));
    const lockPath = join(feedbackRegistryPaths(root).watchCursors, 'replay', 'scan.lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({ createdAt: new Date().toISOString(), pid: 2_147_483_647, token: 'dead-owner' })}\n`,
      { mode: 0o600 },
    );
    expect(await runFeedbackCli(['watch', '--once', '--cursor', 'replay'], io, { root })).toBe(0);
    expect(output.filter((line) => line.includes(second.id))).toHaveLength(1);
  });

  test('fences stale-lock replacement under high-contention separate-process watchers', async () => {
    const root = temporaryRoot();
    await Effect.runPromise(submitFeedback('baseline', provenance(0), root));
    const quietIo = { error: () => {}, out: () => {} };
    expect(
      await runFeedbackCli(['watch', '--once', '--cursor', 'contention'], quietIo, { root }),
    ).toBe(0);
    const lockPath = join(feedbackRegistryPaths(root).watchCursors, 'contention', 'scan.lock');
    const sourceBin = join(process.cwd(), 'plugins/pardes-pi/scripts/pardes-feedback.ts');
    for (let round = 0; round < 4; round += 1) {
      const unseen = await Effect.runPromise(
        submitFeedback(`contended ${round}`, provenance(round + 1), root),
      );
      writeFileSync(
        lockPath,
        `${JSON.stringify({ createdAt: new Date().toISOString(), pid: 2_147_483_647, token: `legacy-dead-owner-${round}` })}\n`,
        { mode: 0o600 },
      );
      const watchers = await Promise.all(
        Array.from({ length: 16 }, () =>
          runProcess('bun', [sourceBin, 'watch', '--once', '--cursor', 'contention'], {
            cwd: process.cwd(),
            env: { ...process.env, PARDES_PI_STATE_DIR: root },
          }),
        ),
      );
      expect(watchers.filter(({ code }) => code !== 0)).toEqual([]);
      expect(watchers.map(({ stderr }) => stderr)).toEqual(Array.from({ length: 16 }, () => ''));
      expect(
        watchers.reduce((count, { stdout }) => count + Number(stdout.includes(unseen.id)), 0),
      ).toBe(1);
    }
  });

  test('executes through the installed-bin shape and includes feedback runtime files in the package', async () => {
    const root = temporaryRoot();
    const binDirectory = join(root, 'node_modules', '.bin');
    mkdirSync(binDirectory, { recursive: true });
    const sourceBin = join(process.cwd(), 'plugins/pardes-pi/scripts/pardes-feedback.ts');
    const installedBin = join(binDirectory, 'pardes-feedback');
    symlinkSync(sourceBin, installedBin);
    const help = await runProcess(installedBin, ['help'], {
      cwd: process.cwd(),
      env: { ...process.env, PARDES_PI_STATE_DIR: root },
    });
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toContain('Usage: pardes-feedback');

    const submission = await Effect.runPromise(
      submitFeedback('installed watch entry', provenance(0), root),
    );
    const watched = await runProcess(
      installedBin,
      ['watch', '--once', '--include-existing', '--cursor', 'installed-bin'],
      { cwd: process.cwd(), env: { ...process.env, PARDES_PI_STATE_DIR: root } },
    );
    expect(watched.code).toBe(0);
    expect(watched.stdout).toContain(submission.id);

    const packed = await runProcess('bun', ['pm', 'pack', '--dry-run'], {
      cwd: process.cwd(),
      env: process.env,
    });
    expect(packed.code).toBe(0);
    expect(`${packed.stdout}\n${packed.stderr}`).toContain(
      'plugins/pardes-pi/scripts/pardes-feedback.ts',
    );
    expect(`${packed.stdout}\n${packed.stderr}`).toContain(
      'plugins/pardes-pi/extensions/pardes/feedback/store.ts',
    );
  });
});
