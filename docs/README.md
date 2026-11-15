# Maestro documentation

The guides are in [maestro/](maestro/) and are published at [docs.careresearch.ai/maestro](https://docs.careresearch.ai/maestro) with Mintlify (`docs.json` in this directory). Links between the guides are site paths, so follow them on the site.

Maestro runs multi-agent workflows. You write a short JavaScript script that says which agents run, in what order, and what happens to their answers. Maestro executes the script with a plain runtime: each `agent()` call starts a model with a clean context, and the script combines, votes on and passes on the results.

The control flow is code, so it is the same on every run. The reasoning is in the agents.

## Guides

| Guide | What it covers |
|---|---|
| [Quickstart](maestro/quickstart.md) | The shortest path: connect Maestro to Claude Code and ask for a workflow |
| [Getting started](maestro/getting-started.md) | Install, write a first workflow, run it, resume it |
| [Writing workflows](maestro/workflows.md) | The script API: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow` |
| [Agents and tools](maestro/agents-and-tools.md) | Agent options, the built-in tools, agents that write code, your own tools |
| [Runners](maestro/runners.md) | Running agents on Claude, on Codex, or both in one run |
| [Runs, resume and budget](maestro/runs.md) | What a run leaves on disk, how resume works, budgets, watching a run |
| [Command line](maestro/cli.md) | Every `maestro` command and flag |
| [Claude Code](maestro/claude-code.md) | Using Maestro from Claude Code through its MCP server |
| [Library](maestro/library.md) | Calling Maestro from your own Node program or agent harness |

## Design notes

These are the project's working documents. They are written in Turkish.

- [spec.md](spec.md): the design and its contracts.
- [decisions.md](decisions.md): choices made where the spec was open, with the measurements behind them.
- [eval.md](eval.md): how the review workflow is evaluated.
