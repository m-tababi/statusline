import { describe, expect, test } from 'claude-code/testing'

import { PROBE_PROMPT, PROBE_USAGE } from '../hooks/probe'
import { COLD, MIN, START, ZERO, command, start, turn, world } from './world'

// Probes run with the keep-alive off (Task 4 refuses them otherwise).
const OFF = { store: { enabled: false } }

describe('/keepalive-probe', () => {
  test('without arguments it prints the usage', async ($, on) => {
    world(on, OFF)
    await start($)
    expect(await command($, 'keepalive-probe', '')).toBe(PROBE_USAGE)
  })

  test('ttl names the defaults', async ($, on) => {
    world(on, OFF)
    await start($)
    expect(await command($, 'keepalive-probe', 'ttl')).toBe('TTL Hauptverlauf 1h (default (subscription)) · Fork 5m (default)')
  })

  test('ttl follows the environment and the settings', async ($, on) => {
    world(on, { ...OFF, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, settings: { subagentPromptCacheTtl: '1h' } })
    await start($)
    expect(await command($, 'keepalive-probe', 'ttl')).toBe(
      'TTL Hauptverlauf 5m (CLAUDE_CODE_PROMPT_CACHE_TTL) · Fork 1h (subagentPromptCacheTtl)',
    )
  })

  test('now before any request refuses without forking', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    expect(await command($, 'keepalive-probe', 'now')).toContain('Noch keine Anfrage')
    expect(seen.forks).toEqual([])
  })

  test('now forks once, logs it, then logs and stores the next real request only', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(4 * MIN)

    const text = await command($, 'keepalive-probe', 'now')

    expect(seen.forks).toEqual([PROBE_PROMPT])
    expect(text).toBe(
      '[keepalive-probe] Fork 4:00 nach der letzten Anfrage · read 40.0k · write 120 · input 3 · aus Cache 100 % → warm · ' +
        'TTL Hauptverlauf 1h (default (subscription)) · Fork 5m (default)',
    )
    expect(seen.logs).toEqual([text])

    await seen.clock.advance(3 * MIN)
    await turn($, 't2')
    expect(seen.logs[1]).toBe(
      '[keepalive-probe] Probe: Folgeanfrage 7:00 nach der Anfrage vor der Probe · 3:00 nach dem Fork · ' +
        'read 40.0k · write 120 · input 3 · aus Cache 100 % → warm',
    )
    const probes = seen.stored.get('probes') as unknown[]
    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatchObject({
      kind: 'probe', anchorAt: START, fork: { at: START + 4 * MIN }, followUp: { at: START + 7 * MIN },
    })

    await turn($, 't3')
    expect(seen.logs).toHaveLength(2)
  })

  test('a cold follow-up reads KALT', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive-probe', 'now')
    seen.stepUsage = COLD
    await turn($, 't2')
    expect(seen.logs[1]).toContain('aus Cache 45 % → KALT')
  })

  test('at 4m forks four minutes after the last request, not before', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(1 * MIN)

    expect(await command($, 'keepalive-probe', 'at 4m')).toBe(
      'Probe-Fork in 3:00 (4:00 nach der letzten Anfrage). Bis dahin nichts eingeben.',
    )
    await seen.clock.advance(3 * MIN - 1)
    expect(seen.forks).toEqual([])
    await seen.clock.advance(1)
    expect(seen.forks).toEqual([PROBE_PROMPT])
    expect(seen.logs[0]).toMatch(/^\[keepalive-probe\] Fork 4:00 nach der letzten Anfrage/)
  })

  test('at refuses a time already past', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(5 * MIN)
    expect(await command($, 'keepalive-probe', 'at 4m')).toBe('Der Zeitpunkt ist schon vorbei (vor 1:00).')
  })

  test('a timed probe skips while a turn runs', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive-probe', 'at 4m')
    await $.turn.start({ text: 'x', turnId: 't2' })
    await seen.clock.advance(4 * MIN)
    expect(seen.forks).toEqual([])
    expect(seen.logs).toEqual(['[keepalive-probe] Ein Turn läuft – Probe erst danach.'])
  })

  test('control forks nothing and logs the next request as Kontrolle', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    expect(await command($, 'keepalive-probe', 'control')).toMatch(/^\[keepalive-probe\] Kontrolle gesetzt \(kein Fork\)/)
    await seen.clock.advance(7 * MIN)
    await turn($, 't2')
    expect(seen.forks).toEqual([])
    expect(seen.logs[1]).toMatch(/^\[keepalive-probe\] Kontrolle: Folgeanfrage 7:00 nach der Anfrage vor der Probe · read/)
  })

  test('report lists stored probes and the pending one', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive-probe', 'now')
    await turn($, 't2')
    await command($, 'keepalive-probe', 'control')
    const lines = (await command($, 'keepalive-probe', 'report')).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('  (wartet auf die nächste Anfrage)')
    expect(seen.forks).toHaveLength(1)
  })

  test('a failed fork is reported and nothing waits for a follow-up', async ($, on) => {
    const seen = world(on, OFF)
    seen.forkReplies.push({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: ZERO })
    await start($)
    await turn($, 't1')
    expect(await command($, 'keepalive-probe', 'now')).toBe('API-Fehler 429 (rate_limit).')
    await turn($, 't2')
    expect(seen.logs).toEqual([])
  })

  test('/clear drops a pending probe', async ($, on) => {
    const seen = world(on, OFF)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive-probe', 'now')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await turn($, 't2')
    expect(seen.logs).toHaveLength(1)
  })
})
