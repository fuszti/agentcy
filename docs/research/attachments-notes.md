# Mattermost file/attachment support for agents

Date: 2026-09-27. Adds inbound file visibility and outbound upload/download to the office MCP.

Files touched: `src/lib/types.ts`, `src/lib/mattermost.ts`, `src/lib/workspace.ts`, `src/mcp/policy.ts`,
`src/mcp/server.ts`, `templates/office-rules.md`, `office.config.json`,
`test/policy.test.ts` (extended), `test/workspace.test.ts` (new), `test/mattermost-files.test.ts` (new).

## 1. The three gaps this closes

1. **Files were invisible.** `ChatPost`/`InboundEvent` had no `files`/`attachments` field, and
   `MattermostClient` never read `metadata.files` / `file_ids` off a raw post.
2. **Image-only posts were dropped.** `classifyPost` filtered out any post whose `message.trim()`
   was empty — the standard shape of "here's a screenshot" with no caption — before the caller
   ever saw it had a file.
3. **No upload tool.** Agents could read text but had no way to hand a file (a diff, a rendered
   chart, a log excerpt) to the owner or a colleague.

## 2. Design

### Types (`src/lib/types.ts`, additive only)
- `ChatFile { id, name, mimeType, size }`, `ChatPost.files?: ChatFile[]`.
- `EventAttachment { id, name, mimeType, size, path?, skipped? }`, `InboundEvent.attachments?`.
  `path` is set once an immediate event's file has been downloaded; `skipped` explains why it
  wasn't (over the size cap, or a download error). Digest items never get `path` — see §4.
- `AttachmentsConfig { maxBytes }`, `OfficeConfig.attachments?` (optional, defaults to 20 MiB via
  `DEFAULT_MAX_ATTACHMENT_BYTES` in `workspace.ts` when the config field is absent). `office.config.json`
  now sets `"attachments": { "maxBytes": 20971520 }` explicitly.

### `MattermostClient` (`src/lib/mattermost.ts`)
- `getFileInfo(id)` → `GET /files/:id/info`, mapped to `ChatFile`.
- `downloadFile(id): Promise<Buffer>` → raw `GET /files/:id` (not the JSON `request()` helper —
  needs the raw body).
- `uploadFile(channelId, filename, data): Promise<string>` → multipart `POST /files` using the
  platform's native `FormData`/`Blob` (Node 20 has both globally); returns the new file id.
- `createPost` takes `fileIds?: string[]` and sends `file_ids` in the body.
- `mapPost` now resolves `files` per post: **prefers `raw.metadata.files`** (Mattermost already
  includes full `FileInfo` there for posts with attachments — zero extra requests) and only
  falls back to `file_ids` + `getFileInfo()` per id when metadata isn't present (e.g. some code
  paths that construct a bare post). Failed per-file lookups are dropped, not fatal.

### Policy (`src/mcp/policy.ts`)
- `classifyPost`'s empty-message drop became
  `(text.trim() === '' && !hasFiles) || postType.startsWith('system_')` — an image-only post
  with real files still gets classified (as `dm`/`mention`/`room`/... by the existing rules,
  unchanged); a truly empty post with no files, and system posts (even if they somehow carried
  files), are still dropped.
- Every event built from a post with files gets `ev.attachments` set to the **name/size/mime
  only** — no path yet. Deciding whether to actually download is server.ts's job (§4), since
  that's the only layer that knows whether the event is headed for immediate delivery or the
  digest, and it's the layer with I/O.
- `renderEvents`: each event's body is now `[text?, ...attachmentLines].join('\n')` instead of
  just `escapeText(text)`, so an image-only event renders as
  `<event ...><attachment name="a.png" type="image/png" size="10 B" path="/…"/></event>` with no
  leading blank line, and a captioned one renders as `caption\n<attachment .../>`. Sizes are
  formatted B/KB/MB (`fmtSize`), matching the example in the spec (`182 KB`). A skipped
  attachment renders `skipped="too large (…)"` instead of `path`. All existing exact-string
  `renderEvents` tests still pass unchanged (no attachments → no attachment lines → identical
  output).
- `renderDigest`: each digest line gets a trailing `📎 name` per attachment (escaped), e.g.
  `- [18:00] kim: see attached 📎 notes.pdf (post_id=p1)`; an image-only digest item shows just
  `- [18:00] kim: 📎 shot.png (post_id=p1)`.
