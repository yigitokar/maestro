---
title: "Quickstart"
description: "The shortest path: connect Maestro to Claude Code, then ask for a workflow in plain words."
icon: "bolt"
---

You do not need to write any code. You connect Maestro to Claude Code once. After that you ask Claude for a workflow, and Claude writes it and runs it.

It takes about five minutes.

## Before you start

You need three things:

- [Claude Code](https://claude.com/claude-code), installed and working.
- [Node.js](https://nodejs.org) version 22.18 or newer. Check with `node --version`.
- An Anthropic API key. The agents Maestro starts are paid for with this key.

No API key, but a ChatGPT plan with the Codex CLI? That works too. See [the last step](#no-api-key-use-codex).

## Step 1: Download Maestro

Run these three commands in a terminal, one after the other.

```bash
git clone https://github.com/yigitokar/maestro && cd maestro
```

```bash
npm install
```

```bash
npm run build
```

Stay in this `maestro` folder for the next two steps.

## Step 2: Connect it to Claude Code

Put your own key in place of `sk-ant-...`.

```bash
claude mcp add --scope user maestro -e ANTHROPIC_API_KEY=sk-ant-... -- node "$PWD/bin/maestro" mcp
```

## Step 3: Teach Claude how to use it

This copies a short guide that Claude reads before it writes a workflow.

```bash
mkdir -p ~/.claude/skills/maestro-workflow-authoring && cp skill/SKILL.md ~/.claude/skills/maestro-workflow-authoring/SKILL.md
```

## Step 4: Ask

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

To watch the agents work, run this from the `maestro` folder, with the run id Claude gave you and the path of your project:

```bash
node bin/maestro viz <runId> --cwd /path/to/your/project
```

A page opens in your browser with one bar per agent.

## Good to know

- **It costs money.** Every agent uses tokens from your API key. A review of a small change costs from a few tens of cents to a few dollars; a sweep over hundreds of files can cost much more. Tell Claude a limit, as in the third example above.
- **Agents only read by default.** They cannot change your files unless the workflow asks for agents that write, and those work on separate git branches, not in your checkout.
- **Maestro keeps its notes in a `.maestro/` folder** inside your project. Add `.maestro/` to that project's `.gitignore`.

## If nothing happens

- Type `/mcp` in Claude Code. `maestro` should be in the list and connected. If it is not, repeat Step 2 from inside the `maestro` folder and restart Claude Code.
- Claude answered by itself and started no agents? Ask again and say "use a Maestro workflow".
- A run failed at once with a message about a missing API key or authentication? The key in Step 2 was missing or wrong. Run `claude mcp remove maestro`, then repeat Step 2.

## No API key? Use Codex

If you have the [Codex CLI](https://github.com/openai/codex) installed and signed in, the agents can run on your ChatGPT plan. Use this command in Step 2 in place of the one above:

```bash
claude mcp add --scope user maestro -- node "$PWD/bin/maestro" mcp --runner codex
```

## Next

- [Getting started](getting-started.md): write and run a workflow yourself, without Claude Code.
- [Claude Code](claude-code.md): everything the connection can do.
- [Runs, resume and budget](runs.md): limits, costs and looking at past runs.
