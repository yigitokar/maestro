# Agents and tools

## Agent options

`agent(prompt, opts?)` takes these options. All are optional.

| Option | Meaning |
|---|---|
| `label` | The agent's name in the progress view, in `maestro show` and in branch names. |
| `phase` | The phase this agent belongs to. Use it in parallel code instead of `phase()`. |
| `schema` | A JSON Schema. The agent's answer is returned as an object validated against it. |
| `model` | The model for this agent. Default: the run's model. |
| `effort` | `'low'`, `'medium'`, `'high'`, `'xhigh'` or `'max'`. |
| `tools` | The names of the tools this agent may use. Default: the four read-only tools. |
| `isolation` | `'worktree'` gives the agent its own git worktree and branch, and allows write tools. |

`label` and `phase` are for display only. They are not part of the cache key, so renaming an agent does not make it run again on resume.

### Schemas

A schema's root must be an object, and every name in `required` must be in `properties`. An invalid schema makes `agent()` throw.

The answer is checked against the schema you wrote. If the model's answer does not fit after a second attempt, the agent returns `null`.

## The built-in tools

Without a `tools` option an agent gets the read-only set.

| Tool | What it does |
|---|---|
| `read_file` | Reads a file inside the working directory. |
| `grep` | Searches file contents. |
| `glob` | Lists files by pattern. |
| `bash` | Runs a command from a fixed list: `ls`, `cat`, `git log`, `git diff`, `git status`, `git show`, `rg`, `find`. |

Read-only agents are confined to the working directory: `read_file` and the path arguments of `bash` commands cannot leave it. `bash` rejects shell metacharacters, so a command cannot be chained or redirected.

The write set is available only with `isolation: 'worktree'`.

| Tool | What it does |
|---|---|
| `write_file` | Creates or replaces a file. |
| `edit_file` | Replaces text in a file. |
| `shell` | Runs any command in the worktree. |
| `git_commit` | Commits the agent's work to its branch. |

Asking for a write tool without isolation makes `agent()` throw.

Commands an agent runs through `bash` or `shell` do not see `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.

## Agents that write code

```js
const result = await agent('Add input validation to src/cli.ts and commit it.', {
  label: 'validate-cli',
  isolation: 'worktree',
  tools: ['read_file', 'grep', 'edit_file', 'shell', 'git_commit'],
})
```

What Maestro does for an isolated agent:

1. Creates a git worktree under `.maestro/worktrees/` on a new branch `wf/<runId>/<label>`.
2. Runs the agent there. It cannot touch your checkout.
3. When the agent finishes, checks in git that the branch exists, the worktree is clean and there is at least one new commit.
4. Adds `branchName` to the agent's result, so your script can hand the branch to a coordinator.

An agent that ends with uncommitted changes gets one reminder to commit. If it still has not committed, it returns `null`; the worktree is kept for you to inspect, and its path is written to the log.

`node_modules` and build output are not copied into a worktree. Tell writers not to install packages.

Two agents cannot write to the same branch: give writers different labels.

`maestro gc` lists leftover worktrees and `wf/*` branches. See [Command line](cli.md).

## Your own tools

To give agents something the built-ins do not cover, such as a paper search, a database or an internal API, define a tool in a file outside the script. The script only names it.

```js
// .maestro/tools/arxiv_search.js
export default {
  name: 'arxiv_search',
  description: 'Search arXiv papers by keyword. Returns titles, authors and abstracts.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  write: false,
  async run(input, ctx) {
    // ctx.cwd is the agent's working directory, ctx.signal aborts when the run stops
    return '...'
  },
}
```

```js
// in the script
const papers = await agent('Find papers on double machine learning.', { tools: ['read_file', 'arxiv_search'] })
```

Rules:

- Tools are loaded from `.maestro/tools/`, or from the directory given with `--tools-dir`. Each `*.js` or `*.mjs` file default-exports one tool or an array of tools. Files whose names start with `_` or `.` are helpers and are not loaded as tools.
- Definitions are checked before the run starts. A bad one stops the run from starting. The name must not clash with a built-in or another tool, `write` must be stated, and the input schema must be strict: every object has `additionalProperties: false` and lists every property in `required`. Make an optional field nullable instead of leaving it out.
- A tool with `write: true` is a write tool and needs `isolation: 'worktree'`.
- `run` returns a string. Throwing reports an error to the agent.

A working example is in `examples/tools/arxiv_search.js`. It needs no API key; copy it into `.maestro/tools/` to use it.

### What to know before adding tools

- Tool code runs in Maestro's own process, not in the script's restricted context. It can reach the network. Giving a read-only agent a tool that reaches the network means the agent can send out what it reads.
- Files in `.maestro/tools/` are executable code, like the scripts in a `package.json`. Maestro loads them when a run starts, and the MCP server loads them whenever it lists its tools. Run Maestro only in repositories you trust.
- The cache key holds a tool's name, not its code. Changing a tool's code does not invalidate earlier answers. Deleting a tool a run used breaks that run's resume.
