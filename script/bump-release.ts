import { spawnSync } from 'node:child_process';

export type BumpKind = 'patch' | 'minor' | 'major';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requirePullRequestTarget(
  pullRequest: { baseRefName?: unknown; headRefOid?: unknown },
  expectedHead?: string,
): string {
  if (pullRequest.baseRefName !== 'main') {
    throw new Error(`bump PR base must be main, got ${JSON.stringify(pullRequest.baseRefName)}`);
  }
  if (
    typeof pullRequest.headRefOid !== 'string' ||
    !/^[0-9a-f]{40}$/.test(pullRequest.headRefOid)
  ) {
    throw new Error(`bump PR head must be a full commit SHA`);
  }
  if (expectedHead && pullRequest.headRefOid !== expectedHead) {
    throw new Error(
      `bump PR head ${pullRequest.headRefOid} does not match published head ${expectedHead}`,
    );
  }
  return pullRequest.headRefOid;
}

export function scopedGitAuthKey(originUrl: string, serverUrl: string): string {
  let origin: URL;
  let server: URL;
  try {
    origin = new URL(originUrl);
    server = new URL(serverUrl);
  } catch {
    throw new Error(`publication Git origin/server must be absolute URLs`);
  }
  if (origin.protocol !== 'https:' || server.protocol !== 'https:') {
    throw new Error(`publication Git origin/server must use HTTPS`);
  }
  if (server.pathname !== '/' || origin.origin !== server.origin) {
    throw new Error(
      `publication Git origin must stay on configured GitHub server ${server.origin}`,
    );
  }
  if (!/^\/[^/]+\/[^/]+(?:\.git)?\/?$/.test(origin.pathname)) {
    throw new Error(`publication Git origin must identify one repository`);
  }
  return `http.${server.origin}/.extraheader`;
}

export function requireSemver(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(value)
  ) {
    throw new Error(`invalid plugin semver: ${JSON.stringify(value)}`);
  }
}

export function bumpVersion(version: string, kind: BumpKind): string {
  requireSemver(version);
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10));
  const next =
    kind === 'major'
      ? `${major + 1}.0.0`
      : kind === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
  requireSemver(next);
  return next;
}

function stringEnd(input: string, start: number): number {
  if (input.charAt(start) !== '"') throw new Error('expected a JSON string');
  let escaped = false;
  for (let index = start + 1; index < input.length; index++) {
    const char = input.charAt(index);
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') return index + 1;
  }
  throw new Error('unterminated JSON string');
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (/\s/.test(input.charAt(index))) index++;
  return index;
}

