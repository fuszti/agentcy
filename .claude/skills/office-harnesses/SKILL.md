---
name: office-harnesses
description: Use when changing src/lib/harness/claude.ts, src/lib/harness/opencode.ts, src/lib/tmux.ts, src/lib/transcript.ts or src/lib/workspace.ts, or tasks about how an agent session is launched, detected idle, woken, forked, merged, shifted or given its CLAUDE.md/AGENTS.md.
---

# Harnesses: launching and driving Claude Code and opencode sessions

An agent is a long-running TUI in one tmux window of the office session (`cfg.tmuxSession`, default
`office`). The harness adapters build the launch command, report whether the session is idle, and
inject prompts. `src/lib/transcript.ts` reads session history for fork and merge.
`src/lib/workspace.ts` writes the instruction file each session starts from. The orchestration
(`startAgent`, `cmdFork`, `cmdMerge`, `cmdShift`) lives in `src/cli/office.ts`.
Background: `docs/design.md` 4.6 to 4.9, `docs/research/opencode-runtime.md`, `docs/research/knowledge-fork-merge.md`.

## Map

- `src/lib/harness/claude.ts`
  - `claudeSettings(root, statusFile, workspace)`: the `--settings` JSON: permission allow/deny lists and the hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Notification`) that call `scripts/hook-status.sh`.
  - `claudeMcpConfig`, `claudeLaunchCommand` (modes `new` / `resume` / `fork`), `ensureClaudeOnboarded`, `claudeSessionExists`, `settleClaudeStartup` (answers the folder-trust dialog).
  - `readStatus` / `writeStatus`: `state/agents/<name>/status.json` (`starting|idle|busy|blocked|stopped`).
  - `ClaudeTmuxWakeAdapter`: `isIdle`, `isAlive`, `deliver`.
- `src/lib/harness/opencode.ts`
  - `OpencodeClient`: HTTP client (`waitForServer`, `createSession`, `prompt` via `prompt_async`, `messages`, `fork`, `abort`, `isIdle`, `subscribe` for SSE).
  - `OpencodeWakeAdapter`: idle from the SSE stream, falling back to `/session/status` when the stream is older than 30 s.
  - `buildOpencodeConfig` (permission rules and the `office` MCP entry), `opencodeLaunchCommand`, `forkOpencodeSession`, `opencodeTranscript`.
- `src/lib/tmux.ts`: `openWindow`, `killWindow`, `windowTarget` (`session:=window`), `capturePane`, `paneAlive`, `pasteAndSubmit`, `sendKeys`, `killSession`.
- `src/lib/transcript.ts`: `claudeProjectSlug`, `findClaudeSessionFile`, `copyClaudeSession`, `readClaudeTranscript`, `renderTranscript`.
- `src/lib/workspace.ts`: `writeWorkspaceInstructions`, `prepareAgentGitIdentity`, `seedAgentBrain`, `commitBrain`, `ensureBrain`, `resolveInWorkspace`, attachment helpers.

## Data and state

- Per agent in `state/agents/<name>/`: `agent.json` record (`AgentRecord`: `sessionId`, `pastSessions`, `opencodePort`, `group`, `forkedFrom`), `status.json`, `claude-settings.json`, `mcp.json`, `opencode.json`, `provider.env` (chmod 600, vault keys), `git-credentials`, `fork-base-memory.md` (merge base), `shift-ready`.
- Generated each start: `workspaces/<name>/CLAUDE.md` (Claude) or `AGENTS.md` (opencode). Never hand-edit; change `brain/agents/<name>/*.md` or `templates/`.
- `brain/agents/<name>/{persona,memory,journal}.md`, `brain/agents/<dst>/merges/`.
- Claude transcripts live in the harness's own store (`~/.claude/projects/<slug>/<session>.jsonl`, or the group's `CLAUDE_CONFIG_DIR`).
- Config keys: `tmuxSession`, `opencodeBasePort`, `defaults.claudeModel`, `defaults.opencodeModel`, `defaults.summarizerModel`, `git.allowGithubPush`, `resourceGroups`.

## Invariants and traps

- Never paste into an open dialog. `ClaudeTmuxWakeAdapter.isIdle` returns false on any `DIALOG_MARKERS` text in the last 25 pane lines and when the hook state is `blocked`. If you add a new dialog, add its marker. A paste into a permission prompt answers it.
- Hook state can go stale (Esc interrupt fires no `Stop`). A `busy` status only counts after `staleBusyMs` (90 s) and only if the pane shows no spinner (`BUSY_PATTERNS`).
- `pasteAndSubmit` types a one-line note before the bracketed paste. Claude Code treats a bare paste as content of unknown origin and may not act on it. Keep the note.
- The tmux server can inherit Node's stdio and hang the CLI. `openWindow` uses `tmuxDetached` for that reason. Do not switch it back to `execFile`.
- Env assignments for the harness must sit on the harness command (`exec env A=b claude ...`), not before `cd`. See the comment in `claudeLaunchCommand`.
- Vault keys reach the harness only through the chmod-600 `provider.env` (`withEnvFile`), never on the command line. A Claude agent never receives an API key (it would override the subscription login); `vaultEnvForAgent` filters by harness.
- The permission deny lists block `state/**`, `infra/.env`, `bin/office*`, `src/cli/office*`, `src/cli/bootstrap*`. The office CLI carries owner powers; agents use MCP tools. Keep Claude and opencode lists in step.
- Agent workspaces have their own `git init` so agent git commands and opencode project scoping stay out of the office repo.
- Workspace `CLAUDE.md` is an agent's rule file. The repo-root `CLAUDE.md` is for developing Agentcy; `claudeSettings` sets `claudeMdExcludes: [<root>/CLAUDE.md]` so hired agents do not load it. Keep that line.
- A fresh `CLAUDE_CONFIG_DIR` shows a first-run theme picker that blocks a tmux-driven agent. `ensureClaudeOnboarded` seeds `.claude.json`; it copies only UI-hint keys (`COPIED_ONBOARDING_KEYS`), never account or project data.
- Fork: Claude uses `--resume <parent> --fork-session --session-id <new>` from a new cwd. opencode forks inherit the parent's directory. Forks cannot fork.
- Merge replays only entries after the fork point (found by the `kind="fork"` intro, falling back to `inheritedMessages`). `memory.md` is 3-way merged with `git merge-file` against `fork-base-memory.md`.
- Shift: old `sessionId` is pushed to `pastSessions` and cleared, so the next start creates a new session.
- opencode ports start at `opencodeBasePort` and `nextOpencodePort` skips ports of known records (retired ones included). Do not reuse a retired agent's port.
- opencode agents are launched with `--auto`. The headless `opencode serve` form is used once, to create the desk session id before the TUI opens.

## Testing

- Unit: `test/claude-config-dir.test.ts` (launch command, settings), `test/claude-onboarding.test.ts`, `test/opencode.test.ts`, `test/transcript.test.ts`, `test/workspace.test.ts`, `test/group-cmd.test.ts` (session copy on group move).
- One file: `npx vitest run test/opencode.test.ts`. Against a real opencode server with a cheap model: `OPENCODE_LIVE=1 npx vitest run test/opencode.test.ts`.
- Anything that touches tmux, `startAgent` or a wake adapter needs a real session. Use `npm run test:e2e` in a dev instance (`bin/office dev init` first; see `dev-office`). It hires an opencode agent only; Claude paths have no automated end-to-end test, so test them by hand in the dev instance with a throwaway agent, never a live office's.
- Dev instances use their own tmux session `office-<name>`, so these runs do not touch the live `office` session.

## Pointers

`docs/design.md` 4.6 to 4.9. `docs/research/opencode-runtime.md` (API and startup sequence), `docs/research/knowledge-fork-merge.md`, `docs/research/sandboxing-browsers.md`, `README.md` (Known limitations).
