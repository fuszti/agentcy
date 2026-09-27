# Prior art: open-source systems similar to Agent Office

Task G research, 2026-09-25. Stars / last-push dates come from the GitHub REST API
queried 2026-09-25. Anything unchecked is marked **UNVERIFIED**.

**Ours (baseline)** — persistent, named Claude Code + opencode sessions as colleagues
in a self-hosted Mattermost, woken on mention/assign into a *live, resumable* session
(tmux paste / opencode HTTP), tickets in Forgejo, per-agent memory in git, fork/merge
of sessions, single user, one machine today, multi-machine later.

## 1. Chat bridges for coding agents

**cc-connect** — https://github.com/chenhg5/cc-connect · 15,664★ · pushed 2026-09-22 ·
README says MIT · Go.
13 IM platforms (Feishu, DingTalk, Slack, Telegram, Discord, WeCom, Matrix, QQ, LINE…)
to 10+ local coding CLIs (Claude Code, Codex, Cursor, Gemini, Kimi CLI, OpenCode, any
ACP agent), mostly without a public IP. Closest thing to "the chat half of our system",
but it is remote control for one local agent per conversation: no agent directory,
tickets, memory, fork/merge or shared office.

**kimaki** — https://github.com/remorses/kimaki · 1,422★ · pushed 2026-09-25 · MIT.
Deep OpenCode-in-Discord: channel = project, thread = session, `/resume`, `/fork`,
`/queue`, `/btw`, worktrees, memory snapshots, an injection-guard dependency. Most
mature session→thread mapping and resume/fork UX of the bridges. Discord-only, one
human driving; no tickets, no git memory, no shared-session wake.

**Claude-to-IM-skill** — https://github.com/op7418/Claude-to-IM-skill · 2,879★ ·
pushed 2026-03-23 · MIT. Telegram/Discord/Feishu/QQ/WeChat ↔ Claude Code or Codex with
inline Allow/Deny permission buttons, streaming preview, session persistence. Good
reference for our v2 "permission prompt relayed to chat".

**Mattermost Agents** — https://github.com/mattermost/mattermost-plugin-agents · 251★ ·
pushed 2026-09-25 · Apache-2.0. Mattermost's own AI layer: named assistants, thread
summaries, semantic search, MCP tool calling, and a Mattermost MCP server external
clients can use. It proves the Mattermost side is not our differentiator — but it is
LLM-in-chat, not a live coding session: no tools on disk, no long-lived session.

## 2. Message boards / mailboxes for coding agents

**MCP Agent Mail** — https://github.com/Dicklesworthstone/mcp_agent_mail · 2,166★ ·
pushed 2026-09-22 · Python; Rust rewrite
https://github.com/Dicklesworthstone/mcp_agent_mail_rust · 179★.
Identities (adjective+noun), inbox/outbox, searchable threads, CC/BCC, acks, advisory
**file leases** with a pre-commit guard, Git-backed auditable archive + SQLite FTS5, a
human web UI and a "Human Overseer" composer. Strongest reference for our agent-only
channels/inboxes — and for a primitive we lack (file reservations). Its web UI is a
mail viewer, not a chat; no wake into a harness session, no fork/merge.

**Beads** — https://github.com/steveyegge/beads · 27,427★ · pushed 2026-09-25 · MIT.
Dolt/JSONL git-backed dependency-graph issue tracker for agents: `bd ready`, atomic
`--claim`, `discovered-from` links, `bd remember`, memory decay, multi-machine sync via
git. Beats our Forgejo tickets on dependencies and claims. A CLI/library, not an office.

**Gas Town** — https://github.com/steveyegge/gastown · 18,194★ · pushed 2026-09-18 ·
MIT. Orchestration on Beads: agent identities as beads, mailboxes, hooks ("GUPP"),
Mayor/Polecats/Refinery roles, convoys, `gt handoff` (session restart + context carry),
tmux drivers. Nearest open-source "AI company runtime". CLI/tmux first: no human chat
UI, and its fork story is worktree/handoff, not context-window merge.

**opencode-ensemble** — https://github.com/hueyexe/opencode-ensemble · 225★ · pushed
2026-09-18 · MIT. OpenCode plugin: parallel agents with per-agent session/context, peer
messaging, shared task board, on the public OpenCode SDKs. Relevant to our opencode
wake/fork path; not a chat office.

