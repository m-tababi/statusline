// render(input, opts) → one status line. Pure: time, width, git state and colour are injected.
import { posix } from 'node:path';
import {
  bold, clampPct, fmtSpan, gradientBar, paint, toMs, visibleWidth, weekdayShort,
} from './format.mjs';

export const FALLBACK = '◆ Claude';
const SEP_COLOR = 238;
const GREY = 245;
const MODEL_COLOR = 141;
const fg = (n) => `\x1b[38;5;${n}m`;
const bg = (n) => `\x1b[48;5;${n}m`;
const RESET = '\x1b[0m';
const DAY_MS = 24 * 60 * 60 * 1000;
// Drop levels, applied in order until the line fits:
// 1 duration, 2 project name, 3 reset hints.
const MAX_LEVEL = 3;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function meter(label, rawPct, color) {
  const pct = clampPct(rawPct);
  if (pct === null) return null;
  return `${paint(label, GREY, color)} ${gradientBar(pct, color)} ${bold(`${pct}%`, color)}`;
}

function resetHint(resetsAt, now, weekly, color) {
  const at = toMs(resetsAt);
  if (at === null || at <= now) return '';
  const left = at - now;
  const text = weekly && left >= DAY_MS ? weekdayShort(at) : fmtSpan(left);
  return text === '' ? '' : ` ${paint(text, GREY, color)}`;
}

function limitGroup(label, limit, now, weekly, level, color) {
  if (!isObject(limit)) return null;
  const base = meter(label, limit.used_percentage, color);
  if (base === null) return null;
  return level >= 3 ? base : base + resetHint(limit.resets_at, now, weekly, color);
}

function modelGroup(input, color) {
  const name = typeof input.model?.display_name === 'string' && input.model.display_name
    ? input.model.display_name
    : '?';
  const effort = typeof input.effort?.level === 'string' && input.effort.level ? input.effort.level : '';
  if (!color) return `◆ ${name}${effort ? ` ${effort}` : ''}`;
  const body = `${bg(MODEL_COLOR)}${fg(16)}`;
  const tail = effort ? `${body} ${effort}` : '';
  return `${fg(MODEL_COLOR)}▐${body}\x1b[1m◆ ${name}${tail}${RESET}${fg(MODEL_COLOR)}▌${RESET}`;
}

function gitGroup(input, git, level, color) {
  const ws = isObject(input.workspace) ? input.workspace : {};
  const dir = typeof ws.project_dir === 'string' && ws.project_dir ? ws.project_dir : ws.current_dir;
  const project = typeof dir === 'string' && dir ? posix.basename(dir) : '';
  const branch = git?.branch ?? (typeof input.worktree?.branch === 'string' ? input.worktree.branch : null);
  const showProject = level < 2 && project !== '';
  const name = paint(project, GREY, color);
  if (!branch) return showProject ? name : null;
  const dirty = git?.dirty ? ` ${paint('●', 179, color)}` : '';
  const head = `${paint('⎇', 75, color)}  ${bold(branch, color)}${dirty}`;
  return showProject ? `${head}  ${name}` : head;
}

function durationGroup(cost, color) {
  const ms = cost?.total_duration_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return paint(`⏱ ${fmtSpan(ms)}`, GREY, color);
}

function build(input, { now, git, color }, level) {
  const limits = isObject(input.rate_limits) ? input.rate_limits : {};
  const groups = [
    modelGroup(input, color),
    meter('ctx', input.context_window?.used_percentage, color),
    limitGroup('5h', limits.five_hour, now, false, level, color),
    limitGroup('7d', limits.seven_day, now, true, level, color),
    gitGroup(input, git, level, color),
    level < 1 ? durationGroup(input.cost, color) : null,
  ];
  return groups.filter((g) => g !== null).join(`  ${paint('│', SEP_COLOR, color)}  `);
}

/**
 * @param {unknown} input  parsed stdin JSON
 * @param {{columns: number, now: number, git: {branch: string, dirty: boolean} | null, color: boolean}} opts
 * @returns {string} one line without trailing newline
 */
export function render(input, { columns, now, git, color }) {
  if (!isObject(input)) return FALLBACK;
  const opts = { now, git, color };
  // The plain line has no capsule edges (▐▌); count them anyway so both modes drop the same parts.
  const capsuleEdges = color ? 0 : 2;
  for (let level = 0; level < MAX_LEVEL; level++) {
    const line = build(input, opts, level);
    if (visibleWidth(line) + capsuleEdges <= columns) return line;
  }
  return build(input, opts, MAX_LEVEL);
}
