# opencode runtime for persistent agents — research + implementation

Status: verified against opencode **1.18.32** (`opencode --version`), 2026-09-25. All claims below were tested with real commands; each research question has the command + trimmed output.

Live prompts used only the cheap model `opencode-go/deepseek-v4.1-flash` (well under 20 total).

## 0. TL;DR

An opencode agent is a long-lived `opencode <workspace> --port N` TUI in a tmux window. Its built-in HTTP server exposes a REST API plus an SSE event stream that an external process (our per-agent `office-mcp`) uses to: know the desk session id, watch idle/busy, inject prompts that show live in the TUI, read messages for merge, and fork the session. The verified startup sequence is `OPENCODE_CONFIG=<file> opencode <workspace> --port N -m <model> -s <sessionId>`; the API to drive it is `POST /session/{id}/prompt_async`, `GET /session/{id}/message`, `POST /session/{id}/fork`, and the SSE stream `GET /global/event`.

## 1. Server API (Q1)

- OpenAPI spec is served at **`GET /doc`** (JSON, ~478 KB). `curl -s http://127.0.0.1:4199/doc` → `{"info":{"title":"opencode","version":"1.0.0"}, ...}`.
- Health: `GET /global/health` → `{"healthy":true,"version":"1.18.32"}`; `GET /api/health` → `{"healthy":true}`.
- There are **two overlapping API surfaces**: a legacy `/api/...` namespace and the newer top-level `/session`, `/event`, `/config`, `/global/*` namespace. We use the top-level one (the one whose schemas are `SessionMessage*`, `SessionStatus`, `EventSessionStatus`).

Endpoints relevant to sessions/messages/events/config (from `/doc`, trimmed to what matters):

```
POST   /session                          create session (title, model, agent, permission, workspaceID)
GET    /session                          list sessions (most-recently-updated first)
GET    /session/status                   map sessionID -> {type: idle|busy|retry}
GET    /session/{id}                     session detail (id, directory, projectID, parentID, ...)
POST   /session/{id}/prompt_async        inject a prompt, return immediately (204)
POST   /session/{id}/message             inject a prompt, stream the response (200)
GET    /session/{id}/message             all messages as [{info, parts}]
POST   /session/{id}/fork                fork at an optional messageID
POST   /session/{id}/abort               abort a running session
GET    /session/{id}/children            forked children
POST   /session/{id}/summarize           request a summary
GET    /session/{id}/context             context-window usage
GET    /event                            SSE (directory-scoped), text/event-stream
GET    /global/event                     SSE (global), text/event-stream
GET    /config   PATCH /config           project config (merged view)
GET    /global/config                    global config
GET    /mcp                              declared MCP servers
GET    /project   GET /project/current   project scoping (git hash vs "global")
POST   /tui/select-session|submit-prompt ...  drive the TUI directly
```

## 2. Create a session and prompt asynchronously (Q2)

Create with a title:

```sh
curl -s -X POST http://127.0.0.1:4199/session -H 'Content-Type: application/json' \
  -d '{"title":"oc-spike-test"}'
# {"id":"ses_f26415066ffes8487O9RmBMB2J","slug":"gentle-wolf","projectID":"global",
#  "directory":"…/oc-spike/proj","title":"oc-spike-test","version":"1.18.32", ...}
```

Send a prompt asynchronously — `POST /session/{id}/prompt_async` (exists in 1.18.32; `POST /session/{id}/message` is the streaming variant). Body:

```json
{ "parts": [ { "type": "text", "text": "Reply with exactly the word: pong" } ],
  "model": { "providerID": "opencode-go", "modelID": "deepseek-v4.1-flash" } }
```

`parts` is a list of `TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput`; optional `model` (`{providerID, modelID}`), `agent`, `noReply`, `system`, `tools` override the session defaults. Response is `HTTP/1.1 204 No Content` (returns immediately). You then read the response via `GET /session/{id}/message` or the SSE stream.

## 3. Idle / busy (Q3)

