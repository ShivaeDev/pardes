import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { PluginActivationBlockedError } from './errors.ts';

const DEFAULT_PLUGIN_SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHILD_EXTENSION_INPUT = 'worker-runtime/child-extension.ts';
export const CHILD_RUNTIME_INPUTS = [
  CHILD_EXTENSION_INPUT,
  'worker-runtime/child-profile.ts',
  'worker-runtime/child-tool-call-preview.ts',
] as const;

export type PluginTreeIdentityIssue =
  | 'io_unavailable'
  | 'redirected_input'
  | 'unusual_input'
  | 'invalid_input';
export type PluginRuntimeSnapshotIssue =
  | 'not_materialized'
  | 'capture_unavailable'
  | 'materialization_unavailable'
  | 'snapshot_invalid';
export type PluginSourceControlStatus = 'clean' | 'dirty' | 'non_git' | 'unknown';
export type PluginActivationAlignment = 'aligned' | 'changed' | 'unknown';
export type PluginActivationGuardOperation = 'agent_spawn' | 'agent_revive' | 'agent_reload';

export type PluginTreeIdentity =
  | { readonly kind: 'known'; readonly fingerprint: string; readonly sourceFileCount: number }
  | { readonly kind: 'unknown'; readonly issue: PluginTreeIdentityIssue };

export interface PluginSourceObservation {
  readonly tree: PluginTreeIdentity;
  readonly sourceControl: PluginSourceControlStatus;
}

export type PluginRuntimeSnapshotProjection =
  | { readonly state: 'ready'; readonly identity: string; readonly inputFileCount: number }
  | { readonly state: 'unavailable'; readonly issue: PluginRuntimeSnapshotIssue };

export interface PluginActivationStatus {
  /** Shared allowlisted source comparison only. A changed or unknown value is advisory while the pinned snapshot is ready. */
  readonly status: PluginActivationAlignment;
  readonly lifecycle: 'allowed' | 'blocked';
  readonly reason: 'pinned_snapshot_ready' | 'pinned_snapshot_unavailable';
  readonly loaded: PluginSourceObservation;
  readonly current: PluginSourceObservation;
  readonly snapshot: PluginRuntimeSnapshotProjection;
}

export interface ReadyPluginRuntimeSnapshot {
  readonly identity: string;
  readonly inputFileCount: number;
  readonly workerExtensionPath: string;
}

export interface PluginActivationSafetyShape {
  readonly snapshot: () => PluginActivationStatus;
  readonly inspect: () => Effect.Effect<PluginActivationStatus>;
  readonly materialize: (managerDirectory: string) => Effect.Effect<PluginActivationStatus>;
  readonly requireReady: (
    operation: PluginActivationGuardOperation,
  ) => Effect.Effect<ReadyPluginRuntimeSnapshot, PluginActivationBlockedError>;
}

interface CapturedPluginRuntimeInput {
  readonly relativePath: string;
  readonly contents: Buffer;
}

type CapturedPluginRuntime =
  | {
      readonly kind: 'known';
      readonly identity: string;
      readonly inputs: ReadonlyArray<CapturedPluginRuntimeInput>;
    }
  | { readonly kind: 'unknown'; readonly issue: PluginTreeIdentityIssue };

interface MaterializedPluginRuntime extends ReadyPluginRuntimeSnapshot {
  readonly managerDirectory: string;
  readonly root: string;
  readonly inputs: ReadonlyArray<CapturedPluginRuntimeInput>;
}

function isSafeRelativeInput(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

function unknownTree(issue: PluginTreeIdentityIssue): PluginTreeIdentity {
  return { issue, kind: 'unknown' };
}

function sourceControlStatus(pluginRoot: string): PluginSourceControlStatus {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    return typeof error === 'object' && error !== null && 'status' in error ? 'non_git' : 'unknown';
  }
  try {
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'],
      {
        cwd: pluginRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return status.trim() === '' ? 'clean' : 'dirty';
  } catch {
    return 'unknown';
  }
}

function capturePluginRuntime(
  pluginRoot: string,
  runtimeInputs: ReadonlyArray<string>,
): CapturedPluginRuntime {
  try {
    const rootStats = lstatSync(pluginRoot);
    if (rootStats.isSymbolicLink()) return { issue: 'redirected_input', kind: 'unknown' };
    if (!rootStats.isDirectory()) return { issue: 'unusual_input', kind: 'unknown' };
    const physicalRoot = realpathSync(pluginRoot);
    const inputs: CapturedPluginRuntimeInput[] = [];
    const hash = createHash('sha256');
    for (const relativePath of runtimeInputs) {
      if (!isSafeRelativeInput(relativePath)) return { issue: 'invalid_input', kind: 'unknown' };
      const absolute = join(pluginRoot, relativePath);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) return { issue: 'redirected_input', kind: 'unknown' };
      if (!stats.isFile()) return { issue: 'unusual_input', kind: 'unknown' };
      if (realpathSync(absolute) !== join(physicalRoot, relativePath))
        return { issue: 'redirected_input', kind: 'unknown' };
      const contents = readFileSync(absolute);
      hash.update(`${Buffer.byteLength(relativePath)}:${relativePath}\0${contents.byteLength}:`);
      hash.update(contents);
      hash.update('\0');
      inputs.push({ contents, relativePath });
    }
    return { identity: hash.digest('hex'), inputs, kind: 'known' };
  } catch {
    return { issue: 'io_unavailable', kind: 'unknown' };
  }
}

