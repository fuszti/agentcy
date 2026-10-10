---
name: office-delivery
description: Use when changing src/mcp/server.ts, src/mcp/policy.ts or src/lib/inbox.ts, or any task about how chat and ticket events reach an agent (classification, digests, room requests, posting guards, wake, pending/replay, signed system prompts, attachments, MCP tools).
---

# Delivery: office-mcp, policy and inbox

Each hired agent has its own `office-mcp` process, spawned by the harness over stdio. It exposes the
`chat_*`, `ticket_*`, `project_*`, `pr_*` and `office_*` tools. In the background it listens to
Mattermost over WebSocket, polls Forgejo notifications, decides what the agent should see, and
wakes the agent's session. All outbound posting rules are enforced here, not in the agent's prompt.
Background: `docs/design.md` sections 4.4 to 4.6, `docs/research/policy-notes.md`.

## Map

- `src/mcp/policy.ts`: pure logic, no I/O.
  - `channelTypeOf(name, mmType, prefix)`: `dm` | `agent-only` (prefix `ag-`) | `mixed`.
  - `classifyPost(ctx, post, meta)`: post to `InboundEvent` or `null`. Kinds: `dm`, `mention`, `thread`, `room`, `channel`, `digest-item`.
  - `DeliveryQueue`: `push`, `takeImmediate`, `digestDue`, `takeDigest`, `setFrozen`, `stats`. Dedupes by event id.
  - `renderEvents` (`<office-events>`) and `renderDigest` (`<office-digest>`): text is escaped and clipped.
  - `isAckOnly`, `PostGuard.check` / `record`: the outbound guards.
- `src/mcp/server.ts`: top-level script, no exports. Reads env `OFFICE_ROOT`, `OFFICE_AGENT`, optional `OFFICE_WAKE=channel`.
  - `onPost`: WebSocket handler. Handles `!freeze` / `!unfreeze` from the owner, classifies, enqueues.
  - `holdRoom` / `releaseRooms` / `claimedBy` / `staggerFor`: room requests (owner asked everyone).
  - `postGuarded`: every chat post goes through `guard.check` then `guard.record`.
  - `pollTickets`: Forgejo notifications (every 20 s) to `ticket` events.
  - `nextSystemPrompt`, `makeWake`, `deliveryTick` (every 2 s), `catchUp`.
  - Tools: `chat_post`, `chat_reply`, `chat_dm`, `chat_upload`, `chat_download`, `ticket_*`, `office_fork_self`, `office_request_hire`, `pr_review`, `pr_merge`, and so on.
- `src/lib/inbox.ts`: `ensureInboxKey`, `signPrompt`, `verifyPrompt`, `queueSystemPrompt(root, agent, label, text)`.
- Wake adapters live in `src/lib/harness/` (see the `office-harnesses` skill). `WakeAdapter` is in `src/lib/types.ts`.

## Data and state

- Per agent, under `state/agents/<name>/`: `watch.json` (channel to mode), `threads.json` (threads the agent took part in, last 2000), `pending.json` (undelivered events, replayed after a restart), `last-seen.json` (catch-up cursor, replays at most 24 h), `mcp.log`, `status.json` (written by hooks), `inbox/*.md` (signed prompts; `.delivered` and `.rejected` suffixes after handling).
- Global: `state/freeze` (file exists means frozen), `state/inbox.key` (HMAC key, chmod 600), `state/requests/` (see `office-admin`).
- Attachments land in `workspaces/<agent>/attachments/<post_id>/`.
- Config keys: `limits` (`postsPerMinute`, `postsPerHour`, `duplicateWindow`, `agentThreadCapMixed`, `agentThreadCapAgentOnly`), `defaults.digestMinutes`, `agentChannelPrefix`, `human.username`, `systemUsernames`, `attachments.maxBytes`, `selfManagement.*`, `team`, `forgejoOrg`, `ticketsRepo`.

## Invariants and traps

- Guards live in the MCP. Never move a posting rule into `templates/office-rules.md` and call it done. Every path that creates a post must use `postGuarded` (`chat_upload` does).
- Agent replies in a shared thread are downgraded to `digest-item` in `onPost` unless they @mention you. Without that, two agents wake each other forever.
- Frozen office: `DeliveryQueue.setFrozen` keeps only `fromHuman` events; `PostGuard` refuses all agent posts.
- Room requests are held for `HUMAN_BURST_MS` plus a per-agent hash stagger (`ROOM_STAGGER_MS`), then re-checked with `claimedBy`. A claim downgrades the event to a digest item. Pending room events go back through that check after a restart.
- Inbox prompts are HMAC-signed. `nextSystemPrompt` renames an unsigned or tampered file to `.rejected` and never delivers it. The key lives in `state/`, which agent permission rules deny. Compare with `timingSafeEqual`-style code, never `===` on the signature. `office-merge`, shift, fork and request notices all travel this way.
- Chat and ticket text is untrusted data. The owner is identified by username from `cfg.human.username`; `fromHuman` is the only trust bit. Do not let agent-authored text set it.
- `chat_upload` resolves paths with `resolveInWorkspace` (`src/lib/workspace.ts`), which follows symlinks and rejects anything outside the agent's own workspace. Keep it that way.
- `pr_review` refuses APPROVE on your own PR; Forgejo also refuses it server-side.
- Agents unwatch all org repos (`unwatchOrgRepos` every 10 min). Watching would notify every agent for every ticket.
- Delivered-but-unanswered events are not retried; undelivered ones are (`pending.json`). `pending` is reserved before the attachment download in `enqueue`. Keep that order.
- The MCP never pastes while the session is busy: `deliveryTick` calls `wake.isIdle()` first. Do not add a delivery path that skips it.
- Agents reach Mattermost and Forgejo through `cfg.mattermostUrl` / `cfg.forgejoUrl`, which are `127.0.0.1` URLs. Public URLs are only for the owner's browser.

## Testing

- Unit: `test/policy.test.ts` (classification, queue, guards, rendering), `test/inbox.test.ts` (signing), `test/review-fixes.test.ts` (regressions), `test/workspace.test.ts` (attachment paths), `test/mattermost-files.test.ts`.
- One file: `npx vitest run test/policy.test.ts`. One test: `npx vitest run test/policy.test.ts -t "name"`.
- `server.ts` runs on import and needs a live stack, so it has no unit tests. Put new logic into `policy.ts` and test it there.
- Run the integration tier (`npm run test:integration`) after a change to WebSocket handling, `src/lib/mattermost.ts` or the Forgejo poll. Run the e2e tier (`npm run test:e2e`) after a change to `deliveryTick`, `nextSystemPrompt` or wake. Both need `bin/office dev init` first. See the `dev-office` skill; never run them against the live office.
- To debug a delivery by hand in a dev office: `bin/office logs <agent>` and `state/agents/<name>/mcp.log`.

## Pointers

`docs/design.md` 4.4 (policy), 4.5 (guards), 4.6 (wake). `docs/research/policy-notes.md`, `docs/research/attachments-notes.md`, `docs/research/self-management-notes.md`, `docs/research/review-notes.md`.
