# Task C report — delivery policy, guards and transcript rendering

Date: 2026-09-25. Files delivered (only these were touched):

* `src/mcp/policy.ts` — delivery policy + guards (pure logic, no I/O)
* `src/lib/transcript.ts` — Claude Code project slugs, session lookup, JSONL parsing, compact rendering
* `test/policy.test.ts`, `test/transcript.test.ts` — 40 vitest cases
* `docs/research/policy-notes.md` — this report

`src/lib/types.ts` was **not** modified. One additive extension lives in `policy.ts` itself, see "Open issues".

## 1. What was built

### `src/mcp/policy.ts` (design.md §4.4 / §4.5)

| Export | Behaviour |
|---|---|
| `AgentContext` | username/userId, humanUsernames, agentChannelPrefix, per-channel `watch` + `defaultWatch`, `participatedThreads` (root ids **and** our own post ids, added by the caller) |
| `channelTypeOf(name, mmType, prefix)` | `mmType` `D`/`G` → `dm`; name starts with prefix → `agent-only`; else `mixed` |
| `classifyPost(ctx, post, meta)` | own posts → `null`; empty message or `system_*` type → `null`; then DM → `dm`; mention (mention user id, `@<username>` as a word, `@all`/`@channel`/`@here` **from a human**) → `mention`; `rootId` ∈ `participatedThreads` → `thread`; else watch mode `all` → `channel`, `digest` → `digest-item`, `mentions` → `null`. `id = mm:<post_id>`, `at` = ISO of `createAt`, `threadId = rootId ?? id`, `fromHuman` = username ∈ `humanUsernames` (so human posts in `ag-*` channels keep their kind and render as owner FYI) |
| `DeliveryQueue` | `push` (dedupe by id, remembers the last 2000 ids), `hasImmediate`, `takeImmediate` (non-digest events, sorted by `at`), `digestDue`, `takeDigest`, `setFrozen`, `stats` |
| `renderEvents(agent, events)` | exact `<office-events …>` format from the spec, incl. the closing instruction line, attribute/text escaping and 4000-char text truncation with `…[truncated, use chat_thread/chat_read]`; human posts in agent-only channels get `note="owner FYI in agent-only channel"`; ticket events use `repo/number/title/url/reason` |
| `renderDigest(agent, items)` | `<office-digest … since="…">`, grouped per channel (`#channel (k new)`), `- [HH:MM] from: first 200 chars (post_id=…)` (HH:MM is UTC), closing line about ignoring the digest / replying via `chat_reply` |
| `isAckOnly(text)` | ≤ 60 chars after stripping mentions/emoji/punctuation; vocabulary of thanks/ok/got it/sounds good/will do/on it/… + `köszi`/`oké`; emoji-only posts count as ack, punctuation-only ones do not |
| `PostGuard` | `check({text, channelType, threadAuthors?, frozen?})` → `{ok:true}` or `{ok:false, reason}`; `record(text)` after a successful post |

Guard order and reason strings (all one-liners an LLM can act on):

1. frozen → `office is frozen: only the human may post; wait for the unfreeze`
2. empty → `empty message: write something, or react with chat_react`
3. ack-only → `ack-only message: use chat_react instead`
4. duplicate of the last `duplicateWindow` accepted texts (whitespace-normalised, case-insensitive) → `duplicate of one of your last N posts: rephrase or add new information`
5. sliding-window rate, per minute then per hour → `rate limit N/min reached: retry in Xs` / `rate limit N/hour reached: retry in Xs` (X = seconds until the oldest post leaves the window)
6. trailing consecutive agent posts in `threadAuthors` ≥ cap (`agentThreadCapAgentOnly` for `agent-only`, `agentThreadCapMixed` for `mixed` **and** `dm`) → `thread cap reached: summarise the state into a ticket (ticket_create) or ask the human`

Decisions where the spec left a choice (all unit-tested):

* **Digest cadence**: `digestDue()` is true when digest items exist and ≥ `digestMinutes` elapsed since the **last digest taken**; the very first digest is anchored on the arrival of the first item. This makes digests fire on a fixed period while anything is pending.
* **Freeze**: `setFrozen(true)` both refuses non-human events at `push` time **and** purges already-queued non-human events (counted in `stats().droppedFrozen`), so nothing agent-authored is delivered while frozen.
* `stats()` shape: `{immediate, digest, duplicates, droppedFrozen, digestsTaken}`.
* Digest text is escaped (`&`, `<`, `>`) like `renderEvents` text.

### `src/lib/transcript.ts`

| Export | Behaviour |
|---|---|
| `claudeProjectsDir()` | `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects` |
| `claudeProjectSlug(cwd)` | every char outside `[a-zA-Z0-9]` → `-` (so `/`→`-`, `.`→`-`, `_`→`-`, a literal `-` stays, a leading `/` becomes the leading `-`); slugs longer than 200 chars are cut to 200 + `-` + base-36 of `\|hash(cwd)\|` (int32 `31*h+c`) |
| `claudeSessionFile(cwd, sessionId)` | `<projects>/<slug>/<sessionId>.jsonl` |
| `findClaudeSessionFile(sessionId)` | scans all project dirs (sorted), returns the path or `undefined` |
| `readClaudeTranscript(file)` | parses session JSONL into `TranscriptEntry[]` |
| `renderTranscript(entries, opts?)` | compact `USER:` / `ASSISTANT:` text with `  ↳ tool Name(input…) ⇒ result…`; over `maxChars` keeps the head (first 20% of entries) and the tail with `… [N entries omitted] …` |

