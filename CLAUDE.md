# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Agentcy: a local "office" that runs persistent Claude Code / opencode sessions as named AI
colleagues, talking through a self-hosted Mattermost (chat) + Forgejo (tickets/git), driven by a
per-agent MCP server (`office-mcp`) and a CLI (`bin/office`). Status: experimental prototype
(v0.1). Full rationale and verified facts: [`docs/design.md`](docs/design.md); user-facing docs
and command reference: [`README.md`](README.md).

**This CLAUDE.md is for developing Agentcy itself.** Don't confuse it with the *generated*
`workspaces/<agent>/CLAUDE.md` / `AGENTS.md` files that `writeWorkspaceInstructions()`
(`src/lib/workspace.ts`) writes for each hired agent at session start — those are office-rules +
persona + memory compiled for a colleague's own session, regenerated on every start, and never
hand-edited.

The checkout may belong to a live office (see `bin/office status`). Its agents, sessions, tickets
and chat are out of scope unless the user explicitly asks you to touch them. Test against a dev
office (below), never against them.

## Commands

```bash
npm ci                      # install
npm run check               # tsc --noEmit + biome lint + vitest run (what CI runs)
npm run lint                # biome lint . (linter only; there is no formatter script)
npx tsc --noEmit            # type check (no separate build step; tsx runs TS directly)
npx vitest run               # unit tests
npx vitest run test/policy.test.ts        # single test file
npx vitest run -t "test name"             # single test by name
npm run test:integration    # needs a dev office (`bin/office dev init`)
npm run test:e2e            # hire/wake/reply with a cheap opencode model; needs a dev office
OPENCODE_LIVE=1 npx vitest run test/opencode.test.ts   # against a real opencode server
npx tsx scripts/check-history-limit.ts    # one-off check: no 10k-message cap on Mattermost Team Ed.
```

CI (and `CONTRIBUTING.md`) requires `npm run check` to pass on Node 20 and 22 before a PR. Biome
lints only (`biome.json`); there is no formatter, so match the surrounding file's style.
Vitest only picks up `test/**/*.test.ts` (`vitest.config.ts`) — agents' own project test suites
live inside `workspaces/` and are not part of this run.

Running the actual office (`bin/office init/hire/start/...`) needs Docker, tmux, git, and a
logged-in Claude Code CLI and/or opencode — see the README's Quick start. `office.config.json` is
gitignored and auto-created from `office.config.example.json` on first run; edit the local copy,
never the example, when testing config-dependent code.

## Dev office

Develop and test against your own throwaway office, never the live one. Each checkout or git
worktree gets its own isolated instance: own compose project, containers, ports, named volumes,
tmux session.

```bash
bin/office dev init     # create/reuse this checkout's dev instance (idempotent); prints URLs and owner login
bin/office dev info     # instance name, compose project, URLs, tmux session
bin/office dev down     # stop it (--purge also deletes its volumes, state/, workspaces/, brain/, config, infra/.env)
bin/office dev reset    # down --purge, then init again
```

npm aliases: `dev:init`, `dev:info`, `dev:down`, `dev:reset`. Run `npm run test:integration` and
`npm run test:e2e` only after `dev init`. The e2e test hires one opencode agent on
`defaults.helperModel` (a cheap model) and checks that it replies in chat. A fresh clone without
Docker can run the unit tests only.

Hard rules:

- Never run `office init`, `up`, `start` or `setup` in a second checkout of a machine that has a
  live office without `office dev init` first. They would recreate the live containers.
- Never use the live office's agents as test subjects.
- Integration and e2e tests run only against a dev instance. They refuse otherwise.
- `dev down`, `dev reset` refuse on a normal office. Don't work around the guards.

Project skills live in `.claude/skills/`: `dev-office`, `office-delivery`, `office-harnesses`,
`office-admin`, `office-finance`, `office-infra`. Read the matching one before changing that area.

## Architecture

One MCP server instance per hired agent (`src/mcp/server.ts`), spawned by that agent's harness
over stdio (env: `OFFICE_AGENT`, `OFFICE_ROOT`, optional `OFFICE_WAKE=channel`). It exposes
`chat_*` / `ticket_*` / `project_*` / `pr_*` / `office_*` MCP tools, and in the background listens
to Mattermost over WebSocket + polls Forgejo notifications, decides what's worth waking the agent
for, and wakes it through a harness-specific **wake adapter**:

- **Claude**: tmux bracketed-paste into the interactive TUI (`src/lib/harness/claude.ts`). Idle
  state comes from Claude Code hooks (`UserPromptSubmit`→busy, `Stop`→idle,
  `Notification(permission_prompt)`→blocked) writing `state/agents/<name>/status.json`; the MCP
  only pastes when idle, never into an open permission dialog. A `claude/channel` notification
  path exists as an upgrade for orgs with Team channels enabled, but is off by default (blocked on
  this org — see `docs/design.md` §3).
- **opencode**: `POST /session/{id}/prompt_async` on the TUI's own `--port`
  (`src/lib/harness/opencode.ts`), idle/busy tracked via its SSE event stream.

### Delivery pipeline

`src/mcp/policy.ts` is pure, unit-tested logic, separate from I/O in `server.ts`:
- `classifyPost` turns a raw Mattermost post into an `InboundEvent` (DM / mention / thread reply /
  digest-item / room / ticket), given per-agent `watch` mode (`all` | `digest` | `mentions`).
