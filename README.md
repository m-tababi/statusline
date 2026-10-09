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
| Cache | `⚡  m:ss` warm, `❄` cold or expired; a warm cache without `expires_at` shows a bare `⚡`; with colour, `⚡` and the clock turn yellow under 10 minutes left and red under 3. With the plugin, a keep-alive marker follows: `↻` armed, `⇡` pinging, `∅` paused, `off` | `prompt_cache.warm`, `prompt_cache.expires_at`; the plugin's state file | group omitted |
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

## Keep-alive plugin

The same folder is a Claude Code plugin (`statusline`). It keeps the main conversation's prompt cache warm. Shortly before the cache expires (5 minutes before a 1h entry, after 4 minutes of a 5m one), it sends one tool-less fork of the last request with a one-word prompt. The fork is not in the transcript.

Measured on Claude Code 2.1.295 with Opus 5.5 (2026-10-09), only the first ping of a chain: with a 5m main TTL, a fork at 4:00 refreshed the entry (a follow-up at 7:02 read 100 % from the cache, against 24 % in the control run without a fork). With a 1h main TTL, a fork with the default 5m TTL at 50:00 kept the entry warm (a follow-up at 1h10 read 100 %, against 29 % in the control). A separate fork TTL setting was not needed in this measurement.

Every ping's usage is checked. Each of these pauses the keep-alive until the next real message, after which it turns itself back on:

- a ping that finds the cache cold,
- an API error,
- a compaction,
- a model switch,
- `/clear`,
- the end of the session.

It never pings while a turn runs, and never once the entry is about to lapse, so a late timer after sleep pays nothing.

When Claude Code's own cache keep-alive is switched on for the account (feature flag `tengu_sequential_cloud` in `~/.claude.json`, subscription 1h TTL), the plugin leaves the cache to it for as long as Claude Code keeps touching it (by default up to 60 minutes after the last activity) and pings only after that. An unreadable `~/.claude.json` counts as "off". If the flag is on but Claude Code's touches do not actually happen (server not active, a policy forbids them, the request is refused), the plugin waits in vain: the cache lapses an hour after the last activity, the first ping finds it cold and the keep-alive pauses. A "cache was cold" toast while the flag is on points to this.

`/keepalive on|off|status`: on by default; the switch is stored and applies to every session. `status` shows the TTL, the built-in keep-alive flag, the next and the last ping.

Limits:

- A turn that runs or hangs longer than the cache lifetime (for example, a tool waiting for approval) gets no ping, because the plugin never pings during a turn.
- Without plan limits after the first answer (no subscription) the main TTL is taken as 5m.
- Overage and Claude Code's own 5m switches are invisible to a plugin; the first ping then finds the cache cold and pauses.
- A hot reload of the plugin while a ping fork is in flight can send one extra ping, because the lock lives in the module and resets on reload.
- A fork that never resolves stops the pinging until Claude Code's own request timeout ends it.

The plugin writes `~/.claude/keepalive/<session_id>.json` (or under `CLAUDE_CONFIG_DIR`), which this script reads, without blocking, to draw the marker. A file older than a day is ignored; old files can be removed with:

```bash
find ~/.claude/keepalive -name '*.json' -mtime +7 -delete
```

Each ping reads the whole context from the cache. That costs about a tenth of the input price, against two times the input price for rewriting a 1h entry, so a ping pays for itself while the session is picked up again within about 18 hours. A ping that finds the cache cold writes it again at the 5m rate. Pings count against your plan like any request.

Install from the local marketplace `mohamed-mods`:

```
/plugin install statusline@mohamed-mods
```

## Tests

```bash
node --test test/*.test.mjs
claude plugin test .
```

## License

MIT, see `LICENSE`.
