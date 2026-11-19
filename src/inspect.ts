// Compact, agent-friendly failure inspection (`maestro inspect --compact` & MCP `WorkflowInspect`).
// Reads <runDir>/{journal.jsonl, events.jsonl, args.json, run.json, outcome.json} and distills a
// bounded diagnostic report containing only failed/selected steps, their exact inputs/outputs, and
// relevant upstream state needed to identify the root cause without bloating an agent's context window.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventLogLine } from './event-log.js';
import { readEntries, readResultBlob, readTrace } from './journal.js';
import type { Entry, EntryStatus, LiveAgentStatus, TraceToolCall, Usage } from './types.js';
import { addUsage, cacheReadRatio, totalInput } from './usage.js';
import { readEventLines } from './viz.js';
import { type PersistedOutcome, readOutcome } from './workflow.js';

export interface InspectOptions {
  /** Compact mode (strictly minimal failure-focused output). Default false for library, true for MCP. */
  compact?: boolean;
  /** Optional selector: agent label, `#<index>`, or key prefix. */
  selector?: string;
  /** Override max characters for prompt/text/raw fields. */
  maxFieldChars?: number;
  /** Override max upstream nodes included. */
  maxUpstream?: number;
}

export interface InspectedNodeInput {
  prompt?: string;
  promptTruncated?: boolean;
  model?: string;
  effort?: string;
  isolation?: 'worktree';
  tools?: string[];
  schema?: boolean;
}

export interface InspectedNode {
  index: number;
  key: string;
  label?: string;
  phase?: string;
  group?: string;
  status: EntryStatus;
  error?: string;
  usage: Usage;
  input?: InspectedNodeInput;
  resultPreview?: string;
  resultTruncated?: boolean;
  finalText?: string;
  raw?: string;
  totalToolCalls: number;
  failedToolCalls: TraceToolCall[];
  recentToolCalls: TraceToolCall[];
  worktree?: { path: string; diffStat: string };
  messages?: Array<{ id: number; status: string; text: string; error?: string }>;
}

export interface UpstreamSummary {
  index: number;
  key: string;
  label?: string;
  phase?: string;
  reason: 'referenced-in-prompt' | 'preceding-step';
  resultPreview: string;
  resultTruncated: boolean;
}

export interface RunOverviewItem {
  index: number;
  key: string;
  label?: string;
  phase?: string;
  status: EntryStatus;
  cached?: boolean;
  error?: string;
}

export interface InspectReport {
  runId: string;
  name?: string;
  status: 'done' | 'failed' | 'running';
  /** True when outcome is ok but one or more agents ended null or skipped. */
  degraded: boolean;
  compact: boolean;
  model?: string;
  runner?: string;
  replayedFrom?: { runId: string; from?: string };
  outcome?: PersistedOutcome;
  argsPreview?: string;
  argsTruncated?: boolean;
  stats: {
    totalAgents: number;
    ok: number;
    null: number;
    skipped: number;
    journalCacheHits: number;
    liveCalls: number;
    inputTokens: number;
    outputTokens: number;
    promptCacheRatio: number | null;
  };
  /** Selected nodes (failed nodes by default in compact mode, or the explicitly targeted node). */
  nodes: InspectedNode[];
  /** Relevant completed upstream nodes feeding into the failing/selected step(s). */
  upstream: UpstreamSummary[];
  /** Full node list (omitted in compact mode unless healthy with no failures). */
  overview?: RunOverviewItem[];
  /** Latest recorded live agents if the run is still running or exited abruptly. */
  liveAgents?: LiveAgentStatus[];
}

