import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import { runGitFixture } from '../test-support.ts';
import { runGit } from './transport.ts';

describe('Git command boundary', () => {
  test('captures fixture stderr for replay without printing successful setup chatter', () => {
    expect(() => runGitFixture(tmpdir(), 'pardes-fixture-command-does-not-exist')).toThrow(
      /git: 'pardes-fixture-command-does-not-exist' is not a git command/,
    );
  });

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
});
