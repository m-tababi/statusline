// Session values of the keep-alive. The host holds them, so a
// hot reload of the hooks module keeps them.
export type KeepaliveTtl = '5m' | '1h'
export type KeepaliveTtlChoice = { ttl: KeepaliveTtl; source: string }
export type KeepaliveUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
// The start of the last main-thread request the cache entry dates from.
export type KeepaliveAnchor = { at: number; source: 'turn' | 'ping' }
// One keep-alive ping: when it started, what it cost, whether it read the cache.
export type KeepalivePing = { at: number; usage: KeepaliveUsage; isWarm: boolean }
export type KeepaliveDisplayState = 'off' | 'armed' | 'pinging' | 'paused'
// What the hint line draws from, written whenever the keep-alive plans again.
export type KeepaliveHint = {
  state: KeepaliveDisplayState
  // The start of the request the main cache entry dates from; null while unknown.
  anchorAt: number | null
  // The last ping found the entry cold and no request has refreshed it since.
  isCold: boolean
  ttlMs: number
  // Claude Code's own keep-alive while it touches this entry; null when it does not.
  builtin: { windowMs: number; touchMs: number } | null
  activityAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    statusline: {
      anchor: KeepaliveAnchor | null
      // A main-thread turn runs (turn.start until its turn.complete).
      isTurnRunning: boolean
      // Why the keep-alive waits for the next real turn; null when it does not.
      pause: string | null
      lastPing: KeepalivePing | null
      // The last real activity (main-thread request or turn end), for Claude Code's own keep-alive window.
      activityAt: number | null
      // The keep-alive switch, for this session only; every session starts on.
      isEnabled: boolean
      hint: KeepaliveHint | null
    }
  }
}
