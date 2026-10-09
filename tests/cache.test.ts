import { expect, test } from 'claude-code/testing'

import {
  fmtSpan, fmtTokens, forkTtl, isFlag, isWarm, mainTtl, parseSpan, pickUsage, promptTokens, ttlLine, usageLine,
} from '../hooks/cache'

const u = (read: number, write: number, input = 3) => ({
  input_tokens: input, output_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write,
})

test('main TTL: force flag, then env, then setting, then the subscription default', () => {
  expect(mainTtl({})).toEqual({ ttl: '1h', source: 'default (subscription)' })
  expect(mainTtl({ mainSetting: '5m' })).toEqual({ ttl: '5m', source: 'promptCacheTtl' })
  expect(mainTtl({ mainEnv: '5m', mainSetting: '1h' })).toEqual({ ttl: '5m', source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' })
  expect(mainTtl({ force5m: '1', mainEnv: '1h' })).toEqual({ ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' })
  expect(mainTtl({ mainEnv: '30m', mainSetting: 7 })).toEqual({ ttl: '1h', source: 'default (subscription)' })
  expect(mainTtl({ enable1h: '1', hasPlanLimits: false })).toEqual({ ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' })
  expect(mainTtl({ hasPlanLimits: false })).toEqual({ ttl: '5m', source: 'default (no subscription)' })
  expect(mainTtl({ hasPlanLimits: true })).toEqual({ ttl: '1h', source: 'default (subscription)' })
})

test('fork TTL: subagent env and setting, the 1h flag, else 5m', () => {
  expect(forkTtl({})).toEqual({ ttl: '5m', source: 'default' })
  expect(forkTtl({ enable1h: 'true' })).toEqual({ ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' })
  expect(forkTtl({ forkSetting: '1h', enable1h: '0' })).toEqual({ ttl: '1h', source: 'subagentPromptCacheTtl' })
  expect(forkTtl({ forkEnv: '1h', forkSetting: '5m' })).toEqual({ ttl: '1h', source: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' })
  expect(forkTtl({ force5m: 'yes', forkEnv: '1h' })).toEqual({ ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' })
  expect(forkTtl({ mainEnv: '1h' })).toEqual({ ttl: '5m', source: 'default' })
})

test('flags: unset, empty and false-like words are off', () => {
  for (const off of [undefined, '', '0', 'false', 'No', ' off ']) expect(isFlag(off)).toBe(false)
  for (const on of ['1', 'true', 'yes']) expect(isFlag(on)).toBe(true)
})

test('warm: something read and less than a tenth of it paid in full', () => {
  expect(isWarm(u(40_000, 120))).toBe(true)
  expect(isWarm(u(1000, 99, 0))).toBe(true)
  expect(isWarm(u(1000, 100, 0))).toBe(false)
  expect(isWarm(u(18_000, 22_000))).toBe(false)
  // Uncached input is paid in full just like a cache write.
  expect(isWarm(u(18_000, 0, 22_000))).toBe(false)
  expect(isWarm(u(0, 0, 0))).toBe(false)
})

test('usage helpers', () => {
  expect(promptTokens(u(40_000, 120))).toBe(40_123)
  expect(pickUsage({ ...u(5, 6), model: 'x' } as never)).toEqual(u(5, 6))
  expect(usageLine(u(40_000, 120))).toBe('read 40.0k · write 120 · input 3 · aus Cache 100 % → warm')
  expect(usageLine(u(18_000, 22_000))).toBe('read 18.0k · write 22.0k · input 3 · aus Cache 45 % → KALT')
  expect(usageLine(u(0, 0, 0))).toBe('read 0 · write 0 · input 0 · aus Cache 0 % → KALT')
})

test('formatting', () => {
  expect(fmtTokens(3)).toBe('3')
  expect(fmtTokens(40_000)).toBe('40.0k')
  expect(fmtTokens(1_234_567)).toBe('1.2M')
  expect(fmtSpan(4 * 60_000)).toBe('4:00')
  expect(fmtSpan(65 * 60_000)).toBe('1h05')
  expect(fmtSpan(-5)).toBe('0:00')
  expect(ttlLine({ ttl: '1h', source: 'a' }, { ttl: '5m', source: 'b' })).toBe('TTL Hauptverlauf 1h (a) · Fork 5m (b)')
})

test('spans: seconds, minutes, hours; nothing else', () => {
  expect(parseSpan('90s')).toBe(90_000)
  expect(parseSpan('4m')).toBe(240_000)
  expect(parseSpan(' 50M ')).toBe(3_000_000)
  expect(parseSpan('1h')).toBe(3_600_000)
  for (const bad of ['', '0m', '4', '4 m', 'm', '-4m', '4.5m', '99999m']) expect(parseSpan(bad)).toBe(null)
})
