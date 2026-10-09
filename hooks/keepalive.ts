// The keep-alive's decisions, free of the engine: when to ping, what a ping's
// reply means, and what the status line and /keepalive status are told.
import type { ModelForkResult } from 'claude-code'

import type { KeepaliveAnchor, KeepalivePing, KeepaliveTtlChoice } from '../types'
import { SUBSCRIPTION_SOURCE, TTL_MS, fmtSpan, fmtTokens, isWarm, pickUsage, ttlLine, usageLine } from './cache'

// Ping when this much of the entry's lifetime is left (the owner's "bei 5 Minuten").
export const PING_MARGIN_MS = 5 * 60_000
// ...but never more than this share of a short lifetime: a 5m entry is pinged after 4m.
export const MARGIN_SHARE = 0.2
// From anchor + TTL - SAFETY_MS on, a ping would likely find the entry gone and pay a full write.
export const SAFETY_MS = 20_000
// How often the plugin reads Claude Code's own keep-alive flag again.
export const BUILTIN_REFRESH_MS = 10 * 60_000
// Set by the probe (Task 2): true when a fork keeps the 1h entry only with a 1h fork TTL (R2).
export const FORK_TTL_MUST_MATCH = false
export const FORK_PING_PROMPT =
  '[keepalive] Automatic prompt cache refresh, not a message from the user. Do not call any tools. Reply with the single word ok.'
export const KEEPALIVE_USAGE = 'Nutzung: /keepalive on | off | status'

export const REASON = {
  notInteractive: 'keine interaktive Sitzung',
  noAnchor: 'wartet auf die erste Antwort',
  late: 'Timer kam zu spät, Cache vermutlich abgelaufen',
  forkTtl: 'Fork-TTL kürzer als die Cache-TTL – subagentPromptCacheTtl auf 1h setzen',
  nothingToFork: 'nichts zu warmen (kein Verlauf)',
  aborted: 'Ping abgebrochen',
  compacted: 'Verlauf kompaktiert',
  modelSwitch: 'Modell gewechselt',
  cleared: 'Verlauf geleert (/clear)',
  ended: 'Sitzung beendet',
} as const

// Claude Code's own keep-alive (flag tengu_sequential_cloud in ~/.claude.json).
export type Builtin = { state: 'on' | 'off' | 'unreadable'; windowMs: number; touchMs: number }
export const BUILTIN_OFF: Builtin = { state: 'off', windowMs: 0, touchMs: 0 }
const BUILTIN_UNREADABLE: Builtin = { state: 'unreadable', windowMs: 0, touchMs: 0 }

/**
 * The flag as Claude Code 2.1.295 reads it: a config object
 * ({ enabled = true, touchIntervalSeconds 10-120 = 30, activityWindowMinutes 1-1440 = 60 });
 * any other value is off. No text (missing or unreadable file) or bad JSON counts as off too.
 */
