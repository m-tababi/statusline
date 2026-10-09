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
    ['◆ Opus 5.5 high', 'ctx ━━━━━─── 58%', '5h ━─────── 12% 2h10', '7d ━━━───── 34% Mo', '⎇  master ●  proj', '⚡  3:12', '⏱ 1h12'].join('  │  '),
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

test('cold cache shows a snowflake', () => {
  const input = full();
  input.prompt_cache = { warm: false, ttl: '5m', expires_at: null };
  assert.ok(plain(input).includes('  │  ❄  │  ⏱'));
});

test('warm cache with expires_at null shows the bolt without a clock', () => {
  const input = full();
  input.prompt_cache.expires_at = null;
  assert.ok(plain(input).includes('proj  │  ⚡  │  ⏱'));
});

test('warm cache already expired shows a snowflake, never a negative clock', () => {
  const input = full();
  input.prompt_cache.expires_at = NOW / 1000 - 5;
  const line = plain(input);
  assert.ok(line.includes('  │  ❄  │  ⏱') && !line.includes('-'), line);
});

test('resets_at in the past drops only the reset hint', () => {
  const input = full();
  input.rate_limits.five_hour.resets_at = NOW / 1000 - 60;
  assert.ok(plain(input).includes('5h ━─────── 12%  │  7d'));
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
  assert.ok(plain(input).includes('34% 5h00'));
});

test('git null shows only the project; worktree.branch is used when git is null', () => {
  assert.ok(plain(full(), { git: null }).includes('34% Mo  │  proj  │  ⚡'));
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
  assert.equal(line.split(`  ${GRAY}│`).length - 1, 6);
  assert.ok(line.includes('\x1b[38;2;90;200;120m━\x1b[39m'), 'cell 0');
  assert.ok(!line.includes('\x1b[38;2;255;80;120m'), 'cell 7 stays empty at 58%');
  assert.ok(line.includes(`${GRAY}━\x1b[39m`), 'empty cell');
  assert.ok(line.includes('\x1b[1m58%'), 'percent is bold');
  assert.ok(line.includes('\x1b[38;5;245mctx\x1b[39m'), 'label grey');
  const input = full();
  input.context_window.used_percentage = 100;
  assert.ok(colored(input).includes('\x1b[38;2;255;80;120m━\x1b[39m'), 'cell 7');
});

test('git, cache, duration and reset hint colours', () => {
  const line = colored(full());
  assert.ok(line.includes('\x1b[38;5;75m⎇\x1b[39m  \x1b[1mmaster'), JSON.stringify(line));
  assert.ok(line.includes(' \x1b[38;5;179m●\x1b[39m  \x1b[38;5;245mproj\x1b[39m'), JSON.stringify(line));
  // fixture has 192 s left, so the yellow tier applies
  assert.ok(line.includes('\x1b[38;5;179m⚡\x1b[39m  \x1b[1m\x1b[38;5;179m3:12'), JSON.stringify(line));
  assert.ok(line.includes('\x1b[38;5;245m⏱ 1h12\x1b[39m'), JSON.stringify(line));
  assert.ok(line.includes(' \x1b[38;5;245m2h10\x1b[39m'), JSON.stringify(line));
  const noClock = full();
  noClock.prompt_cache.expires_at = null;
  assert.ok(strip(colored(noClock)).includes('proj  │  ⚡  │  ⏱'));
  assert.ok(colored(noClock).includes('\x1b[38;5;150m⚡\x1b[39m'));
  const cold = full();
  cold.prompt_cache.warm = false;
  assert.ok(colored(cold).includes('\x1b[38;5;110m❄\x1b[39m'));
});

test('clean git shows no dirty dot; no branch shows only the grey project', () => {
  assert.ok(plain(full(), { git: { branch: 'master', dirty: false } }).includes('⎇  master  proj'));
  const line = colored(full(), { git: null });
  assert.ok(line.includes('\x1b[38;5;245mproj\x1b[39m') && !line.includes('⎇'), line);
});

test('color=false emits no escape sequences', () => {
  assert.ok(!plain(full()).includes('\x1b'));
});

