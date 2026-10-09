// Session values of the keep-alive and its probe. The host holds them, so a
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
// A probe fork (or a control without one) waiting for, or holding, the next real request.
export type KeepaliveProbe = {
  kind: 'probe' | 'control'
  anchorAt: number
  fork: { at: number; usage: KeepaliveUsage } | null
  forkRaisedStep: boolean
  followUp: { at: number; usage: KeepaliveUsage } | null
  mainTtl: KeepaliveTtlChoice
  forkTtl: KeepaliveTtlChoice
}

declare module 'claude-code' {
  interface PluginState {
    statusline: {
      anchor: KeepaliveAnchor | null
      // A main-thread turn runs (turn.start until its turn.complete).
      isTurnRunning: boolean
      probe: KeepaliveProbe | null
      // Why the keep-alive waits for the next real turn; null when it does not.
      pause: string | null
      lastPing: KeepalivePing | null
      // The last real activity (main-thread request or turn end), for Claude Code's own keep-alive window.
      activityAt: number | null
    }
  }
}
