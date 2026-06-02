import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditClassifierPolicy,
  auditClassifierRun,
  boundedSubjects,
  classifierEnvironment,
  classifierPrompt,
  createClassifierSandbox,
  materializeClassifierSnapshots,
  OPENCODE_PREFLIGHT_TIMEOUT_MS,
  OPENCODE_RUN_TIMEOUT_MS,
  removeClassifierSandbox,
  SUBJECT_LENGTH_LIMIT,
  SUBJECT_LIMIT,
  SUBMISSION_TOOL,
  strictClassification,
} from './bump-classifier';
import { runGitTestFixture } from './git-test-fixture';

const verdict = {
  added: [],
  bump: 'patch',
  changed: [],
  fixed: ['Prevented fallback classifiers from editing the release checkout.'],
  removed: [],
};

function toolEvent(
  tool = SUBMISSION_TOOL,
  submitted: unknown = verdict,
  input: Record<string, unknown> = { verdict: submitted },
): string {
  return JSON.stringify({
    part: { state: { input, status: 'completed' }, tool },
    type: 'tool_use',
  });
}

function submission(submitted: unknown = verdict, agent = 'bump'): string {
  return `${JSON.stringify({ agent, verdict: submitted })}\n`;
}

function run(overrides: Partial<Parameters<typeof auditClassifierRun>[0]> = {}) {
  return auditClassifierRun({
    status: 0,
    stderr: '',
    stdout: toolEvent(),
    submission: submission(),
    ...overrides,
  });
}

function git(root: string, args: string[]): string {
  return runGitTestFixture(root, args);
}