test('narrow terminals drop duration, project, cache, then reset hints', () => {
  const at = (columns) => plain(full(), { columns });
  assert.ok(at(200).includes('⏱'));
  const w115 = at(115);
  assert.ok(!w115.includes('⏱') && !w115.includes(' proj') && w115.includes('⚡'), w115);
  const w95 = at(95);
  assert.equal(w95, ['◆ Opus 5.5 high', 'ctx ━━━━━─── 58%', '5h ━─────── 12%', '7d ━━━───── 34%', '⎇  master ●'].join('  │  '));
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

test('warm cache colour follows the time left until expires_at', () => {
  const cases = [
    [601, 150, '10:01'], [600, 150, '10:00'], [599, 179, '9:59'],
    [181, 179, '3:01'], [180, 179, '3:00'], [179, 203, '2:59'],
  ];
  for (const [left, code, clock] of cases) {
    const input = full();
    input.prompt_cache.expires_at = NOW / 1000 + left;
    const line = colored(input);
    const fgc = `\x1b[38;5;${code}m`;
    assert.ok(line.includes(`${fgc}⚡\x1b[39m  \x1b[1m${code === 150 ? '' : fgc}${clock}`), `${left}s: ${JSON.stringify(line)}`);
    assert.ok(strip(line).includes(`⚡  ${clock}`), `${left}s clock`);
  }
});

test('cache colour is absent without colour', () => {
  const input = full();
  input.prompt_cache.expires_at = NOW / 1000 + 100;
  assert.ok(!plain(input).includes('\x1b'));
});

const KA = (state, extra = {}) => ({ enabled: state !== 'off', state, warmUntil: null, ...extra });

test('keep-alive marker follows the cache clock', () => {
  const at = (ka) => plain(full(), { keepalive: ka });
  assert.ok(at(KA('armed')).includes('  │  ⚡  3:12 ↻  │  ⏱'), at(KA('armed')));
  assert.ok(at(KA('pinging')).includes('⚡  3:12 ⇡  │'));
  assert.ok(at(KA('paused')).includes('⚡  3:12 ∅  │'));
  assert.ok(at(KA('off')).includes('⚡  3:12 off  │'));
});

test('no keep-alive state leaves the line byte-identical', () => {
  assert.equal(plain(full(), { keepalive: null }), plain(full()));
  assert.equal(render(full(), { columns: 200, now: NOW, git: GIT, color: true, keepalive: null }),
    render(full(), { columns: 200, now: NOW, git: GIT, color: true }));
});

test("the plugin's verified expiry outlives Claude Code's own", () => {
  const input = full();
  input.prompt_cache = { warm: false, ttl: '1h', expires_at: null };
  const line = plain(input, { keepalive: KA('armed', { warmUntil: NOW + 50 * 60 * 1000 }) });
  assert.ok(line.includes('⚡  50:00 ↻'), line);
});

test('the later of the two expiries wins', () => {
  assert.ok(plain(full(), { keepalive: KA('armed', { warmUntil: NOW + 60 * 1000 }) }).includes('⚡  3:12 ↻'));
  const noClock = full();
  noClock.prompt_cache.expires_at = null;
  assert.ok(plain(noClock, { keepalive: KA('armed', { warmUntil: NOW + 600 * 1000 }) }).includes('⚡  10:00 ↻'));
});

test('an expired plugin expiry does not warm a cold cache', () => {
  const input = full();
  input.prompt_cache = { warm: false, ttl: '1h', expires_at: null };
  assert.ok(plain(input, { keepalive: KA('armed', { warmUntil: NOW - 1 }) }).includes('  │  ❄ ↻  │  '));
});

test('without a prompt_cache object there is no cache group and no marker', () => {
  const input = full();
  delete input.prompt_cache;
  const line = plain(input, { keepalive: KA('armed') });
  assert.ok(!line.includes('↻') && !line.includes('⚡'), line);
});

test('marker colours: armed green, pinging yellow, paused and off grey', () => {
  const c = (ka) => render(full(), { columns: 200, now: NOW, git: GIT, color: true, keepalive: ka });
  assert.ok(c(KA('armed')).includes('\x1b[38;5;150m↻\x1b[39m'));
  assert.ok(c(KA('pinging')).includes('\x1b[38;5;179m⇡\x1b[39m'));
  assert.ok(c(KA('paused')).includes('\x1b[38;5;245m∅\x1b[39m'));
  assert.ok(c(KA('off')).includes('\x1b[38;5;245moff\x1b[39m'));
});

test('an unknown state draws no marker', () => {
  assert.equal(plain(full(), { keepalive: KA('dancing') }), plain(full()));
  assert.equal(plain(full(), { keepalive: KA('toString') }), plain(full()));
});

test('the marker counts for the width and leaves with the cache group', () => {
  // The line without project and duration is 112 wide (114 with the capsule
  // edges the plain mode counts): at 115 columns it fits without the marker,
  // and with " ↻" (116) the cache group has to go.
  assert.ok(plain(full(), { columns: 115 }).includes('⚡  3:12'));
  const line = plain(full(), { columns: 115, keepalive: KA('armed') });
  assert.ok(!line.includes('↻') && !line.includes('⚡'), line);
});