export function parseBuiltin(text: string | null): Builtin {
  if (text === null) return BUILTIN_UNREADABLE
  let config: unknown
  try {
    const root = JSON.parse(text) as { cachedGrowthBookFeatures?: Record<string, unknown> } | null
    config = root?.cachedGrowthBookFeatures?.tengu_sequential_cloud
  } catch {
    return BUILTIN_UNREADABLE
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return BUILTIN_OFF
  const c = config as Record<string, unknown>
  if (c.enabled === false) return BUILTIN_OFF
  const minutes = typeof c.activityWindowMinutes === 'number' && c.activityWindowMinutes >= 1 && c.activityWindowMinutes <= 1440
    ? c.activityWindowMinutes
    : 60
  const seconds = typeof c.touchIntervalSeconds === 'number' && c.touchIntervalSeconds >= 10 && c.touchIntervalSeconds <= 120
    ? c.touchIntervalSeconds
    : 30
  return { state: 'on', windowMs: minutes * 60_000, touchMs: seconds * 1000 }
}

export type Gate = {
  isEnabled: boolean
  isInteractive: boolean
  isTurnRunning: boolean
  isForking: boolean
  pause: string | null
  anchor: KeepaliveAnchor | null
  main: KeepaliveTtlChoice
  fork: KeepaliveTtlChoice
  forkTtlMustMatch: boolean
  builtin: Builtin
  // The last real activity: a main-thread request or the end of a turn.
  activityAt: number | null
}

export type Step =
  | { kind: 'off' }
  // A turn or a ping runs; whatever ends it plans again.
  | { kind: 'busy' }
  | { kind: 'wait'; at: number }
  | { kind: 'ping' }
  // Nothing to do until the next real turn (or ever, for a non-interactive session).
  | { kind: 'hold'; reason: string }
  | { kind: 'late' }

export type DisplayState = 'off' | 'armed' | 'pinging' | 'paused'

// What the status line reads, one file per session (schema v1).
export type StatusFile = {
  v: 1
  sessionId: string
  enabled: boolean
  state: DisplayState
  reason: string | null
  nextPingAt: number | null
  warmUntil: number | null
  updatedAt: number
}

export const pingDelayMs = (ttlMs: number): number => ttlMs - Math.min(PING_MARGIN_MS, Math.floor(ttlMs * MARGIN_SHARE))

/** Claude Code touches the entry itself only at the subscriber 1h TTL, and only with its flag on. */
export const isBuiltinActive = (g: Gate): boolean => g.builtin.state === 'on' && g.main.source === SUBSCRIPTION_SOURCE

/** When the entry was last refreshed: the anchor, or Claude Code's last touch inside its activity window. */
export function coveredAnchor(g: Gate, anchorAt: number, now: number): number {
  if (!isBuiltinActive(g) || g.activityAt === null) return anchorAt
  const lastTouch = Math.min(now, g.activityAt + g.builtin.windowMs) - g.builtin.touchMs
  return Math.max(anchorAt, lastTouch)
}

export function nextStep(g: Gate, now: number): Step {
  if (!g.isEnabled) return { kind: 'off' }
  if (!g.isInteractive) return { kind: 'hold', reason: REASON.notInteractive }
  if (g.isTurnRunning || g.isForking) return { kind: 'busy' }
  if (g.pause !== null) return { kind: 'hold', reason: g.pause }
  if (g.anchor === null) return { kind: 'hold', reason: REASON.noAnchor }
  if (g.forkTtlMustMatch && TTL_MS[g.fork.ttl] < TTL_MS[g.main.ttl]) return { kind: 'hold', reason: REASON.forkTtl }
  const ttlMs = TTL_MS[g.main.ttl]
  const anchorAt = coveredAnchor(g, g.anchor.at, now)
  if (now >= anchorAt + ttlMs - SAFETY_MS) return { kind: 'late' }
  const at = anchorAt + pingDelayMs(ttlMs)
  return now < at ? { kind: 'wait', at } : { kind: 'ping' }
}

export function statusFile(sessionId: string, g: Gate, step: Step, now: number): StatusFile {
  const state: DisplayState =
    step.kind === 'off'
      ? 'off'
      : g.isForking
        ? 'pinging'
        : step.kind === 'wait' || step.kind === 'busy' || step.kind === 'ping'
          ? 'armed'
          : 'paused'
  const isLive = state === 'armed' || state === 'pinging'
  return {
    v: 1,
    sessionId,
    enabled: g.isEnabled,
    state,
    reason: step.kind === 'hold' ? step.reason : step.kind === 'late' ? REASON.late : null,
    nextPingAt: step.kind === 'wait' ? step.at : null,
    // Only a verified ping vouches for the entry beyond what Claude Code tracks itself.
    warmUntil: isLive && g.anchor !== null && g.anchor.source === 'ping' ? g.anchor.at + TTL_MS[g.main.ttl] : null,
    updatedAt: now,
  }
}

export function settlePing(reply: ModelForkResult, startedAt: number): { pause: string | null; ping: KeepalivePing | null } {
  if (!('usage' in reply)) return { pause: REASON.nothingToFork, ping: null }
  const usage = pickUsage(reply.usage)
  const ping: KeepalivePing = { at: startedAt, usage, isWarm: isWarm(usage) }
  if (!reply.isAnswered && reply.reason === 'api-error') {
    return { pause: `Ping fehlgeschlagen: API-Fehler ${reply.status ?? 'ohne Status'}`, ping }
  }
  if (!reply.isAnswered && reply.reason === 'aborted') return { pause: REASON.aborted, ping }
  if (!ping.isWarm) {
    const paid = usage.input_tokens + usage.cache_creation_input_tokens
    return { pause: `Cache war kalt (read ${fmtTokens(usage.cache_read_input_tokens)}, voll bezahlt ${fmtTokens(paid)})`, ping }
  }
  return { pause: null, ping }
}

/** A refreshing ping re-dates the entry, unless a turn that started meanwhile already did. */
export function anchorAfterPing(
  current: KeepaliveAnchor | null,
  startedAt: number,
  isRefreshed: boolean,
): KeepaliveAnchor | null {
  if (!isRefreshed) return current
  return current !== null && current.at > startedAt ? current : { at: startedAt, source: 'ping' }
}

export function parseKeepalive(args: string): 'on' | 'off' | 'status' | null {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return 'status'
  return word === 'on' || word === 'off' ? word : null
}

function builtinLine(g: Gate, now: number): string {
  const head = 'Eingebauter Keep-alive (tengu_sequential_cloud): '
  if (g.builtin.state === 'unreadable') return `${head}nicht lesbar, gilt als aus`
  if (g.builtin.state === 'off') return `${head}aus`
  if (!isBuiltinActive(g)) return `${head}an, greift hier nicht (TTL nicht Abo-Standard)`
  const left = g.activityAt === null ? 0 : g.activityAt + g.builtin.windowMs - now
  return left > 0 ? `${head}an, deckt noch ${fmtSpan(left)}` : `${head}an, Fenster abgelaufen`
}

const STATE_WORD: Record<DisplayState, string> = { off: 'aus', armed: 'bereit', pinging: 'pingt gerade', paused: 'pausiert' }

export function statusText(f: StatusFile, g: Gate, last: KeepalivePing | null, now: number): string {
  const head = f.enabled
    ? `Keep-alive an · ${STATE_WORD[f.state]}${f.reason === null ? '' : `: ${f.reason}`}`
    : 'Keep-alive aus'
  const lines = [head, ttlLine(g.main, g.fork), builtinLine(g, now)]
  if (g.anchor !== null) lines.push(`Letzte Anfrage vor ${fmtSpan(now - g.anchor.at)} (${g.anchor.source === 'ping' ? 'Ping' : 'Turn'})`)
  if (f.nextPingAt !== null) lines.push(`Nächster Ping in ${fmtSpan(f.nextPingAt - now)}`)
  if (last !== null) lines.push(`Letzter Ping vor ${fmtSpan(now - last.at)}: ${usageLine(last.usage)}`)
  return lines.join('\n')
}
