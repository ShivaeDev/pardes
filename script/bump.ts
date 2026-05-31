#!/usr/bin/env bun
/**
 * version-bump engine. Runs in CI from `push: main` (trusted, post-merge).
 *
 * Flow: figure out which plugin(s) the pushed range touched -> ask opencode to
 * classify the semver bump + draft changelog bullets (JSON out) -> apply the
 * version bump + changelog edits HERE -> open a PR, merge it synchronously, then
 * tag the PR's exact merge commit `<plugin>--v<version>` — all in this one run.
 *
 * Re-entrant: the only thing that ever bumps a plugin version is this workflow,
 * so a "Re-run failed jobs" detects a prior partial landing from main's manifest
 * version (skip its bump, just ensure its tag), reuses an existing bump PR, and
 * pushes the bump branch as create-or-update. The post-merge tag push has its own
 * bounded retry; if a tag still won't land it fails LOUD with the manual recovery
 * command, since a released-but-untagged version has nothing to re-trigger it.
 *
 * SECURITY
 * - Every external command uses execFileSync/spawnSync (NO shell). Commit
 *   messages/diffs (semi-untrusted, authored in PRs) are passed as argv data —
 *   never built into a shell string — so there is no command-injection surface.
 * - opencode runs as the `bump` agent: read-only (can read repo files for
 *   context, but cannot write/edit/exec). This script performs every file write,
 *   so the model can't mutate the repo or exfiltrate.
 * - Everything uses GITHUB_TOKEN (no bypass actor, no standing secret). The merge
 *   is SYNCHRONOUS, not auto-merge: a GITHUB_TOKEN merge doesn't re-trigger any
 *   workflow, so an async "tag on merge" step would never fire — we merge + tag
 *   inline instead. The GITHUB_TOKEN merge-push also can't re-trigger this job,
 *   so there is no recursion.
 * - Version tags (`<plugin>--v<version>`) are create-only. A repo ruleset on
 *   `*--v*` blocks tag update + delete; we never force/move them. The tag retry
 *   only ever pushes the same tag→same commit (create or no-op), and `git tag -f`
 *   is local-only — the remote ref is never force-updated (supply-chain).
 * - The bump branch (`bump/<sha>`) is bot-owned + disposable (deleted on merge);
 *   only IT may be force-with-leased to re-push a re-run. No `*--v*` tag is.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadPlugins, touchedPlugins } from './bump-core';

const ZERO = '0000000000000000000000000000000000000000';
const DIFF_BUDGET = 60_000; // cap diff text handed to the model (argv size + token sanity)

const afterSha = process.env.AFTER_SHA ?? '';
let beforeSha = process.env.BEFORE_SHA ?? '';
const model = process.env.OPENCODE_MODEL ?? '';

if (!afterSha) die('AFTER_SHA missing');
if (!model) die('OPENCODE_MODEL repo variable not set (provider/model)');
if (!process.env.OPENCODE_API_KEY) die('OPENCODE_API_KEY secret not set');

// First push / new branch: no usable "before". Use afterSha's parent, or git's
// empty-tree hash when afterSha is the root commit (so diffs treat all as new).
if (!beforeSha || beforeSha === ZERO) {
  const hasParent =
    spawnSync('git', ['rev-parse', '--verify', '--quiet', `${afterSha}^`]).status === 0;
  beforeSha = hasParent ? `${afterSha}~1` : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Block the event loop for `ms` (used in retry backoffs). Reaches Bun's native
// sleepSync via globalThis so this file type-checks both under @types/bun and
// under a bare node-only typecheck — without shelling out to an external `sleep`
// (which would be a silent no-op if it failed to spawn).
function sleepSync(ms: number): void {
  (globalThis as unknown as { Bun: { sleepSync(ms: number): void } }).Bun.sleepSync(ms);
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    // Fail with a clean one-liner rather than a child_process stacktrace.
    return die(
      `git ${args.slice(0, 3).join(' ')} failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
    );
  }
}

// spawnSync that surfaces a failure-to-launch. A bare spawnSync returns
// status:null + error set when the binary can't be spawned at all; callers that
// only test `status === 0` would silently read that as a normal "no" (e.g. "tag
// doesn't exist", "PR not merged"). Die loudly instead — a spawn failure is an
// environment problem, never a real answer.
function run(
  cmd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) die(`could not launch ${cmd}: ${r.error.message}`);
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// True if `path` existed at `sha`, so a brand-new plugin can be told apart from
// an edit to an existing one — we never auto-bump a plugin's initial release.
function existedAt(sha: string, path: string): boolean {
  return run('git', ['cat-file', '-e', `${sha}:${path}`]).status === 0;
}

const changed = git(['diff', '--name-only', beforeSha, afterSha]).split('\n').filter(Boolean);
if (changed.length === 0) {
  console.log('no changed files; nothing to do');
  process.exit(0);
}

const plugins = loadPlugins();

// "Touched" = a changed file under the plugin's path that ISN'T the bot-owned
// version manifest — so the bot's own bump never counts as a change to bump again.
const touched = touchedPlugins(plugins, changed);

// A plugin whose manifest didn't exist before this push is a brand-new plugin:
// its initial version is intentional, so don't auto-bump it on the add commit.
const toBump = touched.filter((p) => existedAt(beforeSha, p.manifestPath));
for (const p of touched) {
  if (!toBump.includes(p)) console.log(`${p.name}: new plugin — leaving its initial version alone`);
}

if (toBump.length === 0) {
  console.log('Nothing to bump.');
  process.exit(0);
}
console.log(`Bumping: ${toBump.map((p) => p.name).join(', ')}`);

type Classification = {
  bump: 'patch' | 'minor' | 'major';
  added?: string[];
  changed?: string[];
  fixed?: string[];
  removed?: string[];
};

type RawClassification = {
  bump?: unknown;
  added?: unknown;
  changed?: unknown;
  fixed?: unknown;
  removed?: unknown;
};

function asBullets(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim());
    return out.length ? out : undefined;
  }
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()];
  return undefined;
}

function normalize(o: RawClassification): Classification {
  const bump = String(o.bump ?? '').toLowerCase();
  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    throw new Error(`opencode returned an invalid bump kind: ${JSON.stringify(o.bump)}`);
  }
  return {
    added: asBullets(o.added),
    bump,
    changed: asBullets(o.changed),
    fixed: asBullets(o.fixed),
    removed: asBullets(o.removed),
  };
}

// Scan for every top-level brace-balanced `{...}` object in `text`, in the order
// they appear. A depth counter (ignoring braces inside double-quoted strings,
// honoring backslash escapes) means we capture each complete object span rather
// than a single regex match — so a late real verdict isn't shadowed by an early
// prompt-echo. Returned front-to-back; callers reverse for "last answer wins".
function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i); // charAt returns '' past the end, never undefined
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

// Permissive: opencode may return the JSON bare, fenced in ```json, prefixed with
// prose, or even double-encoded (a JSON string whose value is the JSON). Try hard.
// "Last answer wins": the agent reasons first and emits its real verdict last, so
// later candidates take priority over earlier ones (prompt-echo examples appear
// early in the transcript). Candidate order is therefore:
//   full text, then fenced blocks last-first, then every top-level object last-first.
function parseClassification(raw: string): Classification {
  const tryJSON = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const text = raw.trim();
  const candidates: string[] = [text];
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const f of fences.reverse()) candidates.push(f);
  // Every brace-balanced object, reversed so the LAST one in the transcript is
  // tried first. Replaces the old first-match lazy/greedy single-regex heuristics,
  // which let an early unfenced example beat a late unfenced verdict.
  for (const obj of topLevelObjects(text).reverse()) candidates.push(obj);

  for (const cand of candidates) {
    let val = tryJSON(cand);
    if (typeof val === 'string') {
      // double-encoded: a JSON string that itself contains the JSON object
      val = tryJSON(val) ?? tryJSON(val.match(/\{[\s\S]*\}/)?.[0] ?? '') ?? val;
    }
    if (val && typeof val === 'object' && 'bump' in (val as Record<string, unknown>)) {
      return normalize(val as RawClassification);
    }
  }

  // Fallback: the model ignored the JSON request and answered in prose (some
  // models emit "**Classification:** `minor`" with "- **Added:** ..." bullets).
  // Salvage a bump kind + Keep-a-Changelog bullets from that shape.
  const prose = parseProse(text);
  if (prose) return prose;

  throw new Error(`could not parse classification from opencode output:\n${raw.slice(0, 2000)}`);
}

// Pull the bump kind out of a verdict: first a keyword right after a verdict cue
// ("Classification: `minor`"), else the LAST emphasis-wrapped keyword (prose
// concludes with the verdict). We never guess from a bare token in prose — a
// wrong bump (e.g. "not a major change" → major) is worse than failing cleanly.
// All patterns use bounded quantifiers so adversarial model output can't ReDoS.
function proseBumpKind(text: string): string | null {
  const cued = text.match(
    /(?:classification|verdict|semver|bump)\b[^\n]{0,40}?[`*"']{0,3}(major|minor|patch)\b/i,
  );
  if (cued) return cued[1].toLowerCase();
  const wrapped = [...text.matchAll(/[`*]{1,3}(major|minor|patch)[`*]{1,3}/gi)];
  if (wrapped.length) return wrapped[wrapped.length - 1][1].toLowerCase();
  return null;
}

function parseProse(full: string): Classification | null {
  const text = full.slice(0, 100_000); // bound the scan on untrusted-influenced model output
  const kind = proseBumpKind(text);
  if (!kind) return null;

  // Only salvage bullets that carry an explicit Keep-a-Changelog section label
  // ("- **Fixed:** ..."). UNLABELED bullets are almost always the model's own
  // reasoning — it tends to think in bulleted lists — and scraping those once
  // dumped dozens of deliberation lines straight into the changelog. If nothing
  // is labeled we leave every section empty; writeChangelog then falls back to the
  // commit subjects, which are clean and factual.
  const sections: Record<string, string[]> = { added: [], changed: [], fixed: [], removed: [] };
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) continue;
    const label = bullet[1].match(/^\*{0,2}(added|changed|fixed|removed)\*{0,2}\s*:\s*\*{0,2}\s*/i);
    if (!label) continue; // unlabeled bullet → reasoning, not a changelog entry
    const section = label[1].toLowerCase();
    const body = bullet[1]
      .slice(label[0].length)
      .replace(/^\*+\s*|\s*\*+$/g, '')
      .trim();
    const arr = sections[section];
    if (body && arr) arr.push(body);
  }
  return normalize({ bump: kind.toLowerCase(), ...sections });
}

