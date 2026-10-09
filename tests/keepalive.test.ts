import { expect, test } from 'claude-code/testing'

import {
  BUILTIN_OFF, REASON, anchorAfterPing, coveredAnchor, nextStep, parseBuiltin, parseKeepalive, pingDelayMs, settlePing,
  statusFile, statusText,
} from '../hooks/keepalive'
import type { Gate } from '../hooks/keepalive'

const T0 = 10_000_000
const MIN = 60_000
const WARM = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 120 }
const COLD = { input_tokens: 22_000, output_tokens: 2, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 0 }
const gate = (o: Partial<Gate> = {}): Gate => ({
  isEnabled: true,
  isInteractive: true,
  isTurnRunning: false,
  isForking: false,
  pause: null,
  anchor: { at: T0, source: 'turn' },
  main: { ttl: '1h', source: 'default (subscription)' },
  fork: { ttl: '5m', source: 'default' },
  forkTtlMustMatch: false,
  builtin: BUILTIN_OFF,
  activityAt: T0,
  ...o,
})
const ON = { state: 'on' as const, windowMs: 60 * MIN, touchMs: 30_000 }

test('ping delay: five minutes before a 1h entry ends, a fifth before a 5m one', () => {
  expect(pingDelayMs(60 * MIN)).toBe(55 * MIN)
  expect(pingDelayMs(5 * MIN)).toBe(4 * MIN)
})

test('next step: off, hold, busy, wait, ping, late', () => {
  expect(nextStep(gate({ isEnabled: false }), T0)).toEqual({ kind: 'off' })
  expect(nextStep(gate({ isInteractive: false }), T0)).toEqual({ kind: 'hold', reason: REASON.notInteractive })
  expect(nextStep(gate({ isTurnRunning: true }), T0)).toEqual({ kind: 'busy' })
  expect(nextStep(gate({ isForking: true }), T0)).toEqual({ kind: 'busy' })
  expect(nextStep(gate({ pause: 'x' }), T0)).toEqual({ kind: 'hold', reason: 'x' })
  expect(nextStep(gate({ anchor: null }), T0)).toEqual({ kind: 'hold', reason: REASON.noAnchor })
  expect(nextStep(gate(), T0)).toEqual({ kind: 'wait', at: T0 + 55 * MIN })
  expect(nextStep(gate(), T0 + 55 * MIN - 1)).toEqual({ kind: 'wait', at: T0 + 55 * MIN })
  expect(nextStep(gate(), T0 + 55 * MIN)).toEqual({ kind: 'ping' })
  expect(nextStep(gate(), T0 + 60 * MIN - 20_001)).toEqual({ kind: 'ping' })
  expect(nextStep(gate(), T0 + 60 * MIN - 20_000)).toEqual({ kind: 'late' })
  expect(nextStep(gate({ main: { ttl: '5m', source: 'x' } }), T0)).toEqual({ kind: 'wait', at: T0 + 4 * MIN })
})

test('the built-in flag: an object is on (with its window), anything else off, no text unreadable', () => {
  const flag = (value: unknown) => JSON.stringify({ cachedGrowthBookFeatures: { tengu_sequential_cloud: value } })
  expect(parseBuiltin(flag({ enabled: true }))).toEqual(ON)
  expect(parseBuiltin(flag({}))).toEqual(ON)
  expect(parseBuiltin(flag({ activityWindowMinutes: 30, touchIntervalSeconds: 60 }))).toEqual({
    state: 'on', windowMs: 30 * MIN, touchMs: 60_000,
  })
  expect(parseBuiltin(flag({ activityWindowMinutes: 0, touchIntervalSeconds: 5 }))).toEqual(ON)
  for (const off of [false, true, 'on', 1, null, [], { enabled: false }]) expect(parseBuiltin(flag(off))).toEqual(BUILTIN_OFF)
  expect(parseBuiltin('{}')).toEqual(BUILTIN_OFF)
  expect(parseBuiltin('null')).toEqual(BUILTIN_OFF)
  expect(parseBuiltin(null).state).toBe('unreadable')
  expect(parseBuiltin('{"cachedGrowth').state).toBe('unreadable')
})