Parsing rules (derived from real transcripts, see §2): only `type: user|assistant` lines with `message.content` are kept; `isMeta`, `isSidechain`, `isApiErrorMessage` and non-conversation lines (`attachment`, `system`, `summary`, `file-history-snapshot`, `mode`, …) are skipped; streamed assistant blocks sharing `message.id` are merged into one entry (thinking dropped); `tool_use` + matching `tool_result` (by id) fold into the assistant entry's `tools` (input JSON-stringified, result text extracted, `is_error` → `isError`); user lines that only carry `tool_result` are folded, `<system-reminder>` blocks are stripped from text; timestamps kept in `at`. Entries with no text and no tools are dropped.

Render defaults: `maxChars=20000`, `toolInputChars=200`, `toolResultChars=400`; errors render as `⇒ error: …`, missing results as `⇒ (no result)`.

## 2. Slug rule — how it was derived

Empirical (read-only) against `~/.claude/projects`:

* 39 project dirs whose transcripts record a `cwd`: **39/39** match `cwd.replace(/[^a-zA-Z0-9]/g, '-')`.
* 84 distinct `cwd` values observed across all transcripts: **40** of them map onto an existing project dir (the rest are sub-cds of sessions launched elsewhere), and all 40 match.
* Confirmed examples baked into `test/transcript.test.ts`:
  * `/home/owner/workspace/agent-office` ↔ `-home-owner-workspace-agent-office`
  * `/tmp/claude-1234/-home-owner-workspace-agent-office/a1b2c3d4-…/scratchpad/spike/ws1` ↔ `-tmp-claude-1234--home-owner-workspace-agent-office-a1b2c3d4-…-scratchpad-spike-ws1` (leading `/` → `-`, inner `/-…` → `--…`)
  * `/home/owner/workspace/example-project` ↔ `-home-owner-workspace-example-project` (`_` → `-`)
  * `/home/owner/workspace/example-org/repositories/example-app/.worktrees/feature-frontend-design` ↔ `…example-app--worktrees-feature-frontend-design` (`.` → `-`)
  * `…/pr679_requirements_coverage_retry2/move_rotate_resize_single_element` ↔ `…pr679-requirements-coverage-retry2-move-rotate-resize-single-element` (`_` and `/` both → `-`)

Cross-checked in the installed Claude CLI binary (`~/.local/share/claude/versions/2.1.282`): `function k(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}` and `function cx(e){let n=k(e);if(n.length<=200)return n;return n.slice(0,200)+"-"+Le(e)}` with `Le = Math.abs(yX(e)).toString(36)` and `yX` the `31*h+c` int32 hash — i.e. the same rule including the 200-char cap implemented here.

## 3. How to use it

```ts
import { classifyPost, DeliveryQueue, renderEvents, renderDigest, PostGuard, channelTypeOf } from './src/mcp/policy.js'
import { claudeSessionFile, readClaudeTranscript, renderTranscript } from './src/lib/transcript.js'
```

Typical listener loop: `channelTypeOf` → `classifyPost` → `queue.push`; on wake, if `hasImmediate()` deliver `renderEvents(name, takeImmediate())`; when `digestDue()` deliver `renderDigest(name, takeDigest())`; wrap `PostGuard.check` before every `chat_post`/`chat_reply` and call `record(text)` on success. For merge: `renderTranscript(readClaudeTranscript(claudeSessionFile(cwd, sessionId)))`.

## 4. Verification (commands actually run)

```
$ npx vitest run test/policy.test.ts test/transcript.test.ts
 Test Files  2 passed (2)
      Tests  40 passed (40)
```

```
$ npx tsc --ignoreConfig --noEmit --strict --module NodeNext --moduleResolution NodeNext \
    --target ES2022 --esModuleInterop --skipLibCheck --types node \
    src/mcp/policy.ts src/lib/transcript.ts test/policy.test.ts test/transcript.test.ts
typecheck clean
```

Read-only sanity run of the real parser against live `~/.claude` data (scratch script in `/tmp/opencode/verify-transcript.ts`):

```
slug check: 39/39 first-line cwd pairs match
slug check: 40/84 observed cwds map to an existing project dir (rest ran in other dirs)
11111111-…-ws1.jsonl: 2 entries, 0 tools (0 with results)      # spike session: USER prompt + "PONG"
36b53ef6-….jsonl: 25 entries, 27 tools (27 with results)        # 32MB-ish real session, all tools folded
findClaudeSessionFile: found exact path
missing session -> undefined
```

## 5. Open issues / notes

* **One additive type**: `classifyPost` takes `meta: { mentions, channelType, channelName, postType? }`. The spec requires rejecting Mattermost `system_*` posts, but `ChatPost` in `types.ts` carries no post type; the optional `postType` field is the minimal local extension (no change to `types.ts`). Callers that cannot supply it still work (empty message check remains).
* Repo-wide `npx tsc --noEmit` currently reports errors in `src/cli/office.ts`, `src/lib/harness/opencode.ts` and `src/mcp/server.ts` (other agents' in-flight files, mostly a sync/async config-loader mismatch). None of the errors are in Task C files; those were type-checked in isolation (command above).
* `renderTranscript` keeps whole entries, so output can slightly exceed `maxChars` when a single entry (e.g. the first 20% head) is larger than the budget; it never cuts mid-entry.
* `isAckOnly`'s vocabulary is intentionally small (see `ACK_WORDS`/`ACK_PHRASES`); "and similar" wording is open to tuning once live traffic is observed.
* `PostGuard` counts the thread cap from `threadAuthors` passed by the caller — the caller must include the agent's own earlier posts in that list (they are agent-authored, so they count).
* Digest `HH:MM` timestamps are UTC (parsed from the event `at`); if local wall-clock is preferred for the human's timezone, that is a one-line change in `renderDigest`.
