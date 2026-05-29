#!/usr/bin/env bun
// Entry point. Two modes, selected by the first argument:
//   statusline            -> main session status line (multi-line)
//   statusline subagent   -> agent-panel row overrides (one JSON line per row)
//
// Reads the Claude Code JSON payload on stdin. Must never crash to a blank line:
// any failure falls back to a minimal status so the bar never disappears.

import { fg } from './lib/ansi';
import { renderMain } from './render/main';
import { renderSubagent } from './render/subagent';
import type { StatusInput, SubagentInput } from './types';

async function readStdin(): Promise<string> {
  try {
    return await Bun.stdin.text();
  } catch {
    return '';
  }
}

function fallbackMain(raw: string): string {
  // Best-effort minimal line if rendering blew up: model + cwd.
  try {
    const s = JSON.parse(raw) as StatusInput;
    const model = s.model?.display_name ?? s.model?.id ?? 'claude';
    const dir = s.workspace?.current_dir ?? s.cwd ?? '';
    return `${fg(213, model)} ${fg(245, dir)}`;
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'main';
  const raw = await readStdin();

  // Any unrecognized first argument (e.g. a stale invocation form): exit cleanly
  // so nothing breaks if an old reference lingers somewhere.
  if (mode !== 'main' && mode !== 'subagent') {
    return;
  }

  if (mode === 'subagent') {
    try {
      const input = (raw ? JSON.parse(raw) : {}) as SubagentInput;
      const out = renderSubagent(input);
      if (out) process.stdout.write(`${out}\n`);
    } catch {
      // Emit nothing -> Claude Code keeps its default agent rows.
    }
    return;
  }

  try {
    const input = (raw ? JSON.parse(raw) : {}) as StatusInput;
    process.stdout.write(`${renderMain(input)}\n`);
  } catch {
    const fb = fallbackMain(raw);
    if (fb) process.stdout.write(`${fb}\n`);
  }
}

await main();
