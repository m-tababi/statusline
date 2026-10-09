// Pure formatting helpers: gradient bar, colours, widths, time spans.

const BAR_CELLS = 8;
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
// Characters that terminals draw two columns wide (East Asian Width "W").
const WIDE = new Set(['⚡']);
const ANSI = /\x1b\[[0-9;]*m/g;

/** Round to an integer and clamp to 0..100; non-numbers become null. */
export function clampPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Eight-cell bar of heavy lines; filled cells run green to red by position, empty cells are grey. */
export function gradientBar(pct, color) {
  const filled = Math.round((pct / 100) * BAR_CELLS);
  let out = '';
  for (let i = 0; i < BAR_CELLS; i++) {
    if (i >= filled) {
      out += color ? paint('━', 238, true) : '─';
      continue;
    }
    if (!color) {
      out += '━';
      continue;
    }
    const t = i / (BAR_CELLS - 1);
    const r = Math.round(90 + 165 * t);
    const g = Math.round(200 - 120 * t);
    out += `\x1b[38;2;${r};${g};120m━\x1b[39m`;
  }
  return out;
}

/** Bold text, closed with a full reset. */
export function bold(text, enabled) {
  return enabled ? `\x1b[1m${text}\x1b[0m` : text;
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

/** German short weekday of an epoch-ms instant in local time. */
export function weekdayShort(epochMs) {
  return WEEKDAYS[new Date(epochMs).getDay()] ?? '';
}

/** Epoch seconds or milliseconds to milliseconds (values above 1e12 are already ms). */
export function toMs(epoch) {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null;
  return epoch > 1e12 ? epoch : epoch * 1000;
}
