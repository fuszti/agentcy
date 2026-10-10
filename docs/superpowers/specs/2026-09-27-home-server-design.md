# Home-server office (multi-machine, milestone 1)

Status: implemented on `feature/home-server` (milestone 1). Milestone 2 is designed below, not built.

## Goal

Run the office (Mattermost + Forgejo, the agents, and the admin/watchdog/dispatcher/finance
daemons) on a home server instead of the laptop. The laptop only needs a browser or the Mattermost
app. Manage provider credentials centrally. The model is Coolify: you clone the repo and run the
installer on the machine that will host the office, and later add more machines to it.

## Reference: how Coolify does it

- Coolify runs as one control plane. The worker machines only need sshd and Docker; Coolify drives
  them over SSH.
- SSH private keys are their own objects: generated or imported, encrypted at rest, and assigned
  to servers.
- Adding a server means name, host, port, user and key, followed by "Validate & Install":
  SSH → OS family → prerequisites → Docker install.
- Coolify keeps one persistent SSH connection per server (ControlMaster), retries transient
  failures with backoff, uses sudo for non-root users, and redacts secrets from logs.
- A periodic job checks reachability and lists containers. An optional agent (Sentinel) reports
  metrics.

## Decisions (grilled 2026-09-27)

| # | Decision |
|---|---|
| Q1 | A home server is the control plane. The laptop is only a client. |
| Q2 | Agentcy is network-agnostic. Tailscale/WireGuard is recommended, and the office is never published on `0.0.0.0`. |
| Q3 | Management happens through chat-ops in Mattermost (`#office-admin`), plus a guided installer that runs *on the server*, like Coolify. |
| Q4 | Preparing a machine means validating it, then installing each missing item only after you confirm. Installs are automated on Debian/Ubuntu; other distros are check-only. |
| Q5 | A dedicated, sudo-less `agentcy` Unix user runs everything, because agents have no OS sandbox. |
| Q6 | Servers must run Linux. |
| Q7 | Milestone 1 is one server running everything. Distributing agents over several machines is milestone 2. |
| Q8 | Each machine logs in to Claude itself with `claude auth login`. A `claude setup-token` token is an opt-in vault entry. Copying `.credentials.json` between machines is rejected: refresh tokens are single-use, so copies log each other out. |
| Q9 | The vault holds API keys only, handed to agents as env vars. OAuth logins are not synced. |
| Q10 | The vault is encrypted with a key file (`state/vault.key`, chmod 600), so the office can restart unattended. |
| Q11 | Milestone 1 needs no SSH layer. Everything runs locally on the server. |
| Q12 | Nothing Agentcy-specific is installed on the laptop. The fallback is `ssh` plus `office …` on the server. |
| Q13 | Keys are entered on the server shell or in the setup wizard, never in chat. Chat shows status only. |
| Q14 | Onboarding is `install.sh` (system checks, `agentcy` user, checkout, harness CLIs, systemd), followed by the `office setup` wizard. |
| Q15 | A systemd system service `agentcy.service` (`User=agentcy`) starts the office at boot. |
| Q16 | Migration works as `office export` → `office import`. Agents start fresh sessions from their brains; transcripts are not rewritten. |
| Q17 | Chat and tickets are reached over LAN HTTP or Tailscale HTTPS (`tailscale serve`). There is no bundled reverse proxy. |

## What was built (milestone 1)

- **`src/lib/vault.ts`** — the vault: AES-256-GCM, with the entry id as additional authenticated
  data (AAD), stored in chmod-600 files.
  - Vault entries map to per-harness env vars. opencode keys go only to opencode agents; an
    Anthropic API key is never injected into Claude, where it would override the subscription.
  - Keys reach agents through `state/agents/<name>/provider.env`, which is sourced by the launch
    command (`set -a; . file`). The command line itself never carries a key.
  - For opencode, `provider.<id>.options.apiKey` is set to `{env:VAR}`.
  - Finance, the merge summarizer and the admin helper read keys from the vault first, then fall
    back to opencode's `auth.json`.
