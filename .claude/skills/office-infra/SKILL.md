---
name: office-infra
description: Use when changing infra/ (docker-compose.yml, docker-compose.dev.yml, .env.example, agentcy.service), src/lib/infra.ts, src/lib/migrate.ts, src/cli/bootstrap.ts, src/cli/setup.ts, src/cli/dev-cmd.ts or install.sh, or tasks about the Mattermost/Forgejo stack, dev instances, ports, bootstrap, export/import or the home-server setup.
---

# Infrastructure: the stack, dev instances, bootstrap, export/import, home server

`infra/docker-compose.yml` runs Postgres 16, Mattermost Team Edition and Forgejo (SQLite) as one compose
project, with data bind-mounted under `infra/data/`. `office init` (`bootstrap()`) brings it up and
creates the owner, team, channels, bots, Forgejo org and ticket repo. A checkout is one office. A
dev instance is a second, isolated office (own compose project, containers, ports, named volumes and
tmux session) so several can run next to the owner's live office. Home-server pieces: `install.sh`,
`office setup`, `office export` / `import`, `infra/agentcy.service`.
Background: `docs/research/infra-notes.md`, README "Run it on a home server".

## Map

- `infra/docker-compose.yml`: services `postgres`, `mattermost`, `forgejo`. Container names `${OFFICE_CONTAINER_PREFIX:-agent-office}-<service>`; host ports `${MM_PORT:-8065}`, `${FORGEJO_PORT:-3033}`, `${FORGEJO_SSH_PORT:-2222}` on `${BIND_ADDR:-127.0.0.1}`; network named `${OFFICE_CONTAINER_PREFIX:-agent-office}`; `MM_SITE_URL` and `FORGEJO_ROOT_URL` with loopback defaults.
- `infra/docker-compose.dev.yml`: override for dev instances. Replaces each `./data/...` bind with a named volume (`postgres-data`, `mattermost-*`, `forgejo-data`).
- `infra/.env.example` documents `.env` keys. `infra/.env` is gitignored and holds `POSTGRES_PASSWORD` and the instance keys.
- `src/lib/infra.ts`:
  - Files and env: `infraDir`, `composeFileArgs(root)`, `readInfraEnv`, `writeInfraEnv`, `parseEnv`, `updateEnv`, `LAN_OVERRIDE`, `DEV_OVERRIDE`.
  - Instance identity: `instanceName(root)`, `containerPrefix(root)`, `devProject(name)`, `instanceSlug`, `instanceNameFor(root, slug?)`, `startPortBase`, `instancePorts(base)`, `pickPortBase(name, isFree)`, `devEnv`, `devConfig`.
  - Guards: `assertStackOwnership(root)` (with pure `findForeignContainer`), `assertInstanceConfig(root, cfg)`, `assertNotDevInstance(root, what)`, `assertInitialised(root, what)`.
  - Home server: `renderLanOverride`, `publicUrlsFor`, `tailscaleServeCommands`, `applyAccessMode`, `isValidHostname`.
- `src/cli/dev-cmd.ts`: `cmdDev` with `devInit`, `devInfo`, `devDown`, `devReset`, `requireDevInstance`. All side effects arrive through the injected `DevDeps` (like `GroupDeps`); it must not import `office.ts`, which runs `main()` on import. The real deps object is `devDeps` in `src/cli/office.ts`.
- `src/cli/bootstrap.ts`: `bootstrap()`, `createAgentIdentity(name, displayName, bio)`, `retireAgentIdentity(name)`. `dockerCompose` and `dockerExec(service, user, cmd)` go through `docker compose <composeFileArgs> ...` with service names `mattermost` / `forgejo`, never container names.
- `src/lib/migrate.ts`: `exportOffice`, `importOffice`, `readManifest`, `resetSessionsAfterMove`, `MOVED_PROMPT`. `src/cli/setup.ts`: `runSetup` plus pure helpers `privateAddresses`, `parseTailscaleStatus`, `USERNAME_RE`. `install.sh` creates the `agentcy` user and the systemd unit.

## Data and state

- Normal office: `infra/data/` (root-owned container files), `infra/.env`, optional `infra/docker-compose.lan.yml`, `state/office.json` (tokens, owner password), `office.config.json`.
- Dev instance: same files, but data lives in Docker named volumes of compose project `agentcy-<name>`. `infra/.env` gains `OFFICE_INSTANCE`, `COMPOSE_PROJECT_NAME`, `OFFICE_CONTAINER_PREFIX`, `MM_PORT`, `FORGEJO_PORT`, `FORGEJO_SSH_PORT`, `MM_SITE_URL`, `FORGEJO_ROOT_URL`. Name is `<slug>-<hash6>`, hash6 from `sha1(realpath(checkout))`. Port base starts at `20000 + (hash % 100) * 100`, steps by 100 until `base`, `base+1`, `base+2` are free; opencode ports start at `base+10`.
- Config keys: `mattermostUrl`, `forgejoUrl`, `publicUrls`, `tmuxSession`, `opencodeBasePort`, `team`, `forgejoOrg`, `ticketsRepo`, `human`, `adminChannel`, `financeChannel`, `defaultChannels`.

## Invariants and traps

