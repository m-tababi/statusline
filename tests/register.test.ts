import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

import { FORK_PING_PROMPT, KEEPALIVE_USAGE, PILL, REASON } from '../hooks/keepalive'
import {
  COLD, ENGINE_LINE, HINT, HOME, MIN, START, ZERO, command, complete, forkReply, hintLine, peek, PEEK, start, stepOnly, turn, world,
} from './world'

const NEXT_PING = 'Nächster Ping in '
const WITH_PEEK = { plugins: [PEEK] }

// Holds the keep-alive's "pinging" write for a second: the await before the fork.
const SLOW_PINGING = {
  name: 'slow-pinging',
  register(on: On) {
    on('state.set', { plugin: 'statusline', key: 'hint' }, async ($, e, next) => {
      if ((e.value as { state?: unknown } | null)?.state === 'pinging') await $.clock.sleep(1000)
      return next(e)
    })
  },
}

/** What the hint line draws from, with the reason and the next ping as /keepalive status says them. */
async function status($: Engine) {
  const snap = (await peek($)).hint
  const lines = (await command($, 'keepalive', 'status')).split('\n')
  return {
    state: snap?.state ?? null,
    anchorAt: snap?.anchorAt ?? null,
    isCold: snap?.isCold ?? null,
    reason: /^Keep-alive an \(diese Sitzung\) · [^:]+: (.*)$/.exec(lines[0] ?? '')?.[1] ?? null,
    nextPing: lines.find(line => line.startsWith(NEXT_PING))?.slice(NEXT_PING.length) ?? null,
  }
}

describe('keep-alive timing', () => {
  test('pings once, five minutes before a 1h entry expires, then re-dates the entry', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    expect(await status($)).toEqual({ state: 'armed', anchorAt: START, isCold: false, reason: null, nextPing: '55:00' })

    await seen.clock.advance(55 * MIN - 1)
    expect(seen.forks).toEqual([])
    await seen.clock.advance(1)
    expect(seen.forks).toEqual([FORK_PING_PROMPT])
    // The ping re-dated the entry: the next one is 55 minutes after it.
    expect(await status($)).toMatchObject({ state: 'armed', anchorAt: START + 55 * MIN, nextPing: '55:00' })
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

  test('no ping while a turn runs; the turn re-arms from its own request', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(50 * MIN)
    await $.turn.start({ text: 'x', turnId: 't2' })
    await seen.clock.advance(10 * MIN)
    expect(seen.forks).toEqual([])
    await stepOnly($, 't2')
    await complete($, 't2')
    expect(await status($)).toMatchObject({ state: 'armed', anchorAt: START + 60 * MIN, nextPing: '55:00' })
  })

  test('a timer that comes too late does not fork and pauses', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive', 'off')
    await seen.clock.advance(60 * MIN - 10_000)
    const text = await command($, 'keepalive', 'on')
    expect(seen.forks).toEqual([])
    expect(text).toContain(`pausiert: ${REASON.late}`)
    expect(await status($)).toMatchObject({ state: 'paused', reason: REASON.late })
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

  test('a non-interactive session never pings and leaves the hint line alone', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($, false)
    await turn($, 't1')
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toEqual([])
    expect((await peek($)).hint).toBe(null)
  })

  test('no file is written, pings and pauses included', async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push(forkReply(), forkReply(COLD))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(2 * 55 * MIN)
    expect(seen.forks).toHaveLength(2)
    await command($, 'keepalive', 'off')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(seen.files.size).toBe(0)
  })
})

