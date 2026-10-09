import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.match(r.stdout, /^◆ Opus 5\.5 high {2}│ {2}ctx ━━━━━─── 58%/);
  assert.ok(r.stdout.includes('  │  proj  │  '), r.stdout); // fixture dir does not exist → no git, project only
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
  assert.ok(!narrow.includes('⏱') && !narrow.includes('2h10'), narrow);
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

test('a git that ignores SIGTERM and hangs cannot stall the line (CIFS guarantee)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakegit-'));
  try {
    const fake = join(dir, 'git');
    writeFileSync(fake, '#!/bin/sh\ntrap "" TERM\nsleep 3\n');
    chmodSync(fake, 0o755);
    const input = JSON.stringify({ ...JSON.parse(FULL), workspace: { current_dir: tmpdir() } });
    const t0 = Date.now();
    const r = run(input, { NO_COLOR: '1', PATH: `${dir}:${process.env.PATH}` });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.ok(r.stdout.length > 0);
    assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no keep-alive state file is read: a fresh one of this session changes nothing', () => {
  const plainLine = run(FULL, { NO_COLOR: '1' }).stdout;
  const dir = mkdtempSync(join(tmpdir(), 'kacfg-'));
  const body = JSON.stringify({
    v: 1, sessionId: '00000000-0000-0000-0000-000000000000', enabled: true, state: 'armed', reason: null,
    nextPingAt: Date.now() + 60_000, warmUntil: Date.now() + 30 * 60_000, updatedAt: Date.now(),
  });
  try {
    // Where the plugin used to write it: under CLAUDE_CONFIG_DIR, else ~/.claude.
    for (const base of [join(dir, 'cfg'), join(dir, 'home', '.claude')]) {
      mkdirSync(join(base, 'keepalive'), { recursive: true });
      writeFileSync(join(base, 'keepalive', '00000000-0000-0000-0000-000000000000.json'), body);
    }
    for (const env of [{ CLAUDE_CONFIG_DIR: join(dir, 'cfg') }, { HOME: join(dir, 'home') }]) {
      const r = run(FULL, { NO_COLOR: '1', ...env });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, plainLine);
      assert.ok(!/[⚡❄↻⇡∅]/.test(r.stdout), r.stdout);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
