// The `maestro viz` page: one HTML document with inline CSS and JS and no external requests, so it
// works offline and as a single exported file. Live mode polls /api/poll and /api/entry on the
// server that served it; static mode reads the snapshot embedded in window.__MAESTRO__.
// The page script below is plain ES5-style JavaScript inside a TS template literal: it must not use
// backticks or the dollar-brace sequence.

/** JSON safe inside a <script> element: no "</script>", no HTML comment openers, no line separators. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function vizPage(boot: { mode: 'live' | 'static'; runId: string; [k: string]: unknown }): string {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(boot.runId)} · maestro viz</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="title-row">
    <span class="brand">maestro</span>
    <h1 id="name">…</h1>
    <span id="status" class="pill"></span>
  </div>
  <p id="desc" class="desc"></p>
  <p id="meta" class="meta"></p>
  <p id="banner" class="banner" hidden></p>
  <div id="stats" class="stats"></div>
  <div id="attempts" class="attempts" hidden></div>
</header>
<main>
  <section class="panel">
    <div class="panel-head">
      <h2>Zaman çizelgesi</h2>
      <div class="legend">
        <span><i class="sw-wait"></i>sırada (slot bekliyor)</span>
        <span><i class="sw s-running"></i>çalışıyor</span>
        <span><i class="sw s-ok"></i>tamam</span>
        <span><i class="sw s-null"></i>null</span>
        <span><i class="sw s-skipped"></i>atlandı</span>
        <span><i class="sw s-cached"></i>önbellekten</span>
      </div>
      <div class="zoom" role="group" aria-label="Yakınlaştırma">
        <button type="button" id="zoom-out" aria-label="Uzaklaştır">−</button>
        <button type="button" id="zoom-in" aria-label="Yakınlaştır">+</button>
      </div>
    </div>
    <div id="timeline" class="timeline"></div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Log</h2></div>
    <ol id="logs" class="logs"></ol>
  </section>
</main>
<aside id="detail" class="detail" hidden aria-labelledby="d-title">
  <div class="d-head">
    <h2 id="d-title"></h2>
    <button type="button" id="d-close" class="d-close" aria-label="Kapat">×</button>
  </div>
  <div id="d-body" class="d-body"></div>
</aside>
<script>window.__MAESTRO__ = ${scriptJson(boot)};</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg: #f6f6f3; --panel: #ffffff; --ink: #1c1e22; --muted: #686d76; --faint: #9a9ea6;
  --line: #e5e5df; --grid: #efefea; --hover: #f1f1ec;
  --ok: #2b9465; --null: #d27a22; --skipped: #a3a8b0; --cached: #5f86d8; --running: #7458f0;
  --bar-ink: #ffffff; --danger: #c2412d; --shadow: 0 10px 30px rgba(20, 22, 26, 0.12);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111215; --panel: #1a1c20; --ink: #e9e9e6; --muted: #a0a4ac; --faint: #6f747c;
    --line: #2b2e33; --grid: #22252a; --hover: #24272c;
    --ok: #46c18a; --null: #f0a457; --skipped: #6f747c; --cached: #8aa9f2; --running: #a08cff;
    --bar-ink: #111215; --danger: #f07a66; --shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg); color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; }
.top { padding: 20px 24px 8px; max-width: 1400px; margin: 0 auto; }
.title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.brand {
  font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); border: 1px solid var(--line);
  padding: 4px 6px; border-radius: 4px;
}
h1 { font-size: 20px; font-weight: 650; margin: 0; letter-spacing: -0.01em; overflow-wrap: anywhere; }
h2 { font-size: 13px; font-weight: 600; margin: 0; color: var(--muted); letter-spacing: 0.02em; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
  padding: 3px 9px; border-radius: 999px; background: var(--hover); color: var(--muted);
}
.pill.live { color: var(--running); }
.pill.live::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--running);
  animation: pulse 1.6s ease-in-out infinite;
}
.pill.done { color: var(--ok); }
.pill.failed { color: var(--danger); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.desc { margin: 6px 0 0; color: var(--muted); max-width: 80ch; }
.desc:empty { display: none; }
.meta { margin: 4px 0 0; color: var(--faint); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.banner {
  margin: 12px 0 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--panel); color: var(--muted);
}
.banner.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 16px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; min-width: 0; }
.stat .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.stat .v { font-size: 20px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; }
.stat .s { font-size: 12px; color: var(--muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
.attempts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.attempts button {
  border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 4px 10px;
  font-size: 12px; cursor: pointer; color: var(--muted);
}
.attempts button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink); }
main { max-width: 1400px; margin: 0 auto; padding: 8px 24px 40px; display: grid; gap: 14px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-width: 0; }
.panel-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin: 2px 2px 10px; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.zoom { margin-left: auto; display: flex; gap: 4px; }
.zoom button {
  width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel);
  cursor: pointer; font-size: 16px; line-height: 1;
}
.zoom button:disabled { opacity: 0.4; cursor: default; }
.timeline { overflow-x: auto; overflow-y: hidden; position: relative; }
.tl { position: relative; }
.axis { position: relative; height: 22px; border-bottom: 1px solid var(--line); }
.tick { position: absolute; top: 4px; font-size: 11px; color: var(--faint); transform: translateX(-50%); white-space: nowrap; font-variant-numeric: tabular-nums; }
.gridline { position: absolute; top: 22px; bottom: 0; width: 1px; background: var(--grid); }
.lane { position: relative; border-bottom: 1px solid var(--grid); }
.lane-label {
  position: sticky; left: 0; z-index: 2; display: flex; flex-direction: column; justify-content: center;
  height: 100%; padding: 0 10px 0 2px; background: var(--panel); border-right: 1px solid var(--line);
}
.lane-label .n { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lane-label .c { font-size: 11px; color: var(--faint); }
.lane-row { display: flex; }
.track { position: relative; flex: none; }
.waiting { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-size: 12px; color: var(--faint); }
.bar {
  position: absolute; height: 20px; border: 0; padding: 0; background: transparent; cursor: pointer;
  min-width: 4px; border-radius: 5px;
}
.bar .wait {
  position: absolute; left: 0; top: 9px; height: 2px; border-radius: 1px; background: var(--faint); opacity: 0.7;
}
.bar .wait::before {
  content: ""; position: absolute; left: 0; top: -3px; width: 2px; height: 8px; border-radius: 1px; background: inherit;
}
.bar .run {
  position: absolute; top: 0; height: 20px; border-radius: 5px; padding: 0 6px;
  font-size: 11px; font-weight: 600; line-height: 20px; text-align: left; color: var(--bar-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bar:hover .run { filter: brightness(1.08); }
.bar:hover .wait { opacity: 1; }
.bar:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
.bar.sel .run { box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--ink); }
.bar.sel .wait { background: var(--ink); opacity: 1; }
.bar .wlabel {
  position: absolute; left: 6px; top: 3px; padding: 0 4px; font-size: 10px; line-height: 14px; color: var(--muted);
  background: var(--panel); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 3px;
}
.sw-wait { width: 14px; height: 2px; border-radius: 1px; background: var(--faint); display: inline-block; }
.s-queued { background: var(--faint); }
.s-ok { background: var(--ok); }
.s-null { background: var(--null); }
.s-skipped { background: var(--skipped); }
.s-cached { background: var(--cached); }
.s-running {
  background: var(--running);
  background-image: repeating-linear-gradient(-45deg, rgba(255,255,255,0.18) 0 6px, transparent 6px 12px);
  background-size: 17px 17px; animation: stripes 0.9s linear infinite;
}
@keyframes stripes { to { background-position: 17px 0; } }
.logdot {
  position: absolute; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
  background: var(--muted); border: 0; padding: 0; cursor: pointer;
}
.logdot:hover, .logdot:focus-visible { background: var(--ink); outline: none; }
.nowline { position: absolute; top: 22px; bottom: 0; width: 2px; margin-left: -1px; background: var(--running); opacity: 0.6; z-index: 1; }
.empty { color: var(--muted); padding: 16px 6px; }
.logs { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.logs li { display: grid; grid-template-columns: 74px 1fr; gap: 10px; padding: 5px 4px; border-radius: 6px; }
.logs li.flash { background: var(--hover); }
.logs .lt { color: var(--faint); font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.logs .lm { overflow-wrap: anywhere; white-space: pre-wrap; }
.logs .lg { color: var(--muted); }
.jlist { display: grid; gap: 4px; }
.jrow {
  display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: center; text-align: left;
  border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 6px 10px; cursor: pointer;
}
.jrow:hover { background: var(--hover); }
.jrow .sw { width: 12px; height: 12px; }
.jrow .tok { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.detail {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); z-index: 10;
  background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow);
  display: flex; flex-direction: column;
}
.detail[hidden] { display: none; }
.d-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.d-head h2 { color: var(--ink); font-size: 15px; overflow-wrap: anywhere; flex: 1; }
.d-close { border: 0; background: transparent; font-size: 22px; line-height: 1; cursor: pointer; color: var(--muted); width: 32px; height: 32px; border-radius: 6px; }
.d-close:hover { background: var(--hover); color: var(--ink); }
.d-body { overflow-y: auto; padding: 14px 16px 28px; }
.chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; color: var(--bar-ink); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 12px 0 4px; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.d-sec { margin-top: 16px; }
.d-sec h3 { font-size: 12px; font-weight: 600; color: var(--muted); margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.06em; }
.d-sec .note { font-size: 12px; color: var(--faint); margin: 4px 0 0; }
pre {
  margin: 0; padding: 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 340px; overflow: auto;
}
.calls { list-style: none; margin: 0; padding: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.calls li { padding: 3px 0; border-bottom: 1px dashed var(--line); overflow-wrap: anywhere; }
.calls .bad { color: var(--danger); }
.err { color: var(--danger); }
@media (max-width: 700px) {
  .top { padding: 16px 16px 6px; }
  main { padding: 6px 16px 32px; }
  h1 { font-size: 17px; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat .v { font-size: 17px; }
  .zoom { margin-left: 0; }
  .detail { top: auto; left: 0; width: 100vw; height: 78vh; border-left: 0; border-top: 1px solid var(--line); border-radius: 14px 14px 0 0; }
  .logs li { grid-template-columns: 62px 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .s-running, .pill.live::before { animation: none; }
}
`;

const SCRIPT = `
(function () {
  'use strict';
  var BOOT = window.__MAESTRO__ || {};
  var LIVE = BOOT.mode === 'live';
  var ROW_H = 26, BAR_H = 20, LANE_PAD = 4, GAP_PX = 2;
  var ZOOMS = [1, 2, 4, 8, 16];
  var STATUS_TEXT = { queued: 'sırada', running: 'çalışıyor', ok: 'tamam', null: 'null', skipped: 'atlandı', cached: 'önbellekten' };
  var state = {
    lines: [], offset: 0, entries: [], skew: 0, attempt: null, selected: null, selectedRow: null, zoomIndex: 0,
    details: BOOT.details || {}, detailCache: {}, pollError: null, snapNow: null
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  // ---------------------------------------------------------------------------------------------
  // data

  function ingest(snap, reset) {
    if (reset) { state.lines = []; }
    state.lines = state.lines.concat(snap.lines || []);
    state.offset = snap.offset || 0;
    state.entries = snap.entries || [];
    state.skew = (snap.now || Date.now()) - Date.now();
    state.snapNow = snap.now || null;
  }
  function now() {
    if (!LIVE) return state.snapNow || Date.now();
    return Date.now() + state.skew;
  }

  function newAttempt(start, t) {
    return {
      start: start, t0: t, last: t, agents: {}, order: [], lanes: [], laneByKey: {},
      logs: [], budget: null, end: null, slots: false
    };
  }
  function laneKey(group, phase) { return (group || '') + '\\u0000' + (phase || ''); }
  function noteLane(a, group, phase) {
    var k = laneKey(group, phase);
    if (!a.laneByKey[k]) {
      var lane = { key: k, group: group || null, phase: phase || null, agents: [] };
      a.laneByKey[k] = lane;
      a.lanes.push(lane);
    }
    return a.laneByKey[k];
  }

  function buildAttempts(lines) {
    var attempts = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.type === 'run_start') {
        cur = newAttempt(l, l.t);
        attempts.push(cur);
        var ph = l.phases || [];
        for (var j = 0; j < ph.length; j++) noteLane(cur, null, ph[j]);
        continue;
      }
      if (!cur) { cur = newAttempt(null, l.t); attempts.push(cur); }
      var a = cur;
      if (l.t > a.last) a.last = l.t;
      if (l.type === 'agent_start') {
        var g = {
          id: l.id, key: l.key, label: l.label, phase: l.phase, group: l.group,
          start: l.t, running: null, end: null, status: null, cached: false, usage: null, prompt: null, attempt: a
        };
        a.agents[l.id] = g;
        a.order.push(l.id);
        noteLane(a, l.group, l.phase).agents.push(g);
      } else if (l.type === 'agent_prompt') {
        if (a.agents[l.id]) a.agents[l.id].prompt = l;
      } else if (l.type === 'agent_running') {
        a.slots = true;
        if (a.agents[l.id]) a.agents[l.id].running = l.t;
      } else if (l.type === 'agent_end') {
        var e = a.agents[l.id];
        if (!e) {
          e = { id: l.id, key: l.key, label: l.label, phase: l.phase, group: l.group, start: l.t, running: null, prompt: null, attempt: a };
          a.agents[l.id] = e;
          a.order.push(l.id);
          noteLane(a, l.group, l.phase).agents.push(e);
        }
        e.end = l.t; e.status = l.status; e.cached = !!l.cached; e.usage = l.usage || null;
      } else if (l.type === 'phase') {
        noteLane(a, l.group, l.title);
      } else if (l.type === 'log') {
        a.logs.push(l);
      } else if (l.type === 'budget_tick') {
        a.budget = l;
      } else if (l.type === 'run_end') {
        a.end = l;
      }
    }
    return attempts;
  }

  // Logs written since agent_running existed tell queue time from run time; older ones do not, and
  // there an agent counts as running from its start.
  function slotted(g) { return !!(g.attempt && g.attempt.slots); }
  function agentState(g) {
    if (g.end === null || g.end === undefined) return slotted(g) && g.running === null ? 'queued' : 'running';
    if (g.cached) return 'cached';
    return g.status || 'ok';
  }
  /** When the agent's runner call began; null while queued. An agent that ended unrun starts at its end. */
  function runStart(g) {
    if (!slotted(g)) return g.start;
    if (g.running !== null && g.running !== undefined) return g.running;
    return g.end === null || g.end === undefined ? null : g.end;
  }
  function totalIn(u) {
    if (!u) return 0;
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }

  // ---------------------------------------------------------------------------------------------
  // formatting

  function fmtDur(ms) {
    if (ms < 0) ms = 0;
    if (ms < 1000) return Math.round(ms) + ' ms';
    var s = ms / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)).toString().replace('.', ',') + ' sn';
    var m = Math.floor(s / 60), rs = Math.round(s % 60);
    if (rs === 60) { m += 1; rs = 0; }
    if (m < 60) return m + ' dk ' + (rs < 10 ? '0' : '') + rs + ' sn';
    var h = Math.floor(m / 60), rm = m % 60;
    return h + ' sa ' + (rm < 10 ? '0' : '') + rm + ' dk';
  }
  function fmtTick(ms) {
    if (ms === 0) return '0';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toString().replace('.', ',') + 'sn';
    if (ms < 3600000) {
      var m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
      return m + 'dk' + (s ? ' ' + s + 'sn' : '');
    }
    return (ms / 3600000).toFixed(1).replace('.', ',') + 'sa';
  }
  function fmtTok(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace('.', ',') + 'k';
    return (n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace('.', ',') + 'M';
  }
  function fmtNum(n) { return Number(n || 0).toLocaleString('tr-TR'); }
  function fmtClock(t) {
    var d = new Date(t);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtDate(t) {
    var d = new Date(t);
    try { return d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return d.toString(); }
  }
  function agentName(g) { return g.label || ('#' + g.id + ' ' + String(g.key || '').slice(0, 8)); }
  function niceStep(raw) {
    var steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= raw) return steps[i];
    return steps[steps.length - 1];
  }

  // ---------------------------------------------------------------------------------------------
  // render

  function current(attempts) {
    if (!attempts.length) return null;
    if (state.attempt === null || state.attempt >= attempts.length) return attempts[attempts.length - 1];
    return attempts[state.attempt];
  }

  function render() {
    var attempts = buildAttempts(state.lines);
    var a = current(attempts);
    renderHeader(attempts, a);
    var host = $('timeline');
    var keep = host.scrollLeft;
    host.textContent = '';
    if (a && a.order.length + a.lanes.length > 0) renderTimeline(host, a);
    else renderJournalOnly(host);
    host.scrollLeft = keep;
    renderLogs(a);
    if (state.selected !== null && a && a.agents[state.selected]) renderDetail(a.agents[state.selected], a);
    else if (state.selectedRow) renderDetail(state.selectedRow, null);
    document.title = (a && a.start ? a.start.name : BOOT.runId) + ' · maestro viz';
  }

  function stat(label, value, sub) {
    var box = el('div', 'stat');
    box.appendChild(el('div', 'k', label));
    box.appendChild(el('div', 'v', value));
    if (sub) box.appendChild(el('div', 's', sub));
    return box;
  }

  function renderHeader(attempts, a) {
    var start = a && a.start;
    $('name').textContent = start ? start.name : BOOT.runId;
    $('desc').textContent = start ? (start.description || '') : '';
    var metaBits = [BOOT.runId];
    if (start) {
      metaBits.push(start.runner.replace(/Runner$/, '').toLowerCase());
      metaBits.push(start.model);
      metaBits.push(fmtDate(a.t0));
      if (start.resume) metaBits.push('resume');
    }
    $('meta').textContent = metaBits.join(' · ');

    var pill = $('status');
    var banner = $('banner');
    banner.hidden = true; banner.className = 'banner'; banner.textContent = '';
    if (!a) {
      pill.className = 'pill'; pill.textContent = LIVE ? 'olay bekleniyor' : 'olay yok';
    } else if (a.end) {
      pill.className = 'pill ' + (a.end.ok ? 'done' : 'failed');
      pill.textContent = a.end.ok ? '✓ bitti' : '✗ başarısız';
      if (!a.end.ok && a.end.error) {
        banner.hidden = false; banner.className = 'banner error'; banner.textContent = a.end.error;
      }
    } else {
      var idle = now() - a.last;
      pill.className = 'pill live';
      pill.textContent = LIVE ? 'canlı' : 'dışa aktarılırken sürüyordu';
      if (LIVE && idle > 5 * 60000) {
        banner.hidden = false;
        banner.textContent = 'Son olay ' + fmtDur(idle) + ' önce geldi. Run hâlâ sürüyor olabilir ya da onu çalıştıran süreç kapanmış olabilir.';
      }
    }
    if (state.pollError) {
      banner.hidden = false; banner.className = 'banner error'; banner.textContent = state.pollError;
    }

    var stats = $('stats');
    stats.textContent = '';
    if (a) {
      var counts = { queued: 0, running: 0, ok: 0, null: 0, skipped: 0, cached: 0 };
      var inTok = 0, outTok = 0, cacheRead = 0;
      for (var i = 0; i < a.order.length; i++) {
        var g = a.agents[a.order[i]];
        var s = agentState(g);
        counts[s]++;
        if (s !== 'cached' && g.usage) {
          inTok += totalIn(g.usage); outTok += g.usage.output_tokens || 0;
          cacheRead += g.usage.cache_read_input_tokens || 0;
        }
      }
      var parts = [];
      if (counts.running) parts.push(counts.running + ' çalışıyor');
      if (counts.queued) parts.push(counts.queued + ' sırada');
      if (counts.ok) parts.push(counts.ok + ' ✓');
      if (counts.null) parts.push(counts.null + ' null');
      if (counts.skipped) parts.push(counts.skipped + ' atlandı');
      if (counts.cached) parts.push(counts.cached + ' önbellek');
      stats.appendChild(stat('Ajan', String(a.order.length), parts.join(' · ') || 'henüz yok'));
      var endT = a.end ? a.end.t : (LIVE ? now() : a.last);
      stats.appendChild(stat('Süre', fmtDur(endT - a.t0), 'başlangıç ' + fmtClock(a.t0)));
      stats.appendChild(stat('Token', fmtTok(inTok + outTok), fmtTok(inTok) + ' giriş · ' + fmtTok(outTok) + ' çıkış'));
      if (inTok > 0 && cacheRead > 0) stats.appendChild(stat('Önbellek', '%' + Math.round((cacheRead / inTok) * 100), 'girişin önbellekten okunan kısmı'));
      if (a.budget && a.budget.total !== null && a.budget.total !== undefined) {
        stats.appendChild(stat('Bütçe', '%' + Math.round((a.budget.spent / a.budget.total) * 100), fmtTok(a.budget.spent) + ' / ' + fmtTok(a.budget.total)));
      }
      if (a.start) stats.appendChild(stat('Eşzamanlılık', String(a.start.concurrency), 'aynı anda en çok ajan'));
    }

    var box = $('attempts');
    box.textContent = '';
    box.hidden = attempts.length < 2;
    if (attempts.length > 1) {
      var active = state.attempt === null ? attempts.length - 1 : state.attempt;
      attempts.forEach(function (at, idx) {
        var b = el('button', null, (idx + 1) + '. deneme · ' + fmtClock(at.t0));
        b.type = 'button';
        b.setAttribute('aria-pressed', idx === active ? 'true' : 'false');
        b.addEventListener('click', function () {
          state.attempt = idx === attempts.length - 1 ? null : idx;
          state.selected = null; closeDetail(); render();
        });
        box.appendChild(b);
      });
    }
  }

  function packRows(agents, t0, scale, tNow) {
    var sorted = agents.slice().sort(function (x, y) { return x.start - y.start || x.id - y.id; });
    var rowsEnd = [];
    var placed = [];
    for (var i = 0; i < sorted.length; i++) {
      var g = sorted[i];
      var left = (g.start - t0) * scale;
      var end = (g.end === null || g.end === undefined) ? tNow : g.end;
      var width = Math.max((end - g.start) * scale, agentState(g) === 'cached' ? 9 : 5);
      var row = 0;
      while (row < rowsEnd.length && rowsEnd[row] > left - GAP_PX) row++;
      rowsEnd[row] = left + width;
      placed.push({ g: g, left: left, width: width, row: row });
    }
    return { placed: placed, rows: Math.max(rowsEnd.length, 1) };
  }

  function renderTimeline(host, a) {
    var tNow = a.end ? a.end.t : (LIVE ? now() : Math.max(a.last, state.snapNow || a.last));
    var dur = Math.max(tNow - a.t0, 1000);
    var labelW = window.innerWidth <= 700 ? 104 : 168;
    var avail = Math.max(host.clientWidth - labelW - 2, 280);
    var zoom = ZOOMS[state.zoomIndex];
    var trackW = Math.round(avail * zoom);
    var scale = trackW / dur;
    $('zoom-out').disabled = state.zoomIndex === 0;
    $('zoom-in').disabled = state.zoomIndex === ZOOMS.length - 1;

    var tl = el('div', 'tl');
    tl.style.width = (labelW + trackW) + 'px';

    var axis = el('div', 'axis');
    axis.style.marginLeft = labelW + 'px';
    axis.style.width = trackW + 'px';
    var step = niceStep(dur / Math.max(trackW / 90, 1));
    for (var t = 0; t <= dur + 1; t += step) {
      var tick = el('div', 'tick', fmtTick(t));
      tick.style.left = (t * scale) + 'px';
      if (t === 0) tick.style.transform = 'none';
      axis.appendChild(tick);
      var gl = el('div', 'gridline');
      gl.style.left = (labelW + t * scale) + 'px';
      tl.appendChild(gl);
    }
    tl.appendChild(axis);
    if (!a.end && LIVE) {
      var nl = el('div', 'nowline');
      nl.style.left = (labelW + (tNow - a.t0) * scale) + 'px';
      tl.appendChild(nl);
    }

    a.lanes.forEach(function (lane) {
      var packed = packRows(lane.agents, a.t0, scale, tNow);
      var h = packed.rows * ROW_H + LANE_PAD * 2;
      var laneEl = el('div', 'lane');
      var row = el('div', 'lane-row');
      row.style.height = h + 'px';
      var lab = el('div', 'lane-label');
      lab.style.width = labelW + 'px';
      lab.style.minWidth = labelW + 'px';
      var name = (lane.group ? '▸ ' + lane.group + ' · ' : '') + (lane.phase || 'fazsız');
      var nEl = el('div', 'n', name);
      nEl.title = name;
      lab.appendChild(nEl);
      var running = 0, queued = 0;
      lane.agents.forEach(function (g) {
        var st = agentState(g);
        if (st === 'running') running++;
        else if (st === 'queued') queued++;
      });
      var cText = lane.agents.length + ' ajan' + (running ? ' · ' + running + ' çalışıyor' : '') + (queued ? ' · ' + queued + ' sırada' : '');
      var cEl = el('div', 'c', cText);
      cEl.title = cText;
      lab.appendChild(cEl);
      row.appendChild(lab);
      var track = el('div', 'track');
      track.style.width = trackW + 'px';
      track.style.height = h + 'px';
      if (!lane.agents.length) track.appendChild(el('div', 'waiting', a.end ? 'ajan çalışmadı' : 'bekliyor'));
      packed.placed.forEach(function (p) {
        var g = p.g;
        var s = agentState(g);
        var b = el('button', 'bar' + (state.selected === g.id ? ' sel' : ''));
        b.type = 'button';
        b.style.left = p.left + 'px';
        b.style.width = p.width + 'px';
        b.style.top = (LANE_PAD + p.row * ROW_H + (ROW_H - BAR_H) / 2) + 'px';
        var end = g.end === null || g.end === undefined ? tNow : g.end;
        var rs = runStart(g);
        // Queue time is a thin line, run time the coloured bar.
        var waitW = rs === null ? p.width : Math.min(Math.max((rs - g.start) * scale, 0), p.width);
        if (waitW >= 2) {
          var w = el('span', 'wait');
          w.style.width = waitW + 'px';
          b.appendChild(w);
          if (rs === null && waitW > 48) {
            var wl = el('span', 'wlabel', agentName(g));
            wl.style.maxWidth = waitW - 8 + 'px';
            b.appendChild(wl);
          }
        }
        var tip = agentName(g) + ' · ' + STATUS_TEXT[s];
        if (rs !== null && rs - g.start >= 50) tip += ' · sırada ' + fmtDur(rs - g.start);
        if (rs === null) tip += ' · ' + fmtDur(end - g.start);
        else tip += ' · ' + (s === 'running' ? 'çalışıyor ' : '') + fmtDur(end - rs);
        b.title = tip;
        b.setAttribute('aria-label', tip);
        if (rs !== null) {
          var runW = Math.max(p.width - waitW, s === 'cached' ? 9 : 5);
          var r = el('span', 'run s-' + s);
          r.style.left = Math.min(waitW, p.width - runW) + 'px';
          r.style.width = runW + 'px';
          if (runW > 34) r.textContent = (s === 'cached' ? '↺ ' : '') + agentName(g);
          b.appendChild(r);
        }
        b.addEventListener('click', function () { openDetail(g.id); });
        track.appendChild(b);
      });
      row.appendChild(track);
      laneEl.appendChild(row);
      tl.appendChild(laneEl);
    });

    if (a.logs.length) {
      var laneEl2 = el('div', 'lane');
      var row2 = el('div', 'lane-row');
      row2.style.height = '28px';
      var lab2 = el('div', 'lane-label');
      lab2.style.width = labelW + 'px';
      lab2.style.minWidth = labelW + 'px';
      lab2.appendChild(el('div', 'n', 'log'));
      row2.appendChild(lab2);
      var track2 = el('div', 'track');
      track2.style.width = trackW + 'px';
      track2.style.height = '28px';
      a.logs.forEach(function (l, idx) {
        var d = el('button', 'logdot');
        d.type = 'button';
        d.style.left = Math.max((l.t - a.t0) * scale, 4) + 'px';
        d.title = '+' + fmtDur(l.t - a.t0) + ' · ' + l.message;
        d.setAttribute('aria-label', d.title);
        d.addEventListener('click', function () { flashLog(idx); });
        track2.appendChild(d);
      });
      row2.appendChild(track2);
      laneEl2.appendChild(row2);
      tl.appendChild(laneEl2);
    }
    host.appendChild(tl);
  }

  function renderJournalOnly(host) {
    if (!state.entries.length) {
      host.appendChild(el('p', 'empty', LIVE ? 'Henüz olay yok. Run başladığında burada görünecek.' : 'Bu run için kayıt yok.'));
      return;
    }
    host.appendChild(el('p', 'empty', 'Bu run zaman kaydı (events.jsonl) tutulmadan önce çalışmış; yalnızca journal satırları var.'));
    var list = el('div', 'jlist');
    state.entries.forEach(function (row) {
      var b = el('button', 'jrow');
      b.type = 'button';
      b.appendChild(el('i', 'sw s-' + row.status));
      b.appendChild(el('span', null, (row.label || row.key.slice(0, 12)) + (row.phase ? ' · ' + row.phase : '')));
      b.appendChild(el('span', 'tok', fmtTok(totalIn(row.usage)) + ' / ' + fmtTok(row.usage.output_tokens || 0)));
      b.addEventListener('click', function () {
        state.selectedRow = { id: row.index, key: row.key, label: row.label, phase: row.phase, start: null, end: 0, status: row.status, cached: false, usage: row.usage, prompt: null };
        $('detail').hidden = false;
        render();
        $('d-close').focus();
      });
      list.appendChild(b);
    });
    host.appendChild(list);
  }

  function renderLogs(a) {
    var ol = $('logs');
    ol.textContent = '';
    if (!a || !a.logs.length) { ol.appendChild(el('li', 'empty', 'Log satırı yok.')); return; }
    a.logs.forEach(function (l, idx) {
      var li = el('li');
      li.id = 'log-' + idx;
      li.appendChild(el('span', 'lt', '+' + fmtDur(l.t - a.t0)));
      var m = el('span', 'lm');
      if (l.group) m.appendChild(el('span', 'lg', '▸ ' + l.group + ' · '));
      m.appendChild(document.createTextNode(l.message));
      li.appendChild(m);
      ol.appendChild(li);
    });
  }
  function flashLog(idx) {
    var li = $('log-' + idx);
    if (!li) return;
    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    li.classList.add('flash');
    setTimeout(function () { li.classList.remove('flash'); }, 1600);
  }

  // ---------------------------------------------------------------------------------------------
  // detail panel

  function openDetail(id) {
    state.selected = id;
    $('detail').hidden = false;
    render();
    $('d-close').focus();
  }
  function closeDetail() {
    state.selected = null;
    state.selectedRow = null;
    $('detail').hidden = true;
  }

  function section(title, child, note) {
    var s = el('div', 'd-sec');
    s.appendChild(el('h3', null, title));
    s.appendChild(child);
    if (note) s.appendChild(el('p', 'note', note));
    return s;
  }
  function pre(text) { return el('pre', null, text); }

  function detailFor(g) {
    var key = g.key + '|' + g.status;
    if (!LIVE) return state.details[key] || state.details[g.key] || null;
    var c = state.detailCache[key];
    if (c) return c;
    if (!state.detailCache['pending:' + key]) {
      state.detailCache['pending:' + key] = true;
      fetch('api/entry?key=' + encodeURIComponent(g.key) + '&status=' + encodeURIComponent(g.status))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          delete state.detailCache['pending:' + key];
          state.detailCache[key] = d || { missing: true };
          render();
        })
        .catch(function () { delete state.detailCache['pending:' + key]; });
    }
    return null;
  }

  function renderDetail(g, a) {
    var s = g.start === null ? (g.status || 'ok') : agentState(g);
    $('d-title').textContent = agentName(g);
    var body = $('d-body');
    var keepScroll = body.scrollTop;
    body.textContent = '';
    var chip = el('span', 'chip s-' + s, STATUS_TEXT[s]);
    body.appendChild(chip);

    var facts = el('dl', 'facts');
    function fact(k, v) { if (v === undefined || v === null || v === '') return; facts.appendChild(el('dt', null, k)); facts.appendChild(el('dd', null, v)); }
    fact('Faz', g.phase || 'fazsız');
    fact('Grup', g.group);
    if (a && g.start !== null) {
      var live = s === 'running' || s === 'queued';
      var end = live ? now() : g.end;
      var rs = runStart(g);
      fact('Süre', fmtDur(end - g.start) + (live ? ' (sürüyor)' : ''));
      if (slotted(g) && s !== 'cached') {
        fact('Sırada', fmtDur((rs === null ? end : rs) - g.start) + (s === 'queued' ? ' (slot bekliyor)' : ''));
        if (rs !== null && g.running !== null) fact('Çalıştı', fmtDur(end - rs));
      }
      fact('Başladı', '+' + fmtDur(g.start - a.t0) + ' · ' + fmtClock(g.start));
    }
    var p = g.prompt;
    if (p) {
      fact('Model', p.model || (a && a.start ? a.start.model + ' (varsayılan)' : null));
      fact('Effort', p.effort);
      fact('İzolasyon', p.isolation ? 'worktree' : null);
      fact('Araçlar', p.tools && p.tools.length ? p.tools.join(', ') : null);
      fact('Şema', p.schema ? 'var' : 'yok');
    }
    if (g.usage) {
      fact('Giriş', fmtNum(totalIn(g.usage)) + ' token' + (g.usage.cache_read_input_tokens ? ' (' + fmtNum(g.usage.cache_read_input_tokens) + ' önbellekten)' : ''));
      fact('Çıkış', fmtNum(g.usage.output_tokens) + ' token');
    }
    if (s === 'cached') fact('Not', 'Sonuç journal\\'dan geldi; model çağrılmadı. Token sayısı ilk çalıştırmanın.');
    fact('Key', g.key);
    body.appendChild(facts);

    if (p) body.appendChild(section('Prompt', pre(p.prompt), p.truncated ? 'İlk 4.000 karakter gösteriliyor.' : null));

    if (s === 'running' || s === 'queued') {
      body.appendChild(section('Sonuç', el('p', 'note', s === 'queued' ? 'Ajan bir eşzamanlılık slotu bekliyor.' : 'Ajan hâlâ çalışıyor.')));
    } else {
      var d = detailFor(g);
      if (!d) body.appendChild(section('Sonuç', el('p', 'note', LIVE ? 'Yükleniyor…' : 'Bu dosyada sonuç yok.')));
      else if (d.missing) body.appendChild(section('Sonuç', el('p', 'note', 'Journal satırı bulunamadı.')));
      else {
        if (d.error) body.appendChild(section('Hata', el('p', 'err', d.error)));
        body.appendChild(section('Sonuç', pre(d.result), d.resultTruncated ? 'İlk 20.000 karakter gösteriliyor.' : null));
        if (d.raw) body.appendChild(section('Ham metin (şema doğrulanamadı)', pre(d.raw)));
        if (d.trace) {
          var ul = el('ul', 'calls');
          if (!d.trace.toolCalls.length) ul.appendChild(el('li', null, 'Araç çağrısı yok.'));
          d.trace.toolCalls.forEach(function (c) {
            var li = el('li', c.ok ? null : 'bad', (c.ok ? '✓ ' : '✗ ') + c.tool + '  ' + c.inputSummary);
            ul.appendChild(li);
          });
          body.appendChild(section('Araç çağrıları (' + d.trace.toolCalls.length + ')', ul));
          if (d.trace.finalText) body.appendChild(section('Son metin', pre(d.trace.finalText)));
        }
        if (d.worktree) body.appendChild(section('Kirli worktree', pre(d.worktree.path + '\\n' + d.worktree.diffStat)));
      }
    }
    body.scrollTop = keepScroll;
  }

  // ---------------------------------------------------------------------------------------------
  // wiring

  $('d-close').addEventListener('click', function () { closeDetail(); render(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('detail').hidden) { closeDetail(); render(); }
  });
  $('zoom-in').addEventListener('click', function () { if (state.zoomIndex < ZOOMS.length - 1) { state.zoomIndex++; render(); } });
  $('zoom-out').addEventListener('click', function () { if (state.zoomIndex > 0) { state.zoomIndex--; render(); } });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  function running() {
    var a = current(buildAttempts(state.lines));
    return !!a && !a.end;
  }

  function poll() {
    fetch('api/poll?from=' + state.offset)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (snap) {
        var hadError = state.pollError !== null;
        state.pollError = null;
        var changed = (snap.lines && snap.lines.length) || snap.entries.length !== state.entries.length;
        ingest(snap, snap.offset < state.offset);
        if (changed || hadError || running()) render();
      })
      .catch(function () {
        state.pollError = 'Sunucuya ulaşılamıyor (maestro viz kapandı mı?). Tekrar deneniyor…';
        // A render that throws (a malformed line) must not end the polling chain.
        try { render(); } catch (e) {}
      })
      .then(function () {
        var live = false;
        try { live = running(); } catch (e) {}
        setTimeout(poll, live ? 1000 : 3000);
      });
  }

  if (BOOT.snapshot) ingest(BOOT.snapshot, true);
  render();
  if (LIVE) poll();
})();
`;
