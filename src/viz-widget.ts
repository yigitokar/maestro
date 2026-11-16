// `maestro viz <runId> --widget`: the run's latest attempt as an HTML fragment for a chat host's
// inline widget tool (Claude's show_widget): no document skeleton, transparent background, the
// host's CSS tokens for text and surfaces, weights 400/500, nothing under 11px, no fixed
// positioning and no inner scrolling. It is a snapshot: data is embedded and nothing is fetched.
// Like viz-page.ts, the embedded script must not use backticks or the dollar-brace sequence.

import type { EventLogLine } from './event-log.js';
import type { VizSnapshot } from './viz.js';
import { escapeHtml as escapeText, FORMAT_JS, fmtDur, fmtTok } from './viz-format.js';
import { scriptJson } from './viz-page.js';

/** Agents drawn at most; the rest are counted in the caption, never dropped silently. */
export const WIDGET_MAX_AGENTS = 400;
/** Characters of a result shown when an agent is clicked. */
export const WIDGET_PREVIEW_CHARS = 280;

type State = 'queued' | 'running' | 'ok' | 'null' | 'skipped' | 'cached';

/** [label, lane, start, run (null while queued), end (null while live), state, in, out, error, preview] */
export type WidgetAgent = [
  string,
  number,
  number,
  number | null,
  number | null,
  State,
  number,
  number,
  string,
  string,
];

export interface WidgetModel {
  runId: string;
  name: string;
  status: 'done' | 'failed' | 'running';
  error: string;
  /** Milliseconds from the attempt's start to its end, or to the snapshot while it runs. */
  dur: number;
  runner: string;
  concurrency: number | null;
  attempt: number;
  attempts: number;
  tokensIn: number;
  tokensOut: number;
  counts: Record<State, number>;
  lanes: string[];
  agents: WidgetAgent[];
  omitted: number;
}

interface AgentAcc {
  label: string;
  lane: number;
  start: number;
  run: number | null;
  end: number | null;
  key: string;
  status?: string;
  cached: boolean;
  in: number;
  out: number;
}