// Strip ANSI escape sequences so the audited transcript is plain text in the CI
// log. The escape byte is built from its code point to avoid a control char in
// the regex source (which biome's noControlCharactersInRegex would reject).
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, '');

function classify(name: string, version: string, subjects: string[], diff: string): Classification {
  const prompt = [
    `Plugin: ${name}`,
    `Current version: ${version}`,
    `Commit subjects since last release:`,
    ...subjects.map((s) => `- ${s}`),
    ``,
    `Unified diff (may be truncated; you may also read files in the repo for context):`,
    '```diff',
    diff,
    '```',
  ].join('\n');

  // No shell: the prompt (which embeds untrusted diff/commit text) is a single
  // argv. Default format + --thinking renders the model's reasoning AND its answer
  // as human-readable text on stdout (vs --format json, which is raw events).
  // opencode buffers when piped, so the whole transcript lands at once on exit —
  // fine, we echo it as one block. --print-logs stays OFF: that flag is opencode's
  // internal debug spew, not the model's work.
  const res = spawnSync('opencode', ['run', '--agent', 'bump', '--thinking', '-m', model, prompt], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not launch opencode: ${res.error.message}`);

  // Audit trail: echo opencode's full reasoning + output into a collapsed group
  // in the Actions log (expand to review every step the model took). This is the
  // whole point — the bump is mechanical, but the classification should be
  // reviewable after the fact.
  const transcript = stripAnsi(res.stdout ?? '');
  console.log(`::group::opencode classification — ${name}`);
  console.log(transcript.trim() || '(opencode produced no stdout)');
  const err = stripAnsi(res.stderr ?? '').trim();
  if (err) console.log(`--- stderr (last 8 lines) ---\n${err.split('\n').slice(-8).join('\n')}`);
  console.log('::endgroup::');

  if (res.status !== 0) {
    throw new Error(
      `opencode exited ${res.status} (see the "opencode classification — ${name}" group above)`,
    );
  }
  return parseClassification(transcript);
}

function bumpVersion(v: string, kind: Classification['bump']): string {
  const [maj, min, pat] = v.split('.').map((n) => Number.parseInt(n, 10));
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function writeChangelog(
  name: string,
  version: string,
  c: Classification,
  subjects: string[],
): void {
  const file = join('changelog', `${name}.md`);
  const date = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];
  for (const key of ['added', 'changed', 'fixed', 'removed'] as const) {
    const items = c[key];
    if (items?.length) {
      sections.push(`### ${key[0].toUpperCase()}${key.slice(1)}`, ...items.map((i) => `- ${i}`));
    }
  }
  // The prompt requires at least one real bullet, so this is a genuine last
  // resort. Don't emit a meaningless "Maintenance." line — fall back to the
  // actual commit subjects, which at least name what landed.
  if (sections.length === 0) {
    const lines = (subjects.length ? subjects.slice(0, 3) : ['Internal changes']).map(
      (s) => `- ${s.charAt(0).toUpperCase()}${s.slice(1)}`,
    );
    sections.push('### Changed', ...lines);
  }
  const entry = `## [${version}] - ${date}\n${sections.join('\n')}\n`;

  if (existsSync(file)) {
    const body = readFileSync(file, 'utf8');
    const firstEntry = body.indexOf('\n## ');
    if (firstEntry >= 0) {
      writeFileSync(
        file,
        `${body.slice(0, firstEntry + 1)}${entry}\n${body.slice(firstEntry + 1)}`,
      );
    } else {
      writeFileSync(file, `${body.replace(/\s*$/, '')}\n\n${entry}`);
    }
  } else {
    const header = `# Changelog — ${name}\n\nAll notable changes to this plugin are documented in this file.\nFormat follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${header}\n${entry}`);
  }
}

