# Sandboxing & browsers for Agentcy — research notes (2026-09-28)

Scope: today Agentcy's only isolation layer is harness permission rules (`claudeSettings` in
`src/lib/harness/claude.ts`, `buildOpencodeConfig` in `src/lib/harness/opencode.ts`) — agents run
as the owner's real Linux user in tmux (README "Security & safety", design.md §5, §7 known
limitations). This note surveys what's actually available in September 2026 and proposes a v2
hardening plan plus a browser strategy. Claims from web sources are marked `[verified: URL]` when
fetched directly from vendor docs, `[reported]` when only a secondary/aggregated source was found,
and `[unverified]` where no source was checked (memory or estimate).

## A. Claude Code's native sandbox and auto mode

Claude Code ships two built-in isolation layers, both opt-in `[verified: https://code.claude.com/docs/en/sandbox-environments]`:

1. **Sandboxed Bash tool** (`/sandbox`, `sandbox.enabled` in `settings.json`). On Linux/WSL2 it
   uses **bubblewrap** (`bwrap`, present on this machine at `/usr/bin/bwrap`, v0.9.0) plus `socat`
   for the network proxy; on macOS it uses the built-in Seatbelt framework. It restricts only
   **Bash/PowerShell/Monitor commands and their child processes** — filesystem access is a mount
   namespace where a typical config gives `/workspace` read-write and `/usr,/lib,/bin` read-only;
   anything outside is invisible to the sandboxed process, not merely permission-denied
   `[reported: labs.esokia.com, sambaiz.net]`. Network egress goes through a local proxy outside
   the sandbox that checks a domain allowlist; non-allowlisted hosts get HTTP 403 from the proxy,
   and non-proxy traffic is kernel-blocked at the namespace boundary
   `[verified: code.claude.com/docs/en/sandboxing via search summary + sandbox-environments fetch]`.
2. **Sandbox runtime** (`@anthropic-ai/sandbox-runtime`, beta) wraps the **whole Claude Code
   process** — file tools, MCP servers, hooks — in the same bubblewrap/Seatbelt boundary, not
   just Bash. This matters directly for Agentcy: the built-in Bash sandbox explicitly does **not**
   cover MCP servers or hooks, which "run unconstrained on the host"
   `[verified: code.claude.com/docs/en/sandbox-environments]`. Agentcy's `office-mcp` and the
   `hook-status.sh` scripts are exactly that kind of unconstrained process today.

Key interactions relevant to Agentcy:
- **MCP servers**: several real-world reports show the sandbox proxy/allowlist breaking native
  MCP connections (e.g. gateway hostnames missing from `NO_PROXY`, OAuth token endpoints blocked)
  `[reported: github.com/anthropics/claude-code issues #6183, #43472]`. Any move to the sandbox
  runtime would need `office`'s own MCP traffic (loopback to `office-mcp`, which itself talks to
  Mattermost/Forgejo on `127.0.0.1` and ports 8065/3033) explicitly allow-listed, plus outbound
  `api.anthropic.com`, `claude.ai`, `platform.claude.com` for OAuth refresh
  `[verified: code.claude.com/docs/en/sandbox-environments]`.
- **tmux**: the sandbox is per-process, so pasting into a tmux pane is unaffected either way —
  tmux itself sits outside the boundary; only the `claude` process and its Bash children are
  constrained.
- **git**: the sandbox runtime denies writes to `.git/hooks` and `.git/config` (unless
  `filesystem.allowGitConfig: true`) and to `.mcp.json`, `.claude/commands`, `.claude/agents` by
  default — sensible, since a compromised session persisting a malicious git hook or MCP config
  would survive a restart `[verified: code.claude.com/docs/en/sandbox-environments]`. Git over SSH
  breaks under the Bash sandbox's proxy model (it only proxies HTTP/HTTPS, not port 22, and blocks
  the ssh-agent socket) `[reported: labs.esokia.com]` — Agentcy's Forgejo remotes should stay
  HTTP(S) with tokens, which they already are.
