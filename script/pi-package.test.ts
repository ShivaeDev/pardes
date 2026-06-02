import { join } from 'node:path';
import {
  DefaultPackageManager,
  loadSkills,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const agentDir = join(repositoryRoot, '.pi-agent-test');
const skillPath = join(repositoryRoot, 'plugins/pardes-pi/skills/pardes-pr-description/SKILL.md');

describe('Pi package manifest', () => {
  it('discovers the Pardes PR-description skill through the package manifest', async () => {
    const packageManager = new DefaultPackageManager({
      agentDir,
      cwd: repositoryRoot,
      settingsManager: SettingsManager.inMemory(),
    });
    const resources = await packageManager.resolveExtensionSources([repositoryRoot], {
      temporary: true,
    });

    expect(resources.skills).toEqual([
      expect.objectContaining({
        enabled: true,
        metadata: expect.objectContaining({ origin: 'package' }),
        path: skillPath,
      }),
    ]);

    const loaded = loadSkills({
      agentDir,
      cwd: repositoryRoot,
      includeDefaults: false,
      skillPaths: resources.skills.filter(({ enabled }) => enabled).map(({ path }) => path),
    });

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills).toEqual([
      expect.objectContaining({
        description: expect.stringContaining('reviewer-first'),
        filePath: skillPath,
        name: 'pardes-pr-description',
      }),
    ]);
  });
});
