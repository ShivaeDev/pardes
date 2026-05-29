import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitInfo {
  branch: string;
  detached: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

const CACHE_TTL_MS = 2000;
const CACHE_DIR = join(tmpdir(), 'claude-statusline');

function cachePath(cwd: string): string {
  const h = createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `git-${h}.json`);
}

function readCache(cwd: string): GitInfo | null {
  try {
    const raw = readFileSync(cachePath(cwd), 'utf8');
    const obj = JSON.parse(raw) as { ts: number; info: GitInfo };
    if (Date.now() - obj.ts < CACHE_TTL_MS) return obj.info;
  } catch {
    // miss
  }
  return null;
}

function writeCache(cwd: string, info: GitInfo): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(cwd), JSON.stringify({ info, ts: Date.now() }));
  } catch {
    // best-effort
  }
}

export function parsePorcelain(porcelain: string): GitInfo {
  const info: GitInfo = {
    ahead: 0,
    behind: 0,
    branch: '',
    detached: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  const lines = porcelain.split('\n');
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      if (head.startsWith('No commits yet on ')) {
        info.branch = head.slice('No commits yet on '.length).trim();
        continue;
      }
      if (head.startsWith('HEAD (no branch)')) {
        info.detached = true;
        info.branch = 'detached';
        continue;
      }
      // "<branch>...<upstream> [ahead 1, behind 2]"
      const beforeDots = head.split('...')[0] ?? head;
      info.branch = beforeDots.split(' ')[0] ?? beforeDots;
      const ab = head.match(/\[(.*)\]/);
      if (ab?.[1]) {
        const a = ab[1].match(/ahead (\d+)/);
        const b = ab[1].match(/behind (\d+)/);
        if (a) info.ahead = Number(a[1]);
        if (b) info.behind = Number(b[1]);
      }
      continue;
    }
    if (line.startsWith('??')) {
      info.untracked += 1;
      continue;
    }
    const x = line[0];
    const y = line[1];
    if (x && x !== ' ' && x !== '?') info.staged += 1;
    if (y && y !== ' ' && y !== '?') info.unstaged += 1;
  }
  return info;
}

/** Read git state for `cwd` (cached briefly). Returns null when not a repo. */
export function gitInfo(cwd: string): GitInfo | null {
  const cached = readCache(cwd);
  if (cached) return cached;

  const res = spawnSync(
    'git',
    [
      '-C',
      cwd,
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--branch',
      '--untracked-files=normal',
    ],
    { encoding: 'utf8', timeout: 1500 },
  );
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;

  const info = parsePorcelain(res.stdout);
  writeCache(cwd, info);
  return info;
}
