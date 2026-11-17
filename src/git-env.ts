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

/** Credentials of the runner itself: an agent's commands have no use for them and could print them. */
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AI_GATEWAY_API_KEY'];

/** childGitEnv() for the commands an agent runs through the bash and shell tools: no runner credentials. */
export function agentCommandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = childGitEnv(extra);
  for (const k of CREDENTIAL_VARS) delete env[k];
  return env;
}
