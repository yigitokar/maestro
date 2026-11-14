// Environment for child processes that run git (or may run it) in a directory Maestro chose. A parent
// that is itself a git hook, or an agent runtime, exports GIT_DIR and friends; inherited, they would
// point the child's git at that other repository instead of its cwd.

const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

/** A copy of process.env (plus `extra`) without the variables that redirect git to another repo. */
export function childGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of REPO_VARS) delete env[k];
  return env;
}
