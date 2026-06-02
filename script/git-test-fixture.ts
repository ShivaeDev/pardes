import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { gitEnvironmentForExplicitCwd } from './git-environment';

const GIT_TEST_UNSAFE_ENVIRONMENT_VARIABLES = [
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_INDEX_VERSION',
  'GIT_NO_REPLACE_OBJECTS',
] as const;

function gitTestEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...gitEnvironmentForExplicitCwd(),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TEMPLATE_DIR: '',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of GIT_TEST_UNSAFE_ENVIRONMENT_VARIABLES) delete environment[name];
  for (const name of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete environment[name];
  }
  return environment;
}

export function runGitTestFixture(root: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitTestEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
