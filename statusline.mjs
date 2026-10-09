#!/usr/bin/env node
// Status line command: JSON on stdin, one line on stdout. Always exits 0 —
// a non-zero exit blanks the line in the host.
import { getGit } from './lib/git.mjs';
import { render, FALLBACK } from './lib/render.mjs';

const DEFAULT_COLUMNS = 120;
// COLUMNS is the host's full terminal width; the status line is drawn with
// a small indent, so keep a margin to avoid the host's own truncation.
const RESERVED_COLUMNS = 4;

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function terminalColumns(env) {
  const parsed = Number.parseInt(env.COLUMNS ?? '', 10);
  return (parsed > 0 ? parsed : DEFAULT_COLUMNS) - RESERVED_COLUMNS;
}

async function main() {
  let line = FALLBACK;
  try {
    const input = JSON.parse(await readStdin());
    const git = await getGit(input?.workspace?.current_dir);
    line = render(input, {
      columns: terminalColumns(process.env),
      now: Date.now(),
      git,
      color: !process.env.NO_COLOR,
    });
  } catch {
    line = FALLBACK;
  }
  // Exit explicitly once the line is flushed: an orphaned git child must not keep us alive.
  process.stdout.write(`${line}\n`, () => process.exit(0));
}

main();