test('while the built-in keep-alive touches the entry, the plugin waits for the window to end', () => {
  const g = gate({ builtin: ON, activityAt: T0 })
  expect(coveredAnchor(g, T0, T0)).toBe(T0)
  expect(coveredAnchor(g, T0, T0 + 30 * MIN)).toBe(T0 + 30 * MIN - 30_000)
  expect(coveredAnchor(g, T0, T0 + 3 * 60 * MIN)).toBe(T0 + 60 * MIN - 30_000)
  expect(nextStep(g, T0 + 55 * MIN)).toEqual({ kind: 'wait', at: T0 + 110 * MIN - 30_000 })
  expect(nextStep(g, T0 + 114 * MIN)).toEqual({ kind: 'wait', at: T0 + 115 * MIN - 30_000 })
  expect(nextStep(g, T0 + 115 * MIN - 30_000)).toEqual({ kind: 'ping' })
  // Not at a TTL set by environment or settings, and not with the flag off or unreadable.
  expect(coveredAnchor(gate({ builtin: ON, main: { ttl: '1h', source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' } }), T0, T0 + 30 * MIN)).toBe(T0)
  expect(coveredAnchor(gate({ builtin: { ...ON, state: 'unreadable' } }), T0, T0 + 30 * MIN)).toBe(T0)
  expect(coveredAnchor(gate({ builtin: ON, activityAt: null }), T0, T0 + 30 * MIN)).toBe(T0)
})

test('a short fork TTL holds only when the probe said it must match', () => {
  expect(nextStep(gate({ forkTtlMustMatch: true }), T0)).toEqual({ kind: 'hold', reason: REASON.forkTtl })
  expect(nextStep(gate({ forkTtlMustMatch: true, fork: { ttl: '1h', source: 'x' } }), T0).kind).toBe('wait')
  expect(nextStep(gate({ forkTtlMustMatch: false }), T0).kind).toBe('wait')
})

test('status file: armed, pinging, paused, off; warmUntil only after a verified ping', () => {
  expect(statusFile('s1', gate(), { kind: 'wait', at: T0 + 55 * MIN }, T0)).toEqual({
    v: 1, sessionId: 's1', enabled: true, state: 'armed', reason: null, nextPingAt: T0 + 55 * MIN, warmUntil: null, updatedAt: T0,
  })
  const pinged = gate({ anchor: { at: T0, source: 'ping' } })
  expect(statusFile('s1', pinged, { kind: 'wait', at: T0 + 55 * MIN }, T0).warmUntil).toBe(T0 + 60 * MIN)
  expect(statusFile('s1', gate({ isTurnRunning: true }), { kind: 'busy' }, T0)).toMatchObject({ state: 'armed', nextPingAt: null })
  expect(statusFile('s1', gate({ isForking: true }), { kind: 'busy' }, T0).state).toBe('pinging')
  expect(statusFile('s1', gate(), { kind: 'hold', reason: 'r' }, T0)).toMatchObject({ state: 'paused', reason: 'r', warmUntil: null })
  expect(statusFile('s1', gate({ isEnabled: false }), { kind: 'off' }, T0)).toMatchObject({ enabled: false, state: 'off', reason: null })
})

test('settling a ping', () => {
  expect(settlePing({ isAnswered: true, text: 'ok', usage: WARM }, T0)).toEqual({
    pause: null, ping: { at: T0, usage: WARM, isWarm: true },
  })
  expect(settlePing({ isAnswered: false, reason: 'empty-reply', usage: WARM }, T0).pause).toBe(null)
  expect(settlePing({ isAnswered: true, text: 'ok', usage: COLD }, T0).pause).toBe('Cache war kalt (read 18.0k, voll bezahlt 22.0k)')
  expect(settlePing({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: WARM }, T0).pause).toBe(
    'Ping fehlgeschlagen: API-Fehler 429',
  )
  expect(settlePing({ isAnswered: false, reason: 'aborted', usage: WARM }, T0).pause).toBe(REASON.aborted)
  expect(settlePing({ isAnswered: false, reason: 'nothing-to-fork' }, T0)).toEqual({ pause: REASON.nothingToFork, ping: null })
})

test('the anchor after a ping: a newer turn wins, a failed ping changes nothing', () => {
  const turnAt = { at: T0 + 10, source: 'turn' as const }
  expect(anchorAfterPing({ at: T0 - 5, source: 'turn' }, T0, true)).toEqual({ at: T0, source: 'ping' })
  expect(anchorAfterPing(turnAt, T0, true)).toBe(turnAt)
  expect(anchorAfterPing(turnAt, T0, false)).toBe(turnAt)
  expect(anchorAfterPing(null, T0, true)).toEqual({ at: T0, source: 'ping' })
})

test('command words', () => {
  expect(parseKeepalive('')).toBe('status')
  expect(parseKeepalive(' On ')).toBe('on')
  expect(parseKeepalive('OFF')).toBe('off')
  expect(parseKeepalive('status')).toBe('status')
  expect(parseKeepalive('maybe')).toBe(null)
})

test('status text', () => {
  const g = gate()
  const now = T0 + 5 * MIN
  const armed = statusText(statusFile('s1', g, { kind: 'wait', at: T0 + 55 * MIN }, now), g, null, now)
  expect(armed.split('\n')).toEqual([
    'Keep-alive an · bereit',
    'TTL Hauptverlauf 1h (default (subscription)) · Fork 5m (default)',
    'Eingebauter Keep-alive (tengu_sequential_cloud): aus',
    'Letzte Anfrage vor 5:00 (Turn)',
    'Nächster Ping in 50:00',
  ])
  const last = { at: T0, usage: WARM, isWarm: true }
  const paused = statusText(statusFile('s1', g, { kind: 'hold', reason: 'r' }, now), g, last, now)
  expect(paused).toContain('Keep-alive an · pausiert: r')
  expect(paused).toContain('Letzter Ping vor 5:00: read 40.0k · write 120 · input 3 · aus Cache 100 % → warm')
  const lineOf = (o: Partial<Gate>) => statusText(statusFile('s1', gate(o), { kind: 'busy' }, now), gate(o), null, now).split('\n')[2]
  expect(lineOf({ builtin: ON })).toBe('Eingebauter Keep-alive (tengu_sequential_cloud): an, deckt noch 55:00')
  expect(lineOf({ builtin: ON, activityAt: T0 - 2 * 60 * MIN })).toBe('Eingebauter Keep-alive (tengu_sequential_cloud): an, Fenster abgelaufen')
  expect(lineOf({ builtin: ON, main: { ttl: '1h', source: 'promptCacheTtl' } })).toBe(
    'Eingebauter Keep-alive (tengu_sequential_cloud): an, greift hier nicht (TTL nicht Abo-Standard)',
  )
  expect(lineOf({ builtin: { ...ON, state: 'unreadable' } })).toBe('Eingebauter Keep-alive (tengu_sequential_cloud): nicht lesbar, gilt als aus')
  const off = gate({ isEnabled: false })
  expect(statusText(statusFile('s1', off, { kind: 'off' }, now), off, null, now).split('\n')[0]).toBe('Keep-alive aus')
})
