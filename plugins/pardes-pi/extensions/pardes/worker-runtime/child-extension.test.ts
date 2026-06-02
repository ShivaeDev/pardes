import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI, Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, test } from 'vitest';
import { REPORT_DETAILS_MAX_CHARS, REPORT_SUMMARY_MAX_CHARS } from '../reporting/index.ts';
import { requiredValue, runGitFixture } from '../test-support.ts';
import pardesWorker, {
  getWorkerToolPathDenialReason,
  isPathInsideWorktree,
  normalizeWorkerToolPath,
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
  return { outside, worktree };
}

interface ChildProfileEnvironment {
  readonly baseline: string | undefined;
  readonly profile: string | undefined;
  readonly reviewed: string | undefined;
  readonly root: string | undefined;
}

function childProfileEnvironment(): ChildProfileEnvironment {
  return {
    baseline: process.env.PARDES_VERIFICATION_BASELINE_SHA,
    profile: process.env.PARDES_AGENT_PROFILE,
    reviewed: process.env.PARDES_VERIFICATION_REVIEWED_SHA,
    root: process.env.PARDES_WORKTREE_ROOT,
  };
}

function restoreChildProfileEnvironment(previous: ChildProfileEnvironment): void {
  if (previous.root === undefined) delete process.env.PARDES_WORKTREE_ROOT;
  else process.env.PARDES_WORKTREE_ROOT = previous.root;
  if (previous.profile === undefined) delete process.env.PARDES_AGENT_PROFILE;
  else process.env.PARDES_AGENT_PROFILE = previous.profile;
  if (previous.baseline === undefined) delete process.env.PARDES_VERIFICATION_BASELINE_SHA;
  else process.env.PARDES_VERIFICATION_BASELINE_SHA = previous.baseline;
  if (previous.reviewed === undefined) delete process.env.PARDES_VERIFICATION_REVIEWED_SHA;
  else process.env.PARDES_VERIFICATION_REVIEWED_SHA = previous.reviewed;
}

function withWorkerProfileEnvironment<Result>(worktree: string, run: () => Result): Result {
  const previous = childProfileEnvironment();
  process.env.PARDES_WORKTREE_ROOT = worktree;
  delete process.env.PARDES_AGENT_PROFILE;
  delete process.env.PARDES_VERIFICATION_BASELINE_SHA;
  delete process.env.PARDES_VERIFICATION_REVIEWED_SHA;
  try {
    return run();
  } finally {
    restoreChildProfileEnvironment(previous);
  }
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

  test('executes fixed bounded captured-head evidence', async () => {
    const { worktree } = createFixture();
    const git = (...args: string[]) => runGitFixture(worktree, ...args);
    rmSync(join(worktree, 'escape'), { recursive: true });
    git('init', '-b', 'main');
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
      expect(result.details).toMatchObject({
        pardesVerifier: {
          checkoutClean: true,
          checkoutHeadSha: reviewed,
          reviewedHeadSha: reviewed,
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
  test('uses bounded one-line length-only previews without adding result renderers', () => {
    const { worktree } = createFixture();
    const previous = childProfileEnvironment();
    const inheritedVerifier = {
      baseline: 'a'.repeat(40),
      profile: 'verifier',
      reviewed: 'b'.repeat(40),
      root: '/tmp/inherited-verifier-root',
    };
    restoreChildProfileEnvironment(inheritedVerifier);
    try {
      const tools = withWorkerProfileEnvironment(worktree, () => {
        const registered: ToolDefinition[] = [];
        pardesWorker({
          on() {},
          registerTool(tool: ToolDefinition) {
            registered.push(tool);
          },
        } as unknown as ExtensionAPI);
        return registered;
      });
      expect(childProfileEnvironment()).toEqual(inheritedVerifier);
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
        expect(tool.renderResult, tool.name).toBeUndefined();
        const lines = requiredValue(tool.renderCall)(
          argsByTool[tool.name as keyof typeof argsByTool],
          theme,
          {} as never,
        ).render(80);
        expect(lines, tool.name).toHaveLength(1);
        expect(visibleWidth(requiredValue(lines[0])), tool.name).toBeLessThanOrEqual(80);
        expect(lines[0], tool.name).not.toContain('private');
      }
    } finally {
      restoreChildProfileEnvironment(previous);
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
