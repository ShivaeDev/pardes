#!/usr/bin/env bun
/**
 * version-bump engine. Runs in CI from `push: main` (trusted, post-merge).
 *
 * Flow: figure out which plugin(s) the pushed range touched -> ask opencode to
 * classify the semver bump + draft changelog bullets (READ-ONLY, JSON out) ->
 * apply the version bump + changelog edits HERE -> open an auto-merge PR.
 *
 * SECURITY
 * - Every external command uses execFileSync (NO shell). Commit messages/diffs
 *   (semi-untrusted, authored in PRs) are passed as argv data — never built into
 *   a shell string — so there is no command-injection surface.
 * - opencode runs as the `bump` agent with tools disabled: it only reads the text
 *   we hand it and returns JSON. This script performs every file write, so the
 *   model can't touch the repo or exfiltrate anything.
 * - PR is opened + auto-merged with GITHUB_TOKEN -> no recursion, no bypass actor.
 */

import { execFileSync } from 'node:child_process';
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

// First push / new branch: no usable "before" — analyze just the after commit.
if (!beforeSha || beforeSha === ZERO) beforeSha = `${afterSha}~1`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
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

if (touched.length === 0) {
  console.log('no plugin code touched; nothing to bump');
  process.exit(0);
}
console.log(`touched plugins: ${touched.map((p) => p.name).join(', ')}`);

type Classification = {
  bump: 'patch' | 'minor' | 'major';
  added?: string[];
  changed?: string[];
  fixed?: string[];
  removed?: string[];
};

function classify(name: string, version: string, subjects: string[], diff: string): Classification {
  const prompt = [
    `Plugin: ${name}`,
    `Current version: ${version}`,
    `Commit subjects since last release:`,
    ...subjects.map((s) => `- ${s}`),
    ``,
    `Unified diff (may be truncated):`,
    '```diff',
    diff,
    '```',
  ].join('\n');

  // No shell: prompt (which embeds untrusted diff/commit text) is a single argv.
  const out = execFileSync('opencode', ['run', '--agent', 'bump', '-m', model, '--print-logs', prompt], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'], // logs -> stderr, JSON answer -> stdout
  });

  const match = out.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`opencode returned no JSON for ${name}:\n${out}`);
  return JSON.parse(match[0]) as Classification;
}

function bumpVersion(v: string, kind: Classification['bump']): string {
  const [maj, min, pat] = v.split('.').map((n) => Number.parseInt(n, 10));
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function writeChangelog(name: string, version: string, c: Classification): void {
  const file = join('changelog', `${name}.md`);
  const date = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];
  for (const key of ['added', 'changed', 'fixed', 'removed'] as const) {
    const items = c[key];
    if (items?.length) {
      sections.push(`### ${key[0].toUpperCase()}${key.slice(1)}`, ...items.map((i) => `- ${i}`));
    }
  }
  if (sections.length === 0) sections.push('### Changed', '- Maintenance.');
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

for (const p of touched) {
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
  writeChangelog(p.name, next, c);
  bumped.push({ name: p.name, from: current, to: next, kind: c.bump });
  console.log(`${p.name}: ${current} -> ${next} (${c.bump})`);
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

execFileSync('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], {
  stdio: 'inherit',
});
try {
  execFileSync('gh', ['pr', 'merge', branch, '--auto', '--squash'], { stdio: 'inherit' });
  console.log('opened auto-merge PR');
} catch {
  console.log('opened PR but could not enable auto-merge (is "Allow auto-merge" on?); leaving it open');
}
