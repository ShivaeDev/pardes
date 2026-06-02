import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';

export const GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS = 64 * 1024;
export const GIT_FIXTURE_TIMEOUT_MS = 30_000;
let gitFixtureDiagnosticsTail = '';
let omittedGitFixtureDiagnosticChars = 0;

function gitFixtureDiagnosticsOmissionMarker(omittedChars: number): string {
  return `[... ${omittedChars} earlier diagnostic chars omitted ...]\n`;
}

function readGitFixtureDiagnostics(): string {
  return omittedGitFixtureDiagnosticChars === 0
    ? gitFixtureDiagnosticsTail
    : `${gitFixtureDiagnosticsOmissionMarker(omittedGitFixtureDiagnosticChars)}${gitFixtureDiagnosticsTail}`;
}

function appendGitFixtureDiagnostics(diagnostics: string): void {
  gitFixtureDiagnosticsTail += `${gitFixtureDiagnosticsTail === '' ? '' : '\n'}${diagnostics}`;
  while (
    gitFixtureDiagnosticsTail.length +
      (omittedGitFixtureDiagnosticChars === 0
        ? 0
        : gitFixtureDiagnosticsOmissionMarker(omittedGitFixtureDiagnosticChars).length) >
    GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS
  ) {
    const marker = gitFixtureDiagnosticsOmissionMarker(omittedGitFixtureDiagnosticChars + 1);
    const omitted = Math.max(
      1,
      gitFixtureDiagnosticsTail.length + marker.length - GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS,
    );
    gitFixtureDiagnosticsTail = gitFixtureDiagnosticsTail.slice(omitted);
    omittedGitFixtureDiagnosticChars += omitted;
  }
}

function resetGitFixtureDiagnostics(): void {
  gitFixtureDiagnosticsTail = '';
  omittedGitFixtureDiagnosticChars = 0;
}

export function readGitFixtureDiagnosticsForTest(): string {
  return readGitFixtureDiagnostics();
}

beforeEach(({ onTestFailed }) => {
  resetGitFixtureDiagnostics();
  onTestFailed(() => {
    const diagnostics = readGitFixtureDiagnostics();
    if (diagnostics !== '') process.stderr.write(`\n[git fixture diagnostics]\n${diagnostics}\n`);
  });
});

