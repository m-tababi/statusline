// render(input, opts) → one status line. Pure: time, width, git state and colour are injected.
import { posix } from 'node:path';
import {
  COLOR, bar, clampPct, fmtClock, fmtSpan, paint, pctColor, toMs, visibleWidth, weekdayShort,
} from './format.mjs';

export const FALLBACK = '◆ Claude';
const GAP = '   ';
const DAY_MS = 24 * 60 * 60 * 1000;
// Drop levels, applied in order until the line fits:
// 1 duration, 2 project name, 3 cache, 4 reset hints.
const MAX_LEVEL = 4;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function meter(label, rawPct, color) {
  const pct = clampPct(rawPct);
  if (pct === null) return null;
  const c = pctColor(pct);
  return `${label} ▕${paint(bar(pct), c, color)}▏${paint(`${pct}%`, c, color)}`;
}

function resetHint(resetsAt, now, weekly) {
  const at = toMs(resetsAt);
  if (at === null || at <= now) return '';
  const left = at - now;
  return ` ·${weekly && left >= DAY_MS ? weekdayShort(at) : fmtSpan(left)}`;
}

function limitGroup(label, limit, now, weekly, level, color) {
  if (!isObject(limit)) return null;
  const base = meter(label, limit.used_percentage, color);
  if (base === null) return null;
  return level >= 4 ? base : base + resetHint(limit.resets_at, now, weekly);
}

function modelGroup(input, color) {
  const name = typeof input.model?.display_name === 'string' && input.model.display_name
    ? input.model.display_name
    : '?';
  const effort = typeof input.effort?.level === 'string' ? ` ${input.effort.level}` : '';
  return `${paint('◆', COLOR.symbol, color)} ${name}${effort}`;
}

function gitGroup(input, git, level, color) {
  const ws = isObject(input.workspace) ? input.workspace : {};
  const dir = typeof ws.project_dir === 'string' && ws.project_dir ? ws.project_dir : ws.current_dir;
  const project = typeof dir === 'string' && dir ? posix.basename(dir) : '';
  const branch = git?.branch ?? (typeof input.worktree?.branch === 'string' ? input.worktree.branch : null);
  const showProject = level < 2 && project !== '';
  if (!branch) return showProject ? project : null;
  const head = `${paint('⎇', COLOR.symbol, color)} ${branch}${git?.dirty ? '●' : ''}`;
  return showProject ? `${head} ${project}` : head;
}

function cacheGroup(cache, now, color) {
  if (!isObject(cache)) return null;
  if (cache.warm !== true) return paint('❄', COLOR.symbol, color);
  const exp = toMs(cache.expires_at);
  const bolt = paint('⚡', COLOR.symbol, color);
  if (exp === null) return bolt;
  return exp > now ? `${bolt} ${fmtClock(exp - now)}` : paint('❄', COLOR.symbol, color);
}

function durationGroup(cost, color) {
  const ms = cost?.total_duration_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return `${paint('⏱', COLOR.symbol, color)} ${fmtSpan(ms)}`;
}

function build(input, { now, git, color }, level) {
  const limits = isObject(input.rate_limits) ? input.rate_limits : {};
  const groups = [
    modelGroup(input, color),
    meter('ctx', input.context_window?.used_percentage, color),
    limitGroup('5h', limits.five_hour, now, false, level, color),
    limitGroup('7d', limits.seven_day, now, true, level, color),
    gitGroup(input, git, level, color),
    level < 3 ? cacheGroup(input.prompt_cache, now, color) : null,
    level < 1 ? durationGroup(input.cost, color) : null,
  ];
  return groups.filter((g) => g !== null).join(GAP);
}

/**
 * @param {unknown} input  parsed stdin JSON
 * @param {{columns: number, now: number, git: {branch: string, dirty: boolean} | null, color: boolean}} opts
 * @returns {string} one line without trailing newline
 */
export function render(input, { columns, now, git, color }) {
  if (!isObject(input)) return FALLBACK;
  const opts = { now, git, color };
  for (let level = 0; level < MAX_LEVEL; level++) {
    const line = build(input, opts, level);
    if (visibleWidth(line) <= columns) return line;
  }
  return build(input, opts, MAX_LEVEL);
}
