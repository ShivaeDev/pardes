const GIT_EXPLICIT_CWD_UNSAFE_ENVIRONMENT_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ATTR_SOURCE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
] as const;

/** Keep explicit-cwd Git operations rooted in their caller-selected repository. */
export function gitEnvironmentForExplicitCwd(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of GIT_EXPLICIT_CWD_UNSAFE_ENVIRONMENT_VARIABLES) delete result[name];
  return result;
}
