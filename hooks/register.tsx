import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { forkTtl, mainTtl } from './cache'
import type { TtlSources } from './cache'
import {
  BUILTIN_REFRESH_MS,
  FORK_PING_PROMPT,
  FORK_TTL_MUST_MATCH,
  KEEPALIVE_USAGE,
  PILL,
  REASON,
  anchorAfterPing,
  clockText,
  clockTone,
  displayOf,
  hintClock,
  hintOf,
  hintSize,
  nextStep,
  parseBuiltin,
  parseKeepalive,
  settlePing,
  statusText,
} from './keepalive'
import type { Builtin, Gate, Step } from './keepalive'

const anchor = atom({ plugin: 'statusline', key: 'anchor' } as const, null)
const isTurnRunning = atom({ plugin: 'statusline', key: 'isTurnRunning' } as const, false)
const pause = atom({ plugin: 'statusline', key: 'pause' } as const, null)
const lastPing = atom({ plugin: 'statusline', key: 'lastPing' } as const, null)
const activityAt = atom({ plugin: 'statusline', key: 'activityAt' } as const, null)
// Every session starts on; a hot reload keeps what the person chose.
const isEnabled = atom({ plugin: 'statusline', key: 'isEnabled' } as const, true)
const hint = atom({ plugin: 'statusline', key: 'hint' } as const, null)

const TOAST_MS = 8000
const TICK_MS = 1000

// Module values start over on a hot reload, which also cancels the old timers.
// $ is never stored or bound to a name (the engine refuses that); it is only passed on.
let isInteractive = false
let isForking = false
let ended = false
let pingTimer: Timer | undefined
// Redraws the hint line every second while it shows a clock, and at most until that clock runs out.
let ticker: Timer | undefined
let ticksLeft = 0
let builtinCache: { at: number; value: Builtin } | undefined

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

function cancelTimers(): void {
  pingTimer?.cancel()
  pingTimer = undefined
  stopTicker()
}

// Plan limits appear with the first answer; before it the list says nothing.
async function planLimits($: EngineInterface): Promise<boolean | undefined> {
  if ((await read($, anchor)) === null) return undefined
  try {
    return (await $.session.usage()).rateLimits.length > 0
  } catch {
    return undefined
  }
}

async function ttlSources($: EngineInterface): Promise<TtlSources> {
  let settings: Readonly<Record<string, unknown>> = {}
  try {
    settings = await $.settings.read()
  } catch {
    // Unreadable settings: the environment and the defaults still decide.
  }
  return {
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    mainEnv: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    mainSetting: settings.promptCacheTtl,
    forkEnv: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
    forkSetting: settings.subagentPromptCacheTtl,
    hasPlanLimits: await planLimits($),
  }
}

// Claude Code's global config: $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json.
async function globalConfigPath($: EngineInterface): Promise<string | null> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.replace(/\/+$/, '')
  if (dir !== undefined && dir !== '') return `${dir}/.claude.json`
  const home = (await $.env.get('HOME'))?.replace(/\/+$/, '')
  return home !== undefined && home.startsWith('/') ? `${home}/.claude.json` : null
}

// Claude Code's own keep-alive flag, read at most every BUILTIN_REFRESH_MS. Any failure reads as off.
async function builtinOf($: EngineInterface): Promise<Builtin> {
  const now = await $.clock.now()
  if (builtinCache !== undefined && now - builtinCache.at < BUILTIN_REFRESH_MS) return builtinCache.value
  let text: string | null = null
  try {
    const path = await globalConfigPath($)
    if (path !== null) text = await $.fs.read(path)
  } catch {
    text = null
  }
  const value = parseBuiltin(text)
  builtinCache = { at: now, value }
  return value
}

async function gateOf($: EngineInterface): Promise<Gate> {
  const sources = await ttlSources($)
  return {
    isEnabled: await read($, isEnabled),
    isInteractive,
    isTurnRunning: await read($, isTurnRunning),
    isForking,
    pause: await read($, pause),
    anchor: await read($, anchor),
    main: mainTtl(sources),
    fork: forkTtl(sources),
    forkTtlMustMatch: FORK_TTL_MUST_MATCH,
    builtin: await builtinOf($),
    activityAt: await read($, activityAt),
  }
}

