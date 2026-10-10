---
name: office-admin
description: Use when changing src/admin/ (daemon, commands, monitor, watchdog, dispatcher, helper), src/lib/requests.ts, src/lib/projects.ts or src/lib/project-requests.ts, or tasks about the #office-admin chat-ops console, status/inspect output, alerts, approvals, the generate helper or project registry.
---

# Admin console, monitoring and requests

The admin daemon is a bot (`office`) that sits in the private channel `#office-admin`
(`cfg.adminChannel`) and `#office-finance` (`cfg.financeChannel`). The owner types office commands;
the daemon runs `bin/office <argv>` as a child process and threads the output back. The same daemon
runs the watchdog, the project dispatcher, the finance reports (see `office-finance`), and the
queue for agent self-management requests. It runs in tmux window `admin`, started by `office start`
(`ensureAdminDaemon` in `src/cli/office.ts`); `office admin` runs it in the foreground and
`office admin-stop` kills the window. Background: `docs/research/admin-channel-notes.md`,
`monitoring-notes.md`, `generate-helper-notes.md`, `project-requests-notes.md`, `projects-notes.md`.

## Map

- `src/admin/daemon.ts`: `run()`. `handlePost` (routing), `runOfficeArgv` (spawns `bin/office`, 15 min timeout), `execute`, `purgeLeakedKey`, `handleGenerate`, `checkProposals`, `processRequestQueue`, `executeRequest`, `argvForRequest`, `checkApprovals`, `handleConsoleApproveDeny`, `handleFinanceChannelPost`.
- `src/admin/commands.ts`: `allowedCommands` (the whitelist), `parseCommandLine` (accepts `office ` / `!` prefix; unknown input becomes a `generate` request), `vaultSetLeak`, `leakedKeyKind`, `vaultSetHint`, `helpText`, `renderStatusMarkdown`.
- `src/admin/monitor.ts`: pure pane parsers (`detectPaneCondition`, `parsePaneMetrics`, `parseClaudeContext`, `findErrorLines`), `resolveState`, `describeDoing`, `buildRichStatusRow` / `buildRichStatusMarkdown` / `buildRichStatusPlain`, `formatInspectReport`, `buildActivityTimeline`, `detectStaleWork`, `alertKey`, `shouldAlertThreshold`.
- `src/admin/watchdog.ts`: `runWatchdog(deps, state)`, `loadWatchdogState` / `saveWatchdogState`, `clearAlert`.
- `src/admin/dispatcher.ts`: `dispatchRound`, `buildDispatcherDeps`. Announces unassigned project tickets and PRs without reviewers in `#proj-<project>`.
- `src/admin/helper.ts`: the `generate` helper. `buildHelperPrompt`, `runHelper` (one-shot `opencode run`), `buildHelperConfig` (every tool denied), `extractJsonBlock`, `validateProposal`, `loadOrRefreshModels`.
- `src/lib/requests.ts`: signed request files. `buildRequest`, `writeRequest`, `loadRequest`, `listRequests`, `updateRequest`, `setRequestStatus`, `signRequest`, `verifyRequest`.
- `src/lib/projects.ts`: registry `state/projects/<name>.json` (`loadProject`, `saveProject`, `listProjects`, `validateProjectName`). `src/lib/project-requests.ts`: `validateProjectRequest` (limits and auto-approve).
- Agent side of requests: `office_fork_self`, `office_fork_done`, `office_request_shift`, `office_request_hire`, `office_create_project` in `src/mcp/server.ts`.

## Data and state

- `state/requests/<id>.json` (signed), `state/admin/proposals/*.json` (generate proposals), `state/admin/watchdog.json`, `state/admin/dispatcher.json`, `state/admin/finance.json`, `state/admin.log`, `state/helper/` (helper opencode config and models cache), `state/projects/`.
- Read-only inputs: `state/agents/<name>/{agent.json,status.json,pending.json,mcp.log}`, tmux panes.
- Config keys: `adminChannel`, `financeChannel`, `watchdog.alertIntervalSeconds`, `watchdog.staleWorkMinutes`, `selfManagement.*` (`maxAgents`, `maxForksPerAgent`, `autoApproveFork`, `autoMergeOnDone`, `allowSelfShift`, `autoApproveProject`, `maxActiveProjects`, `maxNewProjectsPerAgentPerDay`), `defaults.helperModel`, `systemUsernames`, `tmuxSession`.

## Invariants and traps

- The console runs only commands in `allowedCommands`. `init`, `up`, `setup`, `export`, `import`, `shutdown`, `admin` and `dev` are deliberately absent: a chat message must not be able to tear down the stack or the daemon. Do not add them.
- Only the owner's user id (`secrets.mattermost.humanUserId`) can issue commands, approve proposals (reaction) or approve requests. Agent posts in the admin channel are ignored.
- Key leaks: a `vault set <id> <value>` message or a known API-key shape (`KEY_PATTERNS`: `sk-or-v1-`, `sk-ant-`, long `sk-`) is permanently deleted before any parsing, using the owner's admin token, because bots cannot delete other users' posts. The warning must not repeat untrusted text; `vaultSetHint` only echoes ids that are real vault entries. The patterns are narrow on purpose, since deletion is permanent.
- `vault` in chat shows status only. Keys are set on the server shell with a TTY (`src/cli/vault-cmd.ts`).
- Requests are HMAC-signed with the inbox key (`state/inbox.key`). `listRequests` skips files that fail verification, so an agent cannot write its own approved request. Any new field must go through `canonicalizeRequest` (sorted keys) or verification breaks.
- Generated commands run only after the owner reacts with a check mark on the proposal. The helper runs with `buildHelperConfig` (all tools denied), cwd `state/helper`, and its output is validated by `validateProposal` against `allowedCommands`. Keep both layers.
- Alerts are one per incident: `alertKey` plus `WatchdogState.alerted`, cleared when the condition resolves, persisted in `state/admin/watchdog.json`. A new alert needs a stable key or it will spam.
- Stale-work nudges are rate limited (once per ticket per 2 hours).
- `monitor.ts` parsers read TUI text, which changes between Claude Code and opencode versions. Add a fixture-style test when you change a regex.
- Project names: `[a-z0-9-]`, at most 40 chars. `office project new` creates repo `office/<name>`, `#proj-<name>`, brain folder, branch protection (one approval) and labels.
- The daemon spawns `bin/office` of its own checkout (`path.join(root, 'bin', 'office')`), so a dev instance's daemon acts on its own stack.

## Testing

- Unit: `test/admin.test.ts` (commands, key leaks), `test/monitor.test.ts`, `test/dispatcher.test.ts`, `test/helper.test.ts`, `test/requests.test.ts`, `test/projects.test.ts`, `test/project-requests.test.ts`, `test/review-fixes.test.ts`.
- One file: `npx vitest run test/monitor.test.ts`.
- `daemon.ts` and the watchdog's I/O need a live stack. In a dev instance: `bin/office dev init`, `bin/office start` (starts the admin daemon in window `admin` of the instance's tmux session), then type commands as the owner in the chat URL that `dev init` prints. `npm run test:integration` covers the Mattermost and Forgejo clients, not the daemon.
- Never use a live office's `#office-admin` or agents to try a change.

## Pointers

`docs/design.md` 4.1 (components), 5 (security posture). The README sections "Admin console", "Projects", "Self-management".