function capturedSourceObservation(
  captured: CapturedPluginRuntime,
  sourceControl: PluginSourceControlStatus,
): PluginSourceObservation {
  return {
    sourceControl,
    tree:
      captured.kind === 'known'
        ? { fingerprint: captured.identity, kind: 'known', sourceFileCount: captured.inputs.length }
        : unknownTree(captured.issue),
  };
}

function sourceObservation(
  pluginRoot: string,
  runtimeInputs: ReadonlyArray<string>,
): PluginSourceObservation {
  return capturedSourceObservation(
    capturePluginRuntime(pluginRoot, runtimeInputs),
    sourceControlStatus(pluginRoot),
  );
}

/** Observe only the explicit child-runtime source inputs without exposing filesystem locations. */
export function inspectPluginSource(
  pluginRoot: string,
  runtimeInputs: ReadonlyArray<string> = CHILD_RUNTIME_INPUTS,
): PluginSourceObservation {
  return sourceObservation(pluginRoot, runtimeInputs);
}

export function pluginActivationStatus(
  loaded: PluginSourceObservation,
  current: PluginSourceObservation,
  snapshot: PluginRuntimeSnapshotProjection,
): PluginActivationStatus {
  const status: PluginActivationAlignment =
    loaded.tree.kind !== 'known' || current.tree.kind !== 'known'
      ? 'unknown'
      : loaded.tree.fingerprint === current.tree.fingerprint
        ? 'aligned'
        : 'changed';
  return {
    current,
    lifecycle: snapshot.state === 'ready' ? 'allowed' : 'blocked',
    loaded,
    reason: snapshot.state === 'ready' ? 'pinned_snapshot_ready' : 'pinned_snapshot_unavailable',
    snapshot,
    status,
  };
}

