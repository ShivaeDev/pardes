#!/usr/bin/env bun
// Config doctor for the pardes marketplace.
//
// Reads a Claude Code settings.json, compares it against a manifest of
// RECOMMENDED (never required) settings tuned for this marketplace's
// orchestration-heavy workflow style, and prints a clear report:
//   - set     : the recommended key already holds the recommended value
//   - differs : the key is present but holds a different value (we never touch it)
//   - missing : the key is absent (an --apply run would add it)
//
// Two modes:
//   default        advisory report only — reads, never writes.
//   --apply        merge ONLY the missing recommended keys into settings.json,
//                  after writing a timestamped backup. Never overwrites a key
//                  that already exists (so "differs" entries are left alone),
//                  and never touches unrelated keys.
//
// The settings path defaults to ~/.claude/settings.json but can be overridden
// with --settings <path> or the DOCTOR_SETTINGS_PATH env var, so the doctor can
// be pointed at a sample/temp file for testing without touching the real one.
//
// Zero runtime dependencies: node:* and Bun built-ins only.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Settings = { [k: string]: Json };

// A single recommended setting, addressed by a dotted path into settings.json.
type Recommendation = {
  path: string; // e.g. "env.ENABLE_TOOL_SEARCH" or "model"
  value: Json; // the generic recommended value (never a personal one)
  why: string; // one line: why this helps
};

// --- RECOMMENDED-SETTINGS MANIFEST -----------------------------------------
// Generic power-user defaults for this marketplace's orchestration workflow.
// These are RECOMMENDED, never required. Values here are intentionally generic;
// they ship no personal data.
const RECOMMENDATIONS: Recommendation[] = [
  {
    path: 'env.ENABLE_TOOL_SEARCH',
    value: '1',
    why: 'Defers rarely-used tool schemas so they load on demand — keeps context lean for long orchestrations.',
  },
  {
    path: 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    value: '400000',
    why: 'Triggers auto-compaction before the full window fills, so long sessions stay responsive instead of hard-stopping.',
  },
  {
    path: 'model',
    value: 'opus[1m]',
    why: 'The strongest model with the 1M-token context window — best for deep reasoning and long-running orchestration.',
  },
  {
    path: 'permissions.defaultMode',
    value: 'auto',
    why: 'Lets routine actions proceed without a prompt for every step, so autonomous workflows keep momentum.',
  },
  {
    path: 'effortLevel',
    value: 'high',
    why: 'Spends more reasoning effort per turn — better plans and fewer wrong turns on hard tasks.',
  },
  {
    path: 'showThinkingSummaries',
    value: true,
    why: 'Surfaces a short summary of the reasoning so you can follow what the agent is doing.',
  },
  {
    path: 'autoUpdatesChannel',
    value: 'latest',
    why: 'Stays on the latest Claude Code release channel, so fixes and new capabilities arrive as soon as they ship.',
  },
  {
    path: 'tui',
    value: 'fullscreen',
    why: 'Uses the full-screen terminal UI — more room for the conversation, status line, and agent view during long sessions.',
  },
  {
    path: 'skipAutoPermissionPrompt',
    value: true,
    why: 'Skips the startup auto-permission prompt so auto-mode / autonomous workflows begin without an extra confirmation (pairs with permissions.defaultMode = auto).',
  },
];

// Advisory-only notes for intents whose exact setting key is not stable enough
// to recommend a concrete value for. We describe the intent rather than invent
// a possibly-wrong key. (If you know the precise key, set it by hand.)
const ADVISORY_NOTES: string[] = [
  'Enable workflows/skills by default — if your build exposes a toggle for running marketplace workflows without an explicit opt-in each time, turn it on. (No stable settings key to recommend a value for here.)',
  'Enable the agent / subagent view so you can watch dispatched sub-agents while orchestrating. (No stable settings key to recommend a value for here.)',
];
// ---------------------------------------------------------------------------

type Status = 'set' | 'differs' | 'missing';
type Finding = { rec: Recommendation; status: Status; current?: Json };

function resolveSettingsPath(argv: string[]): string {
  const flagIdx = argv.indexOf('--settings');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1] as string;
  const env = process.env.DOCTOR_SETTINGS_PATH;
  if (env) return env;
  return join(homedir(), '.claude', 'settings.json');
}

function readSettings(path: string): {
  settings: Settings;
  existed: boolean;
  unparseable: boolean;
} {
  if (!existsSync(path)) return { existed: false, settings: {}, unparseable: false };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return { existed: true, settings: {}, unparseable: true };
  }
  if (!raw) return { existed: true, settings: {}, unparseable: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { existed: true, settings: parsed as Settings, unparseable: false };
    }
    return { existed: true, settings: {}, unparseable: true };
  } catch {
    return { existed: true, settings: {}, unparseable: true };
  }
}

// Read the value at a dotted path. Returns `undefined` if any segment is
// missing or a non-object is encountered along the way.
function getAtPath(obj: Settings, path: string): Json | undefined {
  const parts = path.split('.');
  let cur: Json | undefined = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as { [k: string]: Json })[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}

