import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CLASSIFIER_AGENT = 'bump';
export const SUBMISSION_TOOL = 'submit_verdict';
export const SUBJECT_BUDGET = 10_000;
export const SUBJECT_LIMIT = 100;
export const SUBJECT_LENGTH_LIMIT = 240;

export type Classification = {
  bump: 'patch' | 'minor' | 'major';
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
};

type ClassifierSandbox = {
  cache: string;
  config: string;
  data: string;
  home: string;
  root: string;
  submissionFile: string;
  tmp: string;
};

type ClassifierRun = {
  status: number | null;
  stderr: string;
  stdout: string;
  submission: string;
};

const CLASSIFIER_FILES = [
  ['.opencode/opencode.json', '.opencode/opencode.json'],
  ['.opencode/agent/bump.md', '.opencode/agent/bump.md'],
  ['.opencode/tools/submit_verdict.ts', '.opencode/tools/submit_verdict.ts'],
] as const;
const SECTIONS = ['added', 'changed', 'fixed', 'removed'] as const;
const FALLBACK_WARNING = /falling back to default agent/i;

function fail(message: string): never {
  throw new Error(`invalid opencode classifier run: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${at} fields must be exactly ${wanted.join(', ')}; got ${actual.join(', ') || '(none)'}`);
  }
}

export function strictClassification(value: unknown): Classification {
  if (!isRecord(value)) fail('submitted verdict must be an object');
  exactKeys(value, ['bump', ...SECTIONS], 'submitted verdict');

  if (value.bump !== 'patch' && value.bump !== 'minor' && value.bump !== 'major') {
    fail(`submitted bump must be patch, minor, or major; got ${JSON.stringify(value.bump)}`);
  }

  const result: Classification = {
    added: [],
    bump: value.bump,
    changed: [],
    fixed: [],
    removed: [],
  };
  let total = 0;
  for (const section of SECTIONS) {
    const bullets = value[section];
    if (!Array.isArray(bullets)) fail(`submitted ${section} must be an array`);
    if (bullets.length > 3) fail(`submitted ${section} has more than three bullets`);
    result[section] = bullets.map((bullet) => {
      if (typeof bullet !== 'string') fail(`submitted ${section} bullets must be strings`);
      if (!bullet || bullet !== bullet.trim())
        fail(`submitted ${section} bullets must be non-empty and trimmed`);
      if (bullet.length > 160) fail(`submitted ${section} bullet exceeds 160 characters`);
      if (bullet.includes('\n') || bullet.includes('\r'))
        fail(`submitted ${section} bullet must be one line`);
      return bullet;
    });
    total += bullets.length;
  }
  if (total < 1 || total > 3)
    fail(`submitted verdict must contain one to three bullets total; got ${total}`);
  return result;
}

function parseJsonLine(line: string, at: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail(`${at} is not JSON`);
  }
  if (!isRecord(parsed)) fail(`${at} must be a JSON object`);
  return parsed;
}

function parseSubmission(raw: string): { agent: string; verdict: Classification } {
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1) fail(`expected exactly one submission record; got ${lines.length}`);
  const parsed = parseJsonLine(lines[0], 'submission record');
  exactKeys(parsed, ['agent', 'verdict'], 'submission record');
  if (parsed.agent !== CLASSIFIER_AGENT) {
    fail(
      `submission came from agent ${JSON.stringify(parsed.agent)}, expected ${CLASSIFIER_AGENT}`,
    );
  }
  return { agent: parsed.agent, verdict: strictClassification(parsed.verdict) };
}

function toolInput(part: Record<string, unknown>): Classification {
  if (!isRecord(part.state)) fail(`${SUBMISSION_TOOL} event state must be an object`);
  if (part.state.status !== 'completed') {
    fail(
      `${SUBMISSION_TOOL} did not complete successfully (status ${JSON.stringify(part.state.status)})`,
    );
  }
  if (!isRecord(part.state.input)) fail(`${SUBMISSION_TOOL} event input must be an object`);
  exactKeys(part.state.input, ['verdict'], `${SUBMISSION_TOOL} input`);
  return strictClassification(part.state.input.verdict);
}

export function auditClassifierRun(run: ClassifierRun): Classification {
  const combined = `${run.stdout}\n${run.stderr}`;
  if (FALLBACK_WARNING.test(combined)) fail('OpenCode fell back to its default agent');
  if (run.status !== 0) fail(`OpenCode exited ${run.status}`);

  const submissions: Classification[] = [];
  for (const [index, line] of run.stdout.split('\n').entries()) {
    if (!line.trim()) continue;
    const event = parseJsonLine(line, `stdout line ${index + 1}`);
    if (event.type === 'error') fail(`OpenCode emitted an error event`);
    if (event.type !== 'tool_use') continue;
    if (!isRecord(event.part)) fail(`tool_use event part must be an object`);
    if (event.part.tool !== SUBMISSION_TOOL) {
      fail(`unexpected tool call ${JSON.stringify(event.part.tool)}`);
    }
    submissions.push(toolInput(event.part));
  }

  if (submissions.length !== 1)
    fail(`expected exactly one ${SUBMISSION_TOOL} call; got ${submissions.length}`);
  const saved = parseSubmission(run.submission).verdict;
  if (JSON.stringify(saved) !== JSON.stringify(submissions[0])) {
    fail(`${SUBMISSION_TOOL} event and saved verdict differ`);
  }
  return saved;
}

export function boundedSubjects(subjects: string[]): string[] {
  const output: string[] = [];
  let used = 0;
  for (const subject of subjects.slice(0, SUBJECT_LIMIT)) {
    const normalized = subject.replace(/[\r\n]/g, ' ').slice(0, SUBJECT_LENGTH_LIMIT);
    if (used + normalized.length > SUBJECT_BUDGET) break;
    output.push(normalized);
    used += normalized.length;
  }
  if (output.length < subjects.length) output.push('…(commit subjects truncated)');
  return output;
}

export function createClassifierSandbox(sourceRoot = '.'): ClassifierSandbox {
  const root = mkdtempSync(join(tmpdir(), 'pardes-opencode-classifier-'));
  const sandbox = {
    cache: join(root, 'cache'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    home: join(root, 'home'),
    root,
    submissionFile: join(root, 'verdict.jsonl'),
    tmp: join(root, 'tmp'),
  };
  for (const dir of [sandbox.cache, sandbox.config, sandbox.data, sandbox.home, sandbox.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const [source, destination] of CLASSIFIER_FILES) {
    const target = join(root, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRoot, source), target);
  }
  writeFileSync(sandbox.submissionFile, '');
  return sandbox;
}

export function removeClassifierSandbox(sandbox: ClassifierSandbox): void {
  rmSync(sandbox.root, { force: true, recursive: true });
}

export function classifierEnvironment(
  sandbox: ClassifierSandbox,
  apiKey: string,
  path = process.env.PATH ?? '',
): Record<string, string> {
  if (!path) throw new Error('PATH missing');
  return {
    HOME: sandbox.home,
    OPENCODE_API_KEY: apiKey,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    PARDES_VERDICT_FILE: sandbox.submissionFile,
    PATH: path,
    PWD: sandbox.root,
    TMPDIR: sandbox.tmp,
    XDG_CACHE_HOME: sandbox.cache,
    XDG_CONFIG_HOME: sandbox.config,
    XDG_DATA_HOME: sandbox.data,
  };
}

export function readSubmission(sandbox: ClassifierSandbox): string {
  return readFileSync(sandbox.submissionFile, 'utf8');
}
