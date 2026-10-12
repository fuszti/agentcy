# Reach the office from the internet (Cloudflare Tunnel)

Status: designed, not built. Branch `feature/remote-human-login`. Build this after
[`2026-10-10-multi-human-design.md`](2026-10-10-multi-human-design.md).

## Goal

The owner and invited members open chat and tickets from anywhere on the owner's own domain, in a
browser and in the Mattermost mobile app (iOS and Android), without a VPN. The office server
opens no inbound port.

Today `office setup` offers three access modes: this machine only, a LAN address, or Tailscale
HTTPS. `SECURITY.md` declares public exposure out of scope.

## Decisions (brainstormed 2026-10-10)

| # | Decision |
|---|---|
| C1 | A fourth access mode, `cloudflare`: a Cloudflare Tunnel publishes Mattermost and Forgejo on two hostnames of the owner's domain. |
| C2 | No Cloudflare Access in front. The owner decided the Mattermost and Forgejo logins are the protection, so that the mobile app works. The hardening below therefore has to stand on its own. |
| C3 | `cloudflared` runs as an optional service in the office's compose file and reaches the other containers over the Docker network. Nothing binds beyond `127.0.0.1`. |
| C4 | The tunnel is a remotely managed one: the owner creates it and its public hostnames in the Cloudflare dashboard and gives setup the token. Agentcy does not call the Cloudflare API. |
| C5 | Hardening is applied only in this mode. A local, LAN or Tailscale office renders the same compose config as today. |
| C6 | Git over SSH is not published. Remote git uses HTTPS. |

## Risk accepted with C2

The login pages of Mattermost and Forgejo are reachable by anyone. The owner account can instruct
agents that run with the owner's shell, so a stolen owner login is remote code execution on the
server. What stands between the internet and that: a random owner password, login throttling,
closed registration, and MFA once the owner enrols. Setup says this in plain words before
enabling the mode, and the README documents Cloudflare Access as an optional extra for the git
hostname.

## Design

### 1. Access mode

`src/lib/infra.ts`:

- `AccessMode` gains `{ kind: 'cloudflare'; chatHost: string; gitHost: string }`. Both must pass
  `isValidHostname` and differ from each other.
- `publicUrlsFor` returns `https://<chatHost>` and `https://<gitHost>`.
- `applyAccessMode` writes `MM_SITE_URL`, `FORGEJO_ROOT_URL`, the tunnel token and the hardening
  variables to `infra/.env`, and removes the LAN override. Leaving the mode removes the token and
  the hardening variables again.
- `composeFileArgs` adds `--profile cloudflare` when `infra/.env` has `CLOUDFLARE_TUNNEL_TOKEN`.

Agents, the MCP and the CLI keep using `mattermostUrl` / `forgejoUrl` on `127.0.0.1`.

### 2. The tunnel service

`infra/docker-compose.yml` gets a `cloudflared` service:

- `profiles: ["cloudflare"]`, so it does not exist for any other office.
- An image pinned to an exact version, like the other services.
- `command: tunnel --no-autoupdate run`, with `TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}`.
- On the `agent-office` network, `restart: unless-stopped`, started after Mattermost and Forgejo
  are healthy.
- No ports and no volumes.

In the Cloudflare dashboard the owner maps `chatHost` to `http://mattermost:8065` and `gitHost`
to `http://forgejo:3000`. Setup prints these two lines with the real container service names.

The token is a secret. It lives only in `infra/.env` (mode 600), is entered with hidden input, is
never printed and is part of `office export` like the other contents of `infra/.env`.

### 3. Setup wizard

`pickAccess()` in `src/cli/setup.ts` offers "Cloudflare Tunnel (your own domain, works with the
mobile app)". Choosing it:

