// Prompt-cache facts shared by the probe and the keep-alive: which TTL the
// main conversation and a fork get (in the order Claude Code 2.1.295 checks
// them), and how to read a request's usage.
import type { ModelUsage } from 'claude-code'

import type { KeepaliveTtl, KeepaliveTtlChoice, KeepaliveUsage } from '../types'

export const TTL_MS: Record<KeepaliveTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
// The main conversation's TTL on a subscription outside overage. API-key
// sessions and a subscription in overage get 5m, which a mod cannot see.
export const DEFAULT_MAIN_TTL: KeepaliveTtl = '1h'
// $.model.fork sends as querySource "hook_prompt", which takes the subagent TTL.
export const DEFAULT_FORK_TTL: KeepaliveTtl = '5m'
// Served from the cache: the tokens paid in full (uncached input plus cache
// writes) stay under this share of the tokens read.
export const COLD_SHARE = 0.1

// Raw values as the environment and the settings hold them.
export type TtlSources = {
  force5m?: string
  enable1h?: string
  mainEnv?: string
  mainSetting?: unknown
  forkEnv?: string
  forkSetting?: unknown
  // Whether $.session.usage() lists plan limits; undefined before the first answer or when unreadable.
  hasPlanLimits?: boolean
}

export const SUBSCRIPTION_SOURCE = 'default (subscription)'

export const isTtl = (value: unknown): value is KeepaliveTtl => value === '5m' || value === '1h'

/** An environment flag set to anything but an empty or false-like word. */
export const isFlag = (value: string | undefined): boolean =>
  value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())

export function mainTtl(s: TtlSources): KeepaliveTtlChoice {
  if (isFlag(s.force5m)) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  if (isTtl(s.mainEnv)) return { ttl: s.mainEnv, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  if (isTtl(s.mainSetting)) return { ttl: s.mainSetting, source: 'promptCacheTtl' }
  if (isFlag(s.enable1h)) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }
  // No plan limits after the first answer: no subscription, so Claude Code picks 5m.
  if (s.hasPlanLimits === false) return { ttl: '5m', source: 'default (no subscription)' }
  return { ttl: DEFAULT_MAIN_TTL, source: SUBSCRIPTION_SOURCE }
}

export function forkTtl(s: TtlSources): KeepaliveTtlChoice {
  if (isFlag(s.force5m)) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  if (isTtl(s.forkEnv)) return { ttl: s.forkEnv, source: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' }
  if (isTtl(s.forkSetting)) return { ttl: s.forkSetting, source: 'subagentPromptCacheTtl' }
  if (isFlag(s.enable1h)) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }
  return { ttl: DEFAULT_FORK_TTL, source: 'default' }
}

export const pickUsage = (u: ModelUsage): KeepaliveUsage => ({
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  cache_read_input_tokens: u.cache_read_input_tokens,
  cache_creation_input_tokens: u.cache_creation_input_tokens,
})

export const promptTokens = (u: KeepaliveUsage): number =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export const isWarm = (u: KeepaliveUsage): boolean =>
  u.cache_read_input_tokens > 0 &&
  u.input_tokens + u.cache_creation_input_tokens < COLD_SHARE * u.cache_read_input_tokens

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** "4:05" below an hour, "1h05" from one hour up; a negative span reads 0:00. */
export function fmtSpan(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** "90s", "4m", "1h" in milliseconds; anything else, or zero, is null. */
export function parseSpan(text: string): number | null {
  const m = /^(\d{1,4})(s|m|h)$/.exec(text.trim().toLowerCase())
  if (m === null || m[1] === undefined || m[2] === undefined) return null
  const n = Number(m[1])
  if (n <= 0) return null
  return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000)
}

export function usageLine(u: KeepaliveUsage): string {
  const total = promptTokens(u)
  const share = total === 0 ? 0 : Math.round((u.cache_read_input_tokens / total) * 100)
  return (
    `read ${fmtTokens(u.cache_read_input_tokens)} · write ${fmtTokens(u.cache_creation_input_tokens)} · ` +
    `input ${fmtTokens(u.input_tokens)} · aus Cache ${share} % → ${isWarm(u) ? 'warm' : 'KALT'}`
  )
}

export function ttlLine(main: KeepaliveTtlChoice, fork: KeepaliveTtlChoice): string {
  return `TTL Hauptverlauf ${main.ttl} (${main.source}) · Fork ${fork.ttl} (${fork.source})`
}
