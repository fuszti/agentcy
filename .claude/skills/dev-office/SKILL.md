---
name: dev-office
description: Use when you need to run, test or try Agentcy for real while developing it: bringing up, using, resetting or tearing down a dev office (bin/office dev ...), running the integration or e2e tests, hiring a test agent, or whenever you are about to run an office command (init, up, start, setup, hire) in a checkout or worktree.
---

# Dev office: a throwaway office per checkout

A dev office is a complete, isolated Agentcy instance for one checkout or git worktree: its own
Docker compose project (`agentcy-<name>`), containers, ports, named volumes, tmux session
(`office-<name>`), `state/`, `brain/`, `workspaces/` and `office.config.json`. It runs next to the
owner's live office without touching it, and several can run at once, one per checkout. The
commands are in `src/cli/dev-cmd.ts`; the guards are in `src/lib/infra.ts`. Details of the model:
the `office-infra` skill and `docs/superpowers/plans/2026-10-10-devx.md`.

## Hard rules

These protect the owner's live office, which may be running on this machine right now.

- Do not run `office init`, `up`, `start`, `setup`, `shutdown`, `export` or `import` (also as `bin/office ...`, `npm run office -- ...`, `tsx src/cli/office.ts ...`) in a checkout that is not a dev instance when another office runs on the machine. Use `bin/office dev init` first. The guards refuse some of these; do not rely on them and never work around one.
- Integration (`npm run test:integration`) and e2e (`npm run test:e2e`) tests run only against a dev instance. They fail with a message otherwise (`requireDevInstance` in `test/helpers/dev-instance.ts`). There is no override.
- Never use a live office's agents, sessions, tickets or chat as test subjects. Do not attach to its tmux session `office`.
- Never read secrets from `state/` (tokens, `office.json`, `vault.key`, `inbox.key`, `provider.env`) into anything that leaves the machine: not into chat, issues, PRs, logs you paste or commit messages. The dev office's own `state/` is gitignored; keep it that way.
- Do not run raw `docker` or `tmux` commands against names you did not get from `bin/office dev info`. Dev containers are `agentcy-<name>-postgres|mattermost|forgejo`. Containers named `agent-office-*` are the live office.
- Do not touch `infra/.env` or `office.config.json` by hand to change ports or names; `dev init` repairs them.

## Commands

Run all of them from the checkout root. `npm run dev:init|dev:info|dev:down|dev:reset` are aliases.

| Command | What it does |
|---|---|
| `bin/office dev init [--name n] [--port-base N]` | Creates or reuses this checkout's dev instance, then runs the normal init (compose up, owner, team, channels, Forgejo org and `office/tasks`, `brain/`). Prints the instance name, compose project, chat and tickets URLs, tmux session, owner username and where the password is (`state/office.json`). Idempotent: an existing instance keeps its name and ports. |
| `bin/office dev info` | Prints the same facts without changing anything. Exits 1 if this checkout is not a dev instance. |
| `bin/office dev down` | Stops this instance's agent sessions and admin daemon, then `docker compose down`. Data is kept. |
| `bin/office dev down --purge` | Also removes the volumes (`down -v`) and deletes `state/`, `workspaces/`, `brain/`, `office.config.json` and `infra/.env`. Use it when you are done. |
| `bin/office dev reset` | `dev down --purge`, then `dev init` with the same name. Use it for a clean slate. |

Notes:

- `dev init` works on a fresh clone (no config, no `infra/.env`). It needs Docker with Compose v2, `tmux`, `git`, and `npm ci` done (a SessionStart hook runs `scripts/dev-bootstrap.sh` for that in a new worktree).
- Name is `<slug>-<hash6>` (slug from the directory name, or `--name`). Ports are a block of 100 starting at `20000 + (hash % 100) * 100`: chat = base, tickets = base+1, tickets ssh = base+2, opencode agents from base+10. `--port-base N` overrides.
- `dev init` refuses in a checkout that already holds a normal office (`state/office.json` without `OFFICE_INSTANCE` in `infra/.env`). Use another worktree.
- `dev down` and `dev reset` refuse on anything but a dev instance, and when the prefix is `agent-office` or the project is `infra`.
- `export`, `import` and `setup` refuse on a dev instance.
- If `dev init` reports leftover Docker volumes of the same project, a checkout at the same path was deleted without `dev down --purge`. Follow the `docker volume rm` hint in the message, or run `dev down --purge` in the old checkout.

