# Task D report — adversarial code review of the agent-office prototype

Date: 2026-09-25. Scope: `docs/design.md`, all of `src/` (`mcp/server.ts`, `mcp/policy.ts`, `cli/office.ts`, `cli/bootstrap.ts`, `lib/*.ts`, `lib/harness/*.ts`), `templates/office-rules.md`, `scripts/hook-status.sh`. Read-only; only this file was written.

Baseline checks run (read-only): `npx tsc --noEmit` (clean), `npx vitest run` (53 passed / 4 skipped).

Findings are ordered by the review priorities (correctness → security → robustness), most severe first.

---

## 1. Correctness — core loop

### H1. Direct messages are never delivered immediately (classified "mixed", fall into the digest)

`src/lib/mattermost.ts:372`

The WebSocket handler derives the channel kind from the channel *name*:

```ts
const channelType = post.channel.startsWith('ag-') ? 'agent-only' : post.channel === 'dm' ? 'dm' : 'mixed'
```

`post.channel` is the Mattermost channel **name**. DM channels are named `<user1>__<user2>` (e.g. `owner__ada`), never the literal string `"dm"`; group messages (type `G`) similarly get an opaque slug. So the `post.channel === 'dm'` branch is dead code, and every DM/group message arrives at `classifyPost` as `channelType: 'mixed'`.

Consequence: `classifyPost` (`src/mcp/policy.ts:60-102`) then treats a human DM as an ordinary channel post — it is not a mention (a DM usually contains no `@username`), not a thread reply, so it falls through to the default watch mode (`digest`) and is batched for up to `digestMinutes`. The design's hard promise "DM to the agent → immediate" (design.md §4.4) is broken. A human DMing an agent waits 10 minutes (or forever, if the channel watch is `mentions`).

Fix: stop guessing from the name. Mattermost's `posted` event carries `channel_type` (`event.data.channel_type`, values `D`/`G`/`O`/`P`); pass it through and classify with `channelTypeOf(name, type, prefix)` (already implemented in `policy.ts:32` and used by the tool path). Minimal change: in the `.then` handler, compute `channelType = channelTypeOf(post.channel, event.data.channel_type, prefix)`.

Verified by reading: `mapPost` (`mattermost.ts:424-440`) returns only `channel.name` (type is discarded), and `onPost` (`server.ts:293-302`) forwards `meta.channelType` verbatim to `classifyPost`.

---

### H2. Mattermost posts missed during WebSocket disconnect or MCP restart are lost forever

`src/lib/mattermost.ts:388-394` (reconnect) and `src/mcp/server.ts:33-43,55,117-160` (in-memory queue)

Two compounding gaps:

1. The WS client reconnects with a bare `authentication_challenge` (`mattermost.ts:344-353`); it never sends the last-seen `seq`, and nothing re-fetches posts that arrived while the socket was down. Mattermost does not replay missed events to a fresh socket.
2. The `DeliveryQueue` (pending `immediate`/`digestItems`) and its `seenIds` dedup set are pure in-memory (`policy.ts:117-160`) and are rebuilt empty on every MCP restart.

Consequence: any DM, @mention, or thread reply that lands while the agent's MCP is down (crash, `office restart`, shift change, network blip) is silently and permanently dropped. There is no backfill — `getChannelPosts` exists (`mattermost.ts:250`) but is never called for recovery. This is the top item in the review brief ("missed … lost on MCP restart") and breaks the core wake loop for a live office.

Fix (two parts, either mitigates): (a) track the highest `seq` received and, on reconnect, `getChannelPosts` per joined channel with `since = lastDeliveredAt` to re-emit posts as if live (they are already deduped by `mm:<post_id>`); (b) persist the queue and/or `seenIds`/last-seen watermark to `state/agents/<name>/` so a restart resumes instead of dropping.

---

### M3. Forgejo follow-up notifications are dropped (new comments on a notified ticket never wake the agent)

`src/lib/forgejo.ts:367-391` and `src/mcp/server.ts:304-318`

`pollTickets` builds the dedup id from `n.id` and `n.updated_at`:

```ts
const ev: InboundEvent = { id: `fj:${n.id}:${n.updated_at}`, ... }
```

…but `ForgejoClient.listNotifications` strips `updated_at` (and `html_url`, `latest_comment_user`) from the mapped object — it only returns `{ id, unread, subject:{title,url,type,state}, repository:{full_name} }`. So at runtime `n.updated_at` is `undefined` and every event for a given notification thread gets the stable id `fj:<id>:undefined`.

