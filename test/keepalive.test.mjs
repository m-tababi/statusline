import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_AGE_MS, OVERDUE_MS, PING_STUCK_MS, keepaliveDir, parseKeepalive, readKeepalive,
} from '../lib/keepalive.mjs';

const SID = '00000000-0000-0000-0000-000000000000';
const NOW = Date.parse('2026-10-08T10:00:00Z');
const file = (extra = {}) => JSON.stringify({
  v: 1, sessionId: SID, enabled: true, state: 'armed', reason: null,
  nextPingAt: NOW + 60_000, warmUntil: null, updatedAt: NOW, ...extra,
});

test('a well-formed file yields enabled, state and warmUntil', () => {
  assert.deepEqual(parseKeepalive(file({ warmUntil: NOW + 5 }), SID, NOW), { enabled: true, state: 'armed', warmUntil: NOW + 5 });
  assert.deepEqual(parseKeepalive(file({ state: 'pinging' }), SID, NOW), { enabled: true, state: 'pinging', warmUntil: null });
});

test('disabled reads as off whatever the state says', () => {
  for (const state of ['off', 'armed']) {
    assert.deepEqual(parseKeepalive(file({ enabled: false, state }), SID, NOW), { enabled: false, state: 'off', warmUntil: null });
  }
});

test('enabled with state off is inconsistent and ignored', () => {
  assert.equal(parseKeepalive(file({ state: 'off' }), SID, NOW), null);
});

test('corrupt, partial, foreign, unknown-version or unknown-state files are no state', () => {
  const bad = ['', '{', '{"v":1', 'null', '[]', '42', file({ v: 2 }), file({ sessionId: 'other' }),
    file({ state: 'dancing' }), file({ state: 'toString' }), file({ enabled: 'yes' }), file({ updatedAt: 'x' })];
  for (const text of bad) assert.equal(parseKeepalive(text, SID, NOW), null, text);
});

test('a file older than a day is no state', () => {
  assert.equal(parseKeepalive(file({ updatedAt: NOW - MAX_AGE_MS - 1 }), SID, NOW), null);
  assert.notEqual(parseKeepalive(file({ updatedAt: NOW - MAX_AGE_MS }), SID, NOW), null);
});

test('an armed file whose ping is overdue reads as paused and vouches for nothing', () => {
  assert.deepEqual(
    parseKeepalive(file({ nextPingAt: NOW - OVERDUE_MS - 1, warmUntil: NOW + 5 }), SID, NOW),
    { enabled: true, state: 'paused', warmUntil: null },
  );
  assert.equal(parseKeepalive(file({ nextPingAt: NOW - OVERDUE_MS }), SID, NOW).state, 'armed');
});

test('a pinging file stuck for minutes reads as paused', () => {
  assert.equal(parseKeepalive(file({ state: 'pinging', updatedAt: NOW - PING_STUCK_MS - 1 }), SID, NOW).state, 'paused');
});

test('paused never carries warmUntil', () => {
  assert.equal(parseKeepalive(file({ state: 'paused', warmUntil: NOW + 5 }), SID, NOW).warmUntil, null);
});

test('keepaliveDir prefers CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  assert.equal(keepaliveDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/h'), '/cfg/keepalive');
  assert.equal(keepaliveDir({ CLAUDE_CONFIG_DIR: '' }, '/h'), '/h/.claude/keepalive');
  assert.equal(keepaliveDir({}, '/h'), '/h/.claude/keepalive');
});

// A config dir whose keepalive/<SID>.json is made by `make(path)`; removed after `body(dir)`.
function withFile(make, body) {
  const dir = mkdtempSync(join(tmpdir(), 'karead-'));
  try {
    mkdirSync(join(dir, 'keepalive'));
    make(join(dir, 'keepalive', `${SID}.json`));
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const readIn = (dir, sid = SID) => readKeepalive(sid, { env: { CLAUDE_CONFIG_DIR: dir }, home: '/nonexistent', now: NOW });

test('readKeepalive reads <dir>/keepalive/<id>.json', () => {
  withFile((path) => writeFileSync(path, file()), (dir) => {
    assert.deepEqual(readIn(dir), { enabled: true, state: 'armed', warmUntil: null });
  });
});

test('readKeepalive refuses unsafe session ids', () => {
  withFile((path) => writeFileSync(path, file()), (dir) => {
    // keepalive/../x.json would be a valid file for the id "../x" without the id check.
    writeFileSync(join(dir, 'x.json'), file({ sessionId: '../x' }));
    for (const sid of ['../x', 'a/b', '', 'x'.repeat(129), null, 42]) {
      assert.equal(readIn(dir, sid), null, String(sid));
    }
    // readIn's default would turn undefined into SID, so undefined goes in directly.
    assert.equal(readKeepalive(undefined, { env: { CLAUDE_CONFIG_DIR: dir }, home: '/nonexistent', now: NOW }), null);
  });
});

test('a missing file or config dir is no state', () => {
  assert.equal(readIn('/nonexistent/claude-config'), null);
});

test('an oversized file is no state', () => {
  withFile((path) => writeFileSync(path, ' '.repeat(5000) + file()), (dir) => {
    assert.equal(readIn(dir), null);
  });
});

test('a FIFO at the path is no state and does not block', () => {
  withFile((path) => assert.equal(spawnSync('mkfifo', [path]).status, 0), (dir) => {
    const t0 = Date.now();
    assert.equal(readIn(dir), null);
    assert.ok(Date.now() - t0 < 500, 'read blocked');
  });
});

test('a directory at the path is no state', () => {
  withFile((path) => mkdirSync(path), (dir) => {
    assert.equal(readIn(dir), null);
  });
});