// Started by the drawing that shows a clock and stopped by the one that does not. The
// redraw at the clock's end draws the snowflake; the count only ends a tick nobody draws.
function keepTicking($: EngineInterface, leftMs: number): void {
  ticksLeft = Math.ceil(leftMs / TICK_MS)
  ticker ??= $.clock.every(TICK_MS, () => {
    ticksLeft -= 1
    if (ticksLeft < 0) stopTicker()
    $.ui.invalidate('ui.render')
  })
}

// What the hint line draws; the write redraws it. It never throws: ping() calls it
// holding the lock, and a failed write only costs the hint line.
async function show($: EngineInterface, g: Gate, step: Step): Promise<void> {
  if (!isInteractive) return
  try {
    const snap = hintOf(g, step, await read($, lastPing))
    await update($, hint, () => snap)
  } catch {
    // The hint line keeps what it drew last.
  }
}

// Plans the next ping from the state as it stands, replacing any earlier timer.
async function arm($: EngineInterface): Promise<void> {
  const g = await gateOf($)
  const now = await $.clock.now()
  const step = nextStep(g, now)
  if (step.kind === 'late') {
    await update($, pause, () => REASON.late)
    return arm($)
  }
  // No await from here to the assignment: overlapping arms leave exactly one live timer.
  pingTimer?.cancel()
  pingTimer = undefined
  if (step.kind === 'wait' || step.kind === 'ping') {
    const delay = step.kind === 'wait' ? step.at - now : 0
    pingTimer = $.clock.after(delay, () => {
      void ping($).catch(() => undefined)
    })
  }
  await show($, g, step)
}