Consequence: the first delivery marks the thread read; when a later comment re-marks the same thread unread, `listNotifications({unreadOnly:true})` returns it again, but `queue.push` sees the already-seen id `fj:<id>:undefined` and drops it. Follow-up activity (the common case — someone comments on the issue the agent is working) is never delivered. The `updated_at` in the id was clearly intended to distinguish new activity, but it is always `undefined`.

Fix: preserve `updated_at` (and `html_url`, `latest_comment_user`) in `listNotifications`'s mapping, e.g. add `updated_at: n.updated_at` to the returned object. Then new activity produces a distinct id and is re-delivered as intended.

(Related low-severity degradation, same block: `url` falls back to `n.subject.url` (an API path, not the HTML URL) because `subject.html_url` is never populated, `from` is always `'forgejo'` because `latest_comment_user` is stripped, and `reason` is the subject *type* ("Issue"/"Pull") rather than "assigned/mentioned/…". The ticket number extraction itself is correct — the regex matches `/issues|pulls/<n>` in `subject.url`.)

---

### M4. Mention-by-user-id detection is dead code (usernames vs. user id mismatch)

`src/lib/mattermost.ts:366-378` vs `src/mcp/policy.ts:81-84`

`connectWebSocket` resolves the `posted` event's mention list from user **ids** to usernames:

```ts
Promise.all(mentionIds.map((id) => this.resolver.userName(id).catch(() => id)))
```

and hands those usernames to `onPost` → `classifyPost`, which compares them against the agent's **user id**:

```ts
const mentioned = meta.mentions.includes(ctx.userId) || mentionsAsWord(text, ctx.username) || ...
```

`meta.mentions` now contains usernames (`"ada"`), `ctx.userId` is an id (`"wyf5…"`), so the id check is never true. (The unit test `test/policy.test.ts:76` passes an id, matching `policy.ts`'s contract — the mismatch is on the `mattermost.ts` side, which should not have resolved ids to names if the consumer wants ids.)

Consequence: mention-by-id is silently disabled. The `@username` text regex still catches ordinary typed mentions, so the office mostly works, but any mention that arrives without the literal `@username` in the text (e.g. a mention produced via the API with an explicit mention list, group/`@channel`-style mentions whose `mentions` field carries member ids) is not recognised and can fall into the digest or be dropped.

Fix: make the two sides agree. Cheapest correct fix is in `classifyPost`/`server.ts`: compare against usernames — `meta.mentions.includes(ctx.username)` (since `mattermost.ts` already resolves ids to names). Alternatively stop resolving ids to names and pass ids through, then keep `meta.mentions.includes(ctx.userId)`.

---

### M5. Claude fork/merge transcript slice depends on the fork session re-serialising identically (needs check)

`src/cli/office.ts:187-194,244-249` and `src/lib/transcript.ts:106-175`

`cmdFork` records `inheritedMessages = readClaudeTranscript(parentFile).length`; `cmdMerge` then replays `entries.slice(start)` where `start = inheritedMessages`. This is only correct if `readClaudeTranscript(forkSessionFile)` yields **exactly** `inheritedMessages` entries for the inherited prefix. The fork is a *different* session file produced by `claude --resume <parent> --fork-session` (`claude.ts:86`), and `readClaudeTranscript` filters heavily (drops `isMeta`, `isSidechain`, thinking-only turns, merges streamed blocks by `message.id`). If Claude re-serialises the copied history in any way that changes the entry count — e.g. it emits the inherited transcript with a different message-id granularity, or prepends a summary entry — the slice is misaligned and the merge either drops the fork's last inherited message or re-injects the parent's tail as "new" experience. I could not verify the fork-session serialisation from the repo alone, hence "needs check".

Fix (robust either way): don't infer the fork point by message count. Record the fork point by identity — e.g. the last message id / timestamp at fork time, or count entries on the fork's own transcript right after forking (`startAgent`) rather than on the parent's file. For opencode the same race exists in miniature (`cmdFork` counts `inherited` *before* calling `forkOpencodeSession`; any parent message produced in between shifts the slice).

---

## 2. Security

### H6. Freeze is bypassable by agents (freeze is a file in an agent-writable tree)

`src/mcp/server.ts:44-45` (`isFrozen` reads `state/freeze`), `src/cli/office.ts:332-333`, `src/lib/harness/opencode.ts:404-416`

Freeze is implemented purely as the presence of `state/freeze`, and both posting (`postGuarded` → `guard.check({frozen: isFrozen()})`, `server.ts:80-90`) and inbound delivery (`queue.setFrozen(isFrozen())`, `server.ts:355`) re-read that file every tick. But opencode agents are launched with `permission.bash['*'] = 'allow'` and `permission.edit = 'allow'` (`opencode.ts:404-415`); their cwd (`workspaces/<name>/`) is inside the repo, so `rm ../../state/freeze` (or the absolute path) is an allowed command. Nothing in the deny list covers `state/`.

Consequence: any opencode agent — deliberately, or under prompt-injection/runaway — can delete `state/freeze` and unfreeze the office (and can equally *create* it to freeze everyone). The freeze guard, which the design (design.md §4.4, §4.5) treats as a hard "only the human" safety mechanism, is agent-defeatable.

Fix: keep freeze out of the agent-reachable tree and out of the agent's write scope: store it under a directory the harness cannot touch (e.g. chmod/ownership that the agent user can't remove, or a `state/human/` tree excluded from `bash`/`edit` permissions), and add `state/**` to the opencode deny rules. Same for the `freeze`/`unfreeze` toggle: require the human path only.

