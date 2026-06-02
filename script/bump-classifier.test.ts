import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditClassifierPolicy,
  auditClassifierRun,
  boundedSubjects,
  classifierEnvironment,
  createClassifierSandbox,
  OPENCODE_PREFLIGHT_TIMEOUT_MS,
  OPENCODE_RUN_TIMEOUT_MS,
  removeClassifierSandbox,
  SUBJECT_LENGTH_LIMIT,
  SUBJECT_LIMIT,
  SUBMISSION_TOOL,
  strictClassification,
} from './bump-classifier';

const verdict = {
  added: [],
  bump: 'patch',
  changed: [],
  fixed: ['Prevented fallback classifiers from editing the release checkout.'],
  removed: [],
};

function toolEvent(tool = SUBMISSION_TOOL, submitted: unknown = verdict): string {
  return JSON.stringify({
    part: { state: { input: { verdict: submitted }, status: 'completed' }, tool },
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

describe('auditClassifierRun', () => {
  it('accepts one strict schema-first tool submission', () => {
    expect(run()).toEqual(verdict);
  });

  it('rejects the audited subagent fallback into default-build prose/edit symptom', () => {
    const fixture = readFileSync(
      new URL('./fixtures/opencode-default-build-fallback.jsonl', import.meta.url),
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

  it('rejects unexpected tool calls and non-JSON stdout', () => {
    expect(() => run({ stdout: toolEvent('write') })).toThrow('unexpected tool call "write"');
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
  const debugAgent = (name: string, tools: Record<string, boolean>, mode = 'primary') =>
    JSON.stringify({ mode, name, tools });

  it('accepts an effective deny-all fallback and submit-only classifier', () => {
    expect(() =>
      auditClassifierPolicy(
        debugAgent('build', { bash: false, read: false, submit_verdict: false }),
        debugAgent('bump', { bash: false, read: false, submit_verdict: true }),
      ),
    ).not.toThrow();
  });

  it('rejects an actionable fallback or extra classifier capability', () => {
    expect(() =>
      auditClassifierPolicy(
        debugAgent('build', { bash: true, submit_verdict: false }),
        debugAgent('bump', { submit_verdict: true }),
      ),
    ).toThrow('fallback build agent exposes tools: bash');
    expect(() =>
      auditClassifierPolicy(
        debugAgent('build', { bash: false, submit_verdict: false }),
        debugAgent('bump', { read: true, submit_verdict: true }),
      ),
    ).toThrow('bump agent tools must be exactly submit_verdict; got read, submit_verdict');
  });

  it('globally disables fallback build tools and lets only the primary bump agent submit', () => {
    const agent = readFileSync(new URL('../.opencode/agent/bump.md', import.meta.url), 'utf8');
    const config = readFileSync(new URL('../.opencode/opencode.json', import.meta.url), 'utf8');

    expect(agent).toContain('mode: primary');
    expect(agent).toContain('  "*": deny');
    expect(agent).toContain('  submit_verdict: allow');
    expect(agent.match(/:\s+allow/g)).toEqual([': allow']);
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
      expect(existsSync(join(sandbox.root, '.git'))).toBe(true);
      expect(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: sandbox.root,
          encoding: 'utf8',
        }).trim(),
      ).toBe(realpathSync(sandbox.root));
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
        PWD: sandbox.root,
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
