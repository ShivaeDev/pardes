import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { AgentAlreadyRunningError, AgentNotFoundError } from '../agent-errors.ts';
import {
  AgentAlreadyRunningError as PublicAgentAlreadyRunningError,
  AgentNotFoundError as PublicAgentNotFoundError,
} from '../manager/index.ts';

const workerRuntimeRoot = new URL('./', import.meta.url);

function productionTypeScriptSources(directory: URL): ReadonlyArray<URL> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const source = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) return productionTypeScriptSources(source);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [source]
      : [];
  });
}

describe('worker-runtime dependency direction', () => {
  test('does not import the manager bounded context', () => {
    const managerImport = /from\s+["']((?:\.\.\/)+manager(?:\/[^"']*)?)["']/g;
    const imports = productionTypeScriptSources(workerRuntimeRoot).flatMap((source) =>
      [...readFileSync(source, 'utf8').matchAll(managerImport)].map(
        (match) =>
          `${relative(fileURLToPath(workerRuntimeRoot), fileURLToPath(source))}: ${match[1]}`,
      ),
    );

    expect(imports).toEqual([]);
  });

  test('keeps the public manager agent errors backed by the shared pure leaf', () => {
    expect(PublicAgentNotFoundError).toBe(AgentNotFoundError);
    expect(PublicAgentAlreadyRunningError).toBe(AgentAlreadyRunningError);
  });
});
