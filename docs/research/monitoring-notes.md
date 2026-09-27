# Task L — monitoring & debugging agents from #office-admin

## What was built

- **`src/admin/monitor.ts`** — pure pane parsers and renderers: `parsePaneMetrics` (context %, Claude weekly-limit %, error/limit lines, pane condition: working/dialog/idle-prompt/error/unknown), `buildRichStatusRow`/`buildRichStatusMarkdown`/`buildRichStatusPlain` for the status table, `formatInspectReport`/`buildTerminalBlock` for `inspect`, `detectStaleWork` (pure function over Forgejo issues + comments), `buildActivityTimeline`, and `alertKey`/`shouldAlertThreshold` for de-duplication.
- **`src/admin/watchdog.ts`** — `runWatchdog(deps, state)`, called every `watchdog.alertIntervalSeconds` (default 60s) from the admin daemon. Alerts (one per incident, cleared when resolved): window down, blocked-dialog > 2 min, busy > 30 min, pane error/limit text, Claude weekly usage crossing 90%/95%, context ≥ 85%, stale work (ticket assigned/promised with no activity for `watchdog.staleWorkMinutes`, at most once per ticket per 2h, posted in the project channel to @mention the agent plus a short note in #office-admin), and "answered in terminal, not chat" (delivery logged with `human=true`, agent went idle, no chat post within 2 min). State persists to `state/admin/watchdog.json` across daemon restarts.
- **`office status [--md] [--all]`** — one row per agent: state icon+label+age, "Doing" (last delivered event kind or "turn running Nm"), last post age+channel, context %, and a short alerts list.
- **`office inspect <agent>` / `peek`** — identity, state, detected pane condition, weekly-limit line if shown, last 25 terminal lines (ANSI/box-drawing stripped, blank runs collapsed, lines truncated to 200 chars), last 12 mcp.log lines, pending events by kind, last 3 chat posts, and open tickets assigned to/authored by the agent across `office/tasks` and all projects.
- **`office activity [--minutes N]`** — merged, time-sorted timeline of agent/owner chat posts (from channels the bot is a member of) and Forgejo notification events in the window.
- Config: added `watchdog: { staleWorkMinutes: 45, alertIntervalSeconds: 60 }` to `office.config.json` and `WatchdogConfig` to `src/lib/types.ts`.
- Added `updated_at` to the `Issue` type in `src/lib/forgejo.ts` (Forgejo's API returns it; needed for "Last post"/age and stale-work calculations).

## Fixes to the partial (kimi) work

- `src/admin/commands.ts` had an unescaped set of backticks inside the `helpText` template literal (around line 130), which terminated the template string early and broke the whole file's parse. Escaped them (`\`status\``, etc.).
- `src/admin/daemon.ts` referenced `ForgejoClient` without importing it.
- `src/cli/office.ts` imported `buildRichStatusMarkdown`/`buildRichStatusPlain` from `monitor.ts`, which only exported `renderRichStatusMarkdown`/`renderRichStatusPlain`; renamed the exports to match the call sites.
- `shouldAlertThreshold([90, 95])` returned the *first* threshold met (always 90 once usage passed it), so a later crossing of 95% would never fire a second alert. Fixed to return the *highest* threshold met, so 90% and 95% each fire once.
- `Issue` was missing `updated_at`, needed by both `office inspect`'s work-item ages and `detectStaleWork`.

## Verified

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 167 passed, 4 skipped (150 pre-existing + 17 new in `test/monitor.test.ts` covering pane parsers, status-row alerts/rendering, stale-work detection, and alert de-duplication).
- Live, against the running office (agents/containers untouched; only the admin console was restarted via `admin-stop` + `start`):
  - `office status --md` run directly showed all 5 agents (ada, kai, lead, rex, webre) with state, doing, last post, context (rex 18%, webre 33%), no active alerts.
  - `office inspect lead` showed identity (opus, session id, 3 projects), idle-prompt condition, last 25 terminal lines, and the mcp.log tail.
  - `office activity 60` showed a merged timeline including kai's onboarding, lead's compose-guard handover note, and the owner's DM about subscriptions.
  - All three were also posted as the owner into `#office-admin` over the REST API and confirmed the bot replied in-thread with the same output (see the commands above run via `bin/office`; the bot uses the identical code path).

## Open issues / not done

- The watchdog's "answered in terminal, not chat" heuristic relies on `mcp.log` containing `human=true` on the delivery line and the agent's `status.json` going idle; it has not been observed firing against a real incident during this session (no such incident occurred live), only exercised via the pure `detectStaleWork`/threshold unit tests.
- `office activity` only sees Forgejo activity via the *admin* account's own notifications feed (`listNotifications`), not a full audit log across all repos; if the admin user has read notifications already, older events may be missed. A repo-wide events/audit endpoint would be more complete if Forgejo exposes one.
- No live incident was reproduced to confirm the watchdog actually posts to `#office-admin` and the project channel end-to-end (busy > 30 min, stale work, etc.) — only the unit-level logic and the manual `office status`/`inspect`/`activity` commands were verified live.