- **`src/cli/vault-cmd.ts`** — `office vault status|set|rm|check|import-opencode`.
  - `set` reads the key from a hidden TTY prompt and refuses keys passed as arguments.
  - In `#office-admin`, `vault set <id> <value>` permanently deletes the post (via the owner's
    token) and tells you to rotate the key.
- **`src/lib/infra.ts`** — the public URLs (`MM_SITE_URL`, `FORGEJO_ROOT_URL`) now come from
  `infra/.env`. The optional `infra/docker-compose.lan.yml` adds a binding on a LAN address
  alongside the existing loopback bindings.
  - Internal `mattermostUrl`/`forgejoUrl` stay on 127.0.0.1.
  - `publicUrls` in the config is used in the status and finance footers.
- **`src/lib/migrate.ts`** — the export bundle contains `infra-data.tar.gz`, `office.tar.gz` and
  `manifest.json`.
  - Infra data is copied with tar *inside a container*, as root, with the stack stopped. This
    keeps container UIDs without needing host sudo.
  - Import resets `sessionId` (moving the old id to `pastSessions`), deletes the generated
    per-agent files that contain the old root path, and queues a signed "office moved" prompt.
- **`src/cli/setup.ts`** — the `office setup` wizard, in six steps: tools; new or import; owner;
  access; keys; Claude login. Then it runs `bootstrap()` and, for Tailscale, `tailscale serve`.
  It is safe to re-run.
- **`install.sh` + `infra/agentcy.service`** — the installer and the unit; see the README section
  "Run it on a home server".
- **`office shutdown`** — the unit's `ExecStop`. It stops the agents and the admin daemon; Docker
  keeps running because the containers are `restart: unless-stopped`.

## Known limits / follow-ups

- **Unverified:** whether opencode honours `provider.opencode-go.options.apiKey`. The per-agent
  config sets it, but it hasn't been checked against a live opencode. If it doesn't work, the
  fallback is to keep a server-local `opencode auth login` for Go.
- **Not tested end to end:** `install.sh` on a clean Debian/Ubuntu machine, and export/import
  against a real stack. Neither could safely run on the dev machine: the live office uses the
  same compose project name and container names. Tested so far: unit tests for all pure logic;
  CLI smoke tests of `vault` and `setup` guards in a scratch root; and the container tar
  round-trip preserving UIDs.
- **Claude finance with `claude-oauth`:** `/usage` returns 403 for setup-token tokens, so the
  limits section has no Claude rows when that opt-in is used.
- **Security scope of the vault:** it protects against copying or committing `state/` by
  accident. Agents can still read their own env. Root on the server can read everything.

## Milestone 2 (designed, not built): extra worker machines

- **`hosts` registry** in `state/hosts/<name>.json`: host, port, user, key id, roles
  (`agents`, later `infra`), and validation state/logs.
- **SSH keys** are stored under the vault's encryption. The office generates an ed25519 key and
  shows the public key to put in the worker's `authorized_keys`.
- **SSH layer:** `ssh -o ControlMaster=auto -o ControlPersist=10m` using a per-host socket in
  `state/ssh/`, with retry and backoff for transient errors, and never passing secrets on the
  command line (env files go over `scp`, then get sourced).
- **Validate / prepare:** the same checks as `install.sh`, run over SSH. The worker gets an
  `agentcy` user, a checkout and `npm ci`, because the MCP must run next to its agent: the
  harness spawns it over stdio.
- **Remote agents** mean `AgentRecord.host`:
  - tmux commands run over SSH;
  - the `status.json`, `pending.json` and `mcp.log` reads are proxied over SSH;
  - the worker's MCP reaches chat and tickets via the control plane's LAN/Tailscale address
    instead of 127.0.0.1;
  - `workspaces/<name>` and `brain/` live on the worker. The brain is synced with git through
    Forgejo instead of a shared filesystem.
- **Chat-ops:** `host add|validate|list|rm` in `#office-admin`, and `hire <name> --host <h>`.
- **Health:** the watchdog pings each host on an interval and alerts after N misses, like
  Coolify's unreachable count.