describe('keep-alive verification', () => {
  test('a cold ping pauses until the next real turn', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push(forkReply(COLD))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
    expect(seen.toasts).toEqual(['Keep-alive pausiert: Cache war kalt (read 18.0k, voll bezahlt 22.0k)'])
    expect(await status($)).toMatchObject({ state: 'paused', isCold: true })

    await seen.clock.advance(3 * 60 * MIN)
    expect(seen.forks).toHaveLength(1)

    await turn($, 't2')
    expect(await status($)).toMatchObject({ state: 'armed', isCold: false, reason: null, nextPing: '55:00' })
  })

  test('an API error pauses', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: ZERO })
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(await status($)).toMatchObject({ state: 'paused', reason: 'Ping fehlgeschlagen: API-Fehler 429' })
  })

  test('nothing to fork pauses', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push({ isAnswered: false, reason: 'nothing-to-fork' })
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(await status($)).toMatchObject({ state: 'paused', reason: REASON.nothingToFork })
  })

  test('single flight: no second fork while one runs', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    let release: (value: ModelForkResult) => void = () => undefined
    seen.forkReplies.push(() => new Promise<ModelForkResult>(resolve => (release = resolve)))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(await status($)).toMatchObject({ state: 'pinging' })
    await command($, 'keepalive', 'on')
    await seen.clock.advance(1000)
    expect(seen.forks).toHaveLength(1)
    release(forkReply())
    await seen.clock.settle()
    expect(seen.forks).toHaveLength(1)
    expect(await status($)).toMatchObject({ state: 'armed', anchorAt: START + 55 * MIN, nextPing: '54:59' })
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
      'Keep-alive an (diese Sitzung) · bereit',
      'TTL Hauptverlauf 1h (default (subscription)) · Fork 5m (default)',
      'Eingebauter Keep-alive (tengu_sequential_cloud): nicht lesbar, gilt als aus',
      'Letzte Anfrage vor 5:00 (Turn)',
      'Nächster Ping in 50:00',
    ])
    expect(await command($, 'keepalive', 'maybe')).toBe(KEEPALIVE_USAGE)
  })

  test('off stops pings for this session and survives a hot reload; on plans again', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    expect((await command($, 'keepalive', 'off')).split('\n')[0]).toBe('Keep-alive aus (diese Sitzung)')
    expect(seen.stored.has('enabled')).toBe(false)
    expect(await status($)).toMatchObject({ state: 'off' })
    await seen.clock.advance(3 * 60 * MIN)
    expect(seen.forks).toEqual([])

    // A hot reload raises session.start again: the switch stays off.
    await start($)
    await turn($, 't2')
    await seen.clock.advance(60 * MIN)
    expect(seen.forks).toEqual([])

    expect((await command($, 'keepalive', 'on')).split('\n')[0]).toMatch(/^Keep-alive an \(diese Sitzung\) · /)
    expect(seen.stored.has('enabled')).toBe(false)
    await turn($, 't3')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('every session starts on: a stored global "off" is ignored', async ($, on) => {
    const seen = world(on, { store: { enabled: false } })
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('/clear starts the next session switched on', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive', 'off')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await turn($, 't2')
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })
})