async function ping($: EngineInterface): Promise<void> {
  pingTimer = undefined
  if (isForking || ended) return
  const g = await gateOf($)
  const startedAt = await $.clock.now()
  // Everything is checked again: the switch, a turn, a pause, the built-in window, a late timer.
  if (nextStep(g, startedAt).kind !== 'ping') return arm($)

  // The lock is claimed with no await since this check: a second timer cannot slip in.
  if (isForking || ended) return
  isForking = true
  await show($, { ...g, isForking: true }, { kind: 'busy' })
  // The session may have ended while the hint was written: no fork then.
  if (ended) {
    isForking = false
    return
  }
  let outcome: ReturnType<typeof settlePing>
  try {
    outcome = settlePing(await $.model.fork({ prompt: FORK_PING_PROMPT }), startedAt)
  } catch (err) {
    outcome = { pause: `Ping fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, ping: null }
  } finally {
    if (!ended) isForking = false
  }
  // The session ended while the fork ran: nothing is written afterwards.
  if (ended) return

  const isRefreshed = outcome.pause === null && outcome.ping !== null
  await update($, anchor, current => anchorAfterPing(current, startedAt, isRefreshed))
  if (outcome.ping !== null) {
    const done = outcome.ping
    await update($, lastPing, () => done)
  }
  if (outcome.pause !== null) {
    const why = outcome.pause
    await update($, pause, () => why)
    $.ui.toast(`Keep-alive pausiert: ${why}`, { timeoutMs: TOAST_MS })
  }
  await arm($)
}

// Pauses the keep-alive until the next real turn.
async function hold($: EngineInterface, why: string): Promise<void> {
  await update($, anchor, () => null)
  await update($, pause, () => why)
  await arm($)
}

async function keepaliveCommand($: EngineInterface, args: string): Promise<string> {
  const verb = parseKeepalive(args)
  if (verb === null) return KEEPALIVE_USAGE
  if (verb !== 'status') {
    await update($, isEnabled, () => verb === 'on')
    await arm($)
  }
  const g = await gateOf($)
  const now = await $.clock.now()
  return statusText(displayOf(g, nextStep(g, now)), g, await read($, lastPing), now)
}

// A main-thread request that got a response: the new anchor and activity, and the end of any pause.
async function onMainRequest($: EngineInterface, at: number): Promise<void> {
  await update($, anchor, old => (old !== null && old.at > at ? old : { at, source: 'turn' as const }))
  await update($, activityAt, old => Math.max(old ?? 0, at))
  await update($, pause, () => null)
}

// The hint line's switch: off and on for this session.
async function toggle($: EngineInterface): Promise<void> {
  await update($, isEnabled, on => !on)
  await arm($)
}

export const register: Register = on => {
  // Also raised again on a hot reload: the timer is planned anew from $.state.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    ended = false
    builtinCache = undefined
    await $.command.register({
      name: 'keepalive',
      description: 'Prompt-Cache warm halten: on | off | status',
      argumentHint: 'on | off | status',
      immediate: true,
    })
    await arm($)
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'keepalive' }, async ($, e) => ({ text: await keepaliveCommand($, e.args) })).catch(
    () => ({ text: 'keepalive: Befehl fehlgeschlagen.' }),
  )

  // turn.start is raised for the main loop only.
  on('turn.start', async ($, e, next) => {
    ended = false
    await update($, isTurnRunning, () => true)
    await arm($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    // A step while a fork runs and no turn does is the fork's own request.
    if (isForking && !(await read($, isTurnRunning))) return yield* next(e)
    const at = await $.clock.now()
    const result = yield* next(e)
    // The response stands whatever the bookkeeping does.
    try {
      if (result.usage !== null) {
        await onMainRequest($, at)
        // The turn runs, so this plans no ping; it redraws the hint line's clock from the new request.
        await arm($)
      }
    } catch {
      // The next request or turn end plans again.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId == null) {
      const now = await $.clock.now()
      await update($, activityAt, old => Math.max(old ?? 0, now))
      await update($, isTurnRunning, () => false)
      await arm($)
    }
    return done
  }).catch(($, e, next) => next(e))

  // A compaction that stands leaves the cached prefix behind; precompute installs nothing.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.messages !== undefined) {
      await hold($, REASON.compacted)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    await hold($, REASON.modelSwitch)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear ends the conversation without a session.start.
  // Timers go first and synchronously: the end has a short budget.
  on('session.end', async ($, e, next) => {
    // The fork in flight is abandoned: its answer is dropped, and the hint line shows the pause.
    ended = true
    isForking = false
    cancelTimers()
    // The conversation after a /clear is a new session: it starts switched on.
    if (e.reason === 'clear') await update($, isEnabled, () => true)
    await hold($, e.reason === 'clear' ? REASON.cleared : REASON.ended)
    cancelTimers()
    return next(e)
  }).catch(($, e, next) => next(e))

  // The cache clock and the switch, left of the engine's hint line and whatever
  // other plugins drew there (embedded whole). The terminal's main screen takes
  // no clicks on this line: the switch is drawn as text there.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const below = await next(e)
    const snap = await read($, hint)
    const clock = snap === null ? null : hintClock(snap, await $.clock.now())
    const size = snap === null ? null : hintSize(e.viewport?.columns, e.props.hint, clock, snap.state)
    // A clock counts down whether or not this surface has room for it: another may draw it.
    if (clock?.kind === 'warm') keepTicking($, clock.leftMs)
    else stopTicker()
    if (snap === null || size === null) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = snap.state === 'armed' || snap.state === 'pinging'
    const label = (
      <Text backgroundColor={isOn ? 'success' : 'inactive'} color="inverseText" bold={isOn}>
        {PILL[snap.state][size]}
      </Text>
    )
    const pill =
      e.viewport?.isFullscreen === false ? (
        label
      ) : (
        <Button key="keepalive" plain onPress={() => void toggle($).catch(() => undefined)}>
          {label}
        </Button>
      )
    const mine =
      clock === null ? (
        <Box flexShrink={0}>{pill}</Box>
      ) : (
        <Box flexShrink={0} flexDirection="row" columnGap={2}>
          {clock.kind === 'warm' ? (
            <Text color={clockTone(clock.leftMs)} bold>
              {clockText(clock.leftMs)}
            </Text>
          ) : (
            <Text color="inactive">❄</Text>
          )}
          {pill}
        </Box>
      )

    return (
      <Box flexDirection="row" columnGap={2}>
        {mine}
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
