import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnUsage } from 'claude-code'

import type { KeepaliveProbe } from '../types'
import { fmtSpan, forkTtl, mainTtl, pickUsage, ttlLine } from './cache'
import type { TtlSources } from './cache'
import {
  BUILTIN_REFRESH_MS,
  FORK_PING_PROMPT,
  FORK_TTL_MUST_MATCH,
  KEEPALIVE_USAGE,
  REASON,
  anchorAfterPing,
  nextStep,
  parseBuiltin,
  parseKeepalive,
  settlePing,
  statusFile,
  statusText,
} from './keepalive'
import type { Builtin, Gate, Step } from './keepalive'
import { PROBE_KEEP, PROBE_PROMPT, PROBE_USAGE, followUpLine, forkFailure, forkLine, parseProbeArgs, reportText } from './probe'

const anchor = atom({ plugin: 'statusline', key: 'anchor' } as const, null)
const isTurnRunning = atom({ plugin: 'statusline', key: 'isTurnRunning' } as const, false)
const probe = atom({ plugin: 'statusline', key: 'probe' } as const, null)
const pause = atom({ plugin: 'statusline', key: 'pause' } as const, null)
const lastPing = atom({ plugin: 'statusline', key: 'lastPing' } as const, null)
const activityAt = atom({ plugin: 'statusline', key: 'activityAt' } as const, null)

const ENABLED_KEY = 'enabled'
const PROBES_KEY = 'probes'
const TOAST_MS = 8000
const NO_ANCHOR = 'Noch keine Anfrage in dieser Sitzung – zuerst eine Frage stellen.'

// Module values start over on a hot reload, which also cancels the old timers.
// $ is never stored or bound to a name (the engine refuses that); it is only passed on.
let isInteractive = false
let isForking = false
let stepsDuringFork = 0
let pingTimer: Timer | undefined
let probeTimer: Timer | undefined
let builtinCache: { at: number; value: Builtin } | undefined

function cancelTimers(): void {
  pingTimer?.cancel()
  pingTimer = undefined
  probeTimer?.cancel()
  probeTimer = undefined
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

// The switch is global; every check reads it again, so "off" in one session stops the others.
async function isEnabled($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(ENABLED_KEY)) !== false
  } catch {
    return true
  }
}

