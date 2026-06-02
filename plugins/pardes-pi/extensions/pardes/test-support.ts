import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';

const GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS = 64 * 1024;
let gitFixtureDiagnostics = '';

function appendGitFixtureDiagnostics(diagnostics: string): void {
  gitFixtureDiagnostics += `${gitFixtureDiagnostics === '' ? '' : '\n'}${diagnostics}`;
  if (gitFixtureDiagnostics.length <= GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS) return;
  const omitted = gitFixtureDiagnostics.length - GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS;
  gitFixtureDiagnostics = `[... ${omitted} earlier diagnostic chars omitted ...]\n${gitFixtureDiagnostics.slice(-GIT_FIXTURE_DIAGNOSTICS_MAX_CHARS)}`;
}

beforeEach(({ onTestFailed }) => {
  gitFixtureDiagnostics = '';
  onTestFailed(() => {
    if (gitFixtureDiagnostics !== '')
      process.stderr.write(`\n[git fixture diagnostics]\n${gitFixtureDiagnostics}\n`);
  });
});

function formatGitFixtureCommand(cwd: string, args: ReadonlyArray<string>): string {
  return [`$ git ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, `  cwd: ${cwd}`].join('\n');
}

export function runGitFixture(cwd: string, ...args: string[]): string {
  const command = formatGitFixtureCommand(cwd, args);
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = result.stderr.trim();
  if (stderr !== '') appendGitFixtureDiagnostics(`${command}\n${stderr}`);
  if (result.error === undefined && result.status === 0) return result.stdout.trim();

  const stdout = result.stdout.trim();
  const diagnostics = [
    command,
    `  exit: ${result.status ?? result.signal ?? result.error?.message ?? 'unknown'}`,
    ...(stdout === '' ? [] : [`  stdout:\n${stdout}`]),
    ...(stderr === '' ? [] : [`  stderr:\n${stderr}`]),
  ].join('\n');
  if (stderr === '') appendGitFixtureDiagnostics(diagnostics);
  throw new Error(`Git fixture command failed.\n${diagnostics}`, { cause: result.error });
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

function copyGitTemplate(template: string, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(template, root, { recursive: true });
  return root;
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
