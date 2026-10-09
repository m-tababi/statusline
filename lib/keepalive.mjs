// Reads the keep-alive state the statusline plugin writes per session.
// One small, non-blocking read on the local disk; a missing, foreign, corrupt,
// stale or oversized file, or anything that is not a regular file, is simply
// no state, and nothing here throws.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATES = new Set(['off', 'armed', 'pinging', 'paused']);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_BYTES = 4096;
// A file untouched this long belongs to a session that is gone.
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// An armed file whose ping is this overdue has no plugin behind it any more.
export const OVERDUE_MS = 2 * 60 * 1000;
// A ping takes seconds; a file that says "pinging" this long was left behind.
export const PING_STUCK_MS = 5 * 60 * 1000;

export function keepaliveDir(env, home = homedir()) {
  const base = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== ''
    ? env.CLAUDE_CONFIG_DIR
    : join(home, '.claude');
  return join(base, 'keepalive');
}

const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @returns {{enabled: boolean, state: 'off'|'armed'|'pinging'|'paused', warmUntil: number|null} | null}
 */
export function parseKeepalive(text, sessionId, now) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  if (data.v !== 1 || data.sessionId !== sessionId || typeof data.enabled !== 'boolean') return null;
  if (typeof data.state !== 'string' || !STATES.has(data.state)) return null;
  if (!isTime(data.updatedAt) || now - data.updatedAt > MAX_AGE_MS) return null;
  if (!data.enabled) return { enabled: false, state: 'off', warmUntil: null };
  if (data.state === 'off') return null;

  let state = data.state;
  if (state === 'armed' && isTime(data.nextPingAt) && now - data.nextPingAt > OVERDUE_MS) state = 'paused';
  if (state === 'pinging' && now - data.updatedAt > PING_STUCK_MS) state = 'paused';
  const isLive = state === 'armed' || state === 'pinging';
  return { enabled: true, state, warmUntil: isLive && isTime(data.warmUntil) ? data.warmUntil : null };
}

// O_NONBLOCK: a FIFO or a device at the path must never stall the line.
function readSmallFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, MAX_BYTES + 1, 0);
    return length > MAX_BYTES ? null : buffer.toString('utf8', 0, length);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing left to do.
      }
    }
  }
}

export function readKeepalive(sessionId, { env = process.env, home, now = Date.now() } = {}) {
  try {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
    const text = readSmallFile(join(keepaliveDir(env, home ?? homedir()), `${sessionId}.json`));
    return text === null ? null : parseKeepalive(text, sessionId, now);
  } catch {
    return null;
  }
}
