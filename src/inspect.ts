import { type EventLogLine, readEventLines } from './event-log.js';
import { readEntries, readFailureInput } from './journal.js';
import type { Entry } from './types.js';
import { readOutcome } from './workflow.js';

type NodeEnd = Extract<EventLogLine, { type: 'agent_end' }>;
type Prompt = Extract<EventLogLine, { type: 'agent_prompt' }>;

async function describeFailure(
  runDir: string,
  node: Pick<NodeEnd, 'id' | 'status' | 'label' | 'group' | 'phase'>,
  row?: Entry,
  preview?: Prompt,
  defaultModel?: string,
) {
  const exact = row && (await readFailureInput(runDir, row));
  const { upstream, ...options } = exact?.options ?? {};
  const messages = row?.messages?.filter((message) => message.status === 'delivered').map((m) => m.text);
  return {
    id: node.id,
    label: node.label,
    group: node.group,
    phase: node.phase,
    status: node.status,
    reason: row?.error ?? (row ? 'runner supplied no reason' : 'no journal entry for this failure'),
    input: exact
      ? { prompt: exact.prompt, options, model: exact.model, tools: exact.tools }
      : preview
        ? {
            prompt: preview.prompt,
            promptTruncated: preview.truncated ?? false,
            model: preview.model ?? defaultModel,
            tools: preview.tools,
            effort: preview.effort,
            isolation: preview.isolation,
            hasSchema: preview.schema,
            incomplete: 'only the event preview is available',
          }
        : { unavailable: 'input was not recorded' },
    ...(messages?.length ? { messages } : {}),
    ...(row ? { output: row.result, rawOutput: row.raw } : { outputUnavailable: true }),
    ...(upstream !== undefined || exact?.pipeline
      ? { upstream: { state: upstream, pipeline: exact?.pipeline } }
      : {}),
  };
}

/** Inspect the last attempt only. Resume reuses numeric IDs and leaves all older journal rows on disk. */
export async function inspectFailures(runDir: string, runId: string) {
  const [rows, { lines }, outcome] = await Promise.all([
    readEntries(runDir),
    readEventLines(runDir),
    readOutcome(runDir),
  ]);
  const start = lines.findLastIndex((line) => line.type === 'run_start');
  const attempt = lines.slice(start + 1);
  const settings = lines[start];
  const model = settings?.type === 'run_start' ? settings.model : undefined;
  const end = attempt.findLast((line) => line.type === 'run_end');
  const runError = end ? end.error : outcome?.ok === false ? outcome.error : undefined;
  const journalStart = settings?.type === 'run_start' ? settings.journalStart : undefined;
  const currentRows = journalStart === undefined ? rows : rows.slice(journalStart);
  const latest = new Map(currentRows.map((row) => [row.key, row]));
  const prompts = new Map(attempt.flatMap((e) => (e.type === 'agent_prompt' ? [[e.id, e] as const] : [])));
  const failures = [];
  for (const end of attempt) {
    if (end.type !== 'agent_end') continue;
    const row = latest.get(end.key);
    latest.delete(end.key);
    if (end.status !== 'ok') {
      failures.push(
        await describeFailure(
          runDir,
          end,
          row?.index === end.id && row.status === end.status ? row : undefined,
          prompts.get(end.id),
          model,
        ),
      );
    }
  }
  // Rows are durable before agent_end is emitted. Recover a failure even if its event never flushed.
  // With journal-only legacy runs we can identify the most recent row per key, but not attempt boundaries.
  if (journalStart !== undefined || start === -1) {
    for (const row of latest.values()) {
      if (row.status !== 'ok')
        failures.push(
          await describeFailure(runDir, { ...row, id: row.index }, row, prompts.get(row.index), model),
        );
    }
  }
  const stepErrors = attempt.filter((e) => e.type === 'step_failure');
  const rejectedCalls = attempt.filter((e) => e.type === 'agent_rejected');
  return {
    runId,
    runError,
    ...(rejectedCalls.length
      ? { rejectedCalls: rejectedCalls.map(({ type: _type, t: _time, ...detail }) => detail) }
      : {}),
    failures: failures.sort((a, b) => a.id - b.id),
    ...(stepErrors.length
      ? {
          stepErrors: stepErrors.map(({ kind, index, error, input, phase, group }) => ({
            kind,
            index,
            error,
            input,
            phase,
            group,
            output: null,
          })),
        }
      : {}),
  };
}