function snapshotRepository(): { after: string; before: string; root: string } {
  const root = join(tmpdir(), `pardes-classifier-repository-${crypto.randomUUID()}`);
  mkdirSync(join(root, 'docs'), { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(root, 'README.md'), 'before\n');
  writeFileSync(join(root, 'docs/guide.md'), 'tracked documentation\n');
  writeFileSync(join(root, 'untracked-secret.txt'), 'never snapshot me\n');
  git(root, ['add', '--', 'README.md', 'docs/guide.md']);
  git(root, ['commit', '--quiet', '-m', 'before']);
  const before = git(root, ['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'README.md'), 'after\n');
  writeFileSync(join(root, 'source-link'), '/etc/passwd');
  git(root, ['add', '--', 'README.md']);
  git(root, ['add', '--intent-to-add', 'source-link']);
  git(root, [
    'update-index',
    '--add',
    '--cacheinfo',
    '120000',
    git(root, ['hash-object', '-w', 'source-link']),
    'source-link',
  ]);
  git(root, ['commit', '--quiet', '-m', 'after']);
  return { after: git(root, ['rev-parse', 'HEAD']), before, root };
}

describe('auditClassifierRun', () => {
  it('accepts one strict schema-first tool submission', () => {
    expect(run()).toEqual(verdict);
  });

  it('rejects hosted run 26823995139/job 79086126923 default-build prose/edit symptom', () => {
    const fixture = readFileSync(
      new URL(
        './fixtures/hosted-run-26823995139-job-79086126923-default-build-fallback.txt',
        import.meta.url,
      ),
      'utf8',
    );

    expect(() => run({ stdout: fixture, submission: '' })).toThrow(
      'OpenCode fell back to its default agent',
    );
    expect(() => run({ stdout: fixture.split('\n').slice(1).join('\n'), submission: '' })).toThrow(
      'unexpected tool call "edit"',
    );
  });

  it('never salvages transcript prose or transcript JSON', () => {
    expect(() =>
      run({
        stdout: JSON.stringify({ part: { text: JSON.stringify(verdict) }, type: 'text' }),
        submission: '',
      }),
    ).toThrow(`expected exactly one ${SUBMISSION_TOOL} call; got 0`);
  });

  it('rejects missing, duplicate, and mismatched tool submissions', () => {
    expect(() => run({ submission: '' })).toThrow('expected exactly one submission record; got 0');
    expect(() => run({ submission: `${submission()}${submission()}` })).toThrow(
      'expected exactly one submission record; got 2',
    );
    expect(() => run({ submission: submission(verdict, 'build') })).toThrow(
      'submission came from agent "build", expected bump',
    );
    expect(() => run({ stdout: `${toolEvent()}\n${toolEvent()}` })).toThrow(
      `expected exactly one ${SUBMISSION_TOOL} call; got 2`,
    );
  });

  it('allows completed contextual snapshot tools before submission', () => {
    const contextual = [
      toolEvent('glob', undefined, { path: 'snapshots/after', pattern: '**/*.md' }),
      toolEvent('grep', undefined, { path: 'snapshots/after/docs', pattern: 'guide' }),
      toolEvent('read', undefined, { filePath: 'snapshots/before/README.md' }),
      toolEvent(),
    ].join('\n');
    expect(() => run({ stdout: contextual, workspace: '/sandbox/workspace' })).not.toThrow();
  });

  it('rejects unexpected, mutating, shell, and escaped contextual tools', () => {
    expect(() => run({ stdout: toolEvent('write') })).toThrow('unexpected tool call "write"');
    expect(() => run({ stdout: toolEvent('bash') })).toThrow('unexpected tool call "bash"');
    expect(() =>
      run({
        stdout: `${toolEvent('read', undefined, { filePath: '/etc/passwd' })}\n${toolEvent()}`,
        workspace: '/sandbox/workspace',
      }),
    ).toThrow('read path escaped read-only snapshots');
    expect(() =>
      run({
        stdout: `${toolEvent('glob', undefined, { path: '../config', pattern: '**/*' })}\n${toolEvent()}`,
        workspace: '/sandbox/workspace',
      }),
    ).toThrow('glob path escaped read-only snapshots');
    expect(() => run({ stdout: 'freeform model prose' })).toThrow('stdout line 1 is not JSON');
  });

  it('strictly validates the tool-submitted verdict fields', () => {
    const invalid = { ...verdict, surprise: true };
    expect(() =>
      run({ stdout: toolEvent(SUBMISSION_TOOL, invalid), submission: submission(invalid) }),
    ).toThrow('submitted verdict fields must be exactly');
  });
});

describe('classifier policy', () => {
  const permission = [
    { action: 'deny', pattern: '*', permission: '*' },
    { action: 'deny', pattern: '*', permission: 'external_directory' },
    { action: 'deny', pattern: '*', permission: 'read' },
    { action: 'allow', pattern: 'snapshots', permission: 'read' },
    { action: 'allow', pattern: 'snapshots/**', permission: 'read' },
    { action: 'allow', pattern: '*', permission: 'glob' },
    { action: 'allow', pattern: '*', permission: 'grep' },
    { action: 'allow', pattern: '*', permission: 'submit_verdict' },
  ];
  const debugAgent = (
    name: string,
    tools: Record<string, boolean>,
    mode = 'primary',
    rules = permission,
  ) => JSON.stringify({ mode, name, permission: rules, tools });

  it('accepts an inert fallback and snapshot-context classifier', () => {
    expect(() =>
      auditClassifierPolicy(
        debugAgent('build', { bash: false, read: false, submit_verdict: false }, 'primary', [
          { action: 'deny', pattern: '*', permission: '*' },
        ]),
        debugAgent('bump', {
          bash: false,
          glob: true,
          grep: true,
          read: true,
          submit_verdict: true,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an actionable fallback or extra classifier capability', () => {
    expect(() =>
      auditClassifierPolicy(
        debugAgent('build', { bash: true, submit_verdict: false }),
        debugAgent('bump', { glob: true, grep: true, read: true, submit_verdict: true }),
      ),
    ).toThrow('fallback build agent exposes tools: bash');
    expect(() =>
      auditClassifierPolicy(
        debugAgent('build', { bash: false, submit_verdict: false }),
        debugAgent('bump', {
          glob: true,
          grep: true,
          read: true,
          submit_verdict: true,
          write: true,
        }),
      ),
    ).toThrow(
      'bump agent tools must be exactly glob, grep, read, submit_verdict; got glob, grep, read, submit_verdict, write',
    );
    expect(() =>
      auditClassifierPolicy(
        debugAgent('build', { bash: false, submit_verdict: false }),
        debugAgent(
          'bump',
          { glob: true, grep: true, read: true, submit_verdict: true },
          'primary',
          permission.map((rule) =>
            rule.permission === 'external_directory' ? { ...rule, action: 'allow' } : rule,
          ),
        ),
      ),
    ).toThrow('bump agent external_directory "/outside/*" must resolve deny, got allow');
  });

  it('globally disables fallback build tools and lets only the primary bump agent submit', () => {
    const agent = readFileSync(new URL('../.opencode/agent/bump.md', import.meta.url), 'utf8');
    const config = readFileSync(new URL('../.opencode/opencode.json', import.meta.url), 'utf8');

    expect(agent).toContain('mode: primary');
    expect(agent).toContain('  "*": deny');
    expect(agent).toContain('  external_directory: deny');
    expect(agent).toContain('    "snapshots/**": allow');
    expect(agent).toContain('  glob: allow');
    expect(agent).toContain('  grep: allow');
    expect(agent).toContain('  submit_verdict: allow');
    expect(JSON.parse(config).permission).toEqual({ '*': 'deny' });
  });
});

describe('strictClassification', () => {
  it('rejects invalid or extra fields and empty bullet sets', () => {
    expect(() => strictClassification({ ...verdict, surprise: true })).toThrow(
      'submitted verdict fields must be exactly',
    );
    expect(() => strictClassification({ ...verdict, bump: 'tiny' })).toThrow(
      'submitted bump must be patch, minor, or major',
    );
    expect(() => strictClassification({ ...verdict, fixed: [] })).toThrow(
      'submitted verdict must contain one to three bullets total; got 0',
    );
    expect(() => strictClassification({ ...verdict, fixed: [' padded '] })).toThrow(
      'bullets must be non-empty and trimmed',
    );
  });
});

describe('boundedSubjects', () => {
  it('bounds and flattens untrusted commit subjects', () => {
    const subjects = Array.from(
      { length: SUBJECT_LIMIT + 1 },
      (_, index) => `${index}\n${'x'.repeat(500)}`,
    );
    const bounded = boundedSubjects(subjects);

    expect(bounded.at(-1)).toBe('…(commit subjects truncated)');
    expect(bounded.length).toBeLessThanOrEqual(SUBJECT_LIMIT + 1);
    expect(bounded.slice(0, -1).every((subject) => subject.length <= SUBJECT_LENGTH_LIMIT)).toBe(
      true,
    );
    expect(bounded.slice(0, -1).every((subject) => !subject.includes('\n'))).toBe(true);
  });
});

describe('classifierPrompt', () => {
  it('frames contextual snapshot inspection without embedding raw diff prose', () => {
    const prompt = classifierPrompt(
      'example',
      '1.2.3',
      ['feat: docs'],
      ['plugins/example/docs/guide.md'],
    );
    expect(prompt).toContain('Before: snapshots/before');
    expect(prompt).toContain('After: snapshots/after');
    expect(prompt).toContain('plugins/example/docs/guide.md');
    expect(prompt).toContain(
      'Inspect relevant implementation files, docs, manifests, and changelogs',
    );
    expect(prompt).not.toContain('```diff');
  });
});

describe('materializeClassifierSnapshots', () => {
  it('creates read-only tracked before/after snapshots, docs, and inert symlink blobs', () => {
    const repository = snapshotRepository();
    const sandbox = createClassifierSandbox();
    try {
      materializeClassifierSnapshots(sandbox, repository.root, repository.before, repository.after);
      expect(readFileSync(join(sandbox.snapshotRoot, 'before/README.md'), 'utf8')).toBe('before\n');
      expect(readFileSync(join(sandbox.snapshotRoot, 'after/README.md'), 'utf8')).toBe('after\n');
      expect(readFileSync(join(sandbox.snapshotRoot, 'after/docs/guide.md'), 'utf8')).toBe(
        'tracked documentation\n',
      );
      expect(existsSync(join(sandbox.snapshotRoot, 'after/untracked-secret.txt'))).toBe(false);
      expect(lstatSync(join(sandbox.snapshotRoot, 'after/source-link')).isSymbolicLink()).toBe(
        false,
      );
      expect(readFileSync(join(sandbox.snapshotRoot, 'after/source-link'), 'utf8')).toBe(
        '/etc/passwd',
      );
      expect(statSync(join(sandbox.snapshotRoot, 'after/README.md')).mode & 0o222).toBe(0);
      expect(statSync(join(sandbox.snapshotRoot, 'after/docs')).mode & 0o222).toBe(0);
    } finally {
      removeClassifierSandbox(sandbox);
      chmodSync(repository.root, 0o755);
      rmSync(repository.root, { force: true, recursive: true });
    }
  });
});

describe('classifierEnvironment', () => {
  it('establishes a local Git root below a contaminated ancestor', () => {
    const parent = join(tmpdir(), `pardes-opencode-ancestor-${crypto.randomUUID()}`);
    mkdirSync(join(parent, '.opencode/tools'), { recursive: true });
    writeFileSync(
      join(parent, '.opencode/tools/ancestor-probe.ts'),
      'throw new Error("loaded ancestor")',
    );
    const sandbox = createClassifierSandbox('.', parent);
    try {
      expect(existsSync(join(sandbox.workspace, '.git'))).toBe(true);
      expect(git(sandbox.workspace, ['rev-parse', '--show-toplevel'])).toBe(
        realpathSync(sandbox.workspace),
      );
      expect(existsSync(join(sandbox.root, '.opencode/tools/ancestor-probe.ts'))).toBe(false);
      expect(existsSync(join(sandbox.classifierConfig, 'tools/submit_verdict.ts'))).toBe(true);
    } finally {
      removeClassifierSandbox(sandbox);
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it('passes only isolated runtime paths, discovery controls, and the OpenCode credential', () => {
    const sandbox = createClassifierSandbox();
    try {
      expect(classifierEnvironment(sandbox, 'provider-secret', '/runtime/bin')).toEqual({
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: `${sandbox.root}/home`,
        OPENCODE_API_KEY: 'provider-secret',
        OPENCODE_CONFIG_DIR: `${sandbox.root}/config/opencode`,
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        PARDES_VERDICT_FILE: `${sandbox.root}/verdict.jsonl`,
        PATH: '/runtime/bin',
        PWD: `${sandbox.root}/workspace`,
        TMPDIR: `${sandbox.root}/tmp`,
        XDG_CACHE_HOME: `${sandbox.root}/cache`,
        XDG_CONFIG_HOME: `${sandbox.root}/config`,
        XDG_DATA_HOME: `${sandbox.root}/data`,
      });
    } finally {
      removeClassifierSandbox(sandbox);
    }
  });

  it('uses one isolated OpenCode config root and bounded OpenCode child timeouts', () => {
    const sandbox = createClassifierSandbox();
    try {
      const env = classifierEnvironment(sandbox, 'provider-secret', '/runtime/bin');
      expect(env.XDG_CONFIG_HOME).toBe(`${sandbox.root}/config`);
      expect(env.OPENCODE_CONFIG_DIR).toBe(`${env.XDG_CONFIG_HOME}/opencode`);
      expect(env.PWD).toBe(sandbox.workspace);
      expect(env.OPENCODE_CONFIG_DIR?.startsWith(`${sandbox.workspace}/`)).toBe(false);
      expect(env.HOME?.startsWith(`${sandbox.workspace}/`)).toBe(false);
      expect(env.PARDES_VERDICT_FILE?.startsWith(`${sandbox.workspace}/`)).toBe(false);
      expect(OPENCODE_PREFLIGHT_TIMEOUT_MS).toBe(90_000);
      expect(OPENCODE_RUN_TIMEOUT_MS).toBe(300_000);
      const classifier = readFileSync(new URL('./bump-classifier.ts', import.meta.url), 'utf8');
      const bump = readFileSync(new URL('./bump.ts', import.meta.url), 'utf8');
      expect(classifier).toContain('timeout: OPENCODE_PREFLIGHT_TIMEOUT_MS');
      expect(bump).toContain('timeout: OPENCODE_RUN_TIMEOUT_MS');
    } finally {
      removeClassifierSandbox(sandbox);
    }
  });
});
