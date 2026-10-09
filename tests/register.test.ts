import { describe, expect, test } from 'claude-code/testing'
import type { ModelForkResult } from 'claude-code'

import { FORK_PING_PROMPT, KEEPALIVE_USAGE, REASON } from '../hooks/keepalive'
import { COLD, HOME, MIN, START, ZERO, command, complete, forkReply, start, stepOnly, turn, world } from './world'

const FILE = `${HOME}/.claude/keepalive/s1.json`
const status = (seen: ReturnType<typeof world>) => JSON.parse(seen.files.get(FILE) ?? 'null') as Record<string, unknown> | null

describe('keep-alive timing', () => {
  test('pings once, five minutes before a 1h entry expires, then re-dates the entry', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    expect(status(seen)).toMatchObject({
      v: 1, sessionId: 's1', enabled: true, state: 'armed', reason: null, nextPingAt: START + 55 * MIN, warmUntil: null,
    })

    await seen.clock.advance(55 * MIN - 1)
    expect(seen.forks).toEqual([])
    await seen.clock.advance(1)
    expect(seen.forks).toEqual([FORK_PING_PROMPT])
    expect(status(seen)).toMatchObject({ state: 'armed', nextPingAt: START + 110 * MIN, warmUntil: START + 115 * MIN })
  })

  test('keeps pinging while idle, with no cap', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(4 * 55 * MIN)
    expect(seen.forks).toHaveLength(4)
  })

  test('a 5m entry is pinged after four minutes', async ($, on) => {
    const seen = world(on, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await start($)
    await turn($, 't1')
    await seen.clock.advance(4 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('no ping while a turn runs; the turn re-arms from its own request', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(50 * MIN)
    await $.turn.start({ text: 'x', turnId: 't2' })
    await seen.clock.advance(10 * MIN)
    expect(seen.forks).toEqual([])
    await stepOnly($, 't2')
    await complete($, 't2')
    expect(status(seen)).toMatchObject({ state: 'armed', nextPingAt: START + 115 * MIN })
  })

  test('a timer that comes too late does not fork and pauses', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive', 'off')
    await seen.clock.advance(60 * MIN - 10_000)
    const text = await command($, 'keepalive', 'on')
    expect(seen.forks).toEqual([])
    expect(text).toContain(`pausiert: ${REASON.late}`)
    expect(status(seen)).toMatchObject({ state: 'paused', reason: REASON.late })
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toEqual([])
  })

  test('a second session.start (hot reload) re-arms without a second ping', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(30 * MIN)
    await start($)
    await seen.clock.advance(25 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('a non-interactive session never pings and writes no file', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await turn($, 't1')
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toEqual([])
    expect(seen.files.size).toBe(0)
  })

  test('CLAUDE_CONFIG_DIR moves the status file', async ($, on) => {
    const seen = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg/' } })
    await start($)
    await turn($, 't1')
    expect([...seen.files.keys()]).toEqual(['/cfg/keepalive/s1.json'])
  })
})

describe('keep-alive verification', () => {
  test('a cold ping pauses until the next real turn', async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push(forkReply(COLD))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
    expect(seen.toasts).toEqual(['Keep-alive pausiert: Cache war kalt (read 18.0k, voll bezahlt 22.0k)'])
    expect(status(seen)).toMatchObject({ state: 'paused', warmUntil: null })

    await seen.clock.advance(3 * 60 * MIN)
    expect(seen.forks).toHaveLength(1)

    await turn($, 't2')
    expect(status(seen)).toMatchObject({ state: 'armed', reason: null, nextPingAt: seen.clock.now() + 55 * MIN })
  })

  test('an API error pauses', async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: ZERO })
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(status(seen)).toMatchObject({ state: 'paused', reason: 'Ping fehlgeschlagen: API-Fehler 429' })
  })

  test('nothing to fork pauses', async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push({ isAnswered: false, reason: 'nothing-to-fork' })
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(status(seen)).toMatchObject({ state: 'paused', reason: REASON.nothingToFork })
  })

  test('single flight: no second fork while one runs', async ($, on) => {
    const seen = world(on)
    let release: (value: ModelForkResult) => void = () => undefined
    seen.forkReplies.push(() => new Promise<ModelForkResult>(resolve => (release = resolve)))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(status(seen)).toMatchObject({ state: 'pinging' })
    await command($, 'keepalive', 'on')
    await seen.clock.advance(1000)
    expect(seen.forks).toHaveLength(1)
    release(forkReply())
    await seen.clock.settle()
    expect(seen.forks).toHaveLength(1)
    expect(status(seen)).toMatchObject({ state: 'armed', nextPingAt: START + 110 * MIN })
  })
})