## Use it

1. `bin/office dev init`. Open the printed chat URL in a browser and log in as the owner (the password is printed by init and stored in `state/office.json`). The ticket tracker is the printed tickets URL plus `office/tasks`. Both are `http://127.0.0.1:<port>`.
2. Hire a cheap opencode agent: `bin/office hire kim --harness opencode`. A dev instance sets `defaults.opencodeModel` to `defaults.helperModel` (`opencode-go/deepseek-v4.1-flash`), so no `--model` is needed; pass `--model <helperModel>` to be explicit. Needs `opencode` installed and logged in on this machine, or a key in the vault (see below). Names that ever existed, even retired, are rejected; use a fresh name.
3. Talk to it: DM the bot in the chat UI, or `npx tsx scripts/dm.ts kim "hello"` then `npx tsx scripts/wait-reply.ts <post_id> kim 120`. Watch it with `bin/office status`, `bin/office inspect kim`, `bin/office logs kim`, `bin/office attach kim`.
4. Start the admin daemon and every agent with `bin/office start` if you want `#office-admin`; stop with `bin/office shutdown` or `dev down`.
5. Retire test agents when done: `bin/office retire kim`.

Keys: `bin/office vault set opencode-go` needs a TTY and hidden input. Never pass a key as an argument or paste it into chat (the admin daemon deletes such posts). Automated runs may export `OPENCODE_GO_API_KEY`; the e2e test stores it with `setSecret`. Claude agents need `claude auth login` on this machine; avoid them in tests, since they spend subscription quota.

## Test tiers

| Tier | Command | Needs | Covers |
|---|---|---|---|
| Unit | `npx vitest run` (or `npm run check` = tsc, biome lint, vitest) | nothing; no Docker | pure logic. One file: `npx vitest run test/policy.test.ts`; one test: add `-t "name"`. |
| Integration | `npm run test:integration` (`OFFICE_INTEGRATION=1`) | a running dev instance (files run one after another, since each bootstraps the shared stack) | `test/integration/platform.test.ts`: bootstrap, bot identities, WebSocket mentions, thread reads, Forgejo. Creates `itest-a` / `itest-b` and retires them. |
| End to end | `npm run test:e2e` (`OFFICE_E2E=1`) | dev instance, `tmux`, `opencode` | `test/e2e/agent-loop.test.ts`: hires `e2e-<time>` on `helperModel` through `bin/office hire`, DMs it as the owner, waits up to 240 s for any post by the bot in the DM, retires it. Asserts that a reply exists, not what it says. |
| opencode live | `OPENCODE_LIVE=1 npx vitest run test/opencode.test.ts` | a running opencode server | the HTTP client. |

Run unit tests first. Run integration after changes to clients, bootstrap, WebSocket handling or compose. Run e2e after changes to hire, start, wake or delivery. A failing e2e prints the tail of `state/agents/<name>/mcp.log`; also check `bin/office inspect <name>`.

CI runs the same: `bin/office dev init --name ci`, `npm run test:integration`, always `bin/office dev down --purge`; the e2e job runs only when the `OPENCODE_GO_API_KEY` secret exists.

## Typical session

```bash
bin/office dev init              # once per checkout
npx vitest run                   # while editing
npm run test:integration         # after touching infra, bootstrap, clients
npm run test:e2e                 # after touching hire, wake, delivery
bin/office dev reset             # clean slate if state got messy
bin/office dev down --purge      # when the task is done
```

Always finish with `dev down --purge` unless the user asked you to leave the instance running. Several worktrees can each have an instance; `dev info` shows which one this is.

## Pointers

README "Tests" and "Developing Agentcy", `CLAUDE.md` "Dev office", `CONTRIBUTING.md`. Skills for the code areas: `office-delivery`, `office-harnesses`, `office-admin`, `office-finance`, `office-infra`.
