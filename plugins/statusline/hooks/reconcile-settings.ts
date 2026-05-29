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
//   - A present-but-unparseable settings file is preserved byte-for-byte;
//     we never risk corrupting hand-written JSON we can't parse.
//   - Only print the SessionStart hook JSON when we actually changed something,
//     so a steady-state session start is silent.
//
// The pure decision (`reconcile`) is exported and unit-tested in
// test/reconcile.test.ts; the script body below only wires it to fs + stdout.
// Everything here is node:fs + JSON — zero runtime deps.

import { readFileSync, writeFileSync } from 'node:fs';

type StatusLine = { type?: string; command?: string; padding?: number } | undefined;
type Settings = { statusLine?: StatusLine; [k: string]: unknown };

export interface ReconcileInput {
  // Raw settings.json contents. `null` means the file is absent (a fresh
  // install — safe to write); `''`/whitespace is treated as an empty file.
  raw: string | null;
  // The stable launcher path settings.json should point at.
  launcher: string;
  // /statusline-setup forces a report even in the steady state, and reports
  // (without overwriting) when a foreign command holds the slot.
  force: boolean;
  // $HOME, for `~`-expansion when matching our own launcher. Optional/injectable
  // so the decision stays pure and testable.
  home?: string;
}

type MessageKind = 'installed' | 'refreshed' | 'refused';

export type ReconcileDecision =
  // Leave the file exactly as-is and emit nothing.
  | { action: 'skip' }
  // Leave the file as-is but emit a status message (forced steady-state, or a
  // forced run that found a foreign command and refuses to clobber it).
  | { action: 'report'; message: MessageKind }
  // Overwrite the file with `settings` and emit the matching message.
  | { action: 'write'; settings: string; message: MessageKind };

function parseSettings(raw: string | null): { settings: Settings; unparseable: boolean } {
  if (raw === null) return { settings: {}, unparseable: false };
  const trimmed = raw.trim();
  if (!trimmed) return { settings: {}, unparseable: false };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return {
      settings: parsed && typeof parsed === 'object' ? (parsed as Settings) : {},
      unparseable: false,
    };
  } catch {
    return { settings: {}, unparseable: true };
  }
}

// Does a command string belong to this plugin's launcher? Matches the stable
// launcher path (current or a "~"-relative form), so we recognise our own
// wiring even after the plugin root rotated on an update. Matching is by
// anchored equality only — a bare substring match would let any command merely
// CONTAINING the launcher path (a dotfiles wrapper, a `.bak`) be mistaken for
// ours and clobbered.
function isOurs(command: string | undefined, launcher: string, home: string): boolean {
  if (!command) return false;
  const tildeForm = home && command.startsWith('~/') ? command.replace(/^~/, home) : command;
  const tildeLauncher =
    home && launcher.startsWith(`${home}/`) ? `~${launcher.slice(home.length)}` : launcher;
  return command === launcher || tildeForm === launcher || command === tildeLauncher;
}

/**
 * Pure reconcile decision: given the current raw settings, the launcher, and
 * whether this is a forced run, decide what to do — without reading any process
 * or filesystem state. The caller performs the side effects (write + emit).
 */
export function reconcile(input: ReconcileInput): ReconcileDecision {
  const { raw, launcher, force, home = '' } = input;
  const desiredCommand = launcher; // main line: launcher with no extra argument

  const { settings, unparseable } = parseSettings(raw);
  if (unparseable) {
    // Don't risk corrupting a file we can't parse. Stay silent; /statusline-setup
    // surfaces this to the user when run, but we never overwrite.
    return { action: 'skip' };
  }

  const current = settings.statusLine;
  const currentCommand = current?.command;
  const slotEmpty = !current || !currentCommand;
  const ours = isOurs(currentCommand, launcher, home);

  if (!slotEmpty && !ours) {
    // The user has their own custom status line. Never touch it. When forced,
    // report that we declined; otherwise stay silent.
    return force ? { action: 'report', message: 'refused' } : { action: 'skip' };
  }

  const alreadyCorrect = ours && currentCommand === desiredCommand && current?.type === 'command';
  if (alreadyCorrect && !force) {
    // Steady state — nothing to do, nothing to say.
    return { action: 'skip' };
  }

  const wasOurs = ours && !slotEmpty;
  const next: Settings = {
    ...settings,
    statusLine: {
      command: desiredCommand,
      type: 'command',
      ...(current?.padding != null ? { padding: current.padding } : {}),
    },
  };

  if (alreadyCorrect) {
    // Forced run on an already-correct slot: re-report status, no real change.
    return { action: 'report', message: 'refreshed' };
  }

  return {
    action: 'write',
    message: wasOurs ? 'refreshed' : 'installed',
    settings: `${JSON.stringify(next, null, 2)}\n`,
  };
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

function emitMessage(
  message: MessageKind,
  launcher: string,
  settingsPath: string,
  currentCommand: string | undefined,
): void {
  if (message === 'refused') {
    emit(
      `statusline: your settings.json already has a custom statusLine (\`${currentCommand}\`). Leaving it untouched. Remove that statusLine entry first, then re-run /statusline-setup to switch to statusline@pardes.`,
      'statusline@pardes did NOT change the main status line: a custom statusLine is already configured.',
    );
    return;
  }
  if (message === 'refreshed') {
    emit(
      `statusline: refreshed the main status line wiring for statusline@pardes.`,
      `statusline@pardes is active: the main + subagent status lines render via ${launcher}.`,
    );
    return;
  }
  emit(
    `statusline: wired your main status line to statusline@pardes (via ${launcher}). Revert any time by removing the "statusLine" key from ${settingsPath}.`,
    `statusline@pardes is now active: the main + subagent status lines render via ${launcher}.`,
  );
}

function run(): void {
  const settingsPath = process.argv[2];
  const launcher = process.env.STATUSLINE_PARDES_LAUNCHER ?? '';
  const force = process.env.STATUSLINE_PARDES_FORCE === '1';

  if (!settingsPath || !launcher) {
    // Misconfigured invocation — do nothing, say nothing.
    return;
  }

  let raw: string | null;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === 'ENOENT') {
      raw = null; // absent file -> fresh settings, safe to write
    } else {
      return; // unreadable for some other reason -> leave it be
    }
  }

  const { settings } = parseSettings(raw);
  const currentCommand = settings.statusLine?.command;
  const decision = reconcile({ force, home: process.env.HOME ?? '', launcher, raw });

  if (decision.action === 'write') {
    try {
      writeFileSync(settingsPath, decision.settings);
    } catch {
      return;
    }
    emitMessage(decision.message, launcher, settingsPath, currentCommand);
    return;
  }

  if (decision.action === 'report') {
    emitMessage(decision.message, launcher, settingsPath, currentCommand);
  }
}

if (import.meta.main) {
  run();
}
