---
name: office-finance
description: Use when changing src/finance/, src/lib/vault.ts, src/cli/group-cmd.ts or src/cli/vault-cmd.ts, or tasks about resource groups, usage and cost reports, rolling-window limits, finance alerts, the encrypted API-key vault, or which key or login an agent runs with.
---

# Finance, resource groups and the vault

A resource group is a billable thing agents run on: a Claude subscription, an OpenCode Go key, an
OpenRouter key. Several groups of one kind can exist; the first of each kind is the default. Every
hired agent resolves to one group. The finance code reads usage per group and agent, renders
reports, and raises alerts. The vault stores the API keys and hands them to agents as environment
variables. Background: `docs/research/finance-notes.md`, README sections "Finance console",
"Several subscriptions and keys", "Credential vault".

## Map

- `src/finance/groups.ts`: `kindForAgent`, `defaultGroup`, `isDefaultGroup`, `groupIdForAgent`, `groupAgents`, `checkGroupForAgent`, `addGroup`, `removeGroup`, `claudeConfigDir`, `pickAutoGroup`, `suggestMoveText`, `RESERVED_GROUP_IDS`.
- `src/finance/collect.ts`: `collectFinanceSnapshot(root, cfg)` builds `groupsToday`, `groupsWeek`, agent rows and `limits`; also writes the headroom file.
- Collectors: `claude.ts` (account info, token counts from Claude JSONL transcripts), `claude-usage-probe.ts` and `claude-usage.ts` (throwaway `/usage` TUI probe and its parser), `opencode.ts` (`opencode stats` parser, per-agent usage from each agent's server), `opencode-go-usage.ts` (provider's exact usage endpoint), `opencode-limits.ts` (local SQLite estimate), `openrouter.ts` (credits and key usage).
- `src/finance/limits.ts`: pure builders of `LimitRow`. `render.ts`: pure markdown (`renderFinanceReport`, `renderLimitsSection`, `renderAgentDetail`). `alerts.ts`: `detectGroupAlerts`, `detectLimitAlerts`, `detectAgentSpikeAlerts`, state load/save. `headroom.ts`: `writeHeadroom`, `readHeadroom`, `headroomFromSnapshot`.
- `src/lib/vault.ts`: `vaultSpecs`, `setSecret`, `getSecret`, `removeSecret`, `listSecrets` (metadata only), `vaultEnvForAgent`, `vaultEnvDefaults`, `opencodeProviderOverrides`, `writeAgentEnvFile`, `withEnvFile`, `importableFromAuthJson`, `migrateLegacyVault`, `validateSecret`.
- `src/cli/vault-cmd.ts`: `cmdVault`, `promptHidden`. `src/cli/group-cmd.ts`: `cmdGroup` over an injected `GroupDeps`, `resolveHireGroup`.
- Consumers: `src/cli/office.ts` (`cmdFinance`, `startAgent`, `cmdMerge` summariser), `src/admin/daemon.ts` (`checkFinance`, `handleFinanceChannelPost`).

## Data and state

- `state/vault.key` (32 random bytes, chmod 600) and `state/vault.json` (AES-256-GCM entries, AAD bound to the entry id). Per agent `state/agents/<name>/provider.env` (chmod 600, rewritten on each start).
- `state/finance/headroom.json`, `state/finance/claude-usage*.json` (probe cache, 10 min), `state/finance/probe/` (probe cwd), `state/admin/finance.json` (alert state). Per Claude group login: `state/claude/<id>` (the group's `configDir`).
- Config keys: `resourceGroups` (`id`, `kind`, `label`, `configDir`), `finance.dailyReportHour`, `usageAlertThresholds`, `limitAlertThresholds`, `spikeMultiplier`, `opencodeGoMonthlyDollarCap`, `opencodeGoLimits`, `financeChannel`. `AgentRecord.group` pins an agent to a group.

## Invariants and traps

- An Anthropic API key must never reach a Claude agent: it would override the subscription login and bill the API. `STATIC_ENTRIES` marks `anthropic` as `harness: 'opencode'`, and `vaultEnvForAgent` injects an entry only when its harness matches the agent's. Keep both checks.
- Values never leave `vault.ts` except through `getSecret` for env injection and `validateSecret`. `listSecrets`, `renderVaultStatus` and every chat or log line show metadata only. Keys are read from a hidden TTY prompt or opencode's `auth.json`, never from argv or chat (`cmdVault set` refuses an extra argument and a non-TTY). The admin daemon deletes pasted keys (see `office-admin`).
- Keys reach the harness through the chmod-600 env file and `withEnvFile`, not the command line. The merge summariser and the generate helper use `vaultEnvDefaults` (default group of each kind).
- Claude subscription logins are never vaulted or copied between machines (refresh tokens are single use). A Claude group's optional vault entry is a `claude setup-token` value (`CLAUDE_CODE_OAUTH_TOKEN`).
- Group resolution: `groupIdForAgent` ignores a pinned `rec.group` that no longer matches the agent's kind and falls back to the default group. `office model` clears a pin that stops fitting. `removeGroup` throws while hired agents are pinned to it. Group ids may not collide with `RESERVED_GROUP_IDS`.
- Forks stay in the parent's group (`cmdFork` copies `group`). `group move` for Claude across config dirs copies the transcript with `copyClaudeSession` so the session resumes; without a transcript it starts a fresh session.
- Numbers that are derived are marked `~` in reports. Preserve that when adding rows. The OpenCode Go local estimate is machine-local and must stay marked as an estimate; the provider endpoint wins when it answers.
- Collectors degrade to "-" plus a note and never fail the snapshot. Wrap new external calls the same way.
- The Claude `/usage` probe opens a hidden tmux session `office-probe` and kills it afterwards. It uses `--model haiku --strict-mcp-config` only; never add `--dangerously-*` flags. It must never touch the `office` session or an agent window.
- Alerts are one per incident, with persisted state (`FinanceAlertState`). Thresholds are ascending buckets, via `shouldAlertThreshold` from `src/admin/monitor.ts`. Alerts only suggest `group move`; nothing moves automatically.
- `collectFinanceSnapshot` is read-only for agent state. Keep it that way: it runs every 5 minutes in the admin daemon.

## Testing

- Unit: `test/vault.test.ts`, `test/group-cmd.test.ts`, `test/finance-groups.test.ts`, `test/finance-alerts.test.ts`, `test/finance-headroom.test.ts`, `test/finance-limits.test.ts`, `test/finance-render.test.ts`, `test/finance-claude.test.ts`, `test/finance-claude-usage.test.ts`, `test/finance-opencode.test.ts`, `test/finance-opencode-go-usage.test.ts`, `test/finance-opencode-limits.test.ts`, `test/finance-openrouter.test.ts`, `test/claude-config-dir.test.ts`, `test/review-fixes.test.ts`. Fixture: `test/fixtures/opencode-stats-days1-models.txt`.
- One file: `npx vitest run test/vault.test.ts`.
- Parsers of provider or TUI output are tested on captured text. When a provider changes its format, add the new capture as a fixture.
- Live provider calls and the `/usage` probe need real accounts. Do not run them against the owner's accounts from a test. In a dev instance, `bin/office finance` and `bin/office vault status` are safe reads. The e2e test (`npm run test:e2e`) may store `OPENCODE_GO_API_KEY` with `setSecret`; run it only in a dev instance (see `dev-office`).

## Pointers

`docs/research/finance-notes.md`, `docs/research/opencode-runtime.md`, README "Credential vault". `docs/design.md` section 2 (Q3, tiered models) and 5.