- **Subscription login**: sandboxing doesn't touch `~/.claude` credentials directly, but OAuth
  refresh requires `claude.ai`/`platform.claude.com` egress to be allow-listed, or the session
  will fail to refresh once its access token expires `[verified: same page]`.
- **Auto mode** is a *per-action classifier*, not an isolation boundary — Anthropic's own docs say
  explicitly that when using auto mode "an isolation boundary still adds defense in depth... and
  is not required the way it is for `--dangerously-skip-permissions`"
  `[verified: code.claude.com/docs/en/sandbox-environments]`. This directly confirms Agentcy's own
  framing (README: "raises the bar against *accidental* self-inflicted damage... does not contain
  a determined or adversarially-prompted agent").

## B. opencode's OS-level options

opencode's permission system is entirely **configuration-based pattern matching** — `--auto`
auto-approves anything not explicitly `deny`d; `allow`/`ask`/`deny` rules match on glob-like
patterns per tool (`bash`, `edit`, `webfetch`, `external_directory`, ...)
`[verified: opencode.ai/docs/permissions/ fetch]`. As of this research, **opencode has no built-in
OS-level sandbox** (no bwrap/landlock/container integration is documented)
`[verified: same fetch — "no information about OS-level sandboxing mechanisms... configuration-
based approval workflows rather than kernel-level isolation"]`. This matches Agentcy's own
`buildOpencodeConfig`, which denies bash patterns like `rm -rf /*`, `sudo *`, `docker rm*`,
`*state*` by literal string match — an agent that base64-encodes a command, uses `$(...)`
indirection, or writes a script file and executes it would not be caught, since there's no kernel
enforcement behind the pattern list. The broader 2026 tooling landscape treats **Landlock**
(kernel LSM since Linux 5.13, no external binary, self-restricting syscalls) as an emerging
lightweight default for wrapping *any* CLI agent, with bubblewrap remaining the de facto standard
where a full mount-namespace jail is wanted `[reported: multiple 2026 hardening write-ups
including akitaonrails.com/ai-jail and advancedweb.hu, cross-referenced]`. For opencode, external
wrapping (bwrap or Landlock around the whole `opencode` process) is the only way to get real OS
enforcement today; nothing in opencode itself will do it.

## C. Container options and the subscription-credential problem

Anthropic's own reference dev container (`anthropics/claude-code/.devcontainer`) combines the CLI,
a default-deny **iptables + ipset** firewall (`init-firewall.sh`) that allow-lists GitHub IP
ranges, `registry.npmjs.org`, `api.anthropic.com`, and rejects everything else explicitly rather
than dropping silently `[verified: code.claude.com/docs/en/sandbox-environments +
github.com/anthropics/claude-code/.devcontainer/init-firewall.sh]`. Anthropic's docs state
plainly: because the firewall blocks unapproved egress, this is what makes it safe to run
`--dangerously-skip-permissions`/full auto unattended inside it.

Broader container/VM menu, ordered by isolation strength `[verified: code.claude.com/docs/en/sandbox-environments]`:
- **Custom container** (any OCI image, own seccomp/network policy) — medium/high effort, most
  common where container infra already exists.
- **Docker Sandboxes** — a free Docker product giving each session a microVM with its own Docker
  daemon and workspace sync, no Docker Desktop required.
- **Virtual machine / microVM** (Firecracker, gVisor-backed platforms like Modal/Daytona) —
  kernel-level separation; Daytona claims 27–90ms provisioning with a gVisor layer (no GPU
  passthrough), E2B is Firecracker-based (~150ms boot) `[reported: northflank.com,
  spheron.network, amux.io — cross-referenced 2026 comparisons]`.
- **Cloud sessions** (`claude --cloud`) — fully Anthropic-hosted VM, its own network proxy, a
  separate proxy holding GitHub tokens outside the sandbox. Not applicable to Agentcy's
  "everything on localhost" design, but the ceiling of what "isolated + subscription login" can
  look like without self-hosting.

**The subscription-credential problem is real and already partly solved in Agentcy's design.**
Anthropic's refresh token is single-use and rotates on every refresh; multiple processes racing to
refresh the same `~/.claude/.credentials.json` cause exactly the failure mode Agentcy's own
`office group login`/multi-`CLAUDE_CONFIG_DIR` design and README already call out ("refresh tokens
are single-use, so copies log each other out")
`[verified: github.com/anthropics/claude-code issue #56339, cross-referenced with several 2026
container-auth write-ups describing the same race and its fixes]`. Documented mitigations:
- Never bind-mount the single `.credentials.json` file into a container — mount the whole
  `~/.claude` (or `CLAUDE_CONFIG_DIR`) **directory**, so a rename-on-write is visible everywhere,
  or the copies drift and invalidate each other on the next rotation.
- Use a long-lived `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) instead of interactive OAuth
  for any container/VM copy — it doesn't rotate the same way and avoids the race entirely
  `[reported: multiple sources, consistent with Claude Code's documented setup-token workflow]`.
  **This is exactly what Agentcy's `office.config.json` resource-group vault already supports**
  (`office vault set claude-b` stores a `claude setup-token`), so extending containers per group
  is a natural fit, not new design.
- File-level locking (`flock` around refresh) is a documented workaround for sharing one live
  OAuth login across processes, but is strictly worse than each container/group having its own
  `CLAUDE_CONFIG_DIR`, which Agentcy already does per resource group.

## D. Threat model for a multi-agent office

| Risk | What mitigates it today | What a v2 layer adds |
|---|---|---|
| **Bot-to-bot prompt injection** (an agent's chat post instructing another agent) | Design already treats all chat/ticket text as untrusted data; only the human can authorize risky actions (design.md §4.2, §5) | A container boundary doesn't stop this — it's a prompt-level problem. The mitigating control is the existing HMAC-signed inbox + "only human = approval," already verified in design.md §7 ("Forged inbox file... rejected by HMAC check"). Sandboxing reduces the *blast radius* if an injected instruction succeeds in getting a tool call executed. |
| **Secrets exfiltration** (reading `state/`, `.env`, tokens, then leaking via network) | Claude/opencode deny rules block reads under `state/`, `.env` | Deny rules are string-pattern, bypassable (symlinks, `cat state/../state/x`, indirect shell). A real OS mount namespace (bwrap/sandbox runtime) makes `state/` genuinely absent from the process's view, not just refused by a classifier. A network allowlist additionally blocks exfil even if a secret is read, by limiting egress to known hosts. |
| **Destructive commands** (`rm -rf`, `git push --force`, `docker compose down`) | opencode `deny` patterns list these literally; Claude auto-mode classifier flags destructive Bash | Same bypass risk as above (encoding, `$()`, script files). bubblewrap/sandbox runtime enforces at the syscall/namespace level regardless of how the command is spelled. |
| **Network egress / data leaving the box** | None specifically — agents have full outbound access as the OS user | Claude's native sandbox proxy (Anthropic API + explicitly listed domains only) or a devcontainer iptables allowlist are the concrete controls; this is the single biggest gap in Agentcy today. |
| **Runaway spend** | `office-finance` resource-group tracking, watchdog alerts at 75/90/100%, per-agent hourly-spend-spike alerts (README "Finance console") | Already reasonably covered at the product level; a hard API-side spend cap (where the provider supports it) would be the OS-adjacent complement, but this is a billing control, not a sandboxing one. |

The clear conclusion: Agentcy's chat-level controls (signed inbox, human-only approval, untrusted-
data framing) are the right mitigation for *injection*, and are already solid. The clear *gap* is
that nothing currently stops a successfully-injected or simply mis-classified action from reading
`state/`, running a destructive command via an unanticipated spelling, or exfiltrating over the
network — because the only enforcement is string-pattern permission rules interpreted by the
harness's own classifier, not the kernel.

## Recommended v2 layered hardening plan

1. **Low effort, do first — Claude Bash sandbox via `/sandbox` + `sandbox.enabled` in the settings
   passed to `claude` (extend `claudeSettings()` in `src/lib/harness/claude.ts`).** Bubblewrap is
   already installed. Set filesystem allow to the agent's `workspaces/<name>` + `brain`, network
   allowlist to `api.anthropic.com`, `claude.ai`, `platform.claude.com`, plus Forgejo/Mattermost on
   `127.0.0.1`. **What breaks**: any git-over-SSH remote (none in Agentcy — Forgejo uses HTTP
   tokens, so this is fine); MCP servers and hooks are *not* covered by this layer, so `office-mcp`
   itself stays unconstrained — acceptable as a first increment since `office-mcp` is Agentcy's
   own trusted code, not agent-authored.
2. **Medium effort — `@anthropic-ai/sandbox-runtime` around the whole `claude` launch command** in
   `claudeLaunchCommand()`, once its config schema stabilizes past beta. This closes the MCP/hooks
   gap from step 1. Needs explicit write-allow for `~/.claude`, `~/.claude.json`, `/tmp`, the
   agent's workspace and `brain/`, and explicit network-allow for the office-mcp's own ports.
   **What breaks**: `mkdir -p ~/.claude` must exist before first launch (already true after normal
   onboarding); any workspace path created via `git clone`/`git init` mid-session needs to already
   be under an allowed prefix (agents always clone under `workspaces/<name>/`, so this holds).
3. **Medium effort — opencode: wrap the launch command in `bwrap` externally**, since opencode has
   no native OS sandbox. `opencodeLaunchCommand()` would prefix `bwrap --ro-bind /usr /usr --ro-bind
   /lib /lib --bind workspaces/<name> workspaces/<name> --bind brain brain --die-with-parent ...`
   before the existing `opencode ... --auto` invocation, keeping the existing string-pattern deny
   rules as a second layer (defense in depth, not redundant). **What breaks**: opencode's own model
   provider auth (API keys from the vault, injected as env vars) must be readable; any tool that
   shells out to system binaries not bind-mounted (e.g. a linter binary installed globally) needs
   an explicit `--ro-bind`. This needs its own short spike to enumerate what opencode/its tools
   actually touch before locking it down, since nothing today documents opencode's runtime
   filesystem footprint.
4. **Medium/high effort, optional — dev container per Claude/opencode resource group**, following
   Anthropic's reference `.devcontainer` (iptables allowlist) as a template, one `CLAUDE_CONFIG_DIR`
   volume mounted **as a directory**, per group, with a `claude setup-token` (already supported by
   `office vault set <group>`) instead of interactive OAuth to sidestep the refresh-token race.
   Mattermost/Forgejo must be reachable from inside the container — either `host.docker.internal`
   or a shared Docker network with `infra/docker-compose.yml`. This is the point at which "isolation
   is permission-rule level only" in the README would actually become false; it's real work (a
   compose file per group, network wiring, volume ownership) and should be scoped as its own ticket,
   not folded into steps 1–3.
5. **Not recommended for Agentcy's threat model right now**: full VM/microVM per agent (Firecracker/
   gVisor via E2B/Daytona). Agentcy's threat model is a trusted single operator running a handful of
   agents on their own machine, not multi-tenant execution of untrusted third-party code — the
   marginal isolation gain over step 4 doesn't justify the operational cost (per-agent VM lifecycle,
   snapshotting, cost) for this use case. Revisit if Agentcy ever runs agents against genuinely
   untrusted external repos/tickets.

