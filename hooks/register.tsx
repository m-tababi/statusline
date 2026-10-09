import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnUsage } from 'claude-code'

import type { KeepaliveProbe } from '../types'
import { fmtSpan, forkTtl, mainTtl, pickUsage, ttlLine } from './cache'
import type { TtlSources } from './cache'
import { PROBE_KEEP, PROBE_PROMPT, PROBE_USAGE, followUpLine, forkFailure, forkLine, parseProbeArgs, reportText } from './probe'

const anchor = atom({ plugin: 'statusline', key: 'anchor' } as const, null)
const isTurnRunning = atom({ plugin: 'statusline', key: 'isTurnRunning' } as const, false)
const probe = atom({ plugin: 'statusline', key: 'probe' } as const, null)

const PROBES_KEY = 'probes'
const NO_ANCHOR = 'Noch keine Anfrage in dieser Sitzung – zuerst eine Frage stellen.'

// Module values start over on a hot reload, which also cancels the old timers.
// $ is never stored or bound to a name (the engine refuses that); it is only passed on.
let isForking = false
let stepsDuringFork = 0
let probeTimer: Timer | undefined

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

// A main-thread request that got a response: the new anchor, and a pending probe's follow-up.
async function onMainRequest($: EngineInterface, at: number, usage: TurnUsage): Promise<void> {
  await update($, anchor, old => (old !== null && old.at > at ? old : { at, source: 'turn' }))
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
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'keepalive-probe',
      description: 'Messprobe für den Prompt-Cache: ttl | now | at <Dauer> | control | report',
      argumentHint: 'ttl | now | at 4m | control | report',
      immediate: true,
    })
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'keepalive-probe' }, async ($, e) => ({ text: await probeCommand($, e.args) })).catch(
    () => ({ text: 'keepalive-probe: Befehl fehlgeschlagen.' }),
  )

  // turn.start is raised for the main loop only.
  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)
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
    if (result.usage !== null) await onMainRequest($, at, result.usage)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId == null) await update($, isTurnRunning, () => false)
    return done
  }).catch(($, e, next) => next(e))

  // /clear ends the conversation without a session.start: nothing measured before it counts.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      probeTimer?.cancel()
      probeTimer = undefined
      await update($, anchor, () => null)
      await update($, probe, () => null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