SSE events on `GET /global/event` (also `/event`, directory-scoped). Each frame is `data: {json}\n\n` with an initial burst of NUL keep-alive bytes. Relevant event types:

- `session.status` → `{"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"busy"}}}` and `…{"status":{"type":"idle"}}`.
- `session.idle` → `{"type":"session.idle","properties":{"sessionID":"ses_…"}}`.

There is also a polling endpoint `GET /session/status`:

```sh
# idle (no session tracked)                    busy
# {}                                           {"ses_…":{"type":"busy"}}
```

A session that is idle is **absent** from the map; while running it is `{"type":"busy"}`.

Posting a prompt while the session is busy is **queued, not rejected** — `prompt_async` returns `204` and the second prompt runs after the first finishes (verified: posted a `sleep 8` prompt, immediately posted a second prompt → both completed in order, status stayed `busy` throughout then went `idle`). Only the legacy `/api/session/{id}/prompt` documents a `409` (SessionBusyError) response; the top-level `prompt_async`/`message` endpoints accept and queue.

## 4. TUI + API together (Q4)

Start the TUI in tmux with `--port`:

```sh
tmux new-session -d -s ocspike -x 200 -y 50 \
  'opencode . --port 4199 -m opencode-go/deepseek-v4.1-flash'
```

Then create/drive a session via the API on the same port — it works, and the TUI shows API-created sessions and messages **live**. To make the TUI open a specific session, pass **`-s <id>`**:

```sh
opencode . --port 4199 -m opencode-go/deepseek-v4.1-flash -s ses_f2637fd74ffeMTNYX755F2DUUV
```

Verified startup sequence for "TUI shows the desk session + external process can prompt it": launch the TUI with `-s <deskSessionId>`, then `POST /session/<deskSessionId>/prompt_async` from the external process. `tmux capture-pane -p` showed the injected prompt `Say exactly: hello-from-api` and the assistant reply `hello-from-api` in the pane.

## 5. Fork (Q5)

API: `POST /session/{id}/fork` with optional body `{"messageID":"msg_…"}`. Semantics (verified): the fork gets a **new id**, title becomes `"<title> (fork #N)"`, and it copies all messages **strictly before** the fork point (forking at a given message id inherited the 3 messages before it; omitting `messageID` copies the whole transcript). CLI equivalent: `opencode --fork` with `--continue`/`--session` (from `opencode run --help`).

Project scoping (verified):

```sh
# non-git dir                                  git dir
# projectID: "global"                          projectID: <40-hex git commit hash>
```

The session's `directory`/`projectID` are fixed at creation time from the server cwd. A session created in directory A **can be forked** by an instance whose cwd is B — the fork keeps the parent's `directory` (the fork's `directory` query param is ignored in 1.18.32; the child inherits the parent's directory). To fork into a *different* workspace you must fork and then run the child with its own cwd/`-s`, or create the parent in the desired workspace in the first place.

## 6. Config (Q6)

Config precedence (from the source + docs): remote `.well-known/opencode` → global `~/.config/opencode/opencode.json` → **`OPENCODE_CONFIG` (a FILE path)** → project `opencode.json` (highest of the standard files) → `OPENCODE_CONFIG_CONTENT` (a JSON string) → macOS managed. `OPENCODE_CONFIG_DIR` is a *directory* for agents/commands/plugins, not config.

