// Pure formatting helpers: bars, colours, widths, time spans.

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const BAR_CELLS = 5;
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
// Characters that terminals draw two columns wide (East Asian Width "W").
const WIDE = new Set(['⚡']);
const ANSI = /\x1b\[[0-9;]*m/g;

export const COLOR = { green: 114, yellow: 179, red: 203, symbol: 110 };

/** Round to an integer and clamp to 0..100; non-numbers become null. */
export function clampPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Five-cell bar in eighth blocks, padded with spaces to exactly five cells. */
export function bar(pct) {
  const eighths = Math.round((pct / 100) * BAR_CELLS * 8);
  const full = Math.floor(eighths / 8);
  const part = EIGHTHS[eighths % 8];
  const cells = '█'.repeat(full) + part;
  return cells + ' '.repeat(BAR_CELLS - [...cells].length);
}

/** ANSI 256 colour code for a percentage: green < 50, yellow < 80, red otherwise. */
export function pctColor(pct) {
  if (pct < 50) return COLOR.green;
  if (pct < 80) return COLOR.yellow;
  return COLOR.red;
}

/** Wrap text in a 256-colour foreground; resets only the foreground. */
export function paint(text, code, enabled) {
  return enabled ? `\x1b[38;5;${code}m${text}\x1b[39m` : text;
}

/** Terminal columns of a string: ANSI stripped, wide characters count 2. */
export function visibleWidth(text) {
  let width = 0;
  for (const ch of text.replace(ANSI, '')) width += WIDE.has(ch) ? 2 : 1;
  return width;
}

/** Remaining time: "2h10" from one hour up, otherwise "45m". */
export function fmtSpan(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`;
}

/** Cache countdown "m:ss". */
export function fmtClock(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

/** German short weekday of an epoch-ms instant in local time. */
export function weekdayShort(epochMs) {
  return WEEKDAYS[new Date(epochMs).getDay()] ?? '';
}

/** Epoch seconds or milliseconds to milliseconds (values above 1e12 are already ms). */
export function toMs(epoch) {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null;
  return epoch > 1e12 ? epoch : epoch * 1000;
}
