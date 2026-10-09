import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SCRIPT = new URL('../statusline.mjs', import.meta.url).pathname;
const FULL = readFileSync(new URL('./fixtures/full.json', import.meta.url), 'utf8');

function run(stdin, env = {}) {
  const base = { PATH: process.env.PATH, TZ: 'UTC', COLUMNS: '204' };
  return spawnSync(process.execPath, [SCRIPT], {
    input: stdin,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('full fixture: exit 0, one line, nothing on stderr', () => {
  const r = run(FULL, { NO_COLOR: '1' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^◆ Opus 5\.5 high {3}ctx ▕██▉ {2}▏58%/);
  assert.ok(r.stdout.includes('   proj   '), r.stdout); // fixture dir does not exist → no git, project only
  assert.equal(r.stdout.split('\n').length, 2); // one line plus trailing newline
});

test('NO_COLOR unset → ANSI colours present', () => {
  assert.ok(run(FULL).stdout.includes('\x1b[38;5;'));
});

test('NO_COLOR set → no escape sequences', () => {
  assert.ok(!run(FULL, { NO_COLOR: '1' }).stdout.includes('\x1b'));
});

test('invalid JSON, empty stdin and JSON null fall back to the plain line', () => {
  for (const bad of ['{not json', '', 'null']) {
    const r = run(bad);
    assert.equal(r.status, 0, `input=${bad}`);
    assert.equal(r.stdout, '◆ Claude\n', `input=${bad}`);
    assert.equal(r.stderr, '', `input=${bad}`);
  }
});

test('COLUMNS narrows the line (reserved margin applied)', () => {
  const wide = run(FULL, { NO_COLOR: '1', COLUMNS: '204' }).stdout;
  const narrow = run(FULL, { NO_COLOR: '1', COLUMNS: '64' }).stdout;
  assert.ok(wide.includes('⏱'));
  assert.ok(!narrow.includes('⏱') && !narrow.includes('·'), narrow);
});

test('missing or invalid COLUMNS still renders the full-featured default width', () => {
  for (const cols of [undefined, '', 'abc', '0', 'NaN']) {
    const base = { PATH: process.env.PATH, TZ: 'UTC', NO_COLOR: '1' };
    if (cols !== undefined) base.COLUMNS = cols;
    const r = spawnSync(process.execPath, [SCRIPT], { input: FULL, env: base, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, `cols=${cols}`);
    assert.equal(r.stderr, '', `cols=${cols}`);
    assert.match(r.stdout, /^◆ Opus 5\.5/, `cols=${cols}`);
    assert.ok(r.stdout.includes('proj'), `cols=${cols}: ${r.stdout}`);
  }
});