interface PromptMeta extends InspectedNodeInput {
  group?: string;
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}…`, truncated: true };
}

function stringifyCompact(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? 'null' : s;
}

async function resolveResult(runDir: string, row: Entry): Promise<unknown> {
  if (row.blob !== true) return row.result;
  try {
    return await readResultBlob(runDir, row.key);
  } catch {
    return '(result blob unreadable)';
  }
}

/**
 * Extracts prompt metadata, cache-hit counts, run metadata, and live-agent state from `events.jsonl`.
 * Pairs `agent_start` (id → key/group) with `agent_prompt` (id → prompt/opts) per attempt.
 */
function parseEventMetadata(events: EventLogLine[]) {
  let lastStartIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'run_start') {
      lastStartIdx = i;
      break;
    }
  }
  const firstStart = events.find(
    (e): e is Extract<EventLogLine, { type: 'run_start' }> => e.type === 'run_start',
  );
  const lastStart =
    lastStartIdx >= 0 ? (events[lastStartIdx] as Extract<EventLogLine, { type: 'run_start' }>) : undefined;
  const name = lastStart?.name ?? firstStart?.name;
  const model = lastStart?.model ?? firstStart?.model;
  const runner = lastStart?.runner ?? firstStart?.runner;

  let endEvent: Extract<EventLogLine, { type: 'run_end' }> | undefined;
  for (let i = events.length - 1; i > lastStartIdx; i--) {
    const e = events[i];
    if (e?.type === 'run_end') {
      endEvent = e;
      break;
    }
  }

  // Track prompts by key across attempts (latest attempt wins if a key ran again).
  const promptByKey = new Map<string, PromptMeta>();
  const currentIdToKey = new Map<number, { key: string; group?: string }>();
  const live = new Map<number, LiveAgentStatus>();
  let journalCacheHits = 0;
  let liveCalls = 0;
  const cachedInLastAttempt = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const inLastAttempt = i >= Math.max(0, lastStartIdx);
    if (ev.type === 'run_start') {
      currentIdToKey.clear();
      live.clear();
      if (inLastAttempt) {
        journalCacheHits = 0;
        liveCalls = 0;
        cachedInLastAttempt.clear();
      }
    } else if (ev.type === 'run_end') {
      live.clear();
    } else if (ev.type === 'agent_start') {
      currentIdToKey.set(ev.id, { key: ev.key, group: ev.group });
    } else if (ev.type === 'agent_prompt') {
      const ref = currentIdToKey.get(ev.id);
      if (ref) {
        promptByKey.set(ref.key, {
          prompt: ev.prompt,
          ...(ev.truncated ? { promptTruncated: true } : {}),
          ...(ev.model !== undefined ? { model: ev.model } : {}),
          ...(ev.effort !== undefined ? { effort: ev.effort } : {}),
          ...(ev.isolation !== undefined ? { isolation: ev.isolation } : {}),
          tools: ev.tools,
          schema: ev.schema,
          ...(ref.group !== undefined ? { group: ref.group } : {}),
        });
      }
    } else if (ev.type === 'agent_end') {
      live.delete(ev.id);
      if (inLastAttempt) {
        if (ev.cached) {
          journalCacheHits++;
          cachedInLastAttempt.add(ev.key);
        } else {
          liveCalls++;
        }
      }
    } else if (ev.type === 'agent_status') {
      live.set(ev.agent.id, ev.agent);
    }
  }

  return {
    name,
    model,
    runner,
    lastStartIdx,
    endEvent,
    promptByKey,
    liveAgents: [...live.values()],
    journalCacheHits,
    liveCalls,
    cachedInLastAttempt,
  };
}

/** Deduplicates journal rows to the latest row per key while preserving first-seen order. */
function latestRowsByKey(rows: Entry[]): Entry[] {
  const byKey = new Map<string, Entry>();
  const order: string[] = [];
  for (const row of rows) {
    if (!byKey.has(row.key)) order.push(row.key);
    byKey.set(row.key, row);
  }
  return order.map((k) => byKey.get(k)!);
}

/** Checks whether a candidate upstream output appears referenced inside any target prompt. */
function isReferencedInPrompts(candidate: Entry, resultText: string, targetPrompts: string[]): boolean {
  if (targetPrompts.length === 0) return false;
  // Look for meaningful fragments from the upstream result (e.g. a 16+ char snippet or distinct values).
  const trimmed = resultText.trim();
  if (trimmed.length >= 12) {
    const probe = trimmed.replace(/^"|"$/g, '').slice(0, 60);
    if (probe.length >= 12 && targetPrompts.some((p) => p.includes(probe))) return true;
  }
  // Also check string values inside a shallow JSON object/array result (like branchName, file paths, summaries).
  if (candidate.result && typeof candidate.result === 'object') {
    const strings: string[] = [];
    const visit = (v: unknown, depth: number) => {
      if (depth > 2 || strings.length >= 12) return;
      if (typeof v === 'string' && v.length >= 8) strings.push(v.slice(0, 60));
      else if (Array.isArray(v)) for (const item of v.slice(0, 6)) visit(item, depth + 1);
      else if (v && typeof v === 'object') {
        for (const val of Object.values(v as Record<string, unknown>).slice(0, 8)) visit(val, depth + 1);
      }
    };
    visit(candidate.result, 0);
    if (strings.some((s) => targetPrompts.some((p) => p.includes(s)))) return true;
  }
  return false;
}

/** Matches a node selector (`label`, `#<index>`, or key prefix) against the latest rows. */
export function selectRows(rows: Entry[], selector: string): Entry[] {
  const trimmed = selector.trim();
  const byLabel = rows.filter((r) => r.label === trimmed);
  if (byLabel.length > 0) return byLabel;
  if (/^#?\d+$/.test(trimmed)) {
    const idx = Number(trimmed.startsWith('#') ? trimmed.slice(1) : trimmed);
    const byIdx = rows.filter((r) => r.index === idx);
    if (byIdx.length > 0) return byIdx;
  }
  return rows.filter((r) => r.key.startsWith(trimmed));
}

