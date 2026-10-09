process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPct, gradientBar, bold, paint, visibleWidth, fmtSpan, fmtClock, weekdayShort, toMs,
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

test('gradientBar fills round(p/100*8) of eight cells', () => {
  const filled = (p) => [...gradientBar(p, false)].filter((c) => c === '\u2501').length;
  assert.equal(filled(0), 0);
  assert.equal(filled(58), 5);
  assert.equal(filled(100), 8);
  assert.equal(gradientBar(0, false), '\u2500'.repeat(8));
  assert.equal(gradientBar(58, false), '\u2501'.repeat(5) + '\u2500'.repeat(3));
  assert.equal(gradientBar(100, false), '\u2501'.repeat(8));
  for (let p = 0; p <= 100; p++) assert.equal([...gradientBar(p, false)].length, 8, `p=${p}`);
});

test('gradientBar colours filled cells green to red by position, empty cells grey', () => {
  const bar = gradientBar(100, true);
  assert.ok(bar.startsWith('\x1b[38;2;90;200;120m\u2501\x1b[39m'), bar);
  assert.ok(bar.endsWith('\x1b[38;2;255;80;120m\u2501\x1b[39m'), bar);
  const half = gradientBar(50, true);
  assert.equal(half.split('\x1b[38;5;238m\u2501\x1b[39m').length - 1, 4);
  assert.equal(visibleWidth(half), 8);
});

test('bold wraps in bold and reset only when enabled', () => {
  assert.equal(bold('x', true), '\x1b[1mx\x1b[0m');
  assert.equal(bold('x', false), 'x');
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

test('weekdayShort returns an empty string for an out-of-range epoch', () => {
  assert.equal(weekdayShort(1e20), '');
});

test('toMs accepts epoch seconds and epoch milliseconds', () => {
  assert.equal(toMs(1791453600), 1791453600000);
  assert.equal(toMs(1791453600000), 1791453600000);
  assert.equal(toMs(null), null);
  assert.equal(toMs(Number.NaN), null);
});
