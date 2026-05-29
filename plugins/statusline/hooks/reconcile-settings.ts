#!/usr/bin/env bun
// Reconciles the user's main `statusLine` in ~/.claude/settings.json with this
// plugin's stable launcher. Invoked by session-start.sh (and by the
// /statusline-setup command, with STATUSLINE_PARDES_FORCE=1).
//
// Rules:
//   - Empty slot, or a slot we already own (command points at our launcher):
//     (re)install / refresh it.
//   - A slot owned by something else (the user's own custom statusLine): leave
//     it untouched — never clobber. (Unless forced, which still refuses to
//     overwrite a third-party command and reports it.)
//   - Only print the SessionStart hook JSON when we actually changed something,
//     so a steady-state session start is silent.
//
// Everything here is node:fs + JSON — zero runtime deps.

import { readFileSync, writeFileSync } from 'node:fs';

type StatusLine = { type?: string; command?: string; padding?: number } | undefined;
type Settings = { statusLine?: StatusLine; [k: string]: unknown };

const settingsPath = process.argv[2];
const launcher = process.env.STATUSLINE_PARDES_LAUNCHER ?? '';
const force = process.env.STATUSLINE_PARDES_FORCE === '1';

if (!settingsPath || !launcher) {
  // Misconfigured invocation — do nothing, say nothing.
  process.exit(0);
}

const desiredCommand = launcher; // main line: launcher with no extra argument

function readSettings(): Settings {
  try {
    const raw = readFileSync(settingsPath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Settings) : {};
  } catch {
    // Missing file -> fresh settings. Malformed file -> refuse to touch it
    // (signalled by a sentinel the caller distinguishes from {}).
    return {};
  }
}

// Distinguish "missing/empty" (safe to write) from "present but unparseable"
// (must not overwrite — could destroy the user's hand-written settings).
function settingsAreUnparseable(): boolean {
  try {
    const raw = readFileSync(settingsPath, 'utf8').trim();
    if (!raw) return false;
    JSON.parse(raw);
    return false;
  } catch (e) {
    // ENOENT -> not unparseable, just absent.
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === 'ENOENT') {
      return false;
    }
    return true;
  }
}

// Does a command string belong to this plugin's launcher? Matches the stable
// launcher path (current or a "~"-relative form), so we recognise our own
// wiring even after the plugin root rotated on an update.
function isOurs(command: string | undefined): boolean {
  if (!command) return false;
  const home = process.env.HOME ?? '';
  const tildeForm = home && command.startsWith('~/') ? command.replace(/^~/, home) : command;
  const tildeLauncher =
    home && launcher.startsWith(`${home}/`) ? `~${launcher.slice(home.length)}` : launcher;
  return (
    command === launcher ||
    command === desiredCommand ||
    tildeForm === launcher ||
    command === tildeLauncher ||
    command.includes('statusline-pardes.sh')
  );
}

function emit(systemMessage: string, additionalContext: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        additionalContext,
        hookEventName: 'SessionStart',
      },
      systemMessage,
    })}\n`,
  );
}

if (settingsAreUnparseable()) {
  // Don't risk corrupting a file we can't parse. Stay silent; /statusline-setup
  // can report this explicitly if the user runs it.
  process.exit(0);
}

const settings = readSettings();
const current = settings.statusLine;
const currentCommand = current?.command;

const slotEmpty = !current || !currentCommand;
const ours = isOurs(currentCommand);

if (!slotEmpty && !ours && !force) {
  // The user has their own custom status line. Never touch it.
  process.exit(0);
}

if (!slotEmpty && !ours && force) {
  // Forced setup, but a third-party command sits in the slot. Refuse to
  // overwrite; report so the user can decide.
  emit(
    `statusline: your settings.json already has a custom statusLine (\`${currentCommand}\`). Leaving it untouched. Remove that statusLine entry first, then re-run /statusline-setup to switch to statusline@pardes.`,
    'statusline@pardes did NOT change the main status line: a custom statusLine is already configured.',
  );
  process.exit(0);
}

const alreadyCorrect = ours && currentCommand === desiredCommand && current?.type === 'command';
if (alreadyCorrect && !force) {
  // Steady state — nothing to do, nothing to say.
  process.exit(0);
}

const wasOurs = ours && !slotEmpty;
settings.statusLine = {
  command: desiredCommand,
  type: 'command',
  ...(current?.padding != null ? { padding: current.padding } : {}),
};

try {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
} catch {
  process.exit(0);
}

if (wasOurs) {
  emit(
    `statusline: refreshed the main status line wiring for statusline@pardes.`,
    `statusline@pardes is active: the main + subagent status lines render via ${launcher}.`,
  );
} else {
  emit(
    `statusline: wired your main status line to statusline@pardes (via ${launcher}). Revert any time by removing the "statusLine" key from ${settingsPath}.`,
    `statusline@pardes is now active: the main + subagent status lines render via ${launcher}.`,
  );
}