// Read a plugin's manifest version as it exists at a git ref (e.g. `origin/main`),
// or null if the manifest doesn't exist there. Used to make the run re-entrant:
// the only thing that ever bumps a version is THIS workflow, so if main already
// carries a higher version than the working-tree base, a prior (partial) run landed.
function versionAtRef(ref: string, manifestPath: string): string | null {
  const r = run('git', ['cat-file', '-p', `${ref}:${manifestPath}`]);
  if (r.status !== 0) return null;
  try {
    const v = (JSON.parse(r.stdout) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

// Fetch main up front so the bump loop can see whether a prior run already landed
// a version for any plugin (re-entrancy on a "Re-run failed jobs").
git(['fetch', 'origin', 'main']);

// `released`: a bump for this plugin already exists on main (prior run) — only its
// tag may still need to land. `bumped`: a fresh bump computed in this run that we
// still need to commit/merge. The tag step covers both.
const released: { name: string; to: string }[] = [];
const bumped: { name: string; from: string; to: string; kind: string }[] = [];

// Classify, version, and changelog every touched plugin independently. One
// source PR may therefore produce several release entries and immutable tags,
// committed together in the single bot-owned bump PR below.
for (const p of toBump) {
  try {
    const vpath = p.manifestPath;
    const rawManifest = readFileSync(vpath, 'utf8');
    const current: string = JSON.parse(rawManifest).version;

    // Re-entrancy short-circuit: if main's manifest version already differs from
    // the working-tree base, a previous run of this workflow already bumped + merged
    // this plugin. Don't re-classify or re-commit — just make sure its tag exists.
    const mainVersion = versionAtRef('origin/main', p.manifestPath);
    if (mainVersion && mainVersion !== current) {
      released.push({ name: p.name, to: mainVersion });
      console.log(`${p.name}: already at ${mainVersion} on main — skipping bump, will verify tag`);
      continue;
    }

    const subjects = git(['log', `${beforeSha}..${afterSha}`, '--format=%s', '--', p.path])
      .split('\n')
      .filter(Boolean);
    let diff = git(['diff', `${beforeSha}..${afterSha}`, '--', p.path]);
    if (diff.length > DIFF_BUDGET) diff = `${diff.slice(0, DIFF_BUDGET)}\n…(diff truncated)`;

    const c = classify(p.name, current, subjects, diff);
    const next = bumpVersion(current, c.bump);
    // Surgically replace only the version value so the rest of the manifest keeps
    // its exact (biome-formatted) bytes. A full JSON.stringify reflows arrays such
    // as `keywords` onto multiple lines, which biome then rejects in CI — and the
    // bump merges before that check, so the breakage lands on main.
    const updated = rawManifest.replace(/("version"\s*:\s*")[^"]*"/, `$1${next}"`);
    if (updated === rawManifest) {
      throw new Error(`could not locate a "version" field to bump in ${vpath}`);
    }
    writeFileSync(vpath, updated);
    writeChangelog(p.name, next, c, subjects);
    bumped.push({ from: current, kind: c.bump, name: p.name, to: next });
    console.log(`✓ ${p.name}: ${current} → ${next} (${c.bump})`);
  } catch (e) {
    die(`Failed to classify/bump ${p.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Thin wrapper around gh with a clean one-line failure (mirrors git()).
function gh(args: string[]): void {
  try {
    execFileSync('gh', args, { stdio: 'inherit' });
  } catch (e) {
    die(
      `gh ${args.slice(0, 2).join(' ')} failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
    );
  }
}

const short = afterSha.slice(0, 12);
const branch = `bump/${short}`;

// If a prior run already merged every plugin's bump (re-run after a tag-only
// failure), there's nothing to commit/merge — jump straight to the tag step.
if (bumped.length > 0) {
  // Commit on a deterministic bump branch and open a PR (GITHUB_TOKEN identity).
  // The branch name is derived from afterSha, so a "Re-run failed jobs" recomputes
  // the SAME branch — every step below is therefore made create-or-update so the
  // re-run can get past a branch/PR that a partial prior attempt already created.
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  git(['checkout', '-b', branch]);
  git(['add', 'plugins', 'changelog']);

  const title =
    bumped.length === 1
      ? `chore: bump ${bumped[0].name} to ${bumped[0].to}`
      : `chore: bump ${bumped.length} plugins`;
  const body = [
    `Automated version bump for the plugins changed in ${short}.`,
    '',
    ...bumped.map((b) => `- \`${b.name}\` ${b.from} → ${b.to} (${b.kind})`),
  ].join('\n');

  git(['commit', '-m', title]);

  // Create-or-update push: a re-run rebuilds the same branch but with a fresh
  // commit (commit date differs → SHA differs), so a plain push would be rejected
  // as non-fast-forward. Force-with-lease ONLY the bot-owned, disposable bump
  // branch (deleted on merge). This never touches a `*--v*` tag — those stay
  // create-only per the ruleset.
  const branchOnRemote =
    run('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]).status === 0;
  if (branchOnRemote) {
    console.log(`bump branch ${branch} already on remote — updating it`);
    git(['push', '--force-with-lease', '-u', 'origin', branch]);
  } else {
    git(['push', '-u', 'origin', branch]);
  }

  // Reuse an existing PR for this head if a prior run already opened one.
  const existingPr = run('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ]);
  if (existingPr.status === 0 && existingPr.stdout.trim()) {
    console.log(`reusing existing bump PR #${existingPr.stdout.trim()} for ${branch}`);
  } else {
    gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body]);
  }
}

// SYNCHRONOUS merge — NOT `--auto`. Auto-merge happens asynchronously after this
// job exits, and a GITHUB_TOKEN merge does not re-trigger any workflow (the
// recursion guard). Both mean a later "tag on merge" step could never fire. So we
// merge inline here and tag the resulting commit in this same run.
//
// `gh pr merge` (no --auto) merges synchronously, but GitHub may not have finished
// computing the PR's mergeability the instant after `pr create` — gh then fails
// with a transient "still computing"/"not mergeable yet" error. Retry with a short
// backoff so an unattended run isn't flaky, and if a prior attempt actually merged
// (only the branch-delete hiccuped), detect that and stop rather than retrying a
// PR that's already gone.
function bumpPrMerged(): boolean {
  const r = run('gh', ['pr', 'view', branch, '--json', 'state', '--jq', '.state']);
  return r.status === 0 && r.stdout.trim() === 'MERGED';
}

function mergeBumpPr(): void {
  const args = ['pr', 'merge', branch, '--squash', '--delete-branch'];
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = run('gh', args);
    if (r.status === 0) {
      console.log('merged bump PR');
      return;
    }
    if (bumpPrMerged()) {
      console.log('bump PR already merged');
      return;
    }
    const msg = `${r.stderr}${r.stdout}`.trim().split('\n')[0] || `exit ${r.status}`;
    if (attempt === maxAttempts) {
      die(`gh pr merge failed after ${maxAttempts} attempts: ${msg}`);
    }
    console.log(`merge not ready (attempt ${attempt}/${maxAttempts}: ${msg}); retrying in 5s…`);
    sleepSync(5000);
  }
}

if (bumped.length > 0) mergeBumpPr();

// Resolve the EXACT commit a plugin's version landed on, so tags never get
// mis-pointed by an unrelated merge that races onto main between our merge and
// our fetch (the `*--v*` ruleset makes a mis-tag permanent). Freshly-bumped
// plugins resolve via the bump PR's recorded mergeCommit; already-released
// plugins (prior run) resolve via the commit on main that last touched the
// manifest. Both are independent of whatever else `main` HEAD currently points at.
function mergeCommitForBranch(): string {
  const r = run('gh', ['pr', 'view', branch, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
  const oid = r.status === 0 ? r.stdout.trim() : '';
  if (!oid) die(`could not resolve merge commit for ${branch} via gh pr view`);
  git(['fetch', 'origin', oid]);
  return oid;
}

function manifestCommitOnMain(name: string): string {
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) die(`unknown plugin ${name}`);
  const sha = git(['log', '-1', '--format=%H', 'origin/main', '--', plugin.manifestPath]);
  if (!sha) die(`could not resolve the commit that bumped ${name} on main`);
  return sha;
}

// Create + push one `*--v*` tag with a bounded retry mirroring mergeBumpPr(): the
// merge is already done, so a transient push failure must not silently lose the
// tag. Returns false (not die) after exhausting attempts so the caller can collect
// every failure and print all manual recovery commands at once.
function pushTag(tag: string, sha: string): boolean {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-make the local tag each attempt (idempotent locally) before pushing.
    run('git', ['tag', '-f', tag, sha]);
    const r = run('git', ['push', 'origin', `refs/tags/${tag}`]);
    if (r.status === 0) return true;
    // A concurrent run may have created the same tag remotely in between — that's
    // a success, not a failure (the tag exists on the right commit by construction).
    if (run('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`]).status === 0) {
      console.log(`tag ${tag} appeared on the remote — treating as created`);
      return true;
    }
    const msg = `${r.stderr}${r.stdout}`.trim().split('\n')[0] || `exit ${r.status}`;
    if (attempt === maxAttempts) {
      console.error(`tag ${tag} failed after ${maxAttempts} attempts: ${msg}`);
      return false;
    }
    console.log(`tag push not ready (attempt ${attempt}/${maxAttempts}: ${msg}); retrying in 5s…`);
    sleepSync(5000);
  }
  return false;
}

const freshMergeSha = bumped.length > 0 ? mergeCommitForBranch() : '';
const tagTargets: { name: string; to: string; sha: string }[] = [
  ...bumped.map((b) => ({ name: b.name, sha: freshMergeSha, to: b.to })),
  ...released.map((rel) => ({ name: rel.name, sha: manifestCommitOnMain(rel.name), to: rel.to })),
];

// Tag each released plugin version `<plugin>--v<version>` on its exact commit. A
// repo ruleset on `*--v*` blocks tag update + delete, so these are immutable once
// created — never force. The merge above already ran (irreversible), so a tag that
// fails to land would leave a released-but-untagged version with nothing to
// re-trigger the workflow: retry with a bounded backoff, and if it STILL won't
// land, fail loudly with the exact manual recovery command.
const tagFailures: string[] = [];
for (const t of tagTargets) {
  const tag = `${t.name}--v${t.to}`;
  // Idempotent: if a re-run finds the tag already on the remote, leave it. We
  // never delete/move a `*--v*` tag — the ruleset forbids it and so do we.
  if (run('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`]).status === 0) {
    console.log(`tag ${tag} already exists — leaving it`);
    continue;
  }
  if (pushTag(tag, t.sha)) {
    console.log(`✓ tagged ${tag} → ${t.sha.slice(0, 12)}`);
  } else {
    tagFailures.push(`git tag ${tag} ${t.sha} && git push origin refs/tags/${tag}`);
  }
}

if (tagFailures.length > 0) {
  console.error(
    `\nRELEASED BUT UNTAGGED — ${tagFailures.length} tag(s) failed to land after retries.\n` +
      `The version bump(s) are already merged on main; only the immutable tag is missing.\n` +
      `Nothing re-triggers this workflow, so create the tag(s) MANUALLY:\n\n` +
      tagFailures.map((cmd) => `  ${cmd}`).join('\n') +
      '\n',
  );
  process.exit(1);
}