async function validateDirectDirectory(managerDirectory: string, directory: string): Promise<void> {
  const managerStats = await lstat(managerDirectory);
  if (!managerStats.isDirectory() || managerStats.isSymbolicLink())
    throw new Error('manager snapshot namespace is redirected');
  const managerPhysical = await realpath(managerDirectory);
  const relativeDirectory = relative(managerDirectory, directory);
  if (!isSafeRelativeInput(relativeDirectory))
    throw new Error('snapshot directory is outside its manager namespace');
  let candidate = managerDirectory;
  for (const segment of relativeDirectory.split(sep)) {
    candidate = join(candidate, segment);
    const stats = await lstat(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error('snapshot directory is redirected');
  }
  if ((await realpath(directory)) !== join(managerPhysical, relativeDirectory))
    throw new Error('snapshot directory is redirected');
}

async function ensureDirectDirectory(managerDirectory: string, directory: string): Promise<void> {
  const relativeDirectory = relative(managerDirectory, directory);
  if (!isSafeRelativeInput(relativeDirectory))
    throw new Error('snapshot directory is outside its manager namespace');
  let candidate = managerDirectory;
  for (const segment of relativeDirectory.split(sep)) {
    candidate = join(candidate, segment);
    try {
      await mkdir(candidate);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
    }
    await validateDirectDirectory(managerDirectory, candidate);
  }
}

async function snapshotIsValid(snapshot: MaterializedPluginRuntime): Promise<boolean> {
  try {
    await validateDirectDirectory(snapshot.managerDirectory, snapshot.root);
    const physicalRoot = await realpath(snapshot.root);
    for (const input of snapshot.inputs) {
      const target = join(snapshot.root, input.relativePath);
      const stats = await lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink()) return false;
      if ((await realpath(target)) !== join(physicalRoot, input.relativePath)) return false;
      if (!Buffer.from(await readFile(target)).equals(input.contents)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function writeSnapshotFile(
  snapshot: MaterializedPluginRuntime,
  input: CapturedPluginRuntimeInput,
): Promise<void> {
  const target = join(snapshot.root, input.relativePath);
  await ensureDirectDirectory(snapshot.managerDirectory, dirname(target));
  try {
    const stats = await lstat(target);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      !Buffer.from(await readFile(target)).equals(input.contents)
    ) {
      throw new Error('existing snapshot input is invalid');
    }
    await chmod(target, 0o444);
    return;
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, input.contents, { flag: 'wx', mode: 0o444 });
    try {
      await link(temporary, target);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
    }
    await chmod(target, 0o444);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface MakePluginActivationSafetyOptions {
  readonly pluginRoot?: string;
  readonly runtimeInputs?: ReadonlyArray<string>;
  readonly observe?: () => PluginSourceObservation;
}

/**
 * Capture immutable child-runtime bytes once for one loaded manager extension.
 * Materialized snapshots are manager-scoped and intentionally retained: this
 * process never sweeps or deletes a snapshot that another loaded manager or
 * attached child may still consume.
 */
export function makePluginActivationSafety(
  options: MakePluginActivationSafetyOptions = {},
): PluginActivationSafetyShape {
  const pluginRoot = options.pluginRoot ?? DEFAULT_PLUGIN_SOURCE_ROOT;
  const runtimeInputs = options.runtimeInputs ?? CHILD_RUNTIME_INPUTS;
  const captured = capturePluginRuntime(pluginRoot, runtimeInputs);
  const observe = options.observe ?? (() => sourceObservation(pluginRoot, runtimeInputs));
  const loaded = capturedSourceObservation(captured, sourceControlStatus(pluginRoot));
  let current = loaded;
  let projection: PluginRuntimeSnapshotProjection = {
    issue: 'not_materialized',
    state: 'unavailable',
  };
  let materialized: MaterializedPluginRuntime | undefined;
  const snapshot = () => pluginActivationStatus(loaded, current, projection);
  const inspect = Effect.promise(async () => {
    current = observe();
    if (materialized && !(await snapshotIsValid(materialized))) {
      materialized = undefined;
      projection = { issue: 'snapshot_invalid', state: 'unavailable' };
    }
    return snapshot();
  });
  const materialize: PluginActivationSafetyShape['materialize'] = (managerDirectory) =>
    Effect.promise(async () => {
      if (captured.kind === 'unknown') {
        projection = { issue: 'capture_unavailable', state: 'unavailable' };
        return snapshot();
      }
      const root = join(managerDirectory, 'runtime', 'child-extension', captured.identity);
      const candidate: MaterializedPluginRuntime = {
        identity: captured.identity,
        inputFileCount: captured.inputs.length,
        inputs: captured.inputs,
        managerDirectory,
        root,
        workerExtensionPath: join(root, CHILD_EXTENSION_INPUT),
      };
      try {
        await ensureDirectDirectory(managerDirectory, root);
        for (const input of captured.inputs) await writeSnapshotFile(candidate, input);
        if (!(await snapshotIsValid(candidate)))
          throw new Error('materialized child runtime snapshot is invalid');
        materialized = candidate;
        projection = {
          identity: candidate.identity,
          inputFileCount: candidate.inputFileCount,
          state: 'ready',
        };
      } catch {
        materialized = undefined;
        projection = { issue: 'materialization_unavailable', state: 'unavailable' };
      }
      return snapshot();
    });
  const requireReady: PluginActivationSafetyShape['requireReady'] = (operation) =>
    inspect.pipe(
      Effect.flatMap(() =>
        materialized
          ? Effect.succeed({
              identity: materialized.identity,
              inputFileCount: materialized.inputFileCount,
              workerExtensionPath: materialized.workerExtensionPath,
            })
          : Effect.fail(
              new PluginActivationBlockedError({
                operation,
                reason: projection.state === 'unavailable' ? projection.issue : 'snapshot_invalid',
                status: snapshot().status,
              }),
            ),
      ),
    );
  return { inspect: () => inspect, materialize, requireReady, snapshot };
}

/** Capture once while one loaded extension instance constructs its process-scoped controller. */
export function makeProcessLoadedPluginActivationSafety(): PluginActivationSafetyShape {
  return makePluginActivationSafety({ pluginRoot: DEFAULT_PLUGIN_SOURCE_ROOT });
}