export async function inspectRun(
  runDir: string,
  runId: string,
  opts: InspectOptions = {},
): Promise<InspectReport> {
  if (!existsSync(runDir)) {
    throw new Error(`no run ${runId} in ${path.dirname(runDir)}`);
  }
  const compact = opts.compact ?? false;
  const maxFieldChars = opts.maxFieldChars ?? (compact ? 1_200 : 2_500);
  const maxUpstream = opts.maxUpstream ?? (compact ? 5 : 15);
  const upstreamPreviewChars = compact ? 400 : 1_000;
  const recentToolsLimit = compact ? 5 : 20;

  const [rawRows, { lines: events }, outcome, runMeta, rawArgs] = await Promise.all([
    readEntries(runDir).catch(() => [] as Entry[]),
    readEventLines(runDir),
    readOutcome(runDir),
    readFile(path.join(runDir, 'run.json'), 'utf8')
      .then((s) => JSON.parse(s) as Record<string, unknown>)
      .catch(() => null),
    readFile(path.join(runDir, 'args.json'), 'utf8')
      .then((s) => s.trim())
      .catch(() => undefined),
  ]);

  const evMeta = parseEventMetadata(events);
  const latestRows = latestRowsByKey(rawRows);

  const status: 'done' | 'failed' | 'running' =
    evMeta.endEvent !== undefined
      ? evMeta.endEvent.ok
        ? 'done'
        : 'failed'
      : evMeta.lastStartIdx === -1 && outcome !== undefined
        ? outcome.ok
          ? 'done'
          : 'failed'
        : outcome !== undefined
          ? outcome.ok
            ? 'done'
            : 'failed'
          : 'running';

  // Aggregate usage across all journal rows (matching `maestro runs`).
  const totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  for (const r of rawRows) addUsage(totalUsage, r.usage);

  let okCount = 0;
  let nullCount = 0;
  let skippedCount = 0;
  for (const r of latestRows) {
    if (r.status === 'ok') okCount++;
    else if (r.status === 'null') nullCount++;
    else if (r.status === 'skipped') skippedCount++;
  }

  const failedRows = latestRows.filter((r) => r.status !== 'ok');
  const degraded = status === 'done' && failedRows.length > 0;

  let targetRows: Entry[];
  if (opts.selector !== undefined) {
    targetRows = selectRows(latestRows, opts.selector);
    if (targetRows.length === 0) {
      throw new Error(`no agent matching "${opts.selector}" in run ${runId}`);
    }
  } else if (failedRows.length > 0) {
    targetRows = failedRows;
  } else {
    targetRows = [];
  }

  const nodes: InspectedNode[] = await Promise.all(
    targetRows.map(async (row): Promise<InspectedNode> => {
      const promptMeta = evMeta.promptByKey.get(row.key);
      const trace = await readTrace(runDir, row);
      const allCalls = trace?.toolCalls ?? [];
      const failedToolCalls = allCalls.filter((c) => !c.ok);
      const recentToolCalls = allCalls.slice(-recentToolsLimit);

      let input: InspectedNodeInput | undefined;
      if (promptMeta) {
        const p =
          promptMeta.prompt !== undefined ? truncateText(promptMeta.prompt, maxFieldChars) : undefined;
        input = {
          ...(p ? { prompt: p.text } : {}),
          ...(p?.truncated || promptMeta.promptTruncated ? { promptTruncated: true } : {}),
          ...(promptMeta.model !== undefined ? { model: promptMeta.model } : {}),
          ...(promptMeta.effort !== undefined ? { effort: promptMeta.effort } : {}),
          ...(promptMeta.isolation !== undefined ? { isolation: promptMeta.isolation } : {}),
          ...(promptMeta.tools !== undefined ? { tools: promptMeta.tools } : {}),
          ...(promptMeta.schema !== undefined ? { schema: promptMeta.schema } : {}),
        };
      }

      let resultPreview: string | undefined;
      let resultTruncated: boolean | undefined;
      if (row.result !== null && row.result !== undefined) {
        const resolved = await resolveResult(runDir, row);
        const cut = truncateText(stringifyCompact(resolved), maxFieldChars);
        resultPreview = cut.text;
        if (cut.truncated) resultTruncated = true;
      }

      const finalText =
        trace?.finalText && trace.finalText.trim() !== ''
          ? truncateText(trace.finalText, maxFieldChars).text
          : undefined;
      const raw = row.raw !== undefined ? truncateText(row.raw, maxFieldChars).text : undefined;

      return {
        index: row.index,
        key: row.key,
        ...(row.label !== undefined ? { label: row.label } : {}),
        ...(row.phase !== undefined ? { phase: row.phase } : {}),
        ...(promptMeta?.group !== undefined ? { group: promptMeta.group } : {}),
        status: row.status,
        ...(row.error !== undefined ? { error: row.error } : {}),
        usage: row.usage,
        ...(input ? { input } : {}),
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(resultTruncated ? { resultTruncated: true } : {}),
        ...(finalText !== undefined ? { finalText } : {}),
        ...(raw !== undefined ? { raw } : {}),
        totalToolCalls: allCalls.length,
        failedToolCalls,
        recentToolCalls,
        ...(row.worktree !== undefined ? { worktree: row.worktree } : {}),
        ...(row.messages?.length
          ? {
              messages: row.messages.map((m) => ({
                id: m.id,
                status: m.status,
                text: truncateText(m.text, 300).text,
                ...(m.error !== undefined ? { error: m.error } : {}),
              })),
            }
          : {}),
      };
    }),
  );

  // Build relevant upstream state: completed nodes before the earliest target node (or before a script throw).
  const targetKeys = new Set(targetRows.map((r) => r.key));
  const earliestTargetPos =
    targetRows.length > 0
      ? Math.min(...targetRows.map((r) => latestRows.findIndex((x) => x.key === r.key)))
      : status === 'failed'
        ? latestRows.length
        : -1;

  const upstream: UpstreamSummary[] = [];
  if (earliestTargetPos > 0 && maxUpstream > 0) {
    const candidates = latestRows
      .slice(0, earliestTargetPos)
      .filter((r) => r.status === 'ok' && !targetKeys.has(r.key));
    const targetPrompts = targetRows
      .map((r) => evMeta.promptByKey.get(r.key)?.prompt)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);

    const resolvedCandidates = await Promise.all(
      candidates.map(async (row, pos) => {
        const resolved = await resolveResult(runDir, row);
        const text = stringifyCompact(resolved);
        const referenced = isReferencedInPrompts(row, text, targetPrompts);
        return { row, pos, text, referenced };
      }),
    );

    // Referenced nodes first (most relevant), then most recent preceding nodes; preserve execution order in output.
    const referenced = resolvedCandidates.filter((c) => c.referenced);
    const unreferenced = resolvedCandidates.filter((c) => !c.referenced);
    const chosen = [
      ...referenced.slice(-maxUpstream),
      ...unreferenced.slice(-Math.max(0, maxUpstream - referenced.length)),
    ].sort((a, b) => a.pos - b.pos);

    for (const c of chosen) {
      const cut = truncateText(c.text, upstreamPreviewChars);
      upstream.push({
        index: c.row.index,
        key: c.row.key,
        ...(c.row.label !== undefined ? { label: c.row.label } : {}),
        ...(c.row.phase !== undefined ? { phase: c.row.phase } : {}),
        reason: c.referenced ? 'referenced-in-prompt' : 'preceding-step',
        resultPreview: cut.text,
        resultTruncated: cut.truncated,
      });
    }
  }

  let argsPreview: string | undefined;
  let argsTruncated: boolean | undefined;
  if (rawArgs !== undefined && rawArgs !== '' && rawArgs !== 'null') {
    const cut = truncateText(rawArgs, compact ? 500 : 1_500);
    argsPreview = cut.text;
    if (cut.truncated) argsTruncated = true;
  }

  const replayedFrom =
    runMeta && typeof runMeta.replayedFrom === 'object' && runMeta.replayedFrom !== null
      ? (runMeta.replayedFrom as { runId: string; from?: string })
      : undefined;

  const overview: RunOverviewItem[] | undefined =
    !compact || (failedRows.length === 0 && opts.selector === undefined)
      ? latestRows.map((r) => ({
          index: r.index,
          key: r.key,
          ...(r.label !== undefined ? { label: r.label } : {}),
          ...(r.phase !== undefined ? { phase: r.phase } : {}),
          status: r.status,
          ...(evMeta.cachedInLastAttempt.has(r.key) ? { cached: true } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
        }))
      : undefined;

  return {
    runId,
    ...(evMeta.name !== undefined ? { name: evMeta.name } : {}),
    status,
    degraded,
    compact,
    ...(typeof runMeta?.model === 'string'
      ? { model: runMeta.model }
      : evMeta.model !== undefined
        ? { model: evMeta.model }
        : {}),
    ...(typeof runMeta?.runner === 'string'
      ? { runner: runMeta.runner }
      : evMeta.runner !== undefined
        ? { runner: evMeta.runner }
        : {}),
    ...(replayedFrom ? { replayedFrom } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(argsPreview !== undefined ? { argsPreview } : {}),
    ...(argsTruncated ? { argsTruncated: true } : {}),
    stats: {
      totalAgents: latestRows.length,
      ok: okCount,
      null: nullCount,
      skipped: skippedCount,
      journalCacheHits: evMeta.journalCacheHits,
      liveCalls: evMeta.liveCalls,
      inputTokens: totalInput(totalUsage),
      outputTokens: totalUsage.output_tokens,
      promptCacheRatio: cacheReadRatio(totalUsage),
    },
    nodes,
    upstream,
    ...(overview ? { overview } : {}),
    ...(evMeta.liveAgents.length > 0 ? { liveAgents: evMeta.liveAgents } : {}),
  };
}

/** Renders an `InspectReport` as minimal, high-signal Markdown suited for coding-agent context windows. */
export function formatInspectMarkdown(report: InspectReport): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const lines: string[] = [];

  const title = report.name ? `${report.runId} (${report.name})` : report.runId;
  const badge = report.degraded ? `${report.status}, degraded` : report.status;
  lines.push(`# Run ${title} — ${badge}`);

  const metaParts: string[] = [];
  if (report.runner) metaParts.push(`runner: \`${report.runner}\``);
  if (report.model) metaParts.push(`model: \`${report.model}\``);
  metaParts.push(
    `agents: ${report.stats.totalAgents} (${report.stats.ok} ok, ${report.stats.null} null, ${report.stats.skipped} skipped)`,
  );
  if (report.stats.journalCacheHits > 0) {
    metaParts.push(`journal cache hits: ${report.stats.journalCacheHits}`);
  }
  const cachePct =
    report.stats.promptCacheRatio === null
      ? ''
      : ` (${Math.round(report.stats.promptCacheRatio * 100)}% prompt-cached)`;
  metaParts.push(`tokens: ${n(report.stats.inputTokens)} in${cachePct}, ${n(report.stats.outputTokens)} out`);
  if (report.replayedFrom) {
    metaParts.push(
      `replayed from: \`${report.replayedFrom.runId}\`${report.replayedFrom.from ? ` (--from ${report.replayedFrom.from})` : ''}`,
    );
  }
  lines.push(`- ${metaParts.join(' · ')}`);

  if (report.outcome) {
    if (report.outcome.ok) {
      const cut = truncateText(stringifyCompact(report.outcome.result), report.compact ? 400 : 1_200);
      lines.push(`- outcome: \`ok\` — \`${cut.text}\``);
    } else {
      lines.push(`- outcome: \`failed\` — ${report.outcome.error}`);
    }
  }

  if (report.argsPreview !== undefined) {
    lines.push(`- args: \`${report.argsPreview}\``);
  }

  if (report.liveAgents && report.liveAgents.length > 0) {
    lines.push('', '## Active / Stale Live Agents');
    for (const a of report.liveAgents) {
      const name = a.label ?? `#${a.id}`;
      const activity = a.progress?.summary ? ` — ${a.progress.summary}` : '';
      lines.push(`- \`#${a.id} ${name}\` [${a.state}, ${a.turns} turns]${activity}`);
    }
  }

  if (report.nodes.length > 0) {
    const heading = report.nodes.every((node) => node.status !== 'ok')
      ? `## Failed Nodes (${report.nodes.length})`
      : `## Inspected Nodes (${report.nodes.length})`;
    lines.push('', heading);
    for (const node of report.nodes) {
      const id = node.label
        ? `\`${node.label}\` (#${node.index})`
        : `#${node.index} (\`${node.key.slice(0, 12)}\`)`;
      const phasePart = node.phase ? ` · phase \`${node.phase}\`` : '';
      const groupPart = node.group ? ` · workflow \`${node.group}\`` : '';
      lines.push('', `### ${id} [${node.status}]${phasePart}${groupPart}`);
      if (node.error) lines.push(`- **error:** ${node.error}`);

      const specParts: string[] = [];
      if (node.input?.model) specParts.push(`model=\`${node.input.model}\``);
      if (node.input?.effort) specParts.push(`effort=\`${node.input.effort}\``);
      if (node.input?.isolation) specParts.push(`isolation=\`${node.input.isolation}\``);
      if (node.input?.schema) specParts.push('schema=true');
      if (node.input?.tools?.length) specParts.push(`tools=[${node.input.tools.join(', ')}]`);
      specParts.push(`tokens=${n(totalInput(node.usage))} in / ${n(node.usage.output_tokens)} out`);
      lines.push(`- **meta:** ${specParts.join(', ')}`);

      if (node.input?.prompt !== undefined) {
        lines.push('- **input prompt:**', '```text', node.input.prompt, '```');
      }
      if (node.failedToolCalls.length > 0) {
        lines.push(`- **failed tool calls (${node.failedToolCalls.length} of ${node.totalToolCalls}):**`);
        for (const c of node.failedToolCalls) {
          lines.push(`  - ✗ \`${c.tool}\` ${c.inputSummary}`);
        }
      } else if (node.recentToolCalls.length > 0) {
        lines.push(`- **recent tool calls (${node.recentToolCalls.length} of ${node.totalToolCalls}):**`);
        for (const c of node.recentToolCalls) {
          lines.push(`  - ${c.ok ? '✓' : '✗'} \`${c.tool}\` ${c.inputSummary}`);
        }
      }
      if (node.resultPreview !== undefined) {
        lines.push('- **output result:**', '```json', node.resultPreview, '```');
      }
      if (node.raw !== undefined) {
        lines.push('- **raw unparsed output:**', '```text', node.raw, '```');
      } else if (node.finalText !== undefined) {
        lines.push('- **final text:**', '```text', node.finalText, '```');
      }
      if (node.worktree) {
        lines.push(`- **dirty worktree:** \`${node.worktree.path}\``);
        if (node.worktree.diffStat.trim()) {
          lines.push('```text', node.worktree.diffStat.trim(), '```');
        }
      }
    }
  } else if (report.status === 'failed') {
    lines.push('', '## Failure Summary');
    lines.push('No individual agent failed; the workflow script threw directly.');
  }

  if (report.upstream.length > 0) {
    lines.push('', `## Relevant Upstream State (${report.upstream.length})`);
    for (const u of report.upstream) {
      const id = u.label ? `\`${u.label}\` (#${u.index})` : `#${u.index}`;
      const phasePart = u.phase ? ` [${u.phase}]` : '';
      const why = u.reason === 'referenced-in-prompt' ? 'referenced in failing prompt' : 'preceding step';
      lines.push(`- ${id}${phasePart} (${why}): \`${u.resultPreview}\``);
    }
  }

  if (report.overview && report.overview.length > 0) {
    lines.push('', `## Agents (${report.overview.length})`);
    for (const item of report.overview) {
      const id = item.label ?? item.key.slice(0, 12);
      const cached = item.cached ? ' [CACHE HIT]' : '';
      const phase = item.phase ? ` (${item.phase})` : '';
      const err = item.error ? ` — ${item.error}` : '';
      lines.push(`- #${item.index} \`${id}\`${phase} [${item.status}]${cached}${err}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