- Two checkouts must never act on one stack. The default compose project is the directory name `infra`, so a second checkout's `up` would recreate the live containers on its empty `infra/data`. `assertStackOwnership` compares the `com.docker.compose.project.working_dir` label of `<prefix>-mattermost|forgejo|postgres` with this checkout's `infra/` (realpath). It runs in `bootstrap()`, `ensureInfra()`, `exportOffice`, `importOffice`, `runSetup` and before every compose call in `dev-cmd.ts`. A stopped container counts. A label path that no longer exists means the checkout moved, so it passes. No container or no Docker: it passes.
- The defaults must not change a normal office. Same project name, container names, ports and `./data` binds. Any edit to `docker-compose.yml` needs a check that `docker compose config` still renders the same for an existing `.env`; the container config hash must not change or an upgrade recreates containers.
- A dev instance always gets an explicit `-p agentcy-<name>` first in `composeFileArgs`, from `OFFICE_INSTANCE`, so an unset or shell-exported `COMPOSE_PROJECT_NAME` cannot point it at `infra`. The dev override is appended after the main file and before the LAN override.
- `assertInstanceConfig` runs at startup of every command except `dev init` and `dev reset`. A dev checkout whose `office.config.json` was regenerated from the example would otherwise use tmux session `office` and the live ports.
- `dev down`, `dev reset` refuse unless `OFFICE_INSTANCE` is set, and refuse when the prefix is `agent-office` or the project is `infra` (`requireDevInstance`). `dev init` refuses on a checkout that holds a normal office (`state/office.json` exists without `OFFICE_INSTANCE`), and when Docker volumes of the project already exist or `docker-compose.lan.yml` exists. It replaces `office.config.json` only while `state/office.json` does not exist.
- `export`, `import` and `setup` refuse on a dev instance (they tar `infra/data`, hardcode default ports and run `tailscale serve`). `shutdown`, `admin-stop` and `export` refuse without `state/office.json`, since an uninitialised checkout has `tmuxSession: "office"` and would kill the live office's windows.
- Agents, the MCP and the CLI always use `127.0.0.1` (`mattermostUrl`, `forgejoUrl`). Only `MM_SITE_URL`, `FORGEJO_ROOT_URL` and `publicUrls` hold the owner-facing addresses. Publishing on `0.0.0.0` or `::` is refused in `renderLanOverride`. LAN bindings are added on top of loopback.
- Export bundles hold every token and the vault key (chmod 700 dir, 600 files). Claude logins never travel: `state/claude/*/.credentials.json` is excluded from the tar. After import each agent gets a fresh session and generated per-start files are deleted because they hold old paths.
- Bootstrap is idempotent and must stay so. `ensureInfraEnv` keeps an existing `POSTGRES_PASSWORD`; changing it after first start breaks Postgres.
- `ensureOfficePolicies()` (bootstrap.ts) runs in `bootstrap()` and `ensureInfra()`. `ensureChatRoles` (`src/lib/chat-roles.ts`) first trims `team_admin` and verifies it, then promotes every hired agent's bot and the `office` bot to team admin, and only then removes the public-channel permissions from `team_user`. A bot on plain `team_user` loses every channel, so never reorder it. `createAgentIdentity` promotes a new bot right after adding it to the team. `office up` and `init` fail when a policy step fails; `office start` only warns and continues (the office runs as before, invites are refused until `office up` succeeds).
- The Forgejo org and all repos are private (`ensureForgejoPrivacy`). Agents reach them through the `agents` team; invited members are per-repo collaborators and must never be added to that team, which includes all repositories.
- Mattermost needs `MM_SERVICESETTINGS_ENABLEAPIPOSTDELETION` (the key-purge path in the admin daemon) and bot account creation. Do not drop those env settings.

## Testing

- Unit: `test/home-server.test.ts` (setup helpers, LAN override, access modes, env editing, export/import helpers), `test/review-fixes.test.ts` (parts of `infra.ts`). `test/dev-instance.test.ts` for slugging, port blocks, generated `.env` and config, `composeFileArgs`, ownership, `assertInstanceConfig`, the `claudeSettings` exclude, and every refusal rule of `dev init|info|down|reset` through injected `DevDeps`. Pure functions take injected probes (`isFree`, `InspectLabel`, `realpath`) so no Docker is needed.
- One file: `npx vitest run test/home-server.test.ts`.
- Compose changes and bootstrap changes need a real stack. Use a dev instance: `bin/office dev init`, then `npm run test:integration` (platform tests, `OFFICE_INTEGRATION=1`), then `bin/office dev down --purge`. See the `dev-office` skill.
- Never test an infra change by running `office init`, `up`, `start`, `setup`, `export` or `import` in a checkout that is not a dev instance while another office runs on the machine. Read-only checks (`docker compose config`, with the live `.env` copied elsewhere) are fine.
- CI runs the same flow (`bin/office dev init --name ci`, `npm run test:integration`, `bin/office dev down --purge`) in `.github/workflows/ci.yml`.

## Pointers

`docs/research/infra-notes.md`, `docs/design.md` 4.1 and Q13 (later topology: agents reach the server by URL from config), README "Run it on a home server", `docs/superpowers/plans/2026-10-10-devx.md` (dev instance contract).
