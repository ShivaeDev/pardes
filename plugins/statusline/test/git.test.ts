import { describe, expect, it } from 'vitest';
import { parsePorcelain } from '../src/lib/git';

describe('parsePorcelain', () => {
  it('parses branch, ahead/behind, and file states', () => {
    const out = [
      '## main...origin/main [ahead 1, behind 2]',
      ' M src/a.ts',
      '?? new.txt',
      'A  staged.ts',
      '',
    ].join('\n');
    const g = parsePorcelain(out);
    expect(g.branch).toBe('main');
    expect(g.ahead).toBe(1);
    expect(g.behind).toBe(2);
    expect(g.unstaged).toBe(1);
    expect(g.untracked).toBe(1);
    expect(g.staged).toBe(1);
  });

  it('reports a clean tree', () => {
    const g = parsePorcelain('## main...origin/main\n');
    expect(g.branch).toBe('main');
    expect(g.ahead).toBe(0);
    expect(g.behind).toBe(0);
    expect(g.staged + g.unstaged + g.untracked).toBe(0);
  });

  it('handles a fresh repo with no commits', () => {
    expect(parsePorcelain('## No commits yet on trunk\n').branch).toBe('trunk');
  });

  it('handles a detached HEAD', () => {
    const g = parsePorcelain('## HEAD (no branch)\n');
    expect(g.detached).toBe(true);
  });

  it('counts a fully-staged-and-modified file in both buckets', () => {
    // "MM" = staged change plus a further unstaged change to the same file.
    const g = parsePorcelain('## main\nMM both.ts\n');
    expect(g.staged).toBe(1);
    expect(g.unstaged).toBe(1);
  });
});