## E. Browser strategy for many concurrent agents

- **Claude in Chrome (`--chrome`, used today for `office hire <name> --chrome`)** drives the
  owner's real, logged-in Chrome via the extension. No official concurrency limit was found in
  vendor docs during this research (the relevant help-center page 404'd); treat any number above
  one or two simultaneously-`--chrome`-enabled agents as **unverified and likely to conflict**,
  since it's the same browser profile and the same set of tabs — two agents clicking in the same
  window is a race, not a feature. **Recommendation**: reserve `--chrome` for at most one agent at
  a time, or better, only for interactive/human-supervised sessions where the owner's own logins
  (banking, internal tools, anything behind SSO) are required and no automatable alternative
  exists. This matches design.md's M8 review note ("Playwright vs `--chrome` was intended
  behaviour").
- **Playwright MCP (already wired via `claudeMcpConfig`/`opencodePlaywrightMcp`, `--headless
  --isolated`)** is the right default for concurrent, unattended agents: `--isolated` gives each
  session its own in-memory profile with no shared login state, avoiding the documented profile-
  lock conflict ("a persistent profile can only be used by one browser instance at a time... concurrent
  MCP clients sharing the same workspace will conflict") `[verified: microsoft/playwright, fetched
  via WebFetch]`. Each agent already gets its own `npx @playwright/mcp@latest --headless --isolated`
  process, so this is already correct; no change needed. Per-instance memory is not documented by
  Playwright itself; general headless-Chromium guidance in the wild puts a bare headless instance
  around 150–300MB idle, more under load `[unverified estimate]` — with a handful of agents that's
  a few hundred MB to ~1-2GB of RAM if several browse concurrently, worth watching via `office
  status`/`inspect` but not a blocker at Agentcy's current scale.
- **Chrome DevTools MCP** is a narrower tool aimed at performance/network debugging (traces,
  source-mapped console errors) rather than general page automation; it can launch isolated
  instances or attach to a running Chrome, officially supports only Chrome/Chrome-for-Testing
  `[verified: github.com/ChromeDevTools/chrome-devtools-mcp fetch]`. Not a general replacement for
  Playwright MCP in Agentcy; consider it only if an agent needs to debug a real performance
  regression, and keep it off by default.
- **When to hand off to the human's logged-in browser**: any site behind SSO/2FA the agent can't
  complete itself, anything the owner would not want an agent's headless session touching
  unsupervised (payments, admin consoles), or debugging a rendering issue that depends on the
  owner's actual extensions/state. In all other cases — scraping, filling forms on non-authenticated
  or agent-owned accounts, testing Agentcy's own Mattermost/Forgejo UI — Playwright MCP's isolated
  headless mode is the correct default and is already what Agentcy does.

## Sources

- https://code.claude.com/docs/en/sandboxing (fetched)
- https://code.claude.com/docs/en/sandbox-environments (fetched)
- https://opencode.ai/docs/permissions/ (fetched)
- https://github.com/microsoft/playwright (fetched, MCP docs section)
- https://github.com/ChromeDevTools/chrome-devtools-mcp (fetched)
- https://github.com/anthropics/claude-code/.devcontainer/init-firewall.sh (search summary)
- https://github.com/anthropics/claude-code/issues/56339 — credential refresh race (search summary)
- https://github.com/anthropics/claude-code/issues/6183, #43472 — MCP-through-sandbox-proxy issues (search summary)
- https://labs.esokia.com/post/sandboxing-claude-code-cli-linux-bubblewrap/ (search summary)
- Various 2026 comparison write-ups on E2B/Daytona/Modal/gVisor/Firecracker (northflank.com,
  amux.io, spheron.network — cross-referenced, not individually fetched)
- Local verification: `bwrap --version` → bubblewrap 0.9.0; `docker --version` → 29.6.2; `claude
  --version` → 2.1.283; `opencode --version` → 1.18.32; `claude --help` confirms
  `--permission-mode` choices (`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`) and
  `--dangerously-skip-permissions`; `opencode --help` confirms `--auto` is labelled "(dangerous!)".

*(No live agent sessions were started; no other files were modified.)*
