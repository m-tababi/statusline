process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPct, bar, pctColor, paint, visibleWidth, fmtSpan, fmtClock, weekdayShort, toMs, COLOR,
} from '../lib/format.mjs';

test('clampPct rounds, clamps and rejects non-numbers', () => {
  assert.equal(clampPct(12.3), 12);
  assert.equal(clampPct(57.5), 58);
  assert.equal(clampPct(-3), 0);
  assert.equal(clampPct(140), 100);
  assert.equal(clampPct(null), null);
  assert.equal(clampPct(undefined), null);
  assert.equal(clampPct('50'), null);
});

test('bar is always five cells of eighth blocks', () => {
  assert.equal(bar(0), '     ');
  assert.equal(bar(100), '█████');
  assert.equal(bar(50), '██▌  ');
  assert.equal(bar(58), '██▉  ');
  assert.equal(bar(12), '▋    ');
  assert.equal(bar(34), '█▊   ');
  for (let p = 0; p <= 100; p++) assert.equal([...bar(p)].length, 5, `p=${p}`);
});

test('pctColor thresholds 49/50/79/80', () => {
  assert.equal(pctColor(49), COLOR.green);
  assert.equal(pctColor(50), COLOR.yellow);
  assert.equal(pctColor(79), COLOR.yellow);
  assert.equal(pctColor(80), COLOR.red);
});

test('paint adds and resets the foreground only when enabled', () => {
  assert.equal(paint('x', 114, true), '\x1b[38;5;114mx\x1b[39m');
  assert.equal(paint('x', 114, false), 'x');
});

test('visibleWidth strips ANSI and counts the lightning bolt as two columns', () => {
  assert.equal(visibleWidth(paint('abc', 114, true)), 3);
  assert.equal(visibleWidth('⚡ 3:12'), 7);
  assert.equal(visibleWidth('◆ ⎇ ❄ ⏱ ▕█▏'), 11);
});

test('fmtSpan and fmtClock', () => {
  assert.equal(fmtSpan(7800e3), '2h10');
  assert.equal(fmtSpan(45 * 60e3 + 59e3), '45m');
  assert.equal(fmtSpan(-5), '0m');
  assert.equal(fmtClock(192e3), '3:12');
  assert.equal(fmtClock(-1), '0:00');
});

test('weekdayShort uses local time (TZ pinned to UTC in this file)', () => {
  assert.equal(weekdayShort(Date.parse('2026-10-12T06:00:00Z')), 'Mo');
  assert.equal(weekdayShort(Date.parse('2026-10-11T23:59:00Z')), 'So');
});

test('toMs accepts epoch seconds and epoch milliseconds', () => {
  assert.equal(toMs(1791453600), 1791453600000);
  assert.equal(toMs(1791453600000), 1791453600000);
  assert.equal(toMs(null), null);
  assert.equal(toMs(Number.NaN), null);
});