async function gateOf($: EngineInterface): Promise<Gate> {
  const sources = await ttlSources($)
  return {
    isEnabled: await isEnabled($),
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

async function configDir($: EngineInterface): Promise<string | null> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.replace(/\/+$/, '')
  if (dir !== undefined && dir !== '') return dir
  const home = (await $.env.get('HOME'))?.replace(/\/+$/, '')
  return home !== undefined && home.startsWith('/') ? `${home}/.claude` : null
}

// What the status line reads. A failed write only costs the marker.
async function publish($: EngineInterface, g: Gate, step: Step): Promise<void> {
  if (!isInteractive) return
  try {
    const dir = await configDir($)
    if (dir === null) return
    const sessionId = await $.session.id()
    const body = statusFile(sessionId, g, step, await $.clock.now())
    await $.fs.write(`${dir}/keepalive/${sessionId}.json`, `${JSON.stringify(body)}\n`)
  } catch {
    // The status line then shows no marker.
  }
}

// Plans the next ping from the state as it stands, replacing any earlier timer.
async function arm($: EngineInterface): Promise<void> {
  pingTimer?.cancel()
  pingTimer = undefined
  const g = await gateOf($)
  const now = await $.clock.now()
  const step = nextStep(g, now)
  if (step.kind === 'late') {
    await update($, pause, () => REASON.late)
    return arm($)
  }
  if (step.kind === 'wait' || step.kind === 'ping') {
    const delay = step.kind === 'wait' ? step.at - now : 0
    pingTimer = $.clock.after(delay, () => {
      void ping($).catch(() => undefined)
    })
  }
  await publish($, g, step)
}

async function ping($: EngineInterface): Promise<void> {
  pingTimer = undefined
  if (isForking) return
  const g = await gateOf($)
  const startedAt = await $.clock.now()
  // Everything is checked again: the switch, a turn, a pause, the built-in window, a late timer.
  if (nextStep(g, startedAt).kind !== 'ping') return arm($)

  isForking = true
  stepsDuringFork = 0
  await publish($, { ...g, isForking: true }, { kind: 'busy' })
  let outcome: ReturnType<typeof settlePing>
  try {
    outcome = settlePing(await $.model.fork({ prompt: FORK_PING_PROMPT }), startedAt)
  } catch (err) {
    outcome = { pause: `Ping fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, ping: null }
  } finally {
    isForking = false
  }

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

async function savedProbes($: EngineInterface): Promise<KeepaliveProbe[]> {
  try {
    const saved = await $.store.get(PROBES_KEY)
    return Array.isArray(saved) ? (saved as KeepaliveProbe[]) : []
  } catch {
    return []
  }
}

// One fork now (or, for a control, none), remembered until the next real request.
async function runProbe($: EngineInterface, kind: 'probe' | 'control'): Promise<string> {
  if (await isEnabled($)) return 'Erst /keepalive off – sonst verfälschen die Pings die Messung.'
  if (await read($, isTurnRunning)) return 'Ein Turn läuft – Probe erst danach.'
  if (isForking) return 'Eine Probe läuft bereits.'
  const last = await read($, anchor)
  if (last === null) return NO_ANCHOR

  const sources = await ttlSources($)
  const record: KeepaliveProbe = {
    kind,
    anchorAt: last.at,
    fork: null,
    forkRaisedStep: false,
    followUp: null,
    mainTtl: mainTtl(sources),
    forkTtl: forkTtl(sources),
  }
  if (kind === 'probe') {
    const at = await $.clock.now()
    isForking = true
    stepsDuringFork = 0
    try {
      const reply = await $.model.fork({ prompt: PROBE_PROMPT })
      const failure = forkFailure(reply)
      if (failure !== null || !('usage' in reply)) return failure ?? 'Fork ohne Usage.'
      record.fork = { at, usage: pickUsage(reply.usage) }
      record.forkRaisedStep = stepsDuringFork > 0
    } finally {
      isForking = false
    }
  }

  await update($, probe, () => record)
  const line = forkLine(record)
  $.ui.log(line)
  return line
}

async function scheduleProbe($: EngineInterface, ms: number): Promise<string> {
  const last = await read($, anchor)
  if (last === null) return NO_ANCHOR
  const wait = last.at + ms - (await $.clock.now())
  if (wait <= 0) return `Der Zeitpunkt ist schon vorbei (vor ${fmtSpan(-wait)}).`

  probeTimer?.cancel()
  probeTimer = $.clock.after(wait, () => {
    probeTimer = undefined
    void runProbe($, 'probe')
      .then(text => {
        if (!text.startsWith('[keepalive-probe]')) $.ui.log(`[keepalive-probe] ${text}`)
      })
      .catch(() => undefined)
  })
  return `Probe-Fork in ${fmtSpan(wait)} (${fmtSpan(ms)} nach der letzten Anfrage). Bis dahin nichts eingeben.`
}

async function probeCommand($: EngineInterface, args: string): Promise<string> {
  const parsed = parseProbeArgs(args)
  if (parsed === null) return PROBE_USAGE
  if (parsed.verb === 'at') return scheduleProbe($, parsed.ms)
  if (parsed.verb === 'ttl') {
    const sources = await ttlSources($)
    return ttlLine(mainTtl(sources), forkTtl(sources))
  }
  if (parsed.verb === 'report') return reportText(await savedProbes($), await read($, probe))
  return runProbe($, parsed.verb === 'now' ? 'probe' : 'control')
}

async function keepaliveCommand($: EngineInterface, args: string): Promise<string> {
  const verb = parseKeepalive(args)
  if (verb === null) return KEEPALIVE_USAGE
  if (verb !== 'status') {
    await $.store.set(ENABLED_KEY, verb === 'on')
    await arm($)
  }
  const g = await gateOf($)
  const now = await $.clock.now()
  const file = statusFile(await $.session.id(), g, nextStep(g, now), now)
  return statusText(file, g, await read($, lastPing), now)
}

// A main-thread request that got a response: the new anchor and activity, the
// end of any pause, and a pending probe's follow-up.
async function onMainRequest($: EngineInterface, at: number, usage: TurnUsage): Promise<void> {
  await update($, anchor, old => (old !== null && old.at > at ? old : { at, source: 'turn' }))
  await update($, activityAt, old => Math.max(old ?? 0, at))
  await update($, pause, () => null)
  const pending = await read($, probe)
  if (pending === null) return

  await update($, probe, () => null)
  const followUp = { at, usage: pickUsage(usage) }
  $.ui.log(followUpLine(pending, at, followUp.usage))
  try {
    await $.store.set(PROBES_KEY, [...(await savedProbes($)), { ...pending, followUp }].slice(-PROBE_KEEP))
  } catch {
    // The transcript line stays the record.
  }
}

export const register: Register = on => {
  // Also raised again on a hot reload: the timer is planned anew from $.state.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    builtinCache = undefined
    await $.command.register({
      name: 'keepalive',
      description: 'Prompt-Cache warm halten: on | off | status',
      argumentHint: 'on | off | status',
      immediate: true,
    })
    await $.command.register({
      name: 'keepalive-probe',
      description: 'Messprobe für den Prompt-Cache: ttl | now | at <Dauer> | control | report',
      argumentHint: 'ttl | now | at 4m | control | report',
      immediate: true,
    })
    await arm($)
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'keepalive' }, async ($, e) => ({ text: await keepaliveCommand($, e.args) })).catch(
    () => ({ text: 'keepalive: Befehl fehlgeschlagen.' }),
  )

  on('command.run', { command: 'keepalive-probe' }, async ($, e) => ({ text: await probeCommand($, e.args) })).catch(
    () => ({ text: 'keepalive-probe: Befehl fehlgeschlagen.' }),
  )

  // turn.start is raised for the main loop only.
  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)
    await arm($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    // A step while a fork runs and no turn does is the fork's own request.
    if (isForking && !(await read($, isTurnRunning))) {
      stepsDuringFork += 1
      return yield* next(e)
    }
    const at = await $.clock.now()
    const result = yield* next(e)
    // The response stands whatever the bookkeeping does.
    try {
      if (result.usage !== null) await onMainRequest($, at, result.usage)
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

  // /clear ends the conversation without a session.start; the file still names the ending id.
  // Timers go first and synchronously: the end has a short budget.
  on('session.end', async ($, e, next) => {
    cancelTimers()
    await update($, probe, () => null)
    await hold($, e.reason === 'clear' ? REASON.cleared : REASON.ended)
    cancelTimers()
    return next(e)
  }).catch(($, e, next) => next(e))
}