**Ruflo / claude-flow** (73,273★, MIT, https://github.com/ruvnet/ruflo) — meta-harness
around Claude Code/Codex: swarms, memory, federated comms across machines. Big and
shipping fast; headline benchmarks **UNVERIFIED** by us. Inspiration for multi-machine
federation only.

## 3. Session managers

**agent-deck** — https://github.com/asheshgoplani/agent-deck · 953★ · pushed
2026-09-25 · MIT. TUI/CLI/web "mission control" over tmux sessions for Claude/Gemini/
OpenCode/Codex: idle-vs-thinking detection, **session fork with context inheritance**
(Claude, OpenCode, Pi, Codex), MCP + skills manager, worktrees, cost dashboard,
"Conductor" sessions that watch others, and Watchers ingesting webhooks/GitHub/ntfy/
**Slack**. Closest match to `office fork` and our inbound-event→wake path.

**Claude Squad** (8,532★, AGPL-3.0, https://github.com/smtg-ai/claude-squad) —
tmux + one git worktree per task, yolo mode, review-then-push. No chat UI, no memory,
no fork/merge, no tickets.

**vibe-kanban** (28,190★, Apache-2.0, https://github.com/BloopAI/vibe-kanban) —
kanban where each card is an agent task on a worktree; Claude Code/Codex/Gemini/
OpenCode. Bloop shut the cloud product down 2026-04-10; community-maintained since.
Good tickets↔work UX reference; agents are spawned per task, not persistent colleagues.

**Crystal → Nimbalyst** (3,122★, MIT, https://github.com/stravu/crystal) — Electron
parallel Claude/Codex sessions on worktrees; deprecated Feb 2026 for the paid Nimbalyst
successor. Still a usable MIT codebase.

**Sculptor (Imbue)** (232★, MIT, https://github.com/imbue-ai/sculptor) — runs each
agent in a **Docker container**, syncs work back on approval. Relevant to our v2
container-isolation step.

## 4. "AI company / agent office" systems

**TheAgentCompany** — https://github.com/TheAgentCompany/TheAgentCompany · 784★ ·
pushed 2025-11-17 · MIT. Benchmark self-hosting GitLab + Plane + ownCloud + RocketChat
with preloaded data and LLM "colleagues" (via Sotopia) on the chat. Best published
reference for "a company as a testbed"; a fixture, not a runtime — the agents are
characters, not live coding sessions.

**ChatDev 2.0** (34,396★, Apache-2.0, pushed 2026-07-24,
https://github.com/OpenBMB/ChatDev) and **MetaGPT / MGX** (70,611★, MIT, pushed
2026-01-21, https://github.com/foundationagents/metagpt) — the two big "virtual
software company" frameworks. ChatDev turned into a zero-code multi-agent orchestration
platform (YAML workflows, FastAPI + Vue console); MetaGPT encodes SOPs and publishes
structured artifacts into a shared message pool with subscriptions (instructive for our
delivery policy). Both keep agents framework-internal: no persistent CLI sessions, no
self-hosted chat office.

**OpenHands (Agent Canvas)** — https://github.com/OpenHands/OpenHands · 89,167★ ·
pushed 2026-09-25 · MIT. Self-hosted control center running OpenHands, Claude Code,
Codex or any ACP agent on local/remote/cloud backends, plus an Automation Server
(schedules, webhooks, Slack/GitHub/Linear). Most complete open-source "developer
control center" — but a web canvas of conversations, not a chat office of named
persistent colleagues; no git per-agent memory, no session fork/merge.

**AI Village** — https://theaidigest.org/village · live since Apr 2025 · 13 long-running
agents (Claude/GPT/Gemini/DeepSeek) in a public group chat with shared goals, an A2A
embassy, a public event log, per-agent identity docs. Not installable, but the best
public corpus of named agents sharing a channel for a year. **UNVERIFIED** runtime.
**Moltbook** (https://www.moltbook.com, no GitHub repo, **UNVERIFIED**) is a
Hacker-News-style social network *for* agents — public/multi-tenant, out of scope.

**Projects literally called "agent office"** — none is a functional match:
`fwartner/agent-office` 46★ MIT (pixel office UI, Telegram sync, task queue),
`eliautobot/my-virtual-office` 329★ AGPL-3.0 (pixel office visualiser),
`baturyilmaz/agent-office` 24★ (Pi workspace with inbox IPC, tick scheduler, Docker
sandbox; license **UNVERIFIED**), `falkoro/agent-office` 1★ MIT. All visualisers.

## 5. Fit table

✓ yes · ~ partial · ✗ no

| Project | chat UI | named agents | wake → live session | CC/opencode | tickets | memory | fork/merge | multi-machine |
|---|---|---|---|---|---|---|---|---|
| **ours** | ✓ | ✓ | ✓ | ✓ both | ✓ | ✓ | ✓ | planned |
| cc-connect | ~ IM | ✗ | ~ | ✓ both | ✗ | ✗ | ✗ | ~ |
| kimaki | ~ Discord | ~ | ✓ | ~ OC | ✗ | ~ | ~ fork | ✗ |
| Claude-to-IM-skill | ~ IM | ✗ | ✓ | ~ CC | ✗ | ✗ | ✗ | ✗ |
| Mattermost Agents | ✓ | ~ bots | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| MCP Agent Mail | ~ viewer | ✓ | ✗ | ~ MCP | ~ | ~ mail | ✗ | ✓ |
| Beads | ✗ | ~ | ✗ | ~ CLI | ✓ | ~ | ✗ | ✓ |
| Gas Town | ✗ | ✓ | ✓ | ~ CC | ✓ | ✓ | ~ | ✓ |
| opencode-ensemble | ✗ | ✓ | ~ | ~ OC | ~ | ✗ | ~ | ✗ |
| agent-deck | ✗ | ~ | ~ | ✓ both | ✗ | ✗ | ✓ fork | ✗ |
| Squad/vibe-kanban/Crystal/Sculptor | ✗ | ✗ | ~ | ✓ many | ~ | ✗ | ~ | ✗ |
| TheAgentCompany | ✓ | ~ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| ChatDev/MetaGPT | ~ | ~ roles | ✗ | ✗ | ~ | ✗ | ✗ | ✗ |
| OpenHands Canvas | ~ web | ✓ | ~ | ✓ ACP | ~ | ✗ | ✗ | ✓ |
| AI Village | ✓ | ✓ | ~ | ✗ | ~ | ~ | ✗ | ✓ |

## 6. Top 3 closest

1. **Gas Town + Beads** — the only serious open-source attempt at "named persistent
   agents, mailboxes, work ledger, handoffs" as a runtime. No human chat UI and no
   context-window merge: a sibling, not a duplicate.
2. **kimaki** (cc-connect runner-up) — the most developed "chat ↔ live coding session"
   mapping (channel→project, thread→session, resume/fork). Our Mattermost side minus
   identity, tickets, memory and multi-agent presence. cc-connect shows how far a
   general bridge can scale (13 platforms, ACP).
3. **agent-deck** — closest on the session mechanics we built: tmux-backed multi-harness
   sessions, idle detection, **native fork with context inheritance** across Claude and
   opencode, webhook/Slack watchers feeding orchestrating sessions. No chat colleague
   experience, no tickets, no memory.

## 7. What we could reuse or copy

* **Beads** as the work ledger (dependencies, `--claim`, `bd ready`, `bd remember`)
  instead of / in front of plain Forgejo issues — or copy `discovered-from` links and
  atomic-claim semantics into Forgejo labels.
* **MCP Agent Mail**'s file-reservation leases and pre-commit guard: a primitive we
  lack when two agents touch one repo.
* **agent-deck**'s cross-harness fork implementation and idle/thinking heuristics;
  **Sculptor**'s container-per-agent model for v2 sandboxing.
* **Claude-to-IM-skill**'s permission-relay pattern (Allow/Deny buttons) for the
  "permission prompt blocks an agent until the owner answers" limitation.
* **Mattermost Agents**' MCP server for first-class Mattermost tools (search, thread
  summaries) instead of our hand-rolled `chat_*` tools.

## 8. What is genuinely new in ours

* **Wake-on-mention into a long-lived, resumable session** as a first-class concept.
  Bridges start a conversation; session managers manage sessions you drive. Nobody
  found ships "an agent is idle in its desk session and a mention wakes that same
  session, preserving its identity and context".
* **Context-window fork *and* merge** — `office merge` replays/condenses one agent's
  transcript since a fork point into another's live session and 3-way merges
  `memory.md`. Fork exists (agent-deck, kimaki, Claude Code itself); merging two
  agents' *experience* back together does not exist anywhere I found.
* **Per-agent durable memory as git artifacts** (`persona/memory/journal.md` compiled
  into `CLAUDE.md`/`AGENTS.md`) plus a shared wiki, not a database blob or Beads notes.
* **Delivery policy + anti-chatter guards in the MCP** (tiered wake vs digest, ack-only
  filter, rate limits, agent-only thread cap) as hard enforcement rather than prompt
  politeness. Nearest prior art is MetaGPT's pub/sub, for structured artifacts.
* **Mixed Claude Code + opencode colleagues with tiered roles** (scarce subscription
  models for hard work, OpenCode Go models for bulk) in one office. cc-connect supports
  both harnesses but not as simultaneous named coworkers.