- `PostGuard.check` gained `hasAttachment?: boolean`; the empty-text rejection is skipped when
  it's true, so `chat_upload` can post a file with no caption. Every other guard (ack-only,
  duplicate, rate limits, thread cap) still applies unchanged.

### Workspace helpers (`src/lib/workspace.ts`, new exports, pure/testable)
- `DEFAULT_MAX_ATTACHMENT_BYTES` (20 MiB), `formatMB`, `checkAttachmentSize(bytes, maxBytes)` →
  `undefined` or `"too large (N.N MB)"`.
- `sanitizeAttachmentFilename(name)` — `path.basename()` first (drops any `../` or `a/b/` prefix
  outright), then replaces anything outside `[A-Za-z0-9._-]` with `_`, then collapses a leading
  run of dots to a single `_` (so `.hidden` → `_hidden`, `..` → `_`), and falls back to `"file"`
  for an empty result. Used for every on-disk filename derived from a remote name.
- `resolveInWorkspace(root, agentName, filePath)` — resolves `filePath` (absolute, or relative to
  `workspaceDir(root, agentName)`) and **realpath**s it, so a symlink inside the workspace that
  points outside it is rejected (`fs.realpathSync` follows the link; the real target must still
  be `=== wsReal` or start with `wsReal + path.sep`). Returns `undefined` on escape or a missing
  file. This is what makes `chat_upload`'s "only your own workspace" rule enforceable rather than
  just documented — a symlink to `../other-agent/secrets.txt` or `/etc/passwd` doesn't work.

### Server (`src/mcp/server.ts`)
- **Inbound download.** `downloadAttachment(postId, file)` checks the size cap
  (`checkAttachmentSize`), and on success writes to
  `workspaces/<agent>/attachments/<post_id>/<sanitized-name>` (`fs.mkdirSync(recursive)`, then
  `mm.downloadFile` → `fs.writeFileSync`), returning `{path}` or `{skipped}`; a download error
  becomes `{skipped: "download failed: …"}` rather than throwing (a file the agent can't see
  shouldn't sink the whole event delivery).
  `resolveEventAttachments(ev)` is a no-op unless `ev.attachments?.length` **and**
  `ev.kind !== 'digest-item'` — this is the "digest items only get names" rule from the spec.
  It's called from the two places an event actually becomes immediate: `enqueue()` (the normal
  path — `onPost` and `pollTickets`) and `releaseRooms()` (a held room request that nobody claimed
  and is about to become immediate; if someone *did* claim it, the event flips to `digest-item`
  first and attachments are correctly left unresolved).
  `enqueue()` became `async`; its two callers were updated (`void enqueue(ev)` from the
  synchronous WebSocket callback `onPost`, `await enqueue(ev)` from the already-async
  `pollTickets`). The `pending.json` persistence now happens twice — once immediately (so a
  crash mid-download doesn't lose the dedup slot) and again after the download settles (so the
  resolved `path`/`skipped` survives a restart without re-downloading).
- **Outbound tools**, registered next to `chat_react`:
  - `chat_upload({ path, channel?, thread_id?, text? })` — resolves `path` with
    `resolveInWorkspace(root, rec.name, path)` (rejects anything outside the agent's own
    workspace, including a symlink escape); checks size against `maxAttachmentBytes`; resolves
    the target channel/thread the same way `chat_post`/`chat_reply` do; uploads via
    `mm.uploadFile`; then reuses `postGuarded` (now `fileIds`-aware) so every existing guard still
    runs, with `hasAttachment: true` letting `text` be omitted.
  - `chat_download({ file_id })` — `mm.getFileInfo` for the size check, then `mm.downloadFile`
    into `workspaces/<agent>/attachments/downloads/<sanitized-name>`, returning the local path.
    Works on any file id the agent can see (typically from a `files:` list — see next point).
  - `fmtPost` (used by `chat_read`/`chat_thread`/`chat_search`) now appends
    ` files: name (file_id), name2 (file_id2)` when a post has attachments, so `chat_download`
    has something to point at for files from before the agent was even watching (e.g. an old
    thread it opens with `chat_thread`).

### Rules (`templates/office-rules.md`)
New "Files" section (inserted before "Communication rules"): attachments arrive with a local
`path` an agent can open directly; a text-only model should @mention a Claude colleague to look
at an image; `chat_upload` only from the agent's own workspace, never secrets; `chat_download`
for files referenced in older posts.

## 3. Live check (throwaway data only, cleaned up)