function totalIn(u: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}) {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Builds the widget model from a snapshot; `previews` maps "key|status" (or key) to result text. */
export function widgetModel(
  snap: VizSnapshot,
  previews: Record<string, { result: string; error?: string }> = {},
): WidgetModel {
  const lines: EventLogLine[] = snap.lines;
  const starts = lines.flatMap((l, i) => (l.type === 'run_start' ? [i] : []));
  const from = starts.length ? starts[starts.length - 1]! : 0;
  const attemptLines = lines.slice(from);
  const first = attemptLines[0];
  const runStart = first?.type === 'run_start' ? first : undefined;
  const t0 = first?.t ?? snap.now;

  const lanes: string[] = [];
  const laneOf = (group?: string, phase?: string): number => {
    const name = (group ? `▸ ${group} · ` : '') + (phase ?? 'no phase');
    let i = lanes.indexOf(name);
    if (i === -1) i = lanes.push(name) - 1;
    return i;
  };
  for (const p of runStart?.phases ?? []) laneOf(undefined, p);

  const byId = new Map<number, AgentAcc>();
  const order: AgentAcc[] = [];
  let slots = false;
  let end: { ok: boolean; error?: string; t: number } | undefined;
  let last = t0;
  for (const l of attemptLines) {
    if (l.t > last) last = l.t;
    if (l.type === 'agent_start') {
      const a: AgentAcc = {
        label: l.label ?? `#${l.id}`,
        lane: laneOf(l.group, l.phase),
        start: l.t - t0,
        run: null,
        end: null,
        key: l.key,
        cached: false,
        in: 0,
        out: 0,
      };
      byId.set(l.id, a);
      order.push(a);
    } else if (l.type === 'agent_running') {
      slots = true;
      const a = byId.get(l.id);
      if (a) a.run = l.t - t0;
    } else if (l.type === 'agent_end') {
      const a = byId.get(l.id);
      if (!a) continue;
      a.end = l.t - t0;
      a.status = l.status;
      a.cached = l.cached;
      a.in = totalIn(l.usage);
      a.out = l.usage.output_tokens ?? 0;
    } else if (l.type === 'run_end') {
      end = { ok: l.ok, error: l.error, t: l.t };
    }
  }

  const counts: Record<State, number> = { queued: 0, running: 0, ok: 0, null: 0, skipped: 0, cached: 0 };
  let tokensIn = 0;
  let tokensOut = 0;
  const agents: WidgetAgent[] = [];
  for (const a of order) {
    const state: State =
      a.end === null
        ? slots && a.run === null
          ? 'queued'
          : 'running'
        : a.cached
          ? 'cached'
          : ((a.status as State | undefined) ?? 'ok');
    counts[state]++;
    if (state !== 'cached') {
      tokensIn += a.in;
      tokensOut += a.out;
    }
    if (agents.length >= WIDGET_MAX_AGENTS) continue;
    const run = slots ? (a.run ?? (a.end !== null ? a.end : null)) : a.start;
    const p = previews[`${a.key}|${a.status}`] ?? previews[a.key];
    const result = p?.result ?? '';
    agents.push([
      a.label,
      a.lane,
      a.start,
      run,
      a.end,
      state,
      a.in,
      a.out,
      (p?.error ?? '').slice(0, 300),
      result.length > WIDGET_PREVIEW_CHARS ? `${result.slice(0, WIDGET_PREVIEW_CHARS)}…` : result,
    ]);
  }

  return {
    runId: snap.runId,
    name: runStart?.name ?? snap.runId,
    status: end ? (end.ok ? 'done' : 'failed') : 'running',
    error: end?.error ?? '',
    dur: Math.max((end?.t ?? Math.max(snap.now, last)) - t0, 0),
    runner: runStart ? runStart.runner.replace(/Runner$/, '').toLowerCase() : '',
    concurrency: runStart?.concurrency ?? null,
    attempt: Math.max(starts.length, 1),
    attempts: Math.max(starts.length, 1),
    tokensIn,
    tokensOut,
    counts,
    lanes,
    agents,
    omitted: Math.max(order.length - WIDGET_MAX_AGENTS, 0),
  };
}

/** The fragment to pass as the widget's code. */
export function vizWidget(model: WidgetModel): string {
  const c = model.counts;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const statusText = model.status === 'done' ? 'done' : model.status === 'failed' ? 'failed' : 'running';
  const parts = [
    c.running ? `${c.running} running` : '',
    c.queued ? `${c.queued} queued` : '',
    c.ok ? `${c.ok} ok` : '',
    c.null ? `${c.null} null` : '',
    c.skipped ? `${c.skipped} skipped` : '',
    c.cached ? `${c.cached} cached` : '',
  ].filter(Boolean);
  const summary =
    `Timeline of the run ${model.name}: ${total} ${total === 1 ? 'agent' : 'agents'}, ${fmtDur(model.dur)}, ${statusText}` +
    (parts.length ? ` (${parts.join(', ')})` : '') +
    '.';
  const card = (k: string, v: string, s: string) =>
    `<div class="mzw-card"><div class="mzw-k">${escapeText(k)}</div><div class="mzw-v">${escapeText(v)}</div><div class="mzw-s">${escapeText(s)}</div></div>`;
  const caption = [model.runId, model.runner, model.attempts > 1 ? `attempt ${model.attempt}` : '']
    .filter(Boolean)
    .join(' · ');
  return `<style>${STYLE}</style>
<h2 class="sr-only">${escapeText(summary)}</h2>
<div class="mzw-cap"><span class="mzw-pill mzw-${model.status}">${escapeText(statusText)}</span><span>${escapeText(model.name)}</span><span class="mzw-muted">${escapeText(caption)}</span></div>
${model.error ? `<div class="mzw-err">${escapeText(model.error)}</div>` : ''}
<div class="mzw-cards">${card('Agents', String(total), parts.join(' · ') || 'none yet')}${card('Duration', fmtDur(model.dur), model.status === 'running' ? 'snapshot' : 'start to end')}${card('Tokens', fmtTok(model.tokensIn + model.tokensOut), `${fmtTok(model.tokensIn)} in · ${fmtTok(model.tokensOut)} out`)}${model.concurrency !== null ? card('Concurrency', String(model.concurrency), 'most agents at one time') : ''}</div>
<div class="mzw-legend"><span><i class="mzw-sw-wait"></i>queued</span><span><i class="mzw-sw k-running"></i>running</span><span><i class="mzw-sw k-ok"></i>ok</span><span><i class="mzw-sw k-null"></i>null</span><span><i class="mzw-sw k-skipped"></i>skipped</span><span><i class="mzw-sw k-cached"></i>cached</span></div>
<div id="mzw-tl"></div>
${model.omitted ? `<div class="mzw-muted mzw-note">The first ${WIDGET_MAX_AGENTS} agents are drawn; ${model.omitted} more are left out.</div>` : ''}
<div id="mzw-det" class="mzw-det">Click a bar to see that agent's wait and run time, its tokens and the start of its result here.</div>
<script>var M = ${scriptJson(model)};${SCRIPT}</script>
`;
}

const STYLE = `
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mzw-cap{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--text-primary);margin:0.5rem 0 0.75rem}
.mzw-muted{color:var(--text-muted);font-size:12px}
.mzw-pill{font-size:12px;padding:2px 10px;border-radius:var(--radius);background:var(--surface-1);color:var(--text-secondary)}
.mzw-done{background:var(--bg-success);color:var(--text-success)}.mzw-failed{background:var(--bg-danger);color:var(--text-danger)}
.mzw-err{color:var(--text-danger);font-size:13px;margin-bottom:0.75rem}
.mzw-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:1rem}
.mzw-card{background:var(--surface-1);border-radius:var(--radius);padding:12px 14px}
.mzw-k{font-size:13px;color:var(--text-secondary)}.mzw-v{font-size:22px;font-weight:500;color:var(--text-primary)}.mzw-s{font-size:12px;color:var(--text-muted)}
.mzw-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);margin-bottom:8px}
.mzw-legend span{display:inline-flex;align-items:center;gap:6px}
.mzw-sw{width:10px;height:10px;border-radius:2px;background:var(--f)}.mzw-sw-wait{width:14px;height:2px;background:var(--border-strong)}
.mzw-lane{display:grid;grid-template-columns:150px minmax(0,1fr);border-top:0.5px solid var(--border)}
.mzw-ln{font-size:12px;font-weight:500;color:var(--text-primary);padding:6px 8px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mzw-ln small{display:block;font-size:11px;font-weight:400;color:var(--text-muted)}
.mzw-trk{position:relative}.mzw-axis{position:relative;height:18px;font-size:11px;color:var(--text-muted)}
.mzw-w{position:absolute;height:2px;background:var(--border-strong)}
.mzw-b{position:absolute;height:18px;border:0;border-radius:4px;padding:0 6px;font-size:11px;line-height:18px;text-align:left;cursor:pointer;background:var(--f);color:var(--i);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:5px}
.mzw-b.sel{outline:2px solid var(--text-primary);outline-offset:1px}
.mzw-q{background:transparent}
.k-ok{--f:#9FE1CB;--i:#085041}.k-null{--f:#FAC775;--i:#633806}.k-skipped{--f:#D3D1C7;--i:#444441}.k-cached{--f:#B5D4F4;--i:#0C447C}.k-running{--f:#CECBF6;--i:#3C3489}
@media (prefers-color-scheme:dark){:root:not([data-mode=light]) .k-ok{--f:#085041;--i:#9FE1CB}:root:not([data-mode=light]) .k-null{--f:#633806;--i:#FAC775}:root:not([data-mode=light]) .k-skipped{--f:#444441;--i:#D3D1C7}:root:not([data-mode=light]) .k-cached{--f:#0C447C;--i:#B5D4F4}:root:not([data-mode=light]) .k-running{--f:#3C3489;--i:#CECBF6}}
:root[data-mode=dark] .k-ok{--f:#085041;--i:#9FE1CB}:root[data-mode=dark] .k-null{--f:#633806;--i:#FAC775}:root[data-mode=dark] .k-skipped{--f:#444441;--i:#D3D1C7}:root[data-mode=dark] .k-cached{--f:#0C447C;--i:#B5D4F4}:root[data-mode=dark] .k-running{--f:#3C3489;--i:#CECBF6}
.mzw-det{margin-top:1rem;background:var(--surface-1);border-radius:var(--radius);padding:12px 14px;font-size:13px;color:var(--text-secondary)}
.mzw-det pre{margin:8px 0 0;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text-primary)}
.mzw-note{margin-top:6px}
@media (max-width:520px){.mzw-lane{grid-template-columns:96px minmax(0,1fr)}}
`;

const SCRIPT = `
(function () {
  ${FORMAT_JS}
  var ROW = 22, PAD = 4, TEXT = { queued: 'queued', running: 'running', ok: 'ok', null: 'null', skipped: 'skipped', cached: 'cached' };
  var tl = document.getElementById('mzw-tl'), det = document.getElementById('mzw-det');
  var dur = Math.max(M.dur, 1000), sel = null;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; }
  function pct(ms) { return (ms / dur) * 100; }
  var sec = fmtDur, tok = fmtTok;
  function tick(ms) {
    if (ms === 0) return '0';
    if (ms < 60000) return String(ms / 1000) + 's';
    var m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return m + 'min' + (s ? ' ' + s + 's' : '');
  }
  function show(a, b) {
    if (sel) sel.classList.remove('sel');
    sel = b; b.classList.add('sel');
    det.textContent = '';
    var t = el('div', null, a[0] + ' · ' + TEXT[a[5]]);
    t.style.cssText = 'font-weight:500;color:var(--text-primary);margin-bottom:4px';
    det.appendChild(t);
    var end = a[4] === null ? M.dur : a[4];
    var bits = ['Phase ' + M.lanes[a[1]]];
    if (a[3] !== null && a[3] - a[2] >= 50) bits.push('queued ' + sec(a[3] - a[2]));
    if (a[3] !== null && a[5] !== 'cached') bits.push((a[4] === null ? 'running ' : 'ran ') + sec(end - a[3]));
    if (a[3] === null) bits.push('waiting for a slot ' + sec(end - a[2]));
    if (a[6] || a[7]) bits.push(tok(a[6]) + ' input, ' + tok(a[7]) + ' output tokens' + (a[5] === 'cached' ? ' (from the first run)' : ''));
    det.appendChild(el('div', null, bits.join(' · ')));
    if (a[8]) { var e = el('div', null, 'Error: ' + a[8]); e.style.cssText = 'color:var(--text-danger);margin-top:4px'; det.appendChild(e); }
    if (a[9]) det.appendChild(el('pre', null, a[9]));
  }
  function render() {
    tl.textContent = '';
    var lane0 = el('div', 'mzw-lane');
    lane0.style.borderTop = '0';
    lane0.appendChild(el('div'));
    var axis = el('div', 'mzw-axis');
    lane0.appendChild(axis);
    tl.appendChild(lane0);
    var trackPx = Math.max(axis.clientWidth, 200);
    var steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= dur / Math.max(trackPx / 80, 1)) { step = steps[i]; break; }
    for (var t = 0; t <= dur; t += step) {
      var x = el('span', null, tick(t));
      x.style.cssText = 'position:absolute;left:' + pct(t) + '%;transform:translateX(' + (t ? '-50%' : '0') + ')';
      axis.appendChild(x);
    }
    M.lanes.forEach(function (name, li) {
      var list = M.agents.filter(function (a) { return a[1] === li; }).sort(function (x, y) { return x[2] - y[2]; });
      var rowsEnd = [], placed = [];
      list.forEach(function (a) {
        var end = a[4] === null ? M.dur : a[4];
        var l = pct(a[2]), w = Math.max(pct(end - a[2]), 0.8), r = 0;
        while (r < rowsEnd.length && rowsEnd[r] > l - 0.3) r++;
        rowsEnd[r] = l + w;
        placed.push({ a: a, row: r, end: end });
      });
      var rows = Math.max(rowsEnd.length, 1);
      var lane = el('div', 'mzw-lane');
      var ln = el('div', 'mzw-ln', name);
      ln.title = name;
      ln.appendChild(el('small', null, list.length ? list.length + (list.length === 1 ? ' agent' : ' agents') : (M.status === 'running' ? 'waiting' : 'no agents')));
      var trk = el('div', 'mzw-trk');
      trk.style.height = (rows * ROW + PAD * 2) + 'px';
      placed.forEach(function (p) {
        var a = p.a, top = PAD + p.row * ROW;
        var runAt = a[3] === null ? p.end : a[3];
        if (runAt - a[2] > dur * 0.004) {
          var w = el('span', 'mzw-w');
          w.style.cssText = 'left:' + pct(a[2]) + '%;width:' + pct(runAt - a[2]) + '%;top:' + (top + 9) + 'px';
          trk.appendChild(w);
        }
        var queued = a[3] === null;
        var b = el('button', 'mzw-b ' + (queued ? 'mzw-q' : 'k-' + a[5]));
        var from = queued ? a[2] : a[3];
        var bw = pct(p.end - from);
        b.style.cssText = 'left:' + pct(from) + '%;width:' + bw + '%;top:' + top + 'px';
        if (!queued && (bw / 100) * trackPx > 40) b.textContent = (a[5] === 'cached' ? '↺ ' : '') + a[0];
        b.setAttribute('aria-label', a[0] + ', ' + TEXT[a[5]] + ', ' + sec(p.end - from));
        b.title = b.getAttribute('aria-label');
        b.addEventListener('click', function () { show(a, b); });
        trk.appendChild(b);
      });
      lane.appendChild(ln);
      lane.appendChild(trk);
      tl.appendChild(lane);
    });
  }
  render();
  var timer = null;
  window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(render, 150); });
})();
`;
