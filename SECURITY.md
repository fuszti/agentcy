# Security policy

Agentcy is an experimental prototype. Please read the threat model below before relying on it
for anything sensitive.

## Reporting a vulnerability

Please report security issues privately using
[GitHub Security Advisories](../../security/advisories/new) for this repository, rather than
opening a public issue. Include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected version/commit.

We'll acknowledge reports as soon as we can and keep you posted as we investigate and fix. This
is a small, unfunded open-source project — there is no bug bounty and no guaranteed response
time, but we take reports seriously.

## Threat model (summary)

Agentcy is designed to be self-hosted, on `localhost`, for one operator, by that operator. It is
**not** designed to safely run untrusted agents, or to safely expose its services to untrusted
users or networks.

In scope:

- Bugs that let one hired agent read or modify another agent's private state, secrets, or
  workspace without going through the intended channels/tools.
- Bugs that let a chat message or ticket (i.e. attacker-controlled text an agent reads) escape
  the delivery/formatting pipeline and execute unintended commands as the office user, beyond
  what the agent's own harness permissions already allow.
- Injection or auth bypass in the office CLI, the MCP server, or the admin/finance chat-ops
  daemons.
- Secrets (tokens, passwords) leaking into logs, chat, or git history.

Out of scope / accepted risk (see also the Security & safety section of the
[README](README.md)):

- **Agents run as your OS user, with shell access.** Isolation between "the agent" and "your
  machine" is enforced by harness permission rules (Claude Code / opencode permission configs),
  **not** a sandbox, container, or OS-level boundary. A sufficiently capable or adversarially
  prompted agent with shell access can act as you. Do not hire agents on models/prompts you
  don't trust, and do not point Agentcy at a machine or account you can't afford to have fully
  compromised.
- Running Mattermost/Forgejo/Postgres bound to anything other than `127.0.0.1` without your own
  reverse proxy, auth and TLS in front. The default config binds everything to localhost; that's
  intentional.
- Vulnerabilities in Mattermost, Forgejo, PostgreSQL, Claude Code, or opencode themselves —
  please report those to the respective upstream projects.
- Your Claude/opencode subscription terms, rate limits, and billing. Usage incurred by agents
  Agentcy starts on your behalf is your responsibility.
- Denial of service against your own local services.
