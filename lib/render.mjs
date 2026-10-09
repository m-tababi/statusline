// render(input, opts) → one status line. Pure: time, width, git state and colour are injected.
import { posix } from 'node:path';
import {
  bold, clampPct, fmtClock, fmtSpan, gradientBar, paint, toMs, visibleWidth, weekdayShort,
} from './format.mjs';

export const FALLBACK = '◆ Claude';
const SEP_COLOR = 238;
const GREY = 245;
const MODEL_COLOR = 141;
// Warm-cache colour by time left: calm, then yellow under 10 min, red under 3 min.
const CACHE_OK_COLOR = 150;
const CACHE_WARN_COLOR = 179;
const CACHE_CRIT_COLOR = 203;
const CACHE_WARN_MS = 10 * 60 * 1000;
const CACHE_CRIT_MS = 3 * 60 * 1000;
const fg = (n) => `\x1b[38;5;${n}m`;
const bg = (n) => `\x1b[48;5;${n}m`;
const RESET = '\x1b[0m';
const DAY_MS = 24 * 60 * 60 * 1000;
// Drop levels, applied in order until the line fits:
// 1 duration, 2 project name, 3 cache, 4 reset hints.
const MAX_LEVEL = 4;

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
  return level >= 4 ? base : base + resetHint(limit.resets_at, now, weekly, color);
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

// Keep-alive markers after the cache clock (each one column wide); "off" is plain text.
const KEEPALIVE_MARK = { armed: '↻', pinging: '⇡', paused: '∅' };

function keepaliveMark(keepalive, color) {
  if (!isObject(keepalive)) return '';
  if (keepalive.state === 'off') return paint('off', GREY, color);
  if (!Object.hasOwn(KEEPALIVE_MARK, keepalive.state)) return '';
  const tone = keepalive.state === 'armed' ? CACHE_OK_COLOR : keepalive.state === 'pinging' ? CACHE_WARN_COLOR : GREY;
  return paint(KEEPALIVE_MARK[keepalive.state], tone, color);
}

// The clock runs to the later of Claude Code's expires_at and the expiry a
// verified keep-alive ping vouches for (the plugin sends one only then).
function cacheClock(cache, now, color, ownUntil) {
  const cold = paint('❄', 110, color);
  const own = typeof ownUntil === 'number' && Number.isFinite(ownUntil) && ownUntil > now ? ownUntil : null;
  if (cache.warm !== true && own === null) return cold;
  const engine = cache.warm === true ? toMs(cache.expires_at) : null;
  if (engine === null && own === null) return paint('⚡', CACHE_OK_COLOR, color);
  const exp = Math.max(engine ?? 0, own ?? 0);
  if (exp <= now) return cold;
  const left = exp - now;
  if (left >= CACHE_WARN_MS) return `${paint('⚡', CACHE_OK_COLOR, color)}  ${bold(fmtClock(left), color)}`;
  const tone = left >= CACHE_CRIT_MS ? CACHE_WARN_COLOR : CACHE_CRIT_COLOR;
  return `${paint('⚡', tone, color)}  ${bold(paint(fmtClock(left), tone, color), color)}`;
}

function cacheGroup(cache, now, color, keepalive) {
  if (!isObject(cache)) return null;
  const clock = cacheClock(cache, now, color, isObject(keepalive) ? keepalive.warmUntil : null);
  const mark = keepaliveMark(keepalive, color);
  return mark === '' ? clock : `${clock} ${mark}`;
}

function durationGroup(cost, color) {
  const ms = cost?.total_duration_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return paint(`⏱ ${fmtSpan(ms)}`, GREY, color);
}

function build(input, { now, git, color, keepalive }, level) {
  const limits = isObject(input.rate_limits) ? input.rate_limits : {};
  const groups = [
    modelGroup(input, color),
    meter('ctx', input.context_window?.used_percentage, color),
    limitGroup('5h', limits.five_hour, now, false, level, color),
    limitGroup('7d', limits.seven_day, now, true, level, color),
    gitGroup(input, git, level, color),
    level < 3 ? cacheGroup(input.prompt_cache, now, color, keepalive) : null,
    level < 1 ? durationGroup(input.cost, color) : null,
  ];
  return groups.filter((g) => g !== null).join(`  ${paint('│', SEP_COLOR, color)}  `);
}

/**
 * @param {unknown} input  parsed stdin JSON
 * @param {{columns: number, now: number, git: {branch: string, dirty: boolean} | null, color: boolean,
 *   keepalive?: {enabled: boolean, state: string, warmUntil: number | null} | null}} opts
 * @returns {string} one line without trailing newline
 */
export function render(input, { columns, now, git, color, keepalive = null }) {
  if (!isObject(input)) return FALLBACK;
  const opts = { now, git, color, keepalive };
  // The plain line has no capsule edges (▐▌); count them anyway so both modes drop the same parts.
  const capsuleEdges = color ? 0 : 2;
  for (let level = 0; level < MAX_LEVEL; level++) {
    const line = build(input, opts, level);
    if (visibleWidth(line) + capsuleEdges <= columns) return line;
  }
  return build(input, opts, MAX_LEVEL);
}
