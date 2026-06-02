import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import { runGit } from './transport.ts';

describe('Git command boundary', () => {
  test('retains multiline option-looking text as one argv token', async () => {
    const body = 'first line\n--upload-pack=attacker/project\nlast line';

    const result = await Effect.runPromise(
      runGit(tmpdir(), [
        '-c',
        `pardes.argvFixture=${body}`,
        'config',
        '--get',
        'pardes.argvFixture',
      ]),
    );

    expect(result.stdout).toBe(`${body}\n`);
  });

  test('applies opt-in timeout and output circuit breakers', async () => {
    const oversized = await Effect.runPromise(
      runGit(tmpdir(), ['-c', 'alias.emit=!printf 1234567890', 'emit'], { maxBuffer: 4 }).pipe(
        Effect.flip,
      ),
    );
    const timedOut = await Effect.runPromise(
      runGit(tmpdir(), ['-c', 'alias.wait=!sleep 1', 'wait'], { timeoutMs: 10 }).pipe(Effect.flip),
    );

    expect(oversized._tag).toBe('GitCommandError');
    expect(timedOut._tag).toBe('GitCommandError');
  });
});