- **Point one instance at an agent-specific config file**: `OPENCODE_CONFIG=/path/to/agent.json opencode …`. Verified: `OPENCODE_CONFIG=…/myconfig.json opencode serve --port 4198` then `GET /config` reflected the file's `model` and `username`.
- **Local MCP server** (`mcp.office`): `{ "type":"local", "command":[…], "cwd":optional, "environment":{…} }` (McpLocalConfig). Verified it appears in the merged `GET /config`.
- **instructions**: array of file paths (extra instruction files), merged with concatenation across layers. `AGENTS.md` in the project root is loaded automatically (same convention as `CLAUDE.md`).
- **permission** rules: `"permission":{"edit":"allow","bash":{"*":"allow","rm -rf /*":"deny","sudo *":"deny","git push --force*":"deny",…},"webfetch":"ask"}`. Object syntax maps tool → pattern → action (`allow`/`ask`/`deny`), `*`/`?` wildcards, **last matching rule wins** (put the catch-all first).
- **default model**: `"model":"provider/model"` in config (or `-m` flag / `--agent`).
- **`--auto` still honours explicit deny**: yes — from the permissions docs: "Explicit `deny` rules are still enforced. Auto mode only changes requests that would otherwise ask for approval."
- Defaults if unset: most tools `allow`; `doom_loop` and `external_directory` `ask`; `read` allows all but `.env`/`.env.*`.

## 7. Messages export (Q7)

`GET /session/{id}/message` returns a **plain array** (not the `{data,cursor}` wrapper the OpenAPI advertises) of `{info, parts}`:

```json
[
  { "info": { "id":"msg_…", "role":"user", "time":{"created":1790359565711},
              "agent":"build", "model":{"providerID":"opencode-go","modelID":"deepseek-v4.1-flash"} },
    "parts": [ { "type":"text", "text":"Reply with exactly the word: pong", "id":"prt_…" } ] },
  { "info": { "id":"msg_…", "role":"assistant", "parentID":"msg_…",
              "time":{"created":…,"completed":…}, "finish":"stop", "tokens":{…} },
    "parts": [ { "type":"step-start" },
               { "type":"text", "text":"pong", "time":{…} },
               { "type":"step-finish", "reason":"stop", "tokens":{…} } ] },
  { "info": { "role":"assistant", … },
    "parts": [ { "type":"step-start" },
               { "type":"tool", "tool":"read", "callID":"call_1",
                 "state": { "status":"completed",
                            "input": {"filePath":"…/answer.txt"},
                            "output":"<content>\n1: the secret number is 42\n</content>" } },
               { "type":"step-finish" } ] }
]
```

Part types seen: `text`, `tool`, `step-start`, `step-finish`, `reasoning`, `snapshot`, `patch`, `compaction`. A single user turn can produce several assistant messages (e.g. a tool-call message then a text message). The legacy `/api/session/{id}/message` returns the parts-flat `Message` shape instead.

## 8. Long-running use (Q8)

- Compaction is automatic and configurable: config `compaction: { auto, prune, tail_turns, preserve_recent_tokens, reserved }`. Manual: `POST /api/session/{id}/compact` and `POST /session/{id}/summarize`. There is no hard session-size limit that stops the harness; long sessions just compact/summarize.
- `GET /session/{id}/context` reports context-window usage (the TUI shows "0% used"/tokens).
- The whole office state lives in one global SQLite DB `~/.local/share/opencode/opencode.db` (≈770 MB here); sessions persist across TUI restarts, so `-s <id>` resumes them.
- `POST /session/{id}/abort` interrupts a running session cleanly.

## 9. Implementation — `src/lib/harness/opencode.ts`

