import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGit } from '../lib/git.mjs';

function stub(answers) {
  return async (args) => {
    const key = args.join(' ');
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`unexpected git ${key}`);
    return answer;
  };
}

test('branch and dirty from a stubbed runner', async () => {
  const run = stub({
    'rev-parse --abbrev-ref HEAD': 'master\n',
    'status --porcelain -uno': ' M a.txt\n',
  });
  assert.deepEqual(await getGit('/repo', run), { branch: 'master', dirty: true });
});

test('detached HEAD shows the short SHA', async () => {
  const run = stub({
    'rev-parse --abbrev-ref HEAD': 'HEAD\n',
    'rev-parse --short HEAD': 'a1b2c3d\n',
    'status --porcelain -uno': '',
  });
  assert.deepEqual(await getGit('/repo', run), { branch: 'a1b2c3d', dirty: false });
});

test('not a repository → null', async () => {
  const fail = new Error('fatal: not a git repository');
  const run = stub({ 'rev-parse --abbrev-ref HEAD': fail, 'status --porcelain -uno': fail });
  assert.equal(await getGit('/nowhere', run), null);
});

test('dirty lookup timing out keeps the branch and drops the dot', async () => {
  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  const run = stub({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'status --porcelain -uno': timeout });
  assert.deepEqual(await getGit('/repo', run), { branch: 'main', dirty: false });
});

test('a hanging git (stuck I/O on a network share) resolves by the deadline', async () => {
  const hang = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await getGit('/repo', hang, 50), null);
  assert.ok(Date.now() - started < 500);
});

test('branch answers, dirty hangs → branch without the dot', async () => {
  const run = (args) => (args[0] === 'status' ? new Promise(() => {}) : Promise.resolve('main\n'));
  assert.deepEqual(await getGit('/repo', run, 50), { branch: 'main', dirty: false });
});

test('missing cwd → null without calling git', async () => {
  const run = async () => { throw new Error('must not be called'); };
  assert.equal(await getGit(undefined, run), null);
  assert.equal(await getGit('', run), null);
});

test('real repository: clean, dirty, detached', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
  assert.deepEqual(await getGit(dir), { branch: 'main', dirty: false });
  writeFileSync(join(dir, 'untracked.txt'), 'x\n');
  assert.deepEqual(await getGit(dir), { branch: 'main', dirty: false }, 'untracked files are ignored');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  assert.deepEqual(await getGit(dir), { branch: 'main', dirty: true });
  git('checkout', '-q', '--detach');
  const sha = String(git('rev-parse', '--short', 'HEAD')).trim();
  assert.deepEqual(await getGit(dir), { branch: sha, dirty: true });
});
