import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import { runGitFixture } from '../test-support.ts';
import {
  CHILD_RUNTIME_INPUTS,
  inspectPluginSource,
  makePluginActivationSafety,
} from './activation-safety.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function fixturePluginSource(): string {
  const root = temporaryDirectory('pardes-plugin-source-');
  mkdirSync(join(root, 'worker-runtime'));
  writeFileSync(
    join(root, 'worker-runtime', 'child-extension.ts'),
    'export const childVersion = 1;\n',
  );
  writeFileSync(
    join(root, 'worker-runtime', 'child-profile.ts'),
    'export const profileVersion = 1;\n',
  );
  writeFileSync(
    join(root, 'worker-runtime', 'child-tool-call-preview.ts'),
    'export const previewVersion = 1;\n',
  );
  return root;
}

function fixtureManagerDirectory(): string {
  return temporaryDirectory('pardes-manager-state-');
}

function git(cwd: string, ...args: string[]): string {
  return runGitFixture(cwd, ...args);
}

describe('loaded child-runtime activation safety', () => {
  test('pins the exact preserved-path child-runtime input allowlist', () => {
    expect(CHILD_RUNTIME_INPUTS).toEqual([
      'worker-runtime/child-extension.ts',
      'worker-runtime/child-profile.ts',
      'worker-runtime/child-tool-call-preview.ts',
    ]);
  });

  test('inspects its explicit plugin root despite inherited Git repository redirection', () => {
    const pluginRoot = fixturePluginSource();
    git(pluginRoot, 'init', '-b', 'main');
    git(pluginRoot, 'config', 'user.email', 'pardes@example.test');
    git(pluginRoot, 'config', 'user.name', 'Pardes Test');
    git(pluginRoot, 'add', '.');
    git(pluginRoot, 'commit', '-m', 'fixture');
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(pluginRoot, 'missing.git');
    try {
      expect(inspectPluginSource(pluginRoot)).toMatchObject({ sourceControl: 'clean' });
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  test('materializes preserved-path allowlisted sources and keeps post-pull shared drift advisory while launching from the pinned snapshot', async () => {
    const pluginRoot = fixturePluginSource();
    const managerDirectory = fixtureManagerDirectory();
    const safety = makePluginActivationSafety({ pluginRoot });

    const materialized = await Effect.runPromise(safety.materialize(managerDirectory));
    expect(materialized).toMatchObject({
      lifecycle: 'allowed',
      reason: 'pinned_snapshot_ready',
      snapshot: { inputFileCount: 3, state: 'ready' },
      status: 'aligned',
    });
    const initiallyReady = await Effect.runPromise(safety.requireReady('agent_spawn'));
    expect(initiallyReady.workerExtensionPath).toBe(
      join(
        managerDirectory,
        'runtime',
        'child-extension',
        initiallyReady.identity,
        'worker-runtime',
        'child-extension.ts',
      ),
    );
    expect(readFileSync(initiallyReady.workerExtensionPath, 'utf8')).toBe(
      'export const childVersion = 1;\n',
    );
    expect(
      readFileSync(
        join(
          managerDirectory,
          'runtime',
          'child-extension',
          initiallyReady.identity,
          'worker-runtime',
          'child-profile.ts',
        ),
        'utf8',
      ),
    ).toBe('export const profileVersion = 1;\n');
    expect(
      readFileSync(
        join(
          managerDirectory,
          'runtime',
          'child-extension',
          initiallyReady.identity,
          'worker-runtime',
          'child-tool-call-preview.ts',
        ),
        'utf8',
      ),
    ).toBe('export const previewVersion = 1;\n');

    writeFileSync(
      join(pluginRoot, 'worker-runtime', 'child-extension.ts'),
      'export const childVersion = 2;\n',
    );

    expect(await Effect.runPromise(safety.inspect())).toMatchObject({
      lifecycle: 'allowed',
      reason: 'pinned_snapshot_ready',
      status: 'changed',
    });
    expect(await Effect.runPromise(safety.requireReady('agent_revive'))).toEqual(initiallyReady);
  });

  test('ignores unrelated manager, tool, docs, tests, fixtures, generated, and untracked files outside the explicit runtime allowlist', async () => {
    const pluginRoot = fixturePluginSource();
    const safety = makePluginActivationSafety({ pluginRoot });
    await Effect.runPromise(safety.materialize(fixtureManagerDirectory()));
    mkdirSync(join(pluginRoot, 'manager'));
    mkdirSync(join(pluginRoot, 'tools'));
    mkdirSync(join(pluginRoot, 'docs'));
    mkdirSync(join(pluginRoot, 'fixtures'));
    writeFileSync(
      join(pluginRoot, 'manager', 'controller.ts'),
      'export const managerOnly = true;\n',
    );
    writeFileSync(join(pluginRoot, 'tools', 'status.ts'), 'export const toolOnly = true;\n');
    writeFileSync(join(pluginRoot, 'docs', 'README.md'), 'documentation only\n');
    writeFileSync(join(pluginRoot, 'worker-runtime', 'child-extension.test.ts'), 'test only\n');
    writeFileSync(
      join(pluginRoot, 'fixtures', 'generated.js'),
      'generated but not a child input\n',
    );
    writeFileSync(join(pluginRoot, 'fixtures', 'untracked.json'), '{}\n');

    expect(await Effect.runPromise(safety.requireReady('agent_reload'))).toMatchObject({
      inputFileCount: CHILD_RUNTIME_INPUTS.length,
    });
    expect(safety.snapshot()).toMatchObject({ lifecycle: 'allowed', status: 'aligned' });
  });

  test('reports dirty same-SHA changes boundedly while preserving the pinned snapshot', async () => {
    const pluginRoot = fixturePluginSource();
    git(pluginRoot, 'init', '-b', 'main');
    git(pluginRoot, 'config', 'user.email', 'pardes@example.test');
    git(pluginRoot, 'config', 'user.name', 'Pardes Test');
    git(pluginRoot, 'add', '.');
    git(pluginRoot, 'commit', '-m', 'fixture');
    const safety = makePluginActivationSafety({ pluginRoot });
    await Effect.runPromise(safety.materialize(fixtureManagerDirectory()));
    const loadedHead = git(pluginRoot, 'rev-parse', 'HEAD');

    writeFileSync(
      join(pluginRoot, 'worker-runtime', 'child-tool-call-preview.ts'),
      'export const previewVersion = 2;\n',
    );
    expect(git(pluginRoot, 'rev-parse', 'HEAD')).toBe(loadedHead);

    const changed = await Effect.runPromise(safety.inspect());
    expect(changed).toMatchObject({
      current: { sourceControl: 'dirty' },
      lifecycle: 'allowed',
      loaded: { sourceControl: 'clean' },
      snapshot: { state: 'ready' },
      status: 'changed',
    });
    expect(JSON.stringify(changed)).not.toContain(pluginRoot);
    expect(JSON.stringify(changed)).not.toContain(loadedHead);
  });

  test('hard-blocks launch when capture is unavailable or a materialized snapshot is tampered', async () => {
    const missingInputRoot = fixturePluginSource();
    rmSync(join(missingInputRoot, 'worker-runtime', 'child-tool-call-preview.ts'));
    const unavailable = makePluginActivationSafety({ pluginRoot: missingInputRoot });
    expect(
      await Effect.runPromise(unavailable.materialize(fixtureManagerDirectory())),
    ).toMatchObject({
      lifecycle: 'blocked',
      snapshot: { issue: 'capture_unavailable', state: 'unavailable' },
    });
    expect(
      await Effect.runPromise(unavailable.requireReady('agent_spawn').pipe(Effect.flip)),
    ).toMatchObject({
      _tag: 'PluginActivationBlockedError',
      operation: 'agent_spawn',
      reason: 'capture_unavailable',
    });

    const pluginRoot = fixturePluginSource();
    const safety = makePluginActivationSafety({ pluginRoot });
    const ready = await Effect.runPromise(safety.materialize(fixtureManagerDirectory()));
    if (ready.snapshot.state !== 'ready') throw new Error('Expected ready snapshot fixture');
    const snapshot = await Effect.runPromise(safety.requireReady('agent_spawn'));
    chmodSync(snapshot.workerExtensionPath, 0o644);
    writeFileSync(snapshot.workerExtensionPath, 'tampered snapshot\n');
    expect(
      await Effect.runPromise(safety.requireReady('agent_reload').pipe(Effect.flip)),
    ).toMatchObject({
      _tag: 'PluginActivationBlockedError',
      operation: 'agent_reload',
      reason: 'snapshot_invalid',
    });
  });

  test('retains distinct manager-scoped snapshot identities so loaded manager versions coexist across pulls', async () => {
    const pluginRoot = fixturePluginSource();
    const first = makePluginActivationSafety({ pluginRoot });
    const firstSnapshot = await Effect.runPromise(
      first
        .materialize(fixtureManagerDirectory())
        .pipe(Effect.flatMap(() => first.requireReady('agent_spawn'))),
    );
    writeFileSync(
      join(pluginRoot, 'worker-runtime', 'child-extension.ts'),
      'export const childVersion = 2;\n',
    );
    const second = makePluginActivationSafety({ pluginRoot });
    const secondSnapshot = await Effect.runPromise(
      second
        .materialize(fixtureManagerDirectory())
        .pipe(Effect.flatMap(() => second.requireReady('agent_spawn'))),
    );

    expect(secondSnapshot.identity).not.toBe(firstSnapshot.identity);
    expect(secondSnapshot.workerExtensionPath).not.toBe(firstSnapshot.workerExtensionPath);
    expect(existsSync(firstSnapshot.workerExtensionPath)).toBe(true);
    expect(existsSync(secondSnapshot.workerExtensionPath)).toBe(true);
    expect(await Effect.runPromise(first.requireReady('agent_revive'))).toEqual(firstSnapshot);
    expect(first.snapshot()).toMatchObject({ lifecycle: 'allowed', status: 'changed' });
  });

  test('rejects redirected allowlisted source inputs without leaking paths', async () => {
    const pluginRoot = fixturePluginSource();
    const redirected = join(pluginRoot, 'redirected.ts');
    writeFileSync(redirected, 'redirected source\n');
    rmSync(join(pluginRoot, 'worker-runtime', 'child-tool-call-preview.ts'));
    symlinkSync(redirected, join(pluginRoot, 'worker-runtime', 'child-tool-call-preview.ts'));
    const safety = makePluginActivationSafety({ pluginRoot });

    expect(await Effect.runPromise(safety.materialize(fixtureManagerDirectory()))).toMatchObject({
      lifecycle: 'blocked',
      snapshot: { issue: 'capture_unavailable', state: 'unavailable' },
      status: 'unknown',
    });
    const failure = await Effect.runPromise(safety.requireReady('agent_revive').pipe(Effect.flip));
    expect(failure).toMatchObject({
      _tag: 'PluginActivationBlockedError',
      operation: 'agent_revive',
      reason: 'capture_unavailable',
      status: 'unknown',
    });
    expect(JSON.stringify(failure)).not.toContain(pluginRoot);
    expect(JSON.stringify(failure)).not.toContain(redirected);
  });
});