function topLevelStringPropertySpans(
  input: string,
  property: string,
): { end: number; start: number }[] {
  const spans: { end: number; start: number }[] = [];
  let depth = 0;
  for (let index = 0; index < input.length; index++) {
    const char = input.charAt(index);
    if (char === '"') {
      const end = stringEnd(input, index);
      if (depth === 1) {
        const key = JSON.parse(input.slice(index, end)) as unknown;
        const colon = skipWhitespace(input, end);
        if (key === property && input.charAt(colon) === ':') {
          const start = skipWhitespace(input, colon + 1);
          spans.push({ end: stringEnd(input, start), start });
        }
      }
      index = end - 1;
    } else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
  return spans;
}

export function manifestVersion(raw: string): string {
  const manifest = JSON.parse(raw) as unknown;
  if (!isRecord(manifest)) throw new Error('plugin manifest must be a JSON object');
  requireSemver(manifest.version);
  return manifest.version;
}

export function updateManifestVersion(raw: string, current: string, next: string): string {
  requireSemver(current);
  requireSemver(next);
  if (manifestVersion(raw) !== current)
    throw new Error(`plugin manifest is not at expected version ${current}`);

  const spans = topLevelStringPropertySpans(raw, 'version');
  if (spans.length !== 1)
    throw new Error(`plugin manifest must have exactly one top-level version field`);
  const [span] = spans;
  const updated = `${raw.slice(0, span.start)}${JSON.stringify(next)}${raw.slice(span.end)}`;
  if (manifestVersion(updated) !== next)
    throw new Error(`plugin manifest did not update to ${next}`);
  return updated;
}

type GitResult = { status: number | null; stderr: string; stdout: string };

function git(root: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw new Error(`could not launch git: ${result.error.message}`);
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

export function manifestVersionAtRef(
  root: string,
  ref: string,
  manifestPath: string,
): string | null {
  const result = git(root, ['cat-file', '-p', `${ref}:${manifestPath}`]);
  if (result.status !== 0) return null;
  return manifestVersion(result.stdout);
}

export function versionIntroductionCommit(
  root: string,
  ref: string,
  manifestPath: string,
  version: string,
): string {
  requireSemver(version);
  const history = git(root, ['log', '--first-parent', '--format=%H', ref, '--', manifestPath]);
  if (history.status !== 0) throw new Error(`could not inspect ${manifestPath} history at ${ref}`);

  for (const commit of history.stdout.split('\n').filter(Boolean)) {
    if (manifestVersionAtRef(root, commit, manifestPath) !== version) continue;
    if (manifestVersionAtRef(root, `${commit}^`, manifestPath) === version) continue;
    return commit;
  }
  throw new Error(`could not find the commit that introduced ${manifestPath} version ${version}`);
}

export function manifestTouches(
  root: string,
  fromRef: string,
  toRef: string,
  manifestPath: string,
): { from: string; sha: string; to: string }[] {
  const initial = manifestVersionAtRef(root, fromRef, manifestPath);
  if (!initial) throw new Error(`${manifestPath} missing at ${fromRef}`);
  const history = git(root, [
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H',
    `${fromRef}..${toRef}`,
    '--',
    manifestPath,
  ]);
  if (history.status !== 0)
    throw new Error(`could not inspect ${manifestPath} history after ${fromRef}`);

  const touches: { from: string; sha: string; to: string }[] = [];
  let previous = initial;
  for (const sha of history.stdout.split('\n').filter(Boolean)) {
    const version = manifestVersionAtRef(root, sha, manifestPath);
    if (!version) throw new Error(`${manifestPath} missing at ${sha}`);
    touches.push({ from: previous, sha, to: version });
    previous = version;
  }
  return touches;
}

export function changedReleasePaths(
  root: string,
  fromRef: string,
  toRef: string,
  releasePaths: string[],
): string[] {
  if (releasePaths.length === 0) return [];
  const result = git(root, ['diff', '--name-only', fromRef, toRef, '--', ...releasePaths]);
  if (result.status !== 0)
    throw new Error(`could not inspect release-path changes from ${fromRef} to ${toRef}`);
  return result.stdout.split('\n').filter(Boolean);
}

export function nextVersionIntroductionCommit(
  root: string,
  fromRef: string,
  toRef: string,
  manifestPath: string,
  current: string,
): { sha: string; version: string } {
  requireSemver(current);
  if (git(root, ['merge-base', '--is-ancestor', fromRef, toRef]).status !== 0) {
    throw new Error(`${fromRef} is not an ancestor of ${toRef}`);
  }
  const history = git(root, [
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H',
    `${fromRef}..${toRef}`,
    '--',
    manifestPath,
  ]);
  if (history.status !== 0)
    throw new Error(`could not inspect ${manifestPath} history after ${fromRef}`);

  for (const sha of history.stdout.split('\n').filter(Boolean)) {
    const version = manifestVersionAtRef(root, sha, manifestPath);
    if (!version || version === current) continue;
    if (manifestVersionAtRef(root, `${sha}^`, manifestPath) === version) continue;
    return { sha, version };
  }
  throw new Error(`could not find a new ${manifestPath} version after ${fromRef}`);
}
