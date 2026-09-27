# Finance feature — research + verification notes

This file is the verification log for the finance feature.

## Sources probed

- `claude auth status --json` (real capture, redacted):
  ```json
  {
    "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
    "analyticsDisabled": false, "projectsDirectory": "/home/owner/.claude/projects",
    "configDirectory": "/home/owner/.claude", "email": "example@example.com",
    "orgId": "00000000-0000-0000-0000-000000000000",
    "orgName": "Example Org", "subscriptionType": "pro"
  }
  ```
  Only `subscriptionType` and `orgName` are kept (`parseClaudeAuthStatus`); `email`, `orgId` are
  dropped even though not secret, per the "never print tokens/emails beyond the org name" rule
  (the org name happens to embed the email on a personal account — that's the one thing the
  owner said is fine to show).

- `opencode stats --days 1 --models` (real capture saved as
  `test/fixtures/opencode-stats-days1-models.txt`): box-drawing UI table with OVERVIEW,
  COST & TOKENS and MODEL USAGE sections. `parseOpencodeStats` strips the box characters and
  parses `Label   value` pairs; verified against the fixture in
  `test/finance-opencode.test.ts` (sessions=47, totalCost≈$27.41, per-model messages/tokens/cost
  for `opencode-go/kimi-k2.7-code` and `opencode-go/deepseek-v4-pro`).

- opencode per-agent usage: `GET /session/{id}/message` on a live agent's server
  (`http://127.0.0.1:4102/session/ses_.../message`) returns assistant messages with
  `info.cost` and `info.tokens.{total,input,output,reasoning,cache:{read,write}}` — confirmed
  live against agent `rex`. `parseAgentOpencodeUsage` sums these per model/day.

- OpenRouter credits: `GET https://openrouter.ai/api/v1/credits` with the key from
  `~/.local/share/opencode/auth.json`'s `openrouter.key` — confirmed live:
  `{"data":{"total_credits":440,"total_usage":434.105234067}}` → 98.7% used. The key itself was
  never printed or logged; only used to build the request header.

## Unit tests

```
npx vitest run test/finance-groups.test.ts test/finance-claude.test.ts \
  test/finance-opencode.test.ts test/finance-openrouter.test.ts \
  test/finance-alerts.test.ts test/finance-render.test.ts test/monitor.test.ts
```
→ all green (6 finance files + monitor.test.ts, 56 tests total in this slice).

```
npx tsc --noEmit
npx vitest run
```
→ tsc clean; full suite 206 passed / 4 skipped (pre-existing skips, unrelated to this feature).

## Live verification

1. `bin/office init` — idempotent; created the private `#office-finance` channel (owner + `office`
   bot only), confirmed via `GET /teams/{team}/channels/name/office-finance` (`type: "P"`).

   While re-running `init`, discovered and fixed a **pre-existing bug** in
   `ensureOfficeBot` (`src/cli/bootstrap.ts`): Mattermost's `GET /users/{id}/tokens` never
   returns the raw token value (only id/description), so the old code's "reuse an existing
   token named office-bot" path silently returned `token: undefined`, breaking the bot on the
   next `init` run (`state/office.json`'s `officeBot.token` came out missing, and the admin
   daemon died with `401 Invalid or expired session`). Fixed by testing the token already in
   secrets first (same pattern `ensureMattermostAdminToken` already used) and only minting a
   fresh one when that fails. Verified: after the fix, `officeBot.token` is populated and
   `GET /users/me` with it succeeds.

2. Restarted only the console: `bin/office admin-stop` then `bin/office start`. Agent windows
   (ada, kai, lead, rex, webre) were left untouched — `start` printed `already running` for all
   five since they were never stopped or re-prompted.

