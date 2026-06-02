import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { ExtensionAPI, Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, test } from 'vitest';
import { REPORT_DETAILS_MAX_CHARS, REPORT_SUMMARY_MAX_CHARS } from '../reporting/index.ts';
import { requiredValue } from '../test-support.ts';
import pardesWorker, {
  boundedGitDiagnostic,
  boundedVerifierPathRows,
  GIT_INSPECTION_STDOUT_MAX_BYTES,
  getWorkerToolPathDenialReason,
  isPathInsideWorktree,
  normalizeWorkerToolPath,
  VERIFIER_CHANGED_PATHS_MAX_CHARS,
} from './child-extension.ts';

const temporaryDirectories: string[] = [];

type ToolParametersPreview = {
  readonly properties: Record<
    string,
    { readonly description?: string; readonly maxLength?: number; readonly minLength?: number }
  >;
  readonly required?: ReadonlyArray<string>;
};

type ToolExecutionPreview = {
  readonly content: ReadonlyArray<{ readonly text: string }>;
  readonly details?: unknown;
};

type ExecuteToolForTest = (toolCallId: string, args: unknown) => Promise<ToolExecutionPreview>;

function createFixture(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, 'pardes-worker-boundary-'));
  temporaryDirectories.push(root);
  const worktree = join(root, 'worktree');
  const outside = join(root, 'outside');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(worktree, 'escape'));
  return { outside, root, worktree };
}