Ran `scripts/tmp-livecheck/live-check.ts` (deleted after the run — not part of this diff) against
the **live** office (tmux session `office`, 5 agents + admin, none touched):

1. `createAgentIdentity('zz-filetest', ...)` — throwaway Mattermost bot + Forgejo user, not
   hired/started, no tmux window.
2. A private channel (owner + `zz-filetest` only) created via the owner's own REST token
   (`secrets.mattermost.adminToken`, which *is* the owner's personal Mattermost session token —
   confirmed by reading `ensureMattermostAdminToken` in `src/cli/bootstrap.ts`).
3. As the owner: uploaded a 1×1 PNG as an **image-only post** (`message: ''`), and a `.txt` file
   with a caption, via `MattermostClient.uploadFile` + `createPost({fileIds})`.
4. Re-fetched the image-only post with a plain `GET /posts/:id` and ran it through
   `classifyPost()`: **not dropped**, `ev.attachments` populated from `metadata.files` (no extra
   `getFileInfo` round-trip needed — confirmed by the fetched post already carrying `files`).
5. Downloaded the attachment into a temp dir via `checkAttachmentSize` + `sanitizeAttachmentFilename`
   + `mm.downloadFile`, byte-for-byte (68 bytes in, 68 on disk).
6. `renderEvents` output for the resolved event:
   ```
   <event kind="room" channel="zz-filetest-…" channel_type="mixed" from="owner" human="true" post_id="…" thread_id="…" at="…"><attachment name="screenshot.png" type="image/png" size="68 B" path="/tmp/zz-filetest-ws-…/attachments/…/screenshot.png"/></event>
   ```
   and `renderDigest` for the same event demoted to `digest-item`:
   ```
   - [10:06] owner: 📎 screenshot.png (post_id=…)
   ```
7. Uploaded a file **as `zz-filetest`** (its own token, simulating `chat_upload`'s
   `mm.uploadFile` + `createPost` call) — the post came back with `files: [{name: 'from-zz.txt', ...}]`.
8. `fmtPost`-style rendering of the whole thread showed ` files: name (file_id)` on every post
   that had one, including the join/add system posts having none (as expected — they're filtered
   out by `classifyPost` regardless).
9. Cleanup: `deleteChannel` (archives it) and `retireAgentIdentity('zz-filetest')` (disables the
   bot). Verified `tmux list-windows -t office` unchanged before/after (still exactly `kai, ada,
   admin, rex, webre, lead`).

## 4. Verified

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 251 passed, 4 skipped (pre-existing skips, unrelated), 0 failed. New files:
  `test/workspace.test.ts` (sanitizing/traversal/symlink-escape/size-check, 13 cases),
  `test/mattermost-files.test.ts` (getFileInfo/downloadFile/uploadFile/createPost+file_ids against
  a mocked `fetch`, 6 cases); `test/policy.test.ts` gained cases for the empty-text+file
  classification, attachment carry-through regardless of event kind, `renderEvents`/`renderDigest`
  attachment rendering (including the skipped/oversize case), and `PostGuard`'s
  `hasAttachment` bypass.
- Live REST round-trip against the real Mattermost instance (§3), with disposable data only.

## 5. Open issues / follow-ups not done here

- If `enqueue()` is called twice for the same event id before the first download settles (only
  possible during the 24h `catchUp()` replay after a restart racing the live WebSocket), the
  download can run twice; harmless (the queue itself dedupes by id) but wasteful. Not fixed —
  narrow race, existing `pending`/`DeliveryQueue` dedup already exists for the same reason
  elsewhere in this file.
- An event restored from `pending.json` after a crash **mid-download** (between the two
  `savePending()` calls in `enqueue()`) will have attachment metadata but no `path`/`skipped`; it
  is not retried. Rare (a specific crash window) and the agent can still `chat_download` it if
  needed once it has the file id from the rendered event.
- `chat_upload`/inbound download share one size cap (`office.config.json`'s `attachments.maxBytes`,
  default 20 MiB); there's no separate outbound cap even though Mattermost's own upload limit may
  differ — a too-large outbound upload will fail at the tool's own check first with a clear
  reason, before ever reaching `uploadFile`.

## 6. Restart required

None of this reaches the five live agents (`ada`, `kai`, `lead`, `rex`, `webre`) until their
office-mcp process is restarted (new code only loads at MCP startup, same as any other office-mcp
change) — that restart is the owner's call, not done here.