3. Posted as the owner via REST (`state/office.json` → `mattermost.adminToken`) into
   `#office-finance`:

   `finance` →
   ```
   ## Finance — today

   | Group | Status | Usage | Tokens today | Cost today | Tokens 7d | Cost 7d | Agents |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | **Claude subscription** | 🟢 ok | – | 579.8K | – | 599.2K | – | @ada, @kai, @lead |
   | **OpenCode Go** | 🔴 exhausted | – | ~6.3M | ~$27.41 | ~6.5M | ~$27.45 | @rex, @webre |
   | **OpenRouter** | 🟢 ok | 99% | – | – | – | – | – |

   | Agent | Group | Model | Tokens today | Tokens 7d | Est. cost |
   | @ada | Claude subscription | claude-haiku-4-5-20251001, claude-sonnet-5 | 213.3K | 232.7K | – |
   | @rex | OpenCode Go | opencode-go/deepseek-v4-pro | 16.3M | 17.8M | ~$0.75 |
   | @webre | OpenCode Go | opencode-go/mimo-v2.6-flash | 29.0M | 29.0M | ~$0.24 |
   ```

   `finance week` → same shape, headed `## Finance — last 7 days`, larger 7d numbers.

   `finance ada` posted in `#office-admin` → single-agent table, exit 0.

   Before either was asked for, the daemon's own 5-minute finance poll had already posted two
   **real, unprompted alerts** into `#office-finance`:
   ```
   🔴 **OpenCode Go** is exhausted. Agents billed to it (@rex, @webre) may be blocked.
   📊 **OpenRouter** usage is 99% (crossed 90%).
   ```
   Both reflect genuine incidents on this machine: `rex`'s live pane shows
   `Upstream request failed: Insufficient account funds`, and OpenRouter credits really are at
   ~99% usage (440 credits, 434.1 used).

## Rolling-window limits (`finance limits`)

- **Claude `/usage` probe**: real capture (Pro account, via the `office-probe` tmux session,
  `claude --model haiku --strict-mcp-config`) renders each window as its own multi-line block,
  not the single-line format first assumed:
  ```
  Current session
  ████████████▌   25% used
  Resets 1:09pm (Europe/Budapest)

  Current week (all models)
  ███████▌   15% used
  Resets Sep 29, 8:59pm (Europe/Budapest)

  Usage credits
  Usage credits are off · /usage-credits to turn them on
  ```
  `parseClaudeUsageOutput` (`src/finance/claude-usage.ts`) handles this block form (header line,
  then a `NN% used` bar line, then a `Resets …` line) as well as an older single-line form and
  per-model weekly lines (`Current week (Opus)` / `(Sonnet)`), for forward compatibility.
  Live run on 2026-09-27: session 32% (resets 1:10pm Europe/Budapest), week 16% (resets Sep 29,
  9pm). "Usage credits" is the extra/pay-as-you-go toggle — parsed as on/off plus `$spent`/`$limit`
  when on; this account has it off, so the extra-credits row shows "–".

