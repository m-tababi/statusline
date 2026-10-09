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
    }
  }
}
