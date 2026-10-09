import { expect, test } from 'claude-code/testing'

import { followUpLine, forkFailure, forkLine, parseProbeArgs, reportText } from '../hooks/probe'
import type { KeepaliveProbe } from '../types'

const T0 = 1_000_000
const WARM = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 120 }
const record = (o: Partial<KeepaliveProbe> = {}): KeepaliveProbe => ({
  kind: 'probe',
  anchorAt: T0,
  fork: { at: T0 + 4 * 60_000, usage: WARM },
  forkRaisedStep: false,
  followUp: null,
  mainTtl: { ttl: '5m', source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' },
  forkTtl: { ttl: '5m', source: 'default' },
  ...o,
})

test('arguments', () => {
  expect(parseProbeArgs('ttl')).toEqual({ verb: 'ttl' })
  expect(parseProbeArgs(' NOW ')).toEqual({ verb: 'now' })
  expect(parseProbeArgs('control')).toEqual({ verb: 'control' })
  expect(parseProbeArgs('report')).toEqual({ verb: 'report' })
  expect(parseProbeArgs('at 4m')).toEqual({ verb: 'at', ms: 240_000 })
  for (const bad of ['', 'at', 'at x', 'at 4m now', 'now please', 'start']) expect(parseProbeArgs(bad)).toBe(null)
})

test('fork failures carry no usage worth measuring', () => {
  expect(forkFailure({ isAnswered: true, text: 'ok', usage: WARM })).toBe(null)
  expect(forkFailure({ isAnswered: false, reason: 'empty-reply', usage: WARM })).toBe(null)
  expect(forkFailure({ isAnswered: false, reason: 'nothing-to-fork' })).toContain('Nichts zu forken')
  expect(forkFailure({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: WARM })).toBe(
    'API-Fehler 429 (rate_limit).',
  )
  expect(forkFailure({ isAnswered: false, reason: 'aborted', usage: WARM })).toBe('Fork abgebrochen.')
})

test('lines', () => {
  const ttl = 'TTL Hauptverlauf 5m (CLAUDE_CODE_PROMPT_CACHE_TTL) · Fork 5m (default)'
  expect(forkLine(record())).toBe(
    `[keepalive-probe] Fork 4:00 nach der letzten Anfrage · read 40.0k · write 120 · input 3 · aus Cache 100 % → warm · ${ttl}`,
  )
  expect(forkLine(record({ forkRaisedStep: true }))).toContain('· der Fork löste einen Haupt-turn.step aus ·')
  expect(forkLine(record({ kind: 'control', fork: null }))).toBe(`[keepalive-probe] Kontrolle gesetzt (kein Fork) · ${ttl}`)
  expect(followUpLine(record(), T0 + 7 * 60_000, WARM)).toBe(
    '[keepalive-probe] Probe: Folgeanfrage 7:00 nach der Anfrage vor der Probe · 3:00 nach dem Fork · read 40.0k · write 120 · input 3 · aus Cache 100 % → warm',
  )
  expect(followUpLine(record({ kind: 'control', fork: null }), T0 + 7 * 60_000, WARM)).toMatch(
    /^\[keepalive-probe\] Kontrolle: Folgeanfrage 7:00 nach der Anfrage vor der Probe · read/,
  )
})

test('report', () => {
  expect(reportText([], null)).toBe('Noch keine Probe gespeichert.')
  const done = record({ followUp: { at: T0 + 7 * 60_000, usage: WARM } })
  const text = reportText([done], record({ kind: 'control', fork: null }))
  const lines = text.split('\n')
  expect(lines).toHaveLength(4)
  expect(lines[1]).toContain('Probe: Folgeanfrage 7:00')
  expect(lines[3]).toBe('  (wartet auf die nächste Anfrage)')
})
