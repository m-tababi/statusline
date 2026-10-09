// Everything beneath the plugin, in memory: clock, store, environment,
// settings, the fork, turns and their steps, files, logs and toasts.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, TurnUsage } from 'claude-code'

export const START = Date.UTC(2026, 9, 9, 12, 0, 0)
export const MIN = 60_000
export const HOME = '/home/tester'
export const SESSION = 's1'

export const WARM: TurnUsage = {
  model: 'claude-opus-5-5', input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 120,
}
export const COLD: TurnUsage = {
  model: 'claude-opus-5-5', input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 22_000,
}
export const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export const forkReply = (u: TurnUsage = WARM): ModelForkResult => ({
  isAnswered: true,
  text: 'ok',
  usage: {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
  },
})

export type WorldOptions = {
  env?: Record<string, string>
  settings?: Record<string, unknown>
  store?: Record<string, unknown>
  // Plan limits $.session.usage() lists; a subscription has some.
  rateLimits?: unknown[]
}

export function world(on: On, o: WorldOptions = {}) {
  const seen = {
    clock: mock.clock(on, { now: START }),
    stored: new Map<string, unknown>(Object.entries(o.store ?? {})),
    forks: [] as string[],
    // Queued fork answers, oldest first; a function answers when it resolves.
    forkReplies: [] as (ModelForkResult | (() => Promise<ModelForkResult>))[],
    // What the next turn.step reports.
    stepUsage: WARM as TurnUsage,
    logs: [] as string[],
    toasts: [] as string[],
    files: new Map<string, string>(),
    afterWrite: undefined as (() => Promise<void>) | undefined,
    // Files $.fs.read finds (by absolute path); anything else does not exist.
    readable: new Map<string, string>(),
    submits: [] as string[],
  }

  on('store.get', ($, e) => ({ value: seen.stored.get(e.key) }))
  on('store.set', ($, e) => {
    seen.stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    seen.stored.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...seen.stored.keys()] }))
  mock.env(on, { HOME, ...(o.env ?? {}) })
  on('settings.read', () => ({ value: o.settings ?? {} }))
  // Only rateLimits is read by the plugin; the rest is the smallest shape that passes.
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: o.rateLimits ?? [{ kind: 'five_hour', percentUsed: 12 }],
    } as never,
  }))
  on('fs.read', ($, e) => {
    const text = seen.readable.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.fork', async ($, e) => {
    seen.forks.push(e.prompt)
    const next = seen.forkReplies.shift()
    return { value: next === undefined ? forkReply() : typeof next === 'function' ? await next() : next }
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.write', async ($, e) => {
    seen.files.set(e.path, e.text)
    await seen.afterWrite?.()
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    seen.submits.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    const usage = seen.stepUsage
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // A compaction that stands hands the conversation back.
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.PostModelSwitch', () => ({}))

  return seen
}

export const start = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: '/w', surface: isInteractive ? 'terminal' : null, isInteractive })

export async function stepOnly($: Engine, turnId: string): Promise<void> {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain the stream
  }
}

export const complete = ($: Engine, turnId: string) =>
  $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId, reason: 'answer' })

/** One main-thread turn of one request, at the clock's current time. */
export async function turn($: Engine, turnId: string, text = 'x'): Promise<void> {
  await $.turn.start({ text, turnId })
  await stepOnly($, turnId)
  await complete($, turnId)
}

export async function command($: Engine, name: string, args: string): Promise<string> {
  const ran = await $.command.run({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  return ran.text ?? ''
}