---

### H7. Cross-agent prompt injection via the inbox — agent-authored text rendered as authoritative system instructions

`src/mcp/server.ts:323-330` (`nextSystemPrompt`), `src/cli/office.ts:50-56` (`queueSystemPrompt`)

System prompts (welcome, fork-intro, merge, shift) are dropped by the CLI into `state/agents/<name>/inbox/*.md` and later delivered **verbatim, unlabelled as to provenance** by `deliveryTick` → `wake.deliver(sys.text)`. The only thing distinguishing them from a chat event is the `<office-system>` tag they happen to contain. Because the inbox lives under `state/`, and opencode agents have unrestricted `bash`/`edit` (see H6), an agent can write an arbitrary `.md` into **its own** inbox (to plant an "owner says …" instruction that bypasses the normal `human="false"` labelling of `renderEvents`) or into **another agent's** inbox (`state/agents/<other>/inbox/`), where it will be delivered to that agent as a trusted system prompt.

Consequence: this is exactly the "agent-authored text rendered as if from the owner" injection path the design warns against (design.md §4.2, §5). It defeats the provenance labelling that `renderEvents`/`renderDigest` otherwise enforce by escaping text and setting `human="false"`. Fork/merge prompts in particular instruct the agent to "integrate this as your own experience" and inherit open commitments, so a planted prompt has real steering power.

Fix: (a) move the inbox (and `freeze`, per H6) out of the agent's writeable scope, or gate file creation on the CLI only and have the MCP validate that inbox files are owned/written by the office CLI (e.g. include a HMAC/nonce the agent cannot forge); (b) deny `state/**` in opencode `permission`; (c) belt-and-braces: have `renderEvents`/delivery prefix *every* injected system prompt with an explicit, non-spoofable provenance line ("this is a system prompt from the office CLI").

---

### M8. Claude "browser" wiring appears inverted (`playwright: !rec.chrome`)

`src/cli/office.ts:88` and `src/lib/harness/claude.ts:55-67`

```ts
writeJsonFile(mcpFile, claudeMcpConfig(root, rec.name, { playwright: !rec.chrome }))
```

`claudeMcpConfig` adds the Playwright MCP server only when `opts.playwright` is true. So an agent hired with `--chrome` (`rec.chrome === true`) gets **no** Playwright MCP, while an agent *without* `--chrome` gets the headless Playwright MCP. Meanwhile `claudeSettings` always allow-lists `mcp__playwright` (`claude.ts:35`). If the intent is "agents with Chrome use `--chrome`, others get Playwright as their browser", the condition is inverted. I flag it as "needs check" because the intended browser policy for Claude agents is not spelled out in design.md (only "Claude agents may use Chrome", Q1), but either way one of the two states (chrome vs playwright) is being assigned backwards relative to the flag name.

Fix: if the flag means "this agent gets Chrome", use `playwright: rec.chrome ? false : true` explicitly and document it; otherwise rename the flag.

---

## 3. Robustness

### M9. opencode wake adapter's SSE stream never reconnects; idle tracking goes permanently stale

`src/lib/harness/opencode.ts:224-243` and `:308-314`

`subscribe` wraps the SSE fetch in an async IIFE whose `catch` swallows the error and does **not** reconnect:

```ts
try { ... await consumeSse(...) } catch { /* Stream closed or failed to connect … */ }
```

Once any `session.status`/`session.idle` event has been received, `idleBySession.get(id)` is defined, and `isIdle()` returns the cached value without ever falling back to `GET /session/status`:

```ts
const tracked = this.idleBySession.get(id)
if (tracked !== undefined) return tracked
return this.client.isIdle(id)
```