describe('hint line', () => {
  const texts = async (ui: Awaited<ReturnType<typeof hintLine>>) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws the clock and the switch before the engine line (${surface})`, async ($, on) => {
      const seen = world(on)
      await start($)
      await turn($, 't1')
      await seen.clock.advance(5 * MIN + 50_000)
      const ui = await hintLine($, { surface })

      const drawn = (await ui.drawn()) as { type: string; props: unknown; children: unknown[] }
      expect(drawn).toMatchObject({ type: 'Box', props: { flexDirection: 'row', columnGap: 2 } })
      expect(drawn.children).toHaveLength(2)
      expect(drawn.children[1]).toEqual(ENGINE_LINE)
      expect(await ui.find({ type: 'Text', text: '⚡  54:10' })).toMatchObject({ props: { color: 'success', bold: true } })
      expect(await ui.find({ type: 'Button', key: 'keepalive' })).toMatchObject({ props: { plain: true } })
      expect(await ui.find({ type: 'Text', text: PILL.armed.long })).toMatchObject({
        props: { backgroundColor: 'success', color: 'inverseText' },
      })
      expect(await texts(ui)).toEqual(['⚡  54:10', PILL.armed.long])
    })
  }

  test('the clock ticks every second while it shows, in green, yellow and red', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive', 'off')
    await seen.clock.advance(50 * MIN)
    const ui = await hintLine($)
    const clock = async () => (await ui.find({ type: 'Text', text: /⚡/ }))?.props.color
    expect(await ui.find({ type: 'Text', text: '⚡  10:00' })).toBeDefined()
    expect(await clock()).toBe('success')
    await seen.clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: '⚡  9:59' })).toBeDefined()
    expect(await clock()).toBe('warning')
    await seen.clock.advance(7 * MIN - 1000)
    expect(await ui.find({ type: 'Text', text: '⚡  3:00' })).toBeDefined()
    expect(await clock()).toBe('warning')
    await seen.clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: '⚡  2:59' })).toBeDefined()
    expect(await clock()).toBe('error')
    expect(await ui.find({ type: 'Text', text: PILL.off.long })).toMatchObject({ props: { backgroundColor: 'inactive' } })
  })

  test('a lapsed entry shows a grey snowflake and the tick stops', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await command($, 'keepalive', 'off')
    await seen.clock.advance(60 * MIN - 10_000)
    const ui = await hintLine($)
    expect(await ui.find({ type: 'Text', text: '⚡  0:10' })).toBeDefined()
    await seen.clock.advance(10_000)
    expect(await ui.find({ type: 'Text', text: '❄' })).toMatchObject({ props: { color: 'inactive' } })
    expect(await ui.find({ type: 'Text', text: /⚡/ })).toBeUndefined()
    const ticks = seen.invalidates
    await seen.clock.advance(10_000)
    expect(seen.invalidates).toBe(ticks)
  })

  test('no clock and no tick before the first answer', async ($, on) => {
    const seen = world(on)
    await start($)
    const ui = await hintLine($)
    expect(await texts(ui)).toEqual([PILL.paused.long])
    const ticks = seen.invalidates
    await seen.clock.advance(10_000)
    expect(seen.invalidates).toBe(ticks)

    await turn($, 't1')
    await seen.clock.advance(3000)
    expect(seen.invalidates).toBeGreaterThanOrEqual(ticks + 3)
    expect(await texts(ui)).toEqual(['⚡  59:57', PILL.armed.long])
  })

  test('no clock after /clear', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    const ui = await hintLine($)
    expect(await texts(ui)).toEqual([PILL.paused.long])
    const ticks = seen.invalidates
    await seen.clock.advance(10_000)
    expect(seen.invalidates).toBe(ticks)
  })

  test('a cold ping shows the snowflake at once, paused', async ($, on) => {
    const seen = world(on)
    seen.forkReplies.push(forkReply(COLD))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    const ui = await hintLine($)
    expect(await texts(ui)).toEqual(['❄', PILL.paused.long])
  })

  test('a ping in flight shows ⇡, then the new entry', async ($, on) => {
    const seen = world(on)
    let release: (value: ModelForkResult) => void = () => undefined
    seen.forkReplies.push(() => new Promise<ModelForkResult>(resolve => (release = resolve)))
    await start($)
    await turn($, 't1')
    await seen.clock.advance(55 * MIN)
    const ui = await hintLine($)
    expect(await texts(ui)).toEqual(['⚡  5:00', PILL.pinging.long])
    release(forkReply())
    await seen.clock.settle()
    expect(await texts(ui)).toEqual(['⚡  60:00', PILL.armed.long])
  })

  test('pressing the switch turns the keep-alive off and on for this session', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await seen.clock.advance(54 * MIN)
    const ui = await hintLine($)
    await ui.press({ key: 'keepalive' })
    expect(await ui.find({ type: 'Text', text: PILL.off.long })).toBeDefined()
    expect((await command($, 'keepalive', 'status')).split('\n')[0]).toBe('Keep-alive aus (diese Sitzung)')
    // The ping was due at 55:00.
    await seen.clock.advance(2 * MIN)
    expect(seen.forks).toEqual([])

    // Back on at 56:00: the ping is due at once, planned by the press.
    await ui.press({ key: 'keepalive' })
    await seen.clock.settle()
    expect(seen.forks).toEqual([FORK_PING_PROMPT])
    expect(await texts(ui)).toEqual(['⚡  60:00', PILL.armed.long])
  })

  test('the main screen draws the text without a button', async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    const ui = await hintLine($, { isFullscreen: false })
    expect(await texts(ui)).toEqual(['⚡  60:00', PILL.armed.long])
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await seen.clock.advance(1000)
    expect(await texts(ui)).toEqual(['⚡  59:59', PILL.armed.long])
  })

  test('narrows the switch to its glyph, then leaves only the engine line', async ($, on) => {
    world(on)
    await start($)
    await turn($, 't1')
    // room = columns - hint - 8; the clock "⚡  60:00" and its gap take 11, the long pill 8, the short one 5.
    const room = (n: number) => HINT.length + 8 + n
    const long = await hintLine($, { columns: room(19) })
    expect(await texts(long)).toEqual(['⚡  60:00', PILL.armed.long])
    await long.unmount()
    const short = await hintLine($, { columns: room(18) })
    expect(await texts(short)).toEqual(['⚡  60:00', PILL.armed.short])
    await short.unmount()
    const none = await hintLine($, { columns: room(15) })
    expect(await none.drawn()).toEqual(ENGINE_LINE)
  })

  test('a desktop that has not measured gets the long pill', async ($, on) => {
    world(on)
    await start($)
    await turn($, 't1')
    const ui = await hintLine($, { surface: 'desktop', hasViewport: false })
    expect(await texts(ui)).toEqual(['⚡  60:00', PILL.armed.long])
  })

  test('a non-interactive session draws only the engine line', async ($, on) => {
    world(on)
    await start($, false)
    await turn($, 't1')
    const ui = await hintLine($)
    expect(await ui.drawn()).toEqual(ENGINE_LINE)
  })
})

describe('pauses', () => {
  test('compaction pauses until the next turn', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect(await status($)).toMatchObject({ state: 'paused', anchorAt: null, reason: REASON.compacted })
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toEqual([])
    await turn($, 't2')
    expect(await status($)).toMatchObject({ state: 'armed' })
  })

  test("a subagent's compaction and a precompute do not pause", WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    const messages = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages })
    await $.session.compact({ trigger: 'precompute', messages })
    expect(await status($)).toMatchObject({ state: 'armed', nextPing: '55:00' })
    await seen.clock.advance(55 * MIN)
    expect(seen.forks).toHaveLength(1)
  })

  test('a model switch pauses', WITH_PEEK, async ($, on) => {
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
    expect(await status($)).toMatchObject({ state: 'paused', reason: REASON.modelSwitch })
    await seen.clock.advance(60 * MIN)
    expect(seen.forks).toEqual([])
  })

  test('/clear pauses and forgets the entry', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(await status($)).toMatchObject({ state: 'paused', anchorAt: null, reason: REASON.cleared })
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

  test('a session that ends while the ping state is written sends no fork', { plugins: [PEEK, SLOW_PINGING] }, async ($, on) => {
    const seen = world(on)
    await start($)
    await turn($, 't1')
    void seen.clock.advance(55 * MIN)
    await seen.clock.settle()
    // The ping now waits on its own state write: the session ends meanwhile.
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await seen.clock.advance(1000)
    expect(seen.forks).toEqual([])
    expect(await status($)).toMatchObject({ state: 'paused', reason: REASON.cleared })
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toEqual([])
  })

  test('a ping in flight at session end writes nothing afterwards', WITH_PEEK, async ($, on) => {
    const seen = world(on)
    let release: (value: ModelForkResult) => void = () => undefined
    seen.forkReplies.push(() => new Promise<ModelForkResult>(resolve => (release = resolve)))
    await start($)
    await turn($, 't1')
    void seen.clock.advance(55 * MIN)
    await seen.clock.settle()
    expect(await status($)).toMatchObject({ state: 'pinging' })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    const ended = await status($)
    expect(ended).toMatchObject({ state: 'paused', reason: REASON.cleared })
    release(forkReply(COLD))
    await seen.clock.settle()
    expect(await status($)).toEqual(ended)
    expect((await peek($)).lastPing).toBe(null)
    expect(seen.toasts).toEqual([])
    await seen.clock.advance(2 * 60 * MIN)
    expect(seen.forks).toHaveLength(1)
  })
})