// Set the value at a dotted path, creating intermediate objects as needed.
// Refuses to descend through a non-object segment (returns false), so it can
// never clobber an unrelated scalar/array that happens to sit on the path.
function setAtPath(obj: Settings, path: string, value: Json): boolean {
  const parts = path.split('.');
  let cur: { [k: string]: Json } = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    const next = cur[part];
    if (next === undefined) {
      const created: { [k: string]: Json } = {};
      cur[part] = created;
      cur = created;
    } else if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      cur = next as { [k: string]: Json };
    } else {
      return false; // a non-object sits where we'd need to descend — bail out
    }
  }
  cur[parts[parts.length - 1] as string] = value;
  return true;
}

function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function evaluate(settings: Settings): Finding[] {
  return RECOMMENDATIONS.map((rec) => {
    const current = getAtPath(settings, rec.path);
    if (current === undefined) return { rec, status: 'missing' as const };
    if (deepEqual(current, rec.value)) return { current, rec, status: 'set' as const };
    return { current, rec, status: 'differs' as const };
  });
}

const GLYPH: Record<Status, string> = { differs: '≠', missing: '✗', set: '✓' };

function fmt(v: Json | undefined): string {
  return JSON.stringify(v);
}

function printReport(findings: Finding[], settingsPath: string, existed: boolean): void {
  console.log('pardes config doctor');
  console.log(`settings file: ${settingsPath}${existed ? '' : ' (does not exist yet)'}`);
  console.log('');
  console.log('Recommended settings (advisory — none are required):');
  console.log('');
  for (const f of findings) {
    const { rec, status, current } = f;
    console.log(`  ${GLYPH[status]} ${rec.path}`);
    if (status === 'set') {
      console.log(`      already set to ${fmt(rec.value)}`);
    } else if (status === 'missing') {
      console.log(`      not set — recommended: ${fmt(rec.value)}`);
      console.log(`      why: ${rec.why}`);
    } else {
      console.log(`      yours: ${fmt(current)}  |  recommended: ${fmt(rec.value)}`);
      console.log(`      why: ${rec.why}`);
      console.log('      (left unchanged — the doctor never overwrites a value you already chose)');
    }
    console.log('');
  }

  if (ADVISORY_NOTES.length > 0) {
    console.log('Also worth enabling (no stable settings key to apply automatically):');
    for (const note of ADVISORY_NOTES) console.log(`  • ${note}`);
    console.log('');
  }
}

function backupPath(settingsPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${settingsPath}.bak-${stamp}`;
}

function apply(settingsPath: string, settings: Settings, findings: Finding[]): void {
  const toAdd = findings.filter((f) => f.status === 'missing');
  if (toAdd.length === 0) {
    console.log('Nothing to apply — every recommended key is already present.');
    console.log('(Keys that differ from the recommendation are left as you set them.)');
    return;
  }

  // Back up the existing file first (only if it has content to lose).
  if (existsSync(settingsPath)) {
    try {
      const original = readFileSync(settingsPath, 'utf8');
      const bak = backupPath(settingsPath);
      writeFileSync(bak, original);
      console.log(`Backup written: ${bak}`);
    } catch (e) {
      console.error(`Refusing to apply: could not back up ${settingsPath} (${String(e)}).`);
      process.exit(1);
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const f of toAdd) {
    const ok = setAtPath(settings, f.rec.path, f.rec.value);
    if (ok) applied.push(`${f.rec.path} = ${fmt(f.rec.value)}`);
    else skipped.push(f.rec.path);
  }

  // Write atomically: stage to a sibling .tmp, then rename over the target so a
  // crash mid-write can't leave a truncated settings.json. (A timestamped backup
  // was already written above.)
  try {
    const tmp = `${settingsPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, settingsPath);
  } catch (e) {
    console.error(`Failed to write ${settingsPath}: ${String(e)}`);
    process.exit(1);
  }

  console.log('');
  console.log(`Applied ${applied.length} missing recommended setting(s) to ${settingsPath}:`);
  for (const line of applied) console.log(`  + ${line}`);
  if (skipped.length > 0) {
    console.log('');
    console.log('Skipped (a non-object value already occupies part of the path):');
    for (const p of skipped) console.log(`  · ${p}`);
  }
  console.log('');
  console.log('Unrelated keys and any values you had already set were left untouched.');
}

function main(): void {
  const argv = process.argv.slice(2);
  const doApply = argv.includes('--apply');
  const settingsPath = resolveSettingsPath(argv);
  const { settings, existed, unparseable } = readSettings(settingsPath);

  if (unparseable) {
    console.error(`Refusing to proceed: ${settingsPath} exists but is not valid JSON.`);
    console.error('Fix or remove it, then re-run the doctor.');
    process.exit(1);
  }

  const findings = evaluate(settings);
  printReport(findings, settingsPath, existed);

  if (doApply) {
    apply(settingsPath, settings, findings);
  } else {
    const missing = findings.filter((f) => f.status === 'missing').length;
    if (missing > 0) {
      console.log(
        `${missing} recommended setting(s) are not set. This was an advisory report — nothing was changed.`,
      );
      console.log('To apply ONLY the missing ones (with a backup first), re-run with --apply.');
    } else {
      console.log('All recommended settings are present. Nothing to apply.');
    }
  }
}

main();
