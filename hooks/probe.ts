// The /keepalive-probe measurement: what it asks the fork, how it reads its
// arguments and how it words what it saw.
import type { ModelForkResult } from 'claude-code'

import type { KeepaliveProbe, KeepaliveUsage } from '../types'
import { fmtSpan, parseSpan, ttlLine, usageLine } from './cache'

export const PROBE_PROMPT =
  '[keepalive-probe] Measuring the prompt cache, not a message from the user. Do not call any tools. Reply with the single word ok.'
// Finished probes the store keeps, newest last.
export const PROBE_KEEP = 20
export const PROBE_USAGE = 'Nutzung: /keepalive-probe ttl | now | at <Dauer, z. B. 4m oder 50m> | control | report'

export type ProbeArgs =
  | { verb: 'ttl' }
  | { verb: 'now' }
  | { verb: 'control' }
  | { verb: 'report' }
  | { verb: 'at'; ms: number }

export function parseProbeArgs(args: string): ProbeArgs | null {
  const words = args.trim().toLowerCase().split(/\s+/).filter(w => w !== '')
  const [verb, value] = words
  if (words.length === 1 && (verb === 'ttl' || verb === 'now' || verb === 'control' || verb === 'report')) {
    return { verb }
  }
  if (words.length === 2 && verb === 'at' && value !== undefined) {
    const ms = parseSpan(value)
    return ms === null ? null : { verb: 'at', ms }
  }
  return null
}

/** Why a fork reply carries nothing to measure; null when it carries usage. */
export function forkFailure(reply: ModelForkResult): string | null {
  if (reply.isAnswered) return null
  if (reply.reason === 'nothing-to-fork') return 'Nichts zu forken: noch keine Antwort in diesem Verlauf (oder direkt nach /clear).'
  if (reply.reason === 'api-error') return `API-Fehler ${reply.status ?? 'ohne Status'} (${reply.error}).`
  if (reply.reason === 'aborted') return 'Fork abgebrochen.'
  return null
}

export function forkLine(r: KeepaliveProbe): string {
  const ttl = ttlLine(r.mainTtl, r.forkTtl)
  if (r.fork === null) return `[keepalive-probe] Kontrolle gesetzt (kein Fork) · ${ttl}`
  const step = r.forkRaisedStep ? ' · der Fork löste einen Haupt-turn.step aus' : ''
  return `[keepalive-probe] Fork ${fmtSpan(r.fork.at - r.anchorAt)} nach der letzten Anfrage · ${usageLine(r.fork.usage)}${step} · ${ttl}`
}

export function followUpLine(r: KeepaliveProbe, at: number, usage: KeepaliveUsage): string {
  const who = r.fork === null ? 'Kontrolle' : 'Probe'
  const afterFork = r.fork === null ? '' : ` · ${fmtSpan(at - r.fork.at)} nach dem Fork`
  return `[keepalive-probe] ${who}: Folgeanfrage ${fmtSpan(at - r.anchorAt)} nach der Anfrage vor der Probe${afterFork} · ${usageLine(usage)}`
}

export function reportText(done: readonly KeepaliveProbe[], pending: KeepaliveProbe | null): string {
  const lines: string[] = []
  for (const r of done) {
    lines.push(forkLine(r))
    lines.push(r.followUp === null ? '  (keine Folgeanfrage)' : followUpLine(r, r.followUp.at, r.followUp.usage))
  }
  if (pending !== null) {
    lines.push(forkLine(pending))
    lines.push('  (wartet auf die nächste Anfrage)')
  }
  return lines.length === 0 ? 'Noch keine Probe gespeichert.' : lines.join('\n')
}