function formatGitFixtureCommand(cwd: string, args: ReadonlyArray<string>): string {
  return [`$ git ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, `  cwd: ${cwd}`].join('\n');
}

function gitFixtureEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TEMPLATE_DIR: '',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete environment.GIT_CONFIG;
  delete environment.GIT_CONFIG_COUNT;
  delete environment.GIT_CONFIG_PARAMETERS;
  for (const name of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete environment[name];
  }
  return environment;
}

function trimGitFixtureOutput(output: unknown): string {
  return typeof output === 'string' ? output.trim() : '';
}

function formatGitFixtureFailure(
  command: string,
  result: ReturnType<typeof spawnSync>,
  timeoutMs: number,
): string {
  const stdout = trimGitFixtureOutput(result.stdout);
  const stderr = trimGitFixtureOutput(result.stderr);
  const error = result.error as NodeJS.ErrnoException | undefined;
  return [
    command,
    ...(error?.code === 'ETIMEDOUT'
      ? [`  timeout: exceeded ${timeoutMs}ms; investigate a stalled Git fixture command`]
      : []),
    ...(error === undefined ? [] : [`  spawn error: ${error.message}`]),
    `  exit: ${result.status ?? result.signal ?? error?.code ?? 'unknown'}`,
    ...(stdout === '' ? [] : [`  stdout:\n${stdout}`]),
    ...(stderr === '' ? [] : [`  stderr:\n${stderr}`]),
  ].join('\n');
}

interface RunGitFixtureOptions {
  readonly timeoutMs?: number;
}

export function runGitFixtureWithOptions(
  cwd: string,
  args: ReadonlyArray<string>,
  options: RunGitFixtureOptions = {},
): string {
  const timeoutMs = options.timeoutMs ?? GIT_FIXTURE_TIMEOUT_MS;
  const command = formatGitFixtureCommand(cwd, args);
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitFixtureEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  if (result.error !== undefined) {
    const diagnostics = formatGitFixtureFailure(command, result, timeoutMs);
    appendGitFixtureDiagnostics(diagnostics);
    throw new Error(`Git fixture command failed.\n${diagnostics}`, { cause: result.error });
  }

  const stderr = result.stderr.trim();
  if (result.status === 0) {
    if (stderr !== '') appendGitFixtureDiagnostics(`${command}\n${stderr}`);
    return result.stdout.trim();
  }

  const diagnostics = formatGitFixtureFailure(command, result, timeoutMs);
  appendGitFixtureDiagnostics(diagnostics);
  throw new Error(`Git fixture command failed.\n${diagnostics}`);
}

export function runGitFixture(cwd: string, ...args: string[]): string {
  return runGitFixtureWithOptions(cwd, args);
}

interface LocalGitRepositoryFixture {
  readonly repo: string;
  readonly root: string;
}

interface OriginGitRepositoryFixture extends LocalGitRepositoryFixture {
  readonly origin: string;
}

interface RemoteGitRepositoryFixture extends OriginGitRepositoryFixture {
  readonly publisher: string;
}

let localGitTemplate: string | undefined;
const originGitTemplates = new Map<string, string>();
const remoteGitTemplates = new Map<string, string>();
const gitTemplateDirectories = new Set<string>();

function configureGitFixtureIdentity(repo: string): void {
  runGitFixture(repo, 'config', 'user.email', 'pardes@example.test');
  runGitFixture(repo, 'config', 'user.name', 'Pardes Test');
  runGitFixture(repo, 'config', 'commit.gpgSign', 'false');
  runGitFixture(repo, 'config', 'core.hooksPath', devNull);
}

function initializeGitFixtureRepository(repo: string): void {
  configureGitFixtureIdentity(repo);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  runGitFixture(repo, 'add', 'README.md');
  runGitFixture(repo, 'commit', '-m', 'fixture');
}

function immutableLocalGitTemplate(): string {
  if (localGitTemplate !== undefined) return localGitTemplate;
  const root = mkdtempSync(join(tmpdir(), 'pardes-local-git-template-'));
  gitTemplateDirectories.add(root);
  const repo = join(root, 'project');
  runGitFixture(root, 'init', '-b', 'main', repo);
  initializeGitFixtureRepository(repo);
  localGitTemplate = root;
  return root;
}

function immutableOriginGitTemplate(defaultBranch: string): string {
  const cached = originGitTemplates.get(defaultBranch);
  if (cached !== undefined) return cached;
  const root = mkdtempSync(join(tmpdir(), 'pardes-origin-git-template-'));
  gitTemplateDirectories.add(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'project');
  runGitFixture(root, 'init', '--bare', '-b', defaultBranch, origin);
  runGitFixture(root, 'init', '-b', defaultBranch, repo);
  initializeGitFixtureRepository(repo);
  runGitFixture(repo, 'remote', 'add', 'origin', '../origin.git');
  runGitFixture(repo, 'push', '-u', 'origin', defaultBranch);
  originGitTemplates.set(defaultBranch, root);
  return root;
}

function immutableRemoteGitTemplate(defaultBranch: string): string {
  const cached = remoteGitTemplates.get(defaultBranch);
  if (cached !== undefined) return cached;
  const root = mkdtempSync(join(tmpdir(), 'pardes-remote-git-template-'));
  gitTemplateDirectories.add(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'project');
  const publisher = join(root, 'publisher');
  runGitFixture(root, 'init', '--bare', '-b', defaultBranch, origin);
  runGitFixture(root, 'init', '-b', defaultBranch, repo);
  initializeGitFixtureRepository(repo);
  runGitFixture(repo, 'remote', 'add', 'origin', '../origin.git');
  runGitFixture(repo, 'push', '-u', 'origin', defaultBranch);
  runGitFixture(root, 'clone', 'origin.git', publisher);
  runGitFixture(publisher, 'remote', 'set-url', 'origin', '../origin.git');
  configureGitFixtureIdentity(publisher);
  remoteGitTemplates.set(defaultBranch, root);
  return root;
}

export function copyGitTemplate(template: string, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    cpSync(template, root, { recursive: true });
    return root;
  } catch (cause) {
    rmSync(root, { force: true, recursive: true });
    throw cause;
  }
}

export function copyLocalGitRepositoryFixture(prefix: string): LocalGitRepositoryFixture {
  const root = copyGitTemplate(immutableLocalGitTemplate(), prefix);
  return { repo: join(root, 'project'), root };
}

export function copyOriginGitRepositoryFixture(
  prefix: string,
  defaultBranch = 'main',
): OriginGitRepositoryFixture {
  const root = copyGitTemplate(immutableOriginGitTemplate(defaultBranch), prefix);
  return { origin: join(root, 'origin.git'), repo: join(root, 'project'), root };
}

export function copyRemoteGitRepositoryFixture(
  prefix: string,
  defaultBranch = 'main',
): RemoteGitRepositoryFixture {
  const root = copyGitTemplate(immutableRemoteGitTemplate(defaultBranch), prefix);
  return {
    origin: join(root, 'origin.git'),
    publisher: join(root, 'publisher'),
    repo: join(root, 'project'),
    root,
  };
}

afterAll(() => {
  for (const directory of gitTemplateDirectories)
    rmSync(directory, { force: true, recursive: true });
});

export function requiredValue<T>(
  value: T | null | undefined,
  message = 'Expected fixture value',
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
