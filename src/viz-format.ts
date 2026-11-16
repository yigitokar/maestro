// biome-ignore-all lint/style/useTemplate: these functions ship as browser source text and stay plain ES5.
// Formatting shared by the viz page, the widget and their embedded browser scripts. The two format
// functions are written in plain ES5 with no outside references, because FORMAT_JS ships their own
// source text into the page: one definition serves the server side and both scripts.

/** "850 ms", "4.2 s", "59 s", "3 min 07 s", "2 h 05 min"; "–" for a value that is not a time. */
export function fmtDur(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '–';
  if (ms < 0) ms = 0;
  if (ms < 1000) return Math.round(ms) + ' ms';
  var s = ms / 1000;
  if (s < 10) return s.toFixed(1) + ' s';
  var total = Math.round(s);
  if (total < 60) return total + ' s';
  var m = Math.floor(total / 60);
  var rs = total % 60;
  if (m < 60) return m + ' min ' + (rs < 10 ? '0' : '') + rs + ' s';
  var rm = m % 60;
  return Math.floor(m / 60) + ' h ' + (rm < 10 ? '0' : '') + rm + ' min';
}

/** "950", "9.5k", "250k", "1.25M", "12.5M". */
export function fmtTok(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 9995) return (n / 1000).toFixed(1) + 'k';
  if (n < 999500) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
}

/** The two functions above as script source, for the page and the widget. */
export const FORMAT_JS = `${fmtDur.toString()}\n${fmtTok.toString()}\n`;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
