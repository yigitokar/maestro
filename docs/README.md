# Maestro documentation

The guides are in [maestro/](maestro/) and are published at [docs.careresearch.ai/maestro](https://docs.careresearch.ai/maestro) with Mintlify. The site's settings and Maestro's navigation are in `docs.base.json`; `docs.json` is generated from it (see below). Links between the guides are site paths, so follow them on the site.

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

## Latent and BVAR

The same Mintlify site carries two more products, each documented in its own repository:

| Product | Pages written in | Published at |
|---|---|---|
| Latent, a film and scanner emulator for the browser | `docs/` of `yigitokar/filmsim-maestro` (private) | [docs.careresearch.ai/latent](https://docs.careresearch.ai/latent) |
| BVAR, Bayesian vector autoregressions | `docs/site/` of [`yigitokar/rai-bvar`](https://github.com/yigitokar/rai-bvar) | [docs.careresearch.ai/bvar](https://docs.careresearch.ai/bvar) |

The [Sync docs](../.github/workflows/sync-docs.yml) workflow copies their pages into [latent/](latent/) and [bvar/](bvar/) with [mintlify/multirepo-action](https://github.com/mintlify/multirepo-action), and writes `docs.json` from `docs.base.json` with their navigation merged in where `docs.base.json` has a `sourceRef`. It runs every hour and on demand, and opens a pull request when something changed. The sources are listed in [.github/mintlify-multirepo.yml](../.github/mintlify-multirepo.yml).

Edit those pages in their own repositories, and edit `docs.base.json`, not `docs.json`: the next sync overwrites `latent/`, `bvar/` and `docs.json`. The workflow needs the repository secret `DOCS_SYNC_TOKEN`, a fine-grained token with Contents: read on `yigitokar/filmsim-maestro`, and the setting **Allow GitHub Actions to create and approve pull requests**.

## Design notes

These are the project's working documents. They are written in Turkish.

- [spec.md](spec.md): the design and its contracts.
- [decisions.md](decisions.md): choices made where the spec was open, with the measurements behind them.
- [eval.md](eval.md): how the review workflow is evaluated.
