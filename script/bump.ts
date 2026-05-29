#!/usr/bin/env bun
/**
 * version-bump engine. Runs in CI from `push: main` (trusted, post-merge).
 *
 * Flow: figure out which plugin(s) the pushed range touched -> ask opencode to
 * classify the semver bump + draft changelog bullets (JSON out) -> apply the
 * version bump + changelog edits HERE -> open an auto-merge PR.
 *
 * SECURITY
 * - Every external command uses execFileSync (NO shell). Commit messages/diffs
 *   (semi-untrusted, authored in PRs) are passed as argv data — never built into
 *   a shell string — so there is no command-injection surface.
 * - opencode runs as the `bump` agent: read-only (can read repo files for
 *   context, but cannot write/edit/exec). This script performs every file write,
 *   so the model can't mutate the repo or exfiltrate.
 * - PR is opened + auto-merged with GITHUB_TOKEN -> no recursion, no bypass actor.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  const hasParent = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${afterSha}^`]).status === 0;
  beforeSha = hasParent ? `${afterSha}~1` : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    // Fail with a clean one-liner rather than a child_process stacktrace.
    return die(`git ${args.slice(0, 3).join(' ')} failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

// True if `path` existed at `sha`, so a brand-new plugin can be told apart from
// an edit to an existing one — we never auto-bump a plugin's initial release.
function existedAt(sha: string, path: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${sha}:${path}`]).status === 0;
}

const changed = git(['diff', '--name-only', beforeSha, afterSha]).split('\n').filter(Boolean);
if (changed.length === 0) {
  console.log('no changed files; nothing to do');
  process.exit(0);
}

type MarketPlugin = { name: string; source: string };
const marketplace = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8')) as {
  plugins: MarketPlugin[];
};
const plugins = marketplace.plugins.map((p) => ({
  name: p.name,
  path: p.source.replace(/^\.\//, '').replace(/\/$/, ''),
}));

const versionPath = (path: string) => join(path, '.claude-plugin', 'plugin.json');

// "Touched" = a changed file under the plugin's path that ISN'T the bot-owned
// version manifest — so the bot's own bump never counts as a change to bump again.
const touched = plugins.filter((p) =>
  changed.some((f) => f.startsWith(`${p.path}/`) && f !== versionPath(p.path)),
);

// A plugin whose manifest didn't exist before this push is a brand-new plugin:
// its initial version is intentional, so don't auto-bump it on the add commit.
const toBump = touched.filter((p) => existedAt(beforeSha, versionPath(p.path)));
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
    const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
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
    bump,
    added: asBullets(o.added),
    changed: asBullets(o.changed),
    fixed: asBullets(o.fixed),
    removed: asBullets(o.removed),
  };
}

// Permissive: opencode may return the JSON bare, fenced in ```json, prefixed with
// prose, or even double-encoded (a JSON string whose value is the JSON). Try hard.
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
  // The agent reasons first and emits the verdict as the FINAL fenced block, so
  // try fenced blocks last-first — an example block inside the reasoning must not
  // win over the real answer at the end.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const f of fences.reverse()) candidates.push(f);
  const lazyBraces = text.match(/\{[\s\S]*?\}/); // first complete object (JSON followed by trailing prose)
  if (lazyBraces) candidates.push(lazyBraces[0]);
  const greedyBraces = text.match(/\{[\s\S]*\}/); // outermost span (prose-wrapped object)
  if (greedyBraces) candidates.push(greedyBraces[0]);

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
  const cued = text.match(/(?:classification|verdict|semver|bump)\b[^\n]{0,40}?[`*"']{0,3}(major|minor|patch)\b/i);
  if (cued) return cued[1].toLowerCase();
  const wrapped = [...text.matchAll(/[`*]{1,3}(major|minor|patch)[`*]{1,3}/gi)];
  if (wrapped.length) return wrapped[wrapped.length - 1][1].toLowerCase();
  return null;
}

function parseProse(full: string): Classification | null {
  const text = full.slice(0, 100_000); // bound the scan on untrusted-influenced model output
  const kind = proseBumpKind(text);
  if (!kind) return null;

  const sections: Record<string, string[]> = { added: [], changed: [], fixed: [], removed: [] };
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) continue;
    let body = bullet[1];
    const label = body.match(/^\*{0,2}(added|changed|fixed|removed)\*{0,2}\s*:\s*\*{0,2}\s*/i);
    let section = 'changed';
    if (label) {
      section = label[1].toLowerCase();
      body = body.slice(label[0].length);
    }
    body = body.replace(/^\*+\s*|\s*\*+$/g, '').trim();
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
    throw new Error(`opencode exited ${res.status} (see the "opencode classification — ${name}" group above)`);
  }
  return parseClassification(transcript);
}

function bumpVersion(v: string, kind: Classification['bump']): string {
  const [maj, min, pat] = v.split('.').map((n) => Number.parseInt(n, 10));
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function writeChangelog(name: string, version: string, c: Classification, subjects: string[]): void {
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
      writeFileSync(file, `${body.slice(0, firstEntry + 1)}${entry}\n${body.slice(firstEntry + 1)}`);
    } else {
      writeFileSync(file, `${body.replace(/\s*$/, '')}\n\n${entry}`);
    }
  } else {
    const header = `# Changelog — ${name}\n\nAll notable changes to this plugin are documented in this file.\nFormat follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${header}\n${entry}`);
  }
}

const bumped: { name: string; from: string; to: string; kind: string }[] = [];

for (const p of toBump) {
  try {
    const vpath = versionPath(p.path);
    const manifest = JSON.parse(readFileSync(vpath, 'utf8'));
    const current: string = manifest.version;
    const subjects = git(['log', `${beforeSha}..${afterSha}`, '--format=%s', '--', p.path])
      .split('\n')
      .filter(Boolean);
    let diff = git(['diff', `${beforeSha}..${afterSha}`, '--', p.path]);
    if (diff.length > DIFF_BUDGET) diff = `${diff.slice(0, DIFF_BUDGET)}\n…(diff truncated)`;

    const c = classify(p.name, current, subjects, diff);
    const next = bumpVersion(current, c.bump);
    manifest.version = next;
    writeFileSync(vpath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeChangelog(p.name, next, c, subjects);
    bumped.push({ name: p.name, from: current, to: next, kind: c.bump });
    console.log(`✓ ${p.name}: ${current} → ${next} (${c.bump})`);
  } catch (e) {
    die(`Failed to classify/bump ${p.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Commit on a bump branch and open an auto-merge PR (GITHUB_TOKEN identity).
const short = afterSha.slice(0, 12);
const branch = `bump/${short}`;
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
git(['push', '-u', 'origin', branch]);

try {
  execFileSync('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], {
    stdio: 'inherit',
  });
} catch (e) {
  die(`gh pr create failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
}
try {
  execFileSync('gh', ['pr', 'merge', branch, '--auto', '--squash'], { stdio: 'inherit' });
  console.log('opened auto-merge PR');
} catch {
  console.log('opened PR but could not enable auto-merge (is "Allow auto-merge" on?); leaving it open');
}
