# statusline

A one-line status line for Claude Code. A plain Node script, no dependencies, no network, no credentials.

```
▐◆ Opus 5.5 high▌  │  ctx ━━━━━─── 58%  │  5h ━─────── 12% 2h10  │  7d ━━━───── 34% Mo  │  ⎇  master ●  proj  │  ⚡  3:12  │  ⏱ 1h12
```

## Groups

| Group | Shows | Source (stdin JSON) | Missing → |
|---|---|---|---|
| Model | `▐◆ <name> <effort>▌` (a purple capsule; with `NO_COLOR`: `◆ <name> <effort>`) | `model.display_name`, `effort.level` | effort omitted; no model name → `◆ ?` |
| Context | `ctx ━━━━━─── 58%` | `context_window.used_percentage` | group omitted (also while it is `null`) |
| 5h | `5h ━─────── 12% 2h10` | `rate_limits.five_hour` | group omitted |
| 7d | `7d ━━━───── 34% Mo` (under 24 h left: remaining time instead of the weekday) | `rate_limits.seven_day` | group omitted |
| Git | `⎇  <branch>[ ●]  <project>` | `git` in `workspace.current_dir`; project = basename of `workspace.project_dir` (falls back to `current_dir`) | project only; branch falls back to `worktree.branch` |
| Cache | `⚡  m:ss` warm, `❄` cold or expired; a warm cache without `expires_at` shows a bare `⚡` | `prompt_cache.warm`, `prompt_cache.expires_at` | group omitted |
| Duration | `⏱ 1h12` / `45m` | `cost.total_duration_ms` | group omitted |

Groups are separated by `  │  `. The `●` after the branch marks uncommitted changes to tracked files. Weekday abbreviations are German (`So Mo Di Mi Do Fr Sa`).

Each bar has eight cells of `━`. Filled cells (`round(percent / 100 * 8)`) shade from green to red by position, so a fuller bar reaches further into red; empty cells are dark grey. Labels, reset hints, the project name and the duration are grey, the percentage, branch and cache clock are bold. Colours are off when `NO_COLOR` is set and non-empty; empty bar cells are then `─` and the capsule loses its edges. Weekdays and reset times use the local system time.
When the line is too wide, parts are dropped in this order until it fits: duration, project name, cache, reset hints. If it still does not fit after all drops, it is printed anyway and the host truncates it.
Input that is not valid JSON or not a JSON object prints `◆ Claude`. The script always exits 0, because a non-zero exit blanks the line.

## Install

`~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "/path/to/node /path/to/statusline/statusline.mjs",
  "refreshInterval": 1
}
```

`refreshInterval` is in seconds (minimum 1). Use an absolute path to `node`, so the line also works when Claude Code starts without your version manager on `PATH`.

If you use nvm, the path contains the Node version and goes stale after an upgrade; the line then turns blank. Check that the binary still exists and update the version in `statusLine.command`:

```bash
ls /path/to/node || ls ~/.nvm/versions/node/
```

## Width

The script reads `COLUMNS` (120 if missing or invalid) and keeps 4 columns spare (`RESERVED_COLUMNS` in `statusline.mjs`).

## Git

Two git calls run in parallel (a detached HEAD adds a third, sequential `rev-parse --short`), each with a 300 ms timeout, a 400 ms hard deadline and `--no-optional-locks`:
- `rev-parse --abbrev-ref HEAD` gives the branch. A detached HEAD shows the short SHA.
- `status --porcelain -uno` checks tracked files only, which keeps it fast on network shares.

A timeout or error drops the dirty dot; if the branch lookup fails, the branch is dropped. The line itself stays.

## Tests

```bash
node --test test/*.test.mjs
```

## License

MIT, see `LICENSE`.