- **`class OpencodeClient`** (`constructor(baseUrl, {password?, username?})`): `waitForServer(timeoutMs)` (polls `/global/health`), `createSession(title, {model?, agent?})`, `listSessions()`, `prompt(sessionId, text, {wait?, model?, agent?, timeoutMs?})` (POST `prompt_async`; `wait` polls `message` until a new assistant message appears), `messages(sessionId)`, `fork(sessionId, messageId?)`, `abort(sessionId)`, `isIdle(sessionId)` (via `/session/status`), `subscribe(onEvent)` (incremental SSE parser over fetch streaming, returns `{close()}`).
- **`class OpencodeWakeAdapter implements WakeAdapter`** (`constructor({baseUrl, sessionId: () => string|undefined})`): tracks idle state from `session.status`/`session.idle` SSE events and falls back to `/session/status`; `deliver(text)` POSTs a prompt (shows live in the TUI); `isAlive()` = server reachable.
- **`opencodeTranscript(messages)`** → `TranscriptEntry[]`: text parts joined with blank lines; tool parts → `{name, input, result, isError}`.
- **`buildOpencodeConfig({root, agent, model, instructions, extraMcp?})`** → opencode.json object: `$schema`, `model`, `instructions`, `mcp.office` = `["<root>/node_modules/.bin/tsx","<root>/src/mcp/server.ts"]` with `{OFFICE_ROOT, OFFICE_AGENT}`, permission rules (`edit: allow`, `bash: allow` with denials for `rm -rf /*`, `sudo *`, `git push --force*`, `docker rm*`, `docker compose down*`, `webfetch: ask`), plus `extraMcp` merged in (and an exported `opencodePlaywrightMcp` = `npx -y @playwright/mcp@latest --headless --isolated`).
- **`opencodeLaunchCommand({root, agent, workspace, configPath, port, model, sessionId?, headless?})`** → the shell command: TUI form `OPENCODE_CONFIG=<cfg> opencode <workspace> --port N -m <model> [-s <id>]`; headless form `OPENCODE_CONFIG=<cfg> cd <workspace> && opencode serve --port N` (`opencode serve` accepts no project path or `-m`).
- **`forkOpencodeSession({baseUrl, sessionId, messageId?})`** → `Promise<string>` (the new session id), verified against Q5.

## 10. How to use it

```ts
import { OpencodeClient, OpencodeWakeAdapter, buildOpencodeConfig, opencodeLaunchCommand } from './lib/harness/opencode.js'

const cfg = buildOpencodeConfig({ root: repoRoot, agent: 'ada', model: 'opencode-go/kimi-k2.7-code', instructions: ['AGENTS.md'] })
writeJsonFile(workspacePath + '/opencode.json', cfg)

const client = new OpencodeClient('http://127.0.0.1:4100')
await client.waitForServer(30000)
const s = await client.createSession('desk: ada')
// launch (in tmux): opencodeLaunchCommand({ ..., port: 4100, model, sessionId: s.id })
await client.prompt(s.id, 'hello', { wait: true })
const msgs = await client.messages(s.id)
const transcript = opencodeTranscript(msgs)
const forkId = await forkOpencodeSession({ baseUrl: 'http://127.0.0.1:4100', sessionId: s.id })
```

## 11. What I verified

- `npx tsc --noEmit` — `src/lib/harness/opencode.ts` type-clean (remaining errors are in other agents' in-flight files, none reference this module's API).
- `npx vitest run test/opencode.test.ts` — **13 passed, 1 skipped** (live test gated behind `OPENCODE_LIVE=1`).
- `OPENCODE_LIVE=1 npx vitest run test/opencode.test.ts` — **14 passed** (create → prompt(wait) → messages → fork → abort against a real `opencode serve` on :4199).
- `src/cli/office.ts` (another agent) already imports `OpencodeClient`, `buildOpencodeConfig`, `forkOpencodeSession`, `opencodeLaunchCommand`, `opencodeTranscript`; signatures were aligned to its usage (`headless` launch option, `forkOpencodeSession({baseUrl, sessionId}) → string`).

## 12. Open issues / notes

- `/session/{id}/message` returns a bare array in practice, but the OpenAPI advertises `{data, cursor}`; the client trusts the array. If opencode later paginates by default this could break — worth a defensive `Array.isArray` check.
- Fork ignores the `directory` query param in 1.18.32; a fork always inherits the parent's directory/project. Redirecting a fork to a new workspace needs extra steps.
- `/session/status` only ever contained `{"type":"busy"}` while running and dropped the entry when idle in our experiments; the `retry` status is handled defensively (treated as busy) but was not observed live.
- Permission "blocked" state (a `--auto` run hitting an explicit `deny`, or a `question`/`permission.asked` event) is surfaced via events but is not yet folded into `isIdle`; only idle/busy are modelled today.
- No prompts in this task touched anything destructive; deny rules are declared but their runtime enforcement was taken from opencode's documented behaviour, not separately triggered.