- **OpenCode Go exact usage**: `GET https://opencode.ai/zen/go/v1/usage` with
  `Authorization: Bearer <key>` (the key is `opencode-go.key` in
  `~/.local/share/opencode/auth.json` — same file as the OpenRouter key, different top-level
  entry). Live response on this machine:
  ```json
  {"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-09-27T12:38:29.990Z"},
   "weekly":{"status":"rate-limited","percent":100,"resetsAt":"2026-09-28T00:00:00.000Z"},
   "monthly":{"status":"ok","percent":50,"resetsAt":"2026-10-25T13:52:49.000Z"}}}
  ```
  These are the exact same rolling(5h)/weekly/monthly numbers the opencode.ai/workspace dashboard
  shows (confirmed against a screenshot of that dashboard: "Rolling usage 0%", "Weekly usage
  100% · resets in 16h 25m", "Monthly usage 50% · resets in 28d 6h"). `status: "rate-limited"`
  renders as 🟠. No extra/pay-as-you-go credits field in this response — shown as "–".
  Sources: <https://github.com/wmaethner/opencode-go-usage>,
  <https://github.com/anomalyco/opencode/issues/16017>.

  Fallback (only used if that endpoint is unreachable): local $-based estimate. OpenCode Go's
  published caps (<https://opencode.ai/docs/go/>) are per-model MONTHLY dollar amounts, applied
  as a rolling window at 20% (5h) / 50% (week) / 100% (month) of that figure — there is no single
  combined cap across models. The fallback sums this office's actual opencode-go spend (from
  `~/.local/share/opencode/opencode.db`, read-only via the `sqlite3` CLI: `part` rows with
  `type='step-finish'` joined to their `message` row for `providerID`/`modelID`, summing each
  part's `cost`) against the sum of (monthly cap x window fraction) for the models in use, marked
  `~`. Per-model monthly $ caps as scraped from the docs page (noisy formatting; used as configured
  in `office.config.json`'s `finance.opencodeGoMonthlyDollarCap`): $60 (kimi-k2.7-code,
  kimi-k2.6, deepseek-v4.1-flash, deepseek-v4-flash, mimo-v2.6-flash, glm-5.2, minimax-m3), $15
  (kimi-k3, deepseek-v4-pro, mimo-v2.6-pro, mimo-v2.5-pro, glm-5.3, qwen3.8-max). An even coarser
  per-model REQUEST-count fallback (`finance.opencodeGoLimits`, the office's original ask's
  numbers) is implemented and unit-tested (`buildOpencodeGoLimitRows`) but not rendered, per the
  owner's later correction that the Limits table must be per resource GROUP, not per model.

- **OpenRouter**: unchanged collectors (`/api/v1/credits`, `/api/v1/key`), reshaped into a
  `balance` row (account credit remaining) and a `key month` row (this key's spend/cap).

- Live run 2026-09-27 (`bin/office finance limits`, then posted via REST as the owner into
  `#office-finance` and read back the `office` bot's reply — matched exactly):
  ```
  | Claude subscription | 5-hour session | – | – | ▰▰▰▱▱▱▱▱▱▱ 32% | 68% | 1:10pm (Europe/Budapest) |
  | Claude subscription | week (all models) | – | – | ▰▰▱▱▱▱▱▱▱▱ 16% | 84% | Sep 29, 9pm (Europe/Budapest) |
  | OpenCode Go | 🟢 Rolling (5h) | – | – | ▱▱▱▱▱▱▱▱▱▱ 0% | 100% | … (in 5h 0m) |
  | OpenCode Go | 🟠 Weekly | – | – | ▰▰▰▰▰▰▰▰▰▰ 100% | 0% | … (in 16h 15m) |
  | OpenCode Go | 🟢 Monthly | – | – | ▰▰▰▰▰▱▱▱▱▱ 50% | 50% | … (in 28d 6h) |
  | OpenRouter | balance | – | – | ▰▰▰▰▰▰▰▰▰▰ 99% | $5.89 | – |
  | OpenRouter | key month | $0.00 | $20.00 | ▱▱▱▱▱▱▱▱▱▱ 0% | $20.00 | monthly |
  ```
  The `office-probe` tmux session was confirmed gone after the run (`tmux list-sessions` showed
  only `office` and an unrelated session), and the live `office` session's 5 agent windows plus
  the admin window were all still present and untouched. The console was restarted
  (`bin/office admin-stop` then `bin/office start`) with tsc clean and the full suite green
  first; all 5 agents reported "already running" (never touched).

## Known gaps (see task spec for the full list)

- Claude weekly-limit % needs a fresh pane banner line to be visible; usually shows "–" with a
  note.
- OpenCode Go group totals are office-wide (`opencode stats` isn't scoped to this office's
  agents), so they're marked as estimates.
- Spend-spike alerting (`detectSpendSpike`) is implemented and unit-tested but not fed live
  per-hour event streams yet.
