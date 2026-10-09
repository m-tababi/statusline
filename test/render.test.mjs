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
    ['◆ Opus 5.5 high', 'ctx ━━━━━─── 58%', '5h ━─────── 12% 2h10', '7d ━━━───── 34% Mo', '⎇  master ●  proj', '⏱ 1h12'].join('  │  '),
  );
});

test('the prompt cache draws nothing: warm, cold, expired or missing', () => {
  const line = plain(full());
  for (const cache of [{ warm: false, ttl: '5m', expires_at: null }, { warm: true, ttl: '1h', expires_at: null },
    { warm: true, ttl: '5m', expires_at: NOW / 1000 - 5 }, undefined]) {
    const input = full();
    input.prompt_cache = cache;
    assert.equal(plain(input), line);
  }
  assert.ok(!/[⚡❄]/.test(line), line);
  assert.ok(!/[⚡❄]/.test(strip(colored(full()))));
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
  assert.ok(line.includes('ctx '), line);
});

test('missing effort is omitted, missing model shows ?', () => {
  const input = full();
  delete input.effort;
  assert.ok(plain(input).startsWith('◆ Opus 5.5  │  ctx'));
  delete input.model;
  assert.ok(plain(input).startsWith('◆ ?  │  ctx'));
});

test('context used_percentage null (before the first answer) drops the ctx group', () => {
  const input = full();
  input.context_window.used_percentage = null;
  assert.ok(!plain(input).includes('ctx'));
});

test('resets_at in the past drops only the reset hint', () => {
  const input = full();
  input.rate_limits.five_hour.resets_at = NOW / 1000 - 60;
  assert.ok(plain(input).includes('5h ━─────── 12%  │  7d'));
});

test('resets_at in milliseconds is read like seconds', () => {
  const input = full();
  input.rate_limits.five_hour.resets_at *= 1000;
  assert.equal(plain(input), plain(full()));
});

test('7d reset under 24 h shows the remaining time instead of the weekday', () => {
  const input = full();
  input.rate_limits.seven_day.resets_at = NOW / 1000 + 5 * 3600;
  assert.ok(plain(input).includes('34% 5h00'));
});

test('git null shows only the project; worktree.branch is used when git is null', () => {
  assert.ok(plain(full(), { git: null }).includes('34% Mo  │  proj  │  ⏱'));
  const input = full();
  input.worktree = { name: 'wt', branch: 'feature/x' };
  assert.ok(plain(input, { git: null }).includes('⎇  feature/x  proj'));
});

const GRAY = '\x1b[38;5;238m';
const RESET = '\x1b[0m';
const colored = (input, extra = {}) =>
  render(input, { columns: 200, now: NOW, git: GIT, color: true, ...extra });

test('model capsule, separators and gradient bar carry the exact colour sequences', () => {
  const line = colored(full());
  assert.ok(line.startsWith(
    '\x1b[38;5;141m▐\x1b[48;5;141m\x1b[38;5;16m\x1b[1m◆ Opus 5.5\x1b[48;5;141m\x1b[38;5;16m high'
    + `${RESET}\x1b[38;5;141m▌${RESET}`,
  ), JSON.stringify(line));
  assert.ok(line.includes(`${GRAY}│\x1b[39m`), 'separator in fg 238');
  assert.equal(line.split(`  ${GRAY}│`).length - 1, 5);
  assert.ok(line.includes('\x1b[38;2;90;200;120m━\x1b[39m'), 'cell 0');
  assert.ok(!line.includes('\x1b[38;2;255;80;120m'), 'cell 7 stays empty at 58%');
  assert.ok(line.includes(`${GRAY}━\x1b[39m`), 'empty cell');
  assert.ok(line.includes('\x1b[1m58%'), 'percent is bold');
  assert.ok(line.includes('\x1b[38;5;245mctx\x1b[39m'), 'label grey');
  const input = full();
  input.context_window.used_percentage = 100;
  assert.ok(colored(input).includes('\x1b[38;2;255;80;120m━\x1b[39m'), 'cell 7');
});

test('git, duration and reset hint colours', () => {
  const line = colored(full());
  assert.ok(line.includes('\x1b[38;5;75m⎇\x1b[39m  \x1b[1mmaster'), JSON.stringify(line));
  assert.ok(line.includes(' \x1b[38;5;179m●\x1b[39m  \x1b[38;5;245mproj\x1b[39m'), JSON.stringify(line));
  assert.ok(line.includes('\x1b[38;5;245m⏱ 1h12\x1b[39m'), JSON.stringify(line));
  assert.ok(line.includes(' \x1b[38;5;245m2h10\x1b[39m'), JSON.stringify(line));
});

test('clean git shows no dirty dot; no branch shows only the grey project', () => {
  assert.ok(plain(full(), { git: { branch: 'master', dirty: false } }).includes('⎇  master  proj'));
  const line = colored(full(), { git: null });
  assert.ok(line.includes('\x1b[38;5;245mproj\x1b[39m') && !line.includes('⎇'), line);
});

test('color=false emits no escape sequences', () => {
  assert.ok(!plain(full()).includes('\x1b'));
});

test('narrow terminals drop duration, project, then reset hints', () => {
  const at = (columns) => plain(full(), { columns });
  const all = at(200);
  const noDuration = ['◆ Opus 5.5 high', 'ctx ━━━━━─── 58%', '5h ━─────── 12% 2h10', '7d ━━━───── 34% Mo', '⎇  master ●  proj'].join('  │  ');
  const noProject = noDuration.slice(0, -'  proj'.length);
  const noResets = ['◆ Opus 5.5 high', 'ctx ━━━━━─── 58%', '5h ━─────── 12%', '7d ━━━───── 34%', '⎇  master ●'].join('  │  ');
  // The plain line counts the colour-only capsule edges too.
  assert.equal(at(visibleWidth(all) + 2), all);
  assert.equal(at(visibleWidth(all) + 1), noDuration);
  assert.equal(at(visibleWidth(noDuration) + 1), noProject);
  assert.equal(at(visibleWidth(noProject) + 1), noResets);
  assert.equal(at(40), noResets);
});

test('width fitting ignores ANSI codes: coloured and plain lines drop the same groups', () => {
  for (const columns of [60, 80, 100, 115, 125, 135, 200]) {
    const coloured = render(full(), { columns, now: NOW, git: GIT, color: true });
    // the colour-only capsule edges and the empty-cell glyph are the only intended differences
    const norm = (t) => t.replace(/[▐▌]/g, '').replace(/[━─]/g, '-');
    assert.equal(norm(strip(coloured)), norm(plain(full(), { columns })), `columns=${columns}`);
    if (columns >= 95) assert.ok(visibleWidth(coloured) <= columns, `columns=${columns}`);
  }
});

test('empty effort level adds no trailing space', () => {
  const input = full();
  input.effort = { level: '' };
  assert.match(plain(input), /^◆ Opus 5\.5 {2}│ {2}ctx/); // separator only, no extra space
});

test('out-of-range weekly reset prints no bare reset dot', () => {
  const input = full();
  input.rate_limits.seven_day.resets_at = 1e20;
  const line = plain(input);
  assert.ok(line.includes('7d'), line);
  assert.ok(!line.includes('undefined'), line);
  assert.ok(/7d [━─]{8} \d+%\s+│/.test(line), line);
});
