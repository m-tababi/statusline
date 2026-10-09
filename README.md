# statusline

A one-line status line for Claude Code. A plain Node script, no dependencies, no network, no credentials.

```
◆ Opus 5.5 high   ctx ▕██▉  ▏58%   5h ▕▋    ▏12% ·2h10   7d ▕█▊   ▏34% ·Mo   ⎇ master● proj   ⚡ 3:12   ⏱ 1h12
```

## Groups

| Group | Shows | Source (stdin JSON) | Missing → |
|---|---|---|---|
| Model | `◆ <name> <effort>` | `model.display_name`, `effort.level` | effort omitted; no model name → `◆ ?` |
| Context | `ctx ▕bar▏58%` | `context_window.used_percentage` | group omitted (also while it is `null`) |
| 5h | `5h ▕bar▏12% ·2h10` | `rate_limits.five_hour` | group omitted |
| 7d | `7d ▕bar▏34% ·Mo` (under 24 h left: remaining time instead of the weekday) | `rate_limits.seven_day` | group omitted |
| Git | `⎇ <branch>[●] <project>` | `git` in `workspace.current_dir`; project = basename of `workspace.project_dir` (falls back to `current_dir`) | project only; branch falls back to `worktree.branch` |
| Cache | `⚡ m:ss` warm, `❄` cold or expired | `prompt_cache.warm`, `prompt_cache.expires_at` | group omitted |
| Duration | `⏱ 1h12` / `45m` | `cost.total_duration_ms` | group omitted |

The `●` after the branch marks uncommitted changes to tracked files. Weekday abbreviations are German (`So Mo Di Mi Do Fr Sa`).

Bars and percentages are green below 50 %, yellow below 80 %, red from 80 %. Set `NO_COLOR` to turn colours off.
When the line is too wide, groups are dropped in this order until it fits: duration, project name, cache, reset hints.
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

Two git calls run in parallel, each with a 300 ms timeout, a 400 ms hard deadline and `--no-optional-locks`:
- `rev-parse --abbrev-ref HEAD` gives the branch. A detached HEAD shows the short SHA.
- `status --porcelain -uno` checks tracked files only, which keeps it fast on network shares.

A timeout or error drops the dirty dot; if the branch lookup fails, the branch is dropped. The line itself stays.

## Tests

```bash
node --test test/*.test.mjs
```

## License

MIT, see `LICENSE`.