1. Shows the risk paragraph above and asks for confirmation.
2. Asks for the chat hostname and the git hostname.
3. Prints the dashboard steps: create a tunnel, add the two public hostnames, copy the token.
4. Reads the token hidden.
5. Applies the mode and recreates the containers.
6. Checks that `https://<chatHost>/api/v4/system/ping` and the Forgejo version endpoint answer
   through the tunnel, and reports clearly when they do not (DNS not yet active, wrong service
   URL in the dashboard).
7. Prints what to do next: log in, enrol MFA in both, install the mobile app and enter
   `https://<chatHost>` as the server.

`office setup` already refuses on a dev instance; that stays.

### 4. Hardening

Settings that are fixed in `docker-compose.yml` today become variables whose defaults are the
current values, so an existing `.env` renders the same config and containers are not recreated on
upgrade. In `cloudflare` mode `applyAccessMode` sets:

| Setting | Default (unchanged) | In `cloudflare` mode |
|---|---|---|
| Forgejo `REQUIRE_SIGNIN_VIEW` | `false` | `true` |
| Mattermost rate limiting | off | on, varied per user, with the client address taken from Cloudflare's header |
| Mattermost MFA available | off | on |
| Mattermost minimum password length | default | 14 |

Mattermost Team Edition cannot force MFA on members, as far as known; setup and the README tell
the owner and members to enrol. Forgejo two-factor is per user and is covered by the same
instructions.

Two points need a check on a dev office during implementation, before they are relied on:

- Rate limiting must not throttle the agents, which make many API calls from one address. If it
  does and per-user variation does not solve it, the fallback is to leave Mattermost's general
  rate limit off and rely on its login-attempt lockout; the spec's requirement is that repeated
  wrong passwords for one account get locked out.
- Forgejo's container health check (`/api/forgejo/v1/version`) must still pass with
  `REQUIRE_SIGNIN_VIEW=true`. If not, the health check changes to an endpoint that does.

The multi-human spec makes all repos and the org private. Together with `REQUIRE_SIGNIN_VIEW`
nothing in Forgejo is readable without an account.

### 5. Mobile app

The app needs HTTPS and WebSockets on the site URL; the tunnel provides both. Push notifications
need a push proxy. Setup asks whether to enable them and explains the trade-off: on Team Edition
they go through Mattermost's public test push server. When enabled, notification contents are set
to the generic form without message text. They are off unless the owner says yes. The exact
settings are verified on a dev office during implementation.

### 6. Docs

- README: a "Reach it from the internet" section next to "Run it on a home server": the dashboard
  steps, the mobile app, MFA, remote git over HTTPS, optional Cloudflare Access for the git
  hostname.
- `SECURITY.md`: public exposure is supported in `cloudflare` mode only, with the accepted risk
  from this spec. Binding to a public address directly stays out of scope.
- `infra/.env.example` and the `office-infra` skill: the new variables, the profile and the
  invariant that defaults must render the old config.

## Testing

- Unit, `test/home-server.test.ts`: `publicUrlsFor` and `applyAccessMode` for the new mode
  (URLs, token and hardening variables written, LAN override removed, variables removed when
  leaving the mode), hostname validation, `composeFileArgs` adding the profile only when the
  token is set.
- Render check: `docker compose config` for an `.env` without the new variables equals the
  output before this change, for a normal and a dev instance.
- Dev office: the two checks in section 4, with the hardening variables set by hand through the
  same function the wizard calls.
- Manual, by the owner on their own office: the wizard end-to-end with a real tunnel, login from
  a browser and from the iOS app, a `git clone` over HTTPS. This is the one check a dev office
  cannot cover (`office setup` refuses on a dev instance, and a real tunnel needs the owner's
  Cloudflare account and domain), so the owner runs it, never an agent, after the dev-office
  checks above pass.
- `npm run check` passes.

## Out of scope

- Cloudflare Access, WAF rules or any call to the Cloudflare API.
- Other tunnel or reverse-proxy providers.
- Coolify as a deployment target.
- Git over SSH from outside.
- A mail server (password reset stays a CLI command).