function installLargeOutputGit(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'git');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const command = process.argv[2];
if (command === 'rev-parse') {
  process.stdout.write('${'c'.repeat(40)}\\n');
} else if (command === 'status' && process.env.PARDES_TEST_GIT_PATHOLOGICAL === 'true') {
  process.stdout.write('x'.repeat(${16 * 1_024 * 1_024 + 1}));
} else if (command === 'status') {
  for (let index = 0; index < 7_000; index += 1)
    process.stdout.write(\`?? status/\${String(index).padStart(4, '0')}-\${'s'.repeat(170)}\\n\`);
} else if (command === 'diff') {
  for (let index = 0; index < 7_000; index += 1)
    process.stdout.write(\`src/\${String(index).padStart(4, '0')}-\${'p'.repeat(170)}.ts\\n\`);
} else {
  process.stderr.write('unexpected fake Git command');
  process.exitCode = 1;
}
`,
  );
  chmodSync(executable, 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe('worker path boundary', () => {
  test('allows normalized in-root paths and rejects lexical, absolute, alias, and symlink escapes', () => {
    const { worktree, outside } = createFixture();
    const inRoot = join(worktree, 'src', 'new-file.ts');
    const outsideFile = join(outside, 'file.ts');

    expect(isPathInsideWorktree(worktree, 'src/new-file.ts')).toBe(true);
    expect(isPathInsideWorktree(worktree, inRoot)).toBe(true);
    expect(isPathInsideWorktree(worktree, '@src/new-file.ts')).toBe(true);
    expect(isPathInsideWorktree(worktree, pathToFileURL(inRoot).href)).toBe(true);

    expect(isPathInsideWorktree(worktree, '../outside/file.ts')).toBe(false);
    expect(isPathInsideWorktree(worktree, outsideFile)).toBe(false);
    expect(isPathInsideWorktree(worktree, '@../outside/file.ts')).toBe(false);
    expect(isPathInsideWorktree(worktree, pathToFileURL(outsideFile).href)).toBe(false);
    expect(isPathInsideWorktree(worktree, 'escape/file.ts')).toBe(false);
  });

  test('expands home aliases before checking the managed worktree boundary', () => {
    const { worktree } = createFixture(homedir());
    const inRootFromHome = `~/${relative(homedir(), join(worktree, 'src', 'new-file.ts'))}`;

    expect(isPathInsideWorktree(worktree, inRootFromHome)).toBe(true);
    expect(isPathInsideWorktree(worktree, '~/outside/file.ts')).toBe(false);
  });

  test('mirrors the built-in one-at-prefix and unicode-space normalization', () => {
    expect(normalizeWorkerToolPath('@@src/file.ts')).toBe('@src/file.ts');
    expect(normalizeWorkerToolPath('@src/narrow\u202fspace.ts')).toBe('src/narrow space.ts');
  });
});

describe('verifier evidence output bounds', () => {
  test('omits changed-path suffixes instead of slicing through a path row', () => {
    const first = 'a'.repeat(VERIFIER_CHANGED_PATHS_MAX_CHARS - 2);
    const second = 'src/second-complete-path.ts';
    const bounded = boundedVerifierPathRows(`${first}\n${second}\nz\n`);

    expect(bounded).toEqual({
      omitted: 2,
      output: first,
      shown: 1,
      total: 3,
      truncated: true,
    });
    expect(bounded.output).not.toContain(second.slice(0, 4));
  });

  test('makes bounded Git diagnostic omission explicit and keeps terminal controls inert', () => {
    const diagnostic = boundedGitDiagnostic(`fatal:\u001b[31m ${'x'.repeat(1_100)}`, 'fallback');

    expect(diagnostic).toMatchObject({ shownChars: 1_000, source: 'stderr', truncated: true });
    expect(diagnostic.omittedChars).toBeGreaterThan(0);
    expect(diagnostic.preview).toHaveLength(diagnostic.shownChars);
    expect(diagnostic.preview).not.toContain('\u001b');
  });

  test('falls back to a sanitized error message when stderr sanitizes to empty', () => {
    expect(boundedGitDiagnostic('\u001b\u0007\n', 'fatal:\nmissing HEAD\u0007')).toEqual({
      normalizedAwayChars: 1,
      omittedChars: 0,
      originalChars: 20,
      preview: 'fatal: missing HEAD',
      safeChars: 19,
      shownChars: 19,
      source: 'error',
      truncated: false,
    });
  });
});

describe('worker child extension loading boundary', () => {
  test('registers worker-only hooks and never installs coordinating-manager compaction', () => {
    const { worktree } = createFixture();
    const previousRoot = process.env.PARDES_WORKTREE_ROOT;
    process.env.PARDES_WORKTREE_ROOT = worktree;
    try {
      const events: string[] = [];
      pardesWorker({
        on(event: string) {
          events.push(event);
        },
        registerTool() {},
      } as unknown as ExtensionAPI);

      expect(events).toEqual(['tool_call']);
      expect(events).not.toContain('session_before_compact');
    } finally {
      if (previousRoot === undefined) delete process.env.PARDES_WORKTREE_ROOT;
      else process.env.PARDES_WORKTREE_ROOT = previousRoot;
    }
  });
});

describe('verifier child profile', () => {
  test('registers only software-owned evidence beside common report tools', async () => {
    const { worktree } = createFixture();
    const previous = {
      baseline: process.env.PARDES_VERIFICATION_BASELINE_SHA,
      profile: process.env.PARDES_AGENT_PROFILE,
      reviewed: process.env.PARDES_VERIFICATION_REVIEWED_SHA,
      root: process.env.PARDES_WORKTREE_ROOT,
    };
    process.env.PARDES_WORKTREE_ROOT = worktree;
    process.env.PARDES_AGENT_PROFILE = 'verifier';
    process.env.PARDES_VERIFICATION_BASELINE_SHA = 'a'.repeat(40);
    process.env.PARDES_VERIFICATION_REVIEWED_SHA = 'b'.repeat(40);
    try {
      const tools: ToolDefinition[] = [];
      pardesWorker({
        on() {},
        registerTool(tool: ToolDefinition) {
          tools.push(tool);
        },
      } as unknown as ExtensionAPI);
      expect(tools.map((tool) => tool.name)).toEqual([
        'verification_evidence',
        'report_to_manager',
        'ask_manager',
      ]);
      expect(tools.map((tool) => tool.name)).not.toContain('verification_diff');
      const evidence = requiredValue(tools.find((tool) => tool.name === 'verification_evidence'));
      expect(evidence.renderShell).toBe('self');
      expect(typeof evidence.renderCall).toBe('function');
      expect(typeof evidence.renderResult).toBe('function');
      await expect((evidence.execute as unknown as ExecuteToolForTest)('call', {})).rejects.toThrow(
        'Git inspection failed: {"normalizedAwayChars":',
      );
      const report = requiredValue(tools.find((tool) => tool.name === 'report_to_manager'));
      const parameters = report.parameters as unknown as ToolParametersPreview;
      expect(report.description).toContain(
        'Inspect the whole requested risk surface before a terminal report',
      );
      expect(report.description).toContain(
        'consolidate every currently known blocker, concern, and non-blocking note',
      );
      expect(report.description).toContain('bounded reproduction reasoning');
      expect(report.description).toContain('distinguish confidence from completeness limitations');
      expect(report.description).toContain('avoid serial finding drip-feed');
      expect(report.description).toContain('manager judges action');
      expect(parameters.required).toEqual(['details', 'status', 'summary']);
      expect(parameters.properties.status.description).toContain(
        'never drip-feed individually discoverable findings',
      );
      expect(parameters.properties.summary.description).toContain(
        'consolidated finding-count summary',
      );
      expect(parameters.properties.details).toMatchObject({
        maxLength: REPORT_DETAILS_MAX_CHARS,
        minLength: 1,
      });
      expect(parameters.properties.details.description).toContain(
        'separate confidence and completeness limitations',
      );
      expect(tools.find((tool) => tool.name === 'ask_manager')?.description).toContain(
        'only when it truly blocks continued review',
      );

      const delivered = await (report.execute as unknown as ExecuteToolForTest)('call', {
        details:
          'Concern: bounded static reproduction. Confidence: medium. Completeness: one validation unavailable.',
        status: 'completed',
        summary: 'One concern and one note.',
      });
      expect(delivered.content[0].text).toBe(
        'Consolidated advisory report delivered to the owning Pardes manager.',
      );
      expect(delivered.details).toEqual({
        pardesWorker: {
          details:
            'Concern: bounded static reproduction. Confidence: medium. Completeness: one validation unavailable.',
          status: 'completed',
          summary: 'One concern and one note.',
          type: 'report',
        },
      });
    } finally {
      if (previous.root === undefined) delete process.env.PARDES_WORKTREE_ROOT;
      else process.env.PARDES_WORKTREE_ROOT = previous.root;
      if (previous.profile === undefined) delete process.env.PARDES_AGENT_PROFILE;
      else process.env.PARDES_AGENT_PROFILE = previous.profile;
      if (previous.baseline === undefined) delete process.env.PARDES_VERIFICATION_BASELINE_SHA;
      else process.env.PARDES_VERIFICATION_BASELINE_SHA = previous.baseline;
      if (previous.reviewed === undefined) delete process.env.PARDES_VERIFICATION_REVIEWED_SHA;
      else process.env.PARDES_VERIFICATION_REVIEWED_SHA = previous.reviewed;
    }
  });

  test('streams large status and changed-path output with complete-row omission metadata', async () => {
    const { root, worktree } = createFixture();
    const previous = {
      baseline: process.env.PARDES_VERIFICATION_BASELINE_SHA,
      path: process.env.PATH,
      pathological: process.env.PARDES_TEST_GIT_PATHOLOGICAL,
      profile: process.env.PARDES_AGENT_PROFILE,
      reviewed: process.env.PARDES_VERIFICATION_REVIEWED_SHA,
      root: process.env.PARDES_WORKTREE_ROOT,
    };
    process.env.PATH = installLargeOutputGit(root);
    process.env.PARDES_WORKTREE_ROOT = worktree;
    process.env.PARDES_AGENT_PROFILE = 'verifier';
    process.env.PARDES_VERIFICATION_BASELINE_SHA = 'a'.repeat(40);
    process.env.PARDES_VERIFICATION_REVIEWED_SHA = 'b'.repeat(40);
    try {
      const tools: ToolDefinition[] = [];
      pardesWorker({
        on() {},
        registerTool(tool: ToolDefinition) {
          tools.push(tool);
        },
      } as unknown as ExtensionAPI);
      const evidence = requiredValue(tools.find((tool) => tool.name === 'verification_evidence'));
      const execute = evidence.execute as unknown as ExecuteToolForTest;
      const result = await execute('call', {});
      const firstPath = `src/0000-${'p'.repeat(170)}.ts`;
      const firstOmittedPath = `src/0065-${'p'.repeat(170)}.ts`;

      expect(7_000 * `?? status/0000-${'s'.repeat(170)}\n`.length).toBeGreaterThan(1024 * 1024);
      expect(7_000 * `${firstPath}\n`.length).toBeGreaterThan(1024 * 1024);
      expect(result.content[0].text).toContain('checkoutClean: false');
      expect(result.content[0].text).toContain(
        'changed path evidence: total=7000; shown=65; omitted=6935',
      );
      expect(result.content[0].text).toContain(firstPath);
      expect(result.content[0].text).not.toContain(firstOmittedPath);
      expect(result.details).toMatchObject({
        pardesVerifier: {
          changedPaths: { omitted: 6_935, shown: 65, total: 7_000 },
          checkoutClean: false,
          truncated: true,
        },
      });

      process.env.PARDES_TEST_GIT_PATHOLOGICAL = 'true';
      await expect(execute('breaker', {})).rejects.toThrow(
        `Git inspection transport breaker: {"limitBytes":${GIT_INSPECTION_STDOUT_MAX_BYTES},"observedBytes":`,
      );
    } finally {
      if (previous.root === undefined) delete process.env.PARDES_WORKTREE_ROOT;
      else process.env.PARDES_WORKTREE_ROOT = previous.root;
      if (previous.profile === undefined) delete process.env.PARDES_AGENT_PROFILE;
      else process.env.PARDES_AGENT_PROFILE = previous.profile;
      if (previous.baseline === undefined) delete process.env.PARDES_VERIFICATION_BASELINE_SHA;
      else process.env.PARDES_VERIFICATION_BASELINE_SHA = previous.baseline;
      if (previous.reviewed === undefined) delete process.env.PARDES_VERIFICATION_REVIEWED_SHA;
      else process.env.PARDES_VERIFICATION_REVIEWED_SHA = previous.reviewed;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.pathological === undefined) delete process.env.PARDES_TEST_GIT_PATHOLOGICAL;
      else process.env.PARDES_TEST_GIT_PATHOLOGICAL = previous.pathological;
    }
  });

  test('executes fixed bounded captured-head evidence', async () => {
    const { worktree } = createFixture();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
    rmSync(join(worktree, 'escape'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main', worktree]);
    git('config', 'user.email', 'pardes@example.test');
    git('config', 'user.name', 'Pardes Test');
    writeFileSync(join(worktree, 'README.md'), 'baseline\n');
    git('add', 'README.md');
    git('commit', '-m', 'baseline');
    const baseline = git('rev-parse', 'HEAD');
    writeFileSync(join(worktree, 'reviewed.txt'), 'reviewed\n');
    git('add', 'reviewed.txt');
    git('commit', '-m', 'reviewed');
    const reviewed = git('rev-parse', 'HEAD');
    const previous = {
      baseline: process.env.PARDES_VERIFICATION_BASELINE_SHA,
      profile: process.env.PARDES_AGENT_PROFILE,
      reviewed: process.env.PARDES_VERIFICATION_REVIEWED_SHA,
      root: process.env.PARDES_WORKTREE_ROOT,
    };
    process.env.PARDES_WORKTREE_ROOT = worktree;
    process.env.PARDES_AGENT_PROFILE = 'verifier';
    process.env.PARDES_VERIFICATION_BASELINE_SHA = baseline;
    process.env.PARDES_VERIFICATION_REVIEWED_SHA = reviewed;
    try {
      const tools: ToolDefinition[] = [];
      pardesWorker({
        on() {},
        registerTool(tool: ToolDefinition) {
          tools.push(tool);
        },
      } as unknown as ExtensionAPI);
      const evidence = requiredValue(tools.find((tool) => tool.name === 'verification_evidence'));
      const result = await (evidence.execute as unknown as ExecuteToolForTest)('call', {});
      expect(result.content[0].text).toContain(`checkoutHeadSha: ${reviewed}`);
      expect(result.content[0].text).toContain('checkoutClean: true');
      expect(result.content[0].text).toContain(
        'changed path evidence: total=1; shown=1; omitted=0',
      );
      expect(result.details).toMatchObject({
        pardesVerifier: {
          changedPaths: { omitted: 0, shown: 1, total: 1 },
          checkoutClean: true,
          checkoutHeadSha: reviewed,
          reviewedHeadSha: reviewed,
          truncated: false,
          type: 'evidence',
        },
      });
    } finally {
      if (previous.root === undefined) delete process.env.PARDES_WORKTREE_ROOT;
      else process.env.PARDES_WORKTREE_ROOT = previous.root;
      if (previous.profile === undefined) delete process.env.PARDES_AGENT_PROFILE;
      else process.env.PARDES_AGENT_PROFILE = previous.profile;
      if (previous.baseline === undefined) delete process.env.PARDES_VERIFICATION_BASELINE_SHA;
      else process.env.PARDES_VERIFICATION_BASELINE_SHA = previous.baseline;
      if (previous.reviewed === undefined) delete process.env.PARDES_VERIFICATION_REVIEWED_SHA;
      else process.env.PARDES_VERIFICATION_REVIEWED_SHA = previous.reviewed;
    }
  });
});

describe('worker child reporting tool rendering', () => {
  test('uses bounded self-shell call and result renderers with length-only previews', () => {
    const { worktree } = createFixture();
    const previous = {
      baseline: process.env.PARDES_VERIFICATION_BASELINE_SHA,
      profile: process.env.PARDES_AGENT_PROFILE,
      reviewed: process.env.PARDES_VERIFICATION_REVIEWED_SHA,
      root: process.env.PARDES_WORKTREE_ROOT,
      stateDir: process.env.PARDES_PI_STATE_DIR,
    };
    process.env.PARDES_WORKTREE_ROOT = worktree;
    process.env.PARDES_PI_STATE_DIR = join(worktree, 'pardes-state');
    process.env.PARDES_AGENT_PROFILE = 'worker';
    delete process.env.PARDES_VERIFICATION_BASELINE_SHA;
    delete process.env.PARDES_VERIFICATION_REVIEWED_SHA;
    try {
      const tools: ToolDefinition[] = [];
      pardesWorker({
        on() {},
        registerTool(tool: ToolDefinition) {
          tools.push(tool);
        },
      } as unknown as ExtensionAPI);
      const theme = {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      } as unknown as Theme;
      const argsByTool = {
        ask_manager: { context: 'private context', question: 'private question' },
        report_to_manager: {
          details: 'private details',
          status: 'progress',
          summary: 'private summary',
        },
      } as const;

      expect(tools.map((tool) => tool.name)).toEqual(['report_to_manager', 'ask_manager']);
      const reportParameters = requiredValue(
        tools.find((tool) => tool.name === 'report_to_manager'),
      ).parameters as unknown as ToolParametersPreview;
      expect(reportParameters.properties.summary).toMatchObject({
        maxLength: REPORT_SUMMARY_MAX_CHARS,
        minLength: 1,
      });
      expect(reportParameters.properties.details).toMatchObject({
        maxLength: REPORT_DETAILS_MAX_CHARS,
      });
      for (const tool of tools) {
        expect(typeof tool.renderResult, tool.name).toBe('function');
        expect(tool.renderShell, tool.name).toBe('self');
        const args = argsByTool[tool.name as keyof typeof argsByTool];
        const lines = requiredValue(tool.renderCall)(args, theme, {
          isPartial: true,
        } as never).render(80);
        expect(lines, tool.name).toHaveLength(1);
        expect(visibleWidth(requiredValue(lines[0])), tool.name).toBeLessThanOrEqual(80);
        expect(lines[0], tool.name).not.toContain('private');
        const hiddenCall = requiredValue(tool.renderCall)(args, theme, {
          isPartial: false,
        } as never).render(80);
        const resultLines = requiredValue(tool.renderResult)(
          { content: [{ text: 'bounded child result', type: 'text' }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { args, isError: false } as never,
        ).render(240);
        expect(hiddenCall, tool.name).toEqual([]);
        expect(resultLines, tool.name).toHaveLength(1);
        expect(stripVTControlCharacters(requiredValue(resultLines[0])), tool.name).toContain(
          ' → bounded child result',
        );
      }

      mkdirSync(requiredValue(process.env.PARDES_PI_STATE_DIR), { recursive: true });
      writeFileSync(
        join(requiredValue(process.env.PARDES_PI_STATE_DIR), 'config.json'),
        '{"renderer":{"verboseResults":true}}\n',
      );
      const report = requiredValue(tools.find((tool) => tool.name === 'report_to_manager'));
      const reportArgs = argsByTool.report_to_manager;
      const verboseLines = requiredValue(report.renderResult)(
        { content: [{ text: 'first line\nsecond line', type: 'text' }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        { args: reportArgs, isError: false } as never,
      ).render(240);
      expect(verboseLines.map((line) => stripVTControlCharacters(line).trimEnd()).slice(1)).toEqual(
        ['result', 'first line', 'second line'],
      );
    } finally {
      if (previous.root === undefined) delete process.env.PARDES_WORKTREE_ROOT;
      else process.env.PARDES_WORKTREE_ROOT = previous.root;
      if (previous.stateDir === undefined) delete process.env.PARDES_PI_STATE_DIR;
      else process.env.PARDES_PI_STATE_DIR = previous.stateDir;
      if (previous.profile === undefined) delete process.env.PARDES_AGENT_PROFILE;
      else process.env.PARDES_AGENT_PROFILE = previous.profile;
      if (previous.baseline === undefined) delete process.env.PARDES_VERIFICATION_BASELINE_SHA;
      else process.env.PARDES_VERIFICATION_BASELINE_SHA = previous.baseline;
      if (previous.reviewed === undefined) delete process.env.PARDES_VERIFICATION_REVIEWED_SHA;
      else process.env.PARDES_VERIFICATION_REVIEWED_SHA = previous.reviewed;
    }
  });
});

describe('worker file-tool guard', () => {
  test('checks the installed path parameter for every built-in file tool', () => {
    const { worktree } = createFixture();
    const reason = 'Pardes worker path is outside the managed worktree: @../outside/file.ts';

    for (const toolName of ['read', 'write', 'edit', 'grep', 'find', 'ls']) {
      expect(
        getWorkerToolPathDenialReason(worktree, toolName, { path: '@../outside/file.ts' }),
      ).toBe(reason);
    }
  });

  test('allows omitted optional search paths and rejects malformed present path values', () => {
    const { worktree } = createFixture();

    for (const toolName of ['grep', 'find', 'ls']) {
      expect(getWorkerToolPathDenialReason(worktree, toolName, {})).toBeUndefined();
    }
    for (const toolName of ['read', 'write', 'edit', 'grep', 'find', 'ls']) {
      expect(getWorkerToolPathDenialReason(worktree, toolName, { path: undefined })).toBe(
        'Pardes worker path is outside the managed worktree: undefined',
      );
    }
    expect(getWorkerToolPathDenialReason(worktree, 'read', { path: null })).toBe(
      'Pardes worker path is outside the managed worktree: null',
    );
  });

  test('leaves non-file tools unaffected', () => {
    const { worktree } = createFixture();

    expect(
      getWorkerToolPathDenialReason(worktree, 'bash', { path: '@../outside/file.ts' }),
    ).toBeUndefined();
    expect(
      getWorkerToolPathDenialReason(worktree, 'report_to_manager', { path: 42 }),
    ).toBeUndefined();
  });
});