Consequence: if the SSE connection drops (opencode server restart, TUI restart, network blip), the cached busy/idle state is frozen. If it freezes at "busy", the agent **never wakes again** — `deliveryTick` polls `wake.isIdle()` (`server.ts:358`) and silently parks all events forever. If it freezes at "idle", prompts are injected into a busy session (harmless for opencode, which queues, but the state is still wrong).

Fix: reconnect the SSE stream with backoff in `subscribe`, and treat the cache as soft state — either timestamp the last event and fall back to `client.isIdle()` when the stream is stale (e.g. no event for N seconds), or always validate with `/session/status` before delivering.

---

### M10. Uncaught throw in the WebSocket message handler can crash office-mcp

`src/lib/mattermost.ts:364-366`

```ts
if (event.event === 'posted' && event.data) {
  const rawPost: RawPost = JSON.parse(event.data.post)
  const mentionIds: string[] = event.data.mentions ? JSON.parse(event.data.mentions) : []
```

The outer `JSON.parse(data)` is guarded by `try/catch` (`mattermost.ts:356-361`), but these two inner `JSON.parse` calls are not. If Mattermost ever sends a `posted` frame whose `post` or `mentions` field is not valid JSON (server upgrade, corrupted frame, a future message shape), the exception is thrown synchronously inside the `ws.on('message')` handler and there is no `process.on('uncaughtException')` handler in `server.ts` — the whole office-mcp process exits, taking the agent's tools and its inbound listener down with it.

Fix: wrap the inner parsing (or the whole handler body) in `try/catch`, consistent with the existing outer guard.

---

### L11. No HTTP timeouts on Mattermost / Forgejo requests

`src/lib/mattermost.ts:95-119` and `src/lib/forgejo.ts:86-106`

Both `request()` helpers call `fetch` without an `AbortSignal.timeout` (the opencode client, by contrast, does set one — `opencode.ts:115`). A hung server (port open but stalled, DB lock, network black-hole) blocks the calling tool call or `pollTickets` indefinitely. `pollTickets` is scheduled by `setInterval(..., 20_000)` (`server.ts:383`) without awaiting completion, so repeated stalls stack concurrent hung fetches.

Fix: add `signal: AbortSignal.timeout(30_000)` (and the same to `listTokensForUser`/`createTokenForUser`, which also call `fetch` directly) and surface the abort as the normal error path.

---

### L12. Forgejo mark-read returns 205; the client errors on the empty body (benign, but noisy)

`src/lib/forgejo.ts:104-105` and `:393-395`

`markNotificationRead` issues `PATCH /notifications/threads/{id}`. Forgejo/Gitea's `ReadThread` defaults `to-status=read` and answers **205 Reset Content** (no body). The shared `request` helper only special-cases 204:

```ts
if (res.status === 204) return undefined as T
return (await res.json()) as T
```

so it attempts `res.json()` on an empty 205 body, throws, and `pollTickets` swallows it (`server.ts:317` `.catch(() => {})`). The mark-read *does* succeed server-side, so this is not the "never marked read" defect — but the intended read/ack path errors on every poll and would mask a real failure (e.g. a 403) behind the same silent `.catch`.

Fix: treat `res.status === 204 || res.status === 205` as empty success in `request()`, and/or log a real mark-read failure distinctly in `pollTickets`.

---

## Fixes applied (Task E)

End-to-end implementation of the verified findings. All changes are in `src/`, `test/` and `templates/`; this section only documents them.