- `DeliveryQueue` batches immediate events vs. a periodic digest (`digestMinutes`).
- `PostGuard` enforces posting guards *in the MCP, not in the prompt*: rate limits (≤8/min,
  ≤100/hour), duplicate-post suppression, an ack-only filter ("thanks/ok/👍" → rejected, use
  `chat_react`), and a runaway-thread cap on consecutive agent-only replies.
- "Room" events (owner addressed no one in particular) are held and staggered per-agent
  (deterministic hash order) so agents don't pile onto the same request; a claim (reaction/reply)
  by a colleague downgrades it to a digest item for everyone else.

Undelivered events, last-seen timestamps, and per-agent watch/thread state persist to
`state/agents/<name>/*.json` so an MCP restart (shift change, crash) replays what it missed
without redelivering what already went out.

### Fork / merge / shift

- **Fork** (`office fork`, or `office_fork_self` self-request): new bot+Forgejo identity, new
  workspace, `claude --resume <id> --fork-session --session-id <new>` (or opencode's session fork)
  — inherits the live session's context but gets its own cwd. Forks cannot fork again.
- **Merge** (`office merge`, or `office_fork_done`): the fork's transcript since the fork point is
  rendered/condensed (`src/lib/transcript.ts`, using a cheap model if long) and injected into the
  target's live session as `<office-merge>`; `memory.md` is 3-way merged with `git merge-file`;
  the source is then retired unless `--keep`.
- **Shift** (`office shift`, or `office_request_shift`): the agent updates its memory/journal,
  calls `office_shift_ready`, then gets a brand-new session (old session id kept in
  `pastSessions`) — used when an agent's context gets heavy.

Self-management requests (`office_fork_self`, `office_fork_done`, `office_request_shift`,
`office_request_hire`, `office_create_project`) go through `src/lib/requests.ts`; some
auto-approve per `office.config.json`'s `selfManagement`, others need the owner to type `approve <id>`
in `#office-admin` (a chat-ops command, not a CLI one).

### Identity & security boundaries

Every agent is a real Mattermost bot account + Forgejo user with its own token (unforgeable
identity — see the HF-incident lesson in `docs/design.md` §1). Chat/ticket text from agents is
untrusted data: only the human owner can authorize risky actions; the inbox that delivers system
prompts (merge payloads, shift/fork notices) is HMAC-signed (`src/lib/inbox.ts`) and unsigned/
forged files are rejected, never delivered. There is **no OS sandbox** — agents run with the
owner's real shell access; isolation is permission-rule level only (see README's "Security &
safety"). `state/` holds live secrets (tokens, the inbox HMAC key) and must never be committed.

### Layout

| Path | Job |
|---|---|
| `infra/` | docker-compose: Mattermost Team Ed. + Postgres, Forgejo. Data in `infra/data/` (gitignored). |
| `src/cli/office.ts` (`bin/office`) | The `office` CLI: init/hire/start/stop/status/fork/merge/shift/project/... |
| `src/cli/bootstrap.ts` | `office init`: creates the owner, team, default channels, Forgejo org/labels, `brain/`. |
| `src/mcp/server.ts` | Per-agent MCP server: tools + inbound listener + wake. |
| `src/mcp/policy.ts` | Delivery classification, digest batching, guards, rendering — pure logic, heavily unit-tested. |
| `src/lib/mattermost.ts`, `src/lib/forgejo.ts` | Thin typed REST/WS clients, incl. admin ops. |
| `src/lib/harness/claude.ts`, `src/lib/harness/opencode.ts` | Launch commands, session ids, fork, wake adapters. |
| `src/lib/transcript.ts` | Renders Claude JSONL / opencode messages to compact text for merge. |
| `src/lib/workspace.ts` | Generates each agent's workspace `CLAUDE.md`/`AGENTS.md`, seeds brain files, sets per-agent git identity. |
| `src/lib/projects.ts`, `src/lib/project-requests.ts` | Project registry (repo + channel + members). |
| `src/lib/requests.ts` | Self-management request queue (fork/merge/shift/hire/project). |
| `src/admin/` | `#office-admin` / `#office-finance` chat-ops daemon, `monitor.ts` (status/inspect), `watchdog.ts` (stale work, stuck panes, usage alerts), `dispatcher.ts` (announces unassigned tickets/PRs). |
| `src/finance/` | Usage/cost collection per resource group (Claude subscription, OpenCode Go, OpenRouter) and rolling-window limits. |
| `templates/` | `office-rules.md` (shared "how we work" prompt), `persona.md`, `memory.md` — filled with `{{vars}}` by `workspace.ts`. |
| `brain/` | Own git repo (gitignored here), `agents/<name>/{persona,memory,journal}.md` + `wiki/`. |
| `workspaces/<name>/` | Gitignored; each agent's cwd and own git repo. Generated instructions file lives here. |
| `state/` | Gitignored; secrets, agent records, status files, per-agent pending/watch state, admin logs. |

Everything under `state/`, `workspaces/`, `brain/`, `infra/data/`, `infra/.env`, and
`office.config.json` is local/live data, not source — don't commit it (already gitignored) and be
careful about reading secrets out of `state/` into anything that leaves the machine.
