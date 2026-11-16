---
title: "Quickstart"
description: "The shortest path: connect Maestro to Claude Code, then ask for a workflow in plain words."
icon: "bolt"
---

You do not need to write any code. You connect Maestro to Claude Code once. After that you ask Claude for a workflow, and Claude writes it and runs it.

It takes about two minutes.

## Before you start

You need three things:

- [Claude Code](https://claude.com/claude-code), installed and working.
- [Node.js](https://nodejs.org) version 22.18 or newer. Check with `node --version`.
- An Anthropic API key. The agents Maestro starts are paid for with this key.

No API key, but a ChatGPT plan with the Codex CLI? That works too. See [No API key? Use Codex](#no-api-key-use-codex).

## Step 1: Connect it to Claude Code

Run this in a terminal. Put your own key in place of `sk-ant-...`.

```bash
claude mcp add --scope user maestro -e ANTHROPIC_API_KEY=sk-ant-... -- npx -y maestro-workflows mcp
```

There is nothing to download first: `npx` fetches Maestro from npm the first time it runs.

The server also carries a short guide to writing workflows. Claude reads it by itself before it writes its first one, so there is nothing more to install.

Optional: Claude Code can also keep the guide as a skill, which it then sees in every project without asking the server.

```bash
mkdir -p ~/.claude/skills/maestro-workflow-authoring && curl -fsSL https://raw.githubusercontent.com/yigitokar/maestro/main/skill/SKILL.md -o ~/.claude/skills/maestro-workflow-authoring/SKILL.md
```

## Step 2: Ask

Close Claude Code and open it again, in the project you want to work on. Then ask for a workflow in plain words. Say the word **workflow**, so Claude knows you want several agents and not one answer.

Things you can type:

```text
Use a Maestro workflow to review the changes on this branch. Have other agents double-check every finding.
```

```text
Use a workflow to find edge cases in src/parser.ts that the tests do not cover.
```

```text
Use a workflow to check every file in src/ for missing error handling. Keep it under 300k tokens.
```

That is all. Claude writes the script, starts it, and tells you the result when it is done. You can keep working while it runs.

## What you will see

1. Claude says it started a run and gives you a run id, such as `20261114-222359-103d18`.
2. Agents work in the background. A small run takes a minute or two; a big one takes longer.
3. Claude reports what the agents found.

To watch the agents work, run this in your project's folder, with the run id Claude gave you:

```bash
npx -y maestro-workflows viz <runId>
```

A page opens in your browser with one bar per agent.

## Good to know

- **It costs money.** Every agent uses tokens from your API key. A review of a small change costs from a few tens of cents to a few dollars; a sweep over hundreds of files can cost much more. Tell Claude a limit, as in the third example above.
- **Agents only read by default.** They cannot change your files unless the workflow asks for agents that write, and those work on separate git branches, not in your checkout.
- **Maestro keeps its notes in a `.maestro/` folder** inside your project. Add `.maestro/` to that project's `.gitignore`.

## If nothing happens

- Type `/mcp` in Claude Code. `maestro` should be in the list and connected. If it is not, repeat Step 1 and restart Claude Code.
- Claude answered by itself and started no agents? Ask again and say "use a Maestro workflow".
- A run failed at once with a message about a missing API key or authentication? The key in Step 1 was missing or wrong. Run `claude mcp remove maestro`, then repeat Step 1.

## No API key? Use Codex

If you have the [Codex CLI](https://github.com/openai/codex) installed and signed in, the agents can run on your ChatGPT plan. Use this command in Step 1 in place of the one above:

```bash
claude mcp add --scope user maestro -- npx -y maestro-workflows mcp --runner codex
```

## Next

- [Getting started](/maestro/getting-started): write and run a workflow yourself, without Claude Code.
- [Claude Code](/maestro/claude-code): everything the connection can do.
- [Runs, resume and budget](/maestro/runs): limits, costs and looking at past runs.