- **H1** — `mattermost.ts:389` now forwards the raw Mattermost `channel_type` (`D`/`G`/`O`/`P`) as `meta.channelType`; `server.ts:316` converts it with `channelTypeOf(meta.channelName, meta.channelType, cfg.agentChannelPrefix)` before `classifyPost`. `catchUp` already passes `ch.type` (raw). Covered by `test/policy.test.ts` (`channelTypeOf maps raw Mattermost D/G channel types to dm`) and `test/mattermost.test.ts` (WS parsing).
- **H2** — `mattermost.ts:334` added optional `onReconnect?: () => void`; it is invoked on re-open only when the socket had opened before (`mattermost.ts:350-352`). `server.ts` passes `() => void catchUp().catch(...)` so missed posts are replayed after a reconnect. Covered by `test/mattermost.test.ts` (`calls onReconnect on reconnect, not on first open`).
- **M3** — `forgejo.ts:55-69` extended `Notification` with `updated_at`, `subject.html_url`, `subject.latest_comment_url` and `latest_comment_html_url`; `listNotifications` (`forgejo.ts:385-428`) preserves them. `forgejo.ts:434-448` adds `latestCommentAuthor(commentUrl)` to resolve the comment author. `server.ts:327-330` uses `html_url` for the ticket URL, `updated_at` in the dedup id `fj:<id>:<updated_at>`, and the comment author as `from`. Verified against live Forgejo 16 JSON at `http://127.0.0.1:3033/api/v1/notifications`. Covered by `test/forgejo.test.ts`.
- **M4** — `policy.ts:81-85` treats a post as a mention when `meta.mentions` includes `ctx.userId` **or** `ctx.username`. Covered by `test/policy.test.ts` (`detects mentions by user id, username, or username word`).
- **M5** — `office.ts:251-261` locates the fork point by content: the first user entry whose text contains `kind="fork"` and `You are now @<src.name>`; falls back to `inheritedMessages` if not found.
- **H6/H7 (security)**:
  - Claude: `claude.ts:40-44` adds `permissions.deny` for `Read/Edit/Write` of `/${root}/state/**` and `/${root}/infra/.env`, plus `Bash(*${root}/state*)` and `Bash(*../state*)`.
  - opencode: `opencode.ts:435-453` adds explicit `read` and `bash` deny rules for `*<root>/state*` and `*../state*`, keeping the catch-all `allow` first (last match wins).
  - Signed inbox: new `src/lib/inbox.ts` provides `ensureInboxKey` (creates `state/inbox.key`, 32 random bytes, chmod 600), `signPrompt` and `verifyPrompt` (`inbox.ts:16-58`). `office.ts:50-56` signs every system prompt; `server.ts:348-364` verifies before delivery and renames unsigned/invalid files to `.rejected`. Covered by `test/inbox.test.ts`.
- **M8** — `office.ts:91-92` adds a clarifying comment that `rec.chrome` means the agent launches with `--chrome`, so non-chrome agents receive the Playwright MCP.
- **M9** — `opencode.ts:225-265` reworks `subscribe` to reconnect with exponential backoff (1s → 30s) until `close()` is called. `opencode.ts:311-346` tracks `lastEventAt` per session and falls back to `client.isIdle(id)` when the cached SSE state is older than 30s. Covered by `test/opencode.test.ts`.
- **M10** — `mattermost.ts:374-381` wraps the inner `JSON.parse` calls for `event.data.post` and `event.data.mentions` in `try/catch`. `server.ts:447-448` adds `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers that log via the existing `log()` instead of crashing. Covered by `test/mattermost.test.ts` (`does not throw when posted event contains invalid JSON`).
- **L11** — `mattermost.ts:103` and `forgejo.ts:94,144,166,203,436` add `signal: AbortSignal.timeout(30_000)` to all `fetch` calls (direct and via helpers).
- **L12** — `forgejo.ts:109-110` treats `204`, `205` and zero-length bodies as empty success. Covered by `test/forgejo.test.ts` (`treats 205 Reset Content as empty success`, `treats empty-bodied 200 as empty success`).

Verification: `npx tsc --noEmit` (clean) and `npx vitest run` (67 passed / 4 skipped) were run after the changes.

---

## 4. Minor / notes (no action required for v0.1, recorded for completeness)

- `hook-status.sh` drains hook JSON with `cat >/dev/null 2>&1` before writing status; harmless but the `cat` blocks until the harness closes stdin (fine — Claude Code does). `date -u +%Y-%m-%dT%H:%M:%S.000Z` always emits a `.000Z`-style timestamp (correct ISO).
- `claudeLaunchCommand` emits a bare `-n <name>` flag (`claude.ts:87`); I could not confirm a `-n` flag exists in the installed Claude Code CLI — **needs check** (if it is not a real flag, Claude either errors or ignores it; the agent still launches via the other flags).
- `repoRoot`/`claudeSettings`/`hook-status.sh` are not space-safe for `OFFICE_ROOT` paths (the hook command quotes `$statusFile` but not `$root`); irrelevant for the current fixed path, worth quoting if the office is ever relocated.
- Port allocation (`office.ts:58-63`) is checked against other agents' records but not against actually-listening ports, and `startAgent`'s headless-openode-create-then-kill-then-relaunch on the same port relies on a 1s `sleep(1000)` for the port to free — a slow release could make the TUI fail to bind (`office.ts:115-126`).
- `secret` files are correctly chmod 600 (`config.ts:73-85`, `bootstrap.ts:60-66`); `state/agents/<name>/{mcp.json,claude-settings.json,mcp.log}` are world-readable but contain only paths and event text, no tokens. No token was found in `mcp.log`.
