import { describe, expect, it } from 'vitest';
import { reconcile } from '../hooks/reconcile-settings';

const LAUNCHER = '/home/dev/.claude/statusline-pardes.sh';
const HOME = '/home/dev';

// Convenience: run the pure decision with the common fixtures filled in.
function decide(raw: string | null, opts: { force?: boolean; home?: string } = {}) {
  return reconcile({
    force: opts.force ?? false,
    home: opts.home ?? HOME,
    launcher: LAUNCHER,
    raw,
  });
}

describe('reconcile', () => {
  it('installs into an absent settings file', () => {
    const d = decide(null);
    expect(d.action).toBe('write');
    if (d.action !== 'write') throw new Error('expected write');
    expect(d.message).toBe('installed');
    const parsed = JSON.parse(d.settings);
    expect(parsed.statusLine).toEqual({ command: LAUNCHER, type: 'command' });
  });

  it('installs into an empty / whitespace-only settings file', () => {
    const d = decide('   \n  ');
    expect(d.action).toBe('write');
    if (d.action !== 'write') throw new Error('expected write');
    expect(d.message).toBe('installed');
  });

  it('installs when the statusLine slot is missing but sibling keys exist', () => {
    const d = decide(JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }));
    expect(d.action).toBe('write');
    if (d.action !== 'write') throw new Error('expected write');
    const parsed = JSON.parse(d.settings);
    // Sibling keys survive the rewrite untouched.
    expect(parsed.model).toBe('opus');
    expect(parsed.permissions).toEqual({ allow: ['Bash'] });
    expect(parsed.statusLine).toEqual({ command: LAUNCHER, type: 'command' });
  });

  it('is a silent no-op when our launcher already owns the slot (steady state)', () => {
    const raw = JSON.stringify({ statusLine: { command: LAUNCHER, type: 'command' } });
    expect(decide(raw)).toEqual({ action: 'skip' });
  });

  it('recanonicalizes a ~-form of our launcher to the absolute launcher path', () => {
    const raw = JSON.stringify({
      statusLine: { command: '~/.claude/statusline-pardes.sh', type: 'command' },
    });
    const d = decide(raw);
    expect(d.action).toBe('write');
    if (d.action !== 'write') throw new Error('expected write');
    expect(d.message).toBe('refreshed');
    expect(JSON.parse(d.settings).statusLine.command).toBe(LAUNCHER);
  });

  it('preserves a user-set padding when refreshing our own slot', () => {
    const raw = JSON.stringify({
      statusLine: { command: '~/.claude/statusline-pardes.sh', padding: 0, type: 'command' },
    });
    const d = decide(raw);
    expect(d.action).toBe('write');
    if (d.action !== 'write') throw new Error('expected write');
    expect(JSON.parse(d.settings).statusLine).toEqual({
      command: LAUNCHER,
      padding: 0,
      type: 'command',
    });
  });

  describe('never clobbers a foreign command', () => {
    // The #6 regression: a command that merely CONTAINS the launcher token must
    // NOT be treated as ours. Each of these is the user's own status line.
    const foreign = [
      '~/dotfiles/statusline-pardes.sh', // a different path that contains the token
      '/home/dev/.claude/statusline-pardes.sh.bak', // a backup
      'wrapper /home/dev/.claude/statusline-pardes.sh', // a wrapper around ours
      'bun ~/my-own/statusline.ts', // an entirely unrelated status line
    ];

    for (const command of foreign) {
      it(`leaves \`${command}\` untouched on a normal run`, () => {
        const raw = JSON.stringify({ statusLine: { command, type: 'command' } });
        expect(decide(raw)).toEqual({ action: 'skip' });
      });

      it(`reports but does NOT overwrite \`${command}\` on a forced run`, () => {
        const raw = JSON.stringify({ statusLine: { command, type: 'command' } });
        expect(decide(raw, { force: true })).toEqual({ action: 'report', message: 'refused' });
      });
    }
  });

  it('preserves a malformed settings file byte-for-byte (never writes)', () => {
    const malformed = '{ "statusLine": { "command": "x", }, // trailing junk\n not json';
    expect(decide(malformed)).toEqual({ action: 'skip' });
    expect(decide(malformed, { force: true })).toEqual({ action: 'skip' });
  });

  describe('forced runs', () => {
    it('re-reports (without rewriting) when our slot is already correct', () => {
      const raw = JSON.stringify({ statusLine: { command: LAUNCHER, type: 'command' } });
      expect(decide(raw, { force: true })).toEqual({ action: 'report', message: 'refreshed' });
    });

    it('still installs into an empty slot', () => {
      const d = decide(null, { force: true });
      expect(d.action).toBe('write');
    });
  });
});