describe('built-in keep-alive', () => {
  const CONFIG = `${HOME}/.claude.json`
  const flag = (value: unknown) => JSON.stringify({ cachedGrowthBookFeatures: { tengu_sequential_cloud: value } })

  test('flag on: no ping while its activity window covers the entry, then the normal cadence', async ($, on) => {
    const seen = world(on)
    seen.readable.set(CONFIG, flag({ enabled: true }))
    await start($)
    await turn($, 't1')
    // Window ends at 60m; the last touch counts from 59.5m, so the ping comes at 114.5m.
    await seen.clock.advance(114 * MIN)
    expect(seen.forks).toEqual([])
    await seen.clock.advance(31_000)
    expect(seen.forks).toEqual([FORK_PING_PROMPT])
  })

  test('flag false: the normal cadence', async ($, on) => {
    const seen = world(on)
    seen.readable.set(CONFIG, flag(false))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('a broken ~/.claude.json reads as off', async ($, on) => {
    const seen = world(on)
    seen.readable.set(CONFIG, '{"cachedGrowthBookFeatures":')
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('flag on but the TTL set by environment: the built-in one is off, the normal cadence', async ($, on) => {
    const seen = world(on, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
    seen.readable.set(CONFIG, flag({ enabled: true }))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('CLAUDE_CONFIG_DIR moves the global config file too', async ($, on) => {
    const seen = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' } })
    seen.readable.set('/cfg/.claude.json', flag({ enabled: true }))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toEqual([])
  })

  test('/keepalive status names the flag state', async ($, on) => {
    const seen = world(on)
    seen.readable.set(CONFIG, flag({ enabled: true }))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(5 * MIN)
    expect((await command($, 'keepalive', 'status')).split('\n')[2]).toBe(
      'Eingebauter Keep-alive (tengu_sequential_cloud): an, deckt noch 55:00',
    )
  })
})

describe('main TTL without a subscription', () => {
  test('no plan limits after the first answer: 5m, ping after four minutes', async ($, on) => {
    const seen = world(on, { rateLimits: [] })
    await start($)
    await turn($, 't1')
    expect((await command($, 'keepalive', 'status')).split('\n')[1]).toBe(
      'TTL Hauptverlauf 5m (default (no subscription)) · Fork 5m (default)',
    )
    await seen.clock.advance(4 * MIN)
    expect(seen.forks).toHaveLength(1)
  })
})

describe('/keepalive', () => {
  test('status by default, usage on unknown words', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(5 * MIN)
    expect((await command($, 'keepalive', '')).split('\n')).toEqual([
      'Keep-alive an · bereit',
      'TTL Hauptverlauf 1h (default (subscription)) · Fork 5m (default)',
      'Eingebauter Keep-alive (tengu_sequential_cloud): nicht lesbar, gilt als aus',
      'Letzte Anfrage vor 5:00 (Turn)',
      'Nächster Ping in 50:00',
    ])
    expect(await command($, 'keepalive', 'maybe')).toBe(KEEPALIVE_USAGE)
  })

  test('off stops pings, persists into a new session; on turns them back on', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    expect((await command($, 'keepalive', 'off')).split('\n')[0]).toBe('Keep-alive aus')
    expect(seen.stored.get('enabled')).toBe(false)
    expect(status(seen)).toMatchObject({ enabled: false, state: 'off' })
    await seen.clock.advance(3 * 60 * MIN)
    expect(seen.forks).toEqual([])

    await start($)
    await turn($, 't2')
    await seen.clock.advance(60 * MIN)
    expect(seen.forks).toEqual([])

    await command($, 'keepalive', 'on')
    expect(seen.stored.get('enabled')).toBe(true)
    await turn($, 't3')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('off written by another session stops this one at its next due time', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    seen.stored.set('enabled', false)
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toEqual([])
    expect(status(seen)).toMatchObject({ state: 'off' })
  })
})

describe('pauses', () => {
  test('compaction pauses until the next turn', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect(status(seen)).toMatchObject({ state: 'paused', reason: REASON.compacted })
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toEqual([])
    await turn($, 't2')
    expect(status(seen)).toMatchObject({ state: 'armed' })
  })

  test("a subagent's compaction and a precompute do not pause", async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    const messages = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages })
    await $.session.compact({ trigger: 'precompute', messages })
    expect(status(seen)).toMatchObject({ state: 'armed', nextPingAt: START + 55 * MIN })
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('a model switch pauses', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await $.classic.PostModelSwitch({
      from_model: 'claude-opus-5-5',
      to_model: 'claude-sonnet-5',
      requested_model: 'sonnet',
      source: 'command',
      context_tokens: 40_000,
      prompt_cache_warm: true,
      cache_ttl: '1h',
      estimated_cache_write_usd: 0.4,
      pricing: 'catalog',
    })
    expect(status(seen)).toMatchObject({ state: 'paused', reason: REASON.modelSwitch })
    await seen.clock.advance(60 * MIN)
    expect(seen.forks).toEqual([])
  })

  test('/clear pauses and writes the ending session file', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(status(seen)).toMatchObject({ state: 'paused', reason: REASON.cleared })
    await seen.clock.advance(60 * MIN)
    expect(seen.forks).toEqual([])
  })
})

describe('races', () => {
  test('overlapping arms leave one live timer: one fork', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await Promise.all([command($, 'keepalive', 'on'), command($, 'keepalive', 'on'), command($, 'keepalive', 'on')])
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('a slow fork and further arms still make one fork', async ($, on) => {
    const seen = world(on)
    let release: (value: ModelForkResult) => void = () => undefined
    seen.forkReplies.push(() => new Promise<ModelForkResult>(resolve => (release = resolve)))
    await start($)
    await turn($, 't1')
    await Promise.all([seen.clock.advance(55 * MIN), command($, 'keepalive', 'on'), command($, 'keepalive', 'on')])
    await seen.clock.advance(MIN)
    expect(seen.forks).toHaveLength(1)
    release(forkReply())
    await seen.clock.settle()
    expect(seen.forks).toHaveLength(1)
  })

  test('a session that ends while the ping status is written sends no fork', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    seen.afterWrite = async () => {
      if (!seen.files.get(FILE)?.includes('"pinging"')) return
      seen.afterWrite = undefined
      await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    }
    void seen.clock.advance(55 * MIN)
    await seen.clock.settle()
    expect(seen.forks).toEqual([])
    expect(status(seen)).toMatchObject({ state: 'paused', reason: REASON.cleared })
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toEqual([])
  })

  test('a ping in flight at session end writes nothing afterwards', async ($, on) => {
    const seen = world(on)
    let release: (value: ModelForkResult) => void = () => undefined
    seen.forkReplies.push(() => new Promise<ModelForkResult>(resolve => (release = resolve)))
    await start($)
    await turn($, 't1')
    void seen.clock.advance(55 * MIN)
    await seen.clock.settle()
    expect(status(seen)).toMatchObject({ state: 'pinging' })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    const written = seen.files.get(FILE)
    release(forkReply(COLD))
    await seen.clock.settle()
    expect(seen.files.get(FILE)).toBe(written)
    expect(status(seen)).toMatchObject({ state: 'paused', reason: REASON.cleared })
    expect(seen.toasts).toEqual([])
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toHaveLength(1)
  })
})
