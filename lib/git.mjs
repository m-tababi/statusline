// Branch and dirty flag for the status line. Never throws; failures become null/false.
import { execFile } from 'node:child_process';

const TIMEOUT_MS = 300;
// Hard cap per lookup: a git stuck in uninterruptible I/O ignores SIGTERM,
// so execFile's callback may never fire.
const DEADLINE_MS = 400;

/** Run one git command in `cwd`; resolves stdout, rejects on error, non-zero exit or timeout. */
export function runGit(args, cwd, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd, timeout, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

async function branchOf(cwd, run) {
  const name = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  if (name !== 'HEAD') return name;
  return (await run(['rev-parse', '--short', 'HEAD'], cwd)).trim();
}

async function dirtyOf(cwd, run) {
  // -uno: tracked files only; scanning untracked files is the slow part on network shares.
  return (await run(['status', '--porcelain', '-uno'], cwd)).trim().length > 0;
}

function withDeadline(promise, ms, fallback) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([promise.catch(() => fallback), deadline]).finally(() => clearTimeout(timer));
}

/**
 * { branch, dirty } for the repository containing `cwd`, or null when there is no
 * repository, git is missing or the branch lookup times out. An unknown dirty state
 * (error or timeout) is reported as false: no dot rather than a wrong dot.
 */
export async function getGit(cwd, run = runGit, deadline = DEADLINE_MS) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const [branch, dirty] = await Promise.all([
    withDeadline(branchOf(cwd, run), deadline, null),
    withDeadline(dirtyOf(cwd, run), deadline, false),
  ]);
  return branch ? { branch, dirty } : null;
}
