process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render, FALLBACK } from '../lib/render.mjs';
import { visibleWidth } from '../lib/format.mjs';

const NOW = Date.parse('2026-10-08T10:00:00Z'); // 1791453600 s, a Thursday
const full = () => JSON.parse(readFileSync(new URL('./fixtures/full.json', import.meta.url), 'utf8'));
const GIT = { branch: 'master', dirty: true };
const plain = (input, extra = {}) =>
  render(input, { columns: 200, now: NOW, git: GIT, color: false, ...extra });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('full fixture renders every group in order', () => {
  assert.equal(
    plain(full()),
    '◆ Opus 5.5 high   ctx ▕██▉  ▏58%   5h ▕▋    ▏12% ·2h10   7d ▕█▊   ▏34% ·Mo   ⎇ master● proj   ⚡ 3:12   ⏱ 1h12',
  );
});

test('empty object keeps only the model placeholder', () => {
  assert.equal(render({}, { columns: 200, now: NOW, git: null, color: false }), '◆ ?');
});

test('non-object input falls back', () => {
  for (const bad of [null, 42, 'x', []]) {
    assert.equal(render(bad, { columns: 200, now: NOW, git: null, color: false }), FALLBACK);
  }
});

test('without rate_limits the 5h and 7d groups disappear', () => {
  const input = full();
  delete input.rate_limits;
  const line = plain(input);
  assert.ok(!line.includes('5h') && !line.includes('7d'), line);
  assert.ok(line.includes('ctx ▕'), line);
});

test('missing effort is omitted, missing model shows ?', () => {
  const input = full();
  delete input.effort;
  assert.ok(plain(input).startsWith('◆ Opus 5.5   ctx'));
  delete input.model;
  assert.ok(plain(input).startsWith('◆ ?   ctx'));
});

test('context used_percentage null (before the first answer) drops the ctx group', () => {
  const input = full();
  input.context_window.used_percentage = null;
  assert.ok(!plain(input).includes('ctx'));
});

test('cold cache shows a snowflake', () => {
  const input = full();
  input.prompt_cache = { warm: false, ttl: '5m', expires_at: null };
  assert.ok(plain(input).includes('   ❄   ⏱'));
});

test('warm cache with expires_at null shows the bolt without a clock', () => {
  const input = full();
  input.prompt_cache.expires_at = null;
  assert.ok(plain(input).includes('proj   ⚡   ⏱'));
});

test('warm cache already expired shows a snowflake, never a negative clock', () => {
  const input = full();
  input.prompt_cache.expires_at = NOW / 1000 - 5;
  const line = plain(input);
  assert.ok(line.includes('   ❄   ⏱') && !line.includes('-'), line);
});

test('resets_at in the past drops only the reset hint', () => {
  const input = full();
  input.rate_limits.five_hour.resets_at = NOW / 1000 - 60;
  assert.ok(plain(input).includes('5h ▕▋    ▏12%   7d'));
});

test('resets_at in milliseconds is read like seconds', () => {
  const input = full();
  input.rate_limits.five_hour.resets_at *= 1000;
  input.prompt_cache.expires_at *= 1000;
  assert.equal(plain(input), plain(full()));
});

test('7d reset under 24 h shows the remaining time instead of the weekday', () => {
  const input = full();
  input.rate_limits.seven_day.resets_at = NOW / 1000 + 5 * 3600;
  assert.ok(plain(input).includes('34% ·5h00'));
});

test('git null shows only the project; worktree.branch is used when git is null', () => {
  assert.ok(plain(full(), { git: null }).includes('34% ·Mo   proj   ⚡'));
  const input = full();
  input.worktree = { name: 'wt', branch: 'feature/x' };
  assert.ok(plain(input, { git: null }).includes('⎇ feature/x proj'));
});

test('colour thresholds paint bar and percent', () => {
  const input = full();
  for (const [pct, code] of [[49, 114], [50, 179], [79, 179], [80, 203]]) {
    input.context_window.used_percentage = pct;
    const line = render(input, { columns: 200, now: NOW, git: GIT, color: true });
    assert.ok(line.includes(`\x1b[38;5;${code}m${pct}%\x1b[39m`), `pct=${pct}`);
  }
});

test('color=false emits no escape sequences', () => {
  assert.ok(!plain(full()).includes('\x1b'));
});

test('narrow terminals drop duration, project, cache, then reset hints', () => {
  const at = (columns) => plain(full(), { columns });
  assert.ok(at(200).includes('⏱'));
  const w100 = at(100);
  assert.ok(!w100.includes('⏱') && !w100.includes(' proj') && w100.includes('⚡'), w100);
  const w60 = at(60);
  assert.equal(w60, '◆ Opus 5.5 high   ctx ▕██▉  ▏58%   5h ▕▋    ▏12%   7d ▕█▊   ▏34%   ⎇ master●');
});

test('width fitting ignores ANSI codes: coloured and plain lines drop the same groups', () => {
  for (const columns of [60, 80, 100, 120, 200]) {
    const coloured = render(full(), { columns, now: NOW, git: GIT, color: true });
    assert.equal(strip(coloured), plain(full(), { columns }), `columns=${columns}`);
    if (columns >= 80) assert.ok(visibleWidth(coloured) <= columns, `columns=${columns}`);
  }
});
