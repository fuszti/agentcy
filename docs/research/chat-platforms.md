# Chat platform comparison — was Mattermost Team Edition the right call?

Written 2026-09-28. Context: Agentcy runs many bot users (persistent Claude/opencode agents) plus
one human, all API-driven, on one machine (later a small server). We need: threads, reactions
used as claims ("I'm working this"), private/agent-only channels, file uploads, per-channel
posting restrictions (agents post / human reads / human-only admin channels), a realtime event
stream for waking idle sessions, a search API, a small resource footprint, and a license/feature
set that won't get worse as we scale to a handful of agents and later multiple machines.

We already ship on **Mattermost Team Edition 11.11** (MIT-licensed server build, unlicensed —
see `docs/research/infra-notes.md`). This note checks that choice against the realistic
alternatives.

## Scored comparison

Scale: ✅ good fit · ⚠️ workable with a caveat/mitigation · ❌ poor fit or unavailable free.
"Free tier" = what runs without a paid license key, since Agentcy is one operator, no budget for
seat licenses.

| Criterion | Mattermost TE | Zulip (OSS) | Rocket.Chat CE | Matrix (Synapse/Conduit-family) | Revolt/Stoat | Campfire (ONCE) | Discourse (+Chat) |
|---|---|---|---|---|---|---|---|
| Many bot users, 1 human | ✅ bot accounts via API, no count cap found | ✅ same, bots are first-class | ✅ same | ⚠️ bots = extra homeserver users/appservices, heavier per-bot setup | ✅ bot API exists | ❌ single shared login model, not built for many identities | ⚠️ posts-as-user works but forum model, not per-bot identity |
| Threads | ✅ native | ⚠️ topics, not reply-threads (see below) | ✅ native | ⚠️ "threads" (MSC) still uneven across clients | ✅ native | ❌ flat room, no threads | ✅ (topics are threads; Chat plugin adds channel threads) |
| Reactions as claims | ✅ full emoji reaction API | ✅ full reaction API | ✅ full reaction API | ✅ via `m.reaction` | ✅ | ⚠️ limited/boost only | ✅ |
| Private channels | ✅ | ✅ private streams | ✅ | ✅ (private rooms, invite-only) | ✅ | ⚠️ rooms have coarse membership | ⚠️ category-based, less granular |
| Agent-post/human-read channel (read-only) | ❌ gated — "Entry" paid plan+ required (see below) | ✅ free, per-stream "who can post" | ✅ free, "Read Only" toggle is CE | ⚠️ power-level based, doable but manual | ⚠️ role-based, workable | ❌ | ⚠️ category permissions, workable |
| Human-only admin channel | ✅ (private channel, don't invite bots) | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| File uploads | ✅ | ✅ | ✅ | ✅ (media repo) | ✅ | ✅ | ✅ |
| Realtime event stream for wake-on-event | ✅ WS API, used today | ✅ long-poll/events API | ✅ WS/streamer, but throttled push infra for self-host in some setups | ✅ `/sync`, but heavier protocol | ✅ WS | ❌ no bot-friendly stream | ⚠️ MessageBus, less bot-oriented |
| Search API | ✅ Postgres FTS (fine <2.5M posts) | ✅ Postgres/Tsearch | ✅ | ⚠️ weaker cross-room search on some servers | ⚠️ basic | ❌ | ✅ strong (it's a forum) |
| Footprint on localhost | ✅ ~196 MiB idle (measured) | ⚠️ ~2 GB RAM minimum, 5-service stack | ⚠️ MongoDB-based, heavier than Mattermost | ⚠️/❌ Synapse is heavy; Conduit-family (Rust) is light | ✅ light-ish, Rust+MongoDB+Redis | ✅ light (Rails, single box) | ⚠️ Rails, moderate |
| 2026 license/feature gating | ⚠️ MIT server, but common admin features (channel moderation/read-only, guest accounts, SSO, unlimited search) sit behind "Entry"/paid plans | ✅ fully Apache-2.0, no feature paywall | ⚠️ relicensed 2021+, CE feature set narrowed, push notifications historically routed through RC's cloud gateway | ✅ AGPL, no gating, but fragmented server ecosystem | ✅ AGPL-3.0, no gating (small team, risk) | ✅ open-sourced, no gating, but no bot-multi-identity model | ✅ GPL, no core gating |
| Maintenance activity (2026) | ✅ active, frequent releases | ✅ active | ⚠️ active but smaller community post-relicensing, mixed sentiment | ✅ very active ecosystem, but split across forks | ⚠️ small team, renamed to Stoat 2025-2026, activity continuing but young | ⚠️ maintained by 37signals but not their core product focus | ✅ very active, mature |
| Self-host effort (1 machine, Docker) | ✅ 3 containers, already running | ⚠️ 5+ containers | ⚠️ comparable to Mattermost | ❌/⚠️ Synapse fiddly; Conduit-family simpler but younger, fewer bridges | ✅ moderate | ✅ simplest (ONCE is designed for this) | ⚠️ moderate, Rails stack |
| Later multi-machine / remote server | ✅ already URL-configurable | ✅ | ✅ | ✅ (federation is a bonus, unneeded here) | ✅ | ⚠️ single-app model | ✅ |

## Per-platform findings

### Mattermost Team Edition (current choice)

Team Edition's server code is MIT-licensed and unlicensed operation is legal and supported
([Editions and Offerings](https://docs.mattermost.com/product-overview/editions-and-offerings)).
Our own smoke test confirms no 10k-message cap on Team Edition and a footprint of ~196 MiB idle
for the Mattermost container (`docs/research/infra-notes.md`). Bot accounts are created freely
via the REST API with no count limit found in documentation or forums; the one "only one bot
allowed" report we found belongs to the separate `mattermost-plugin-agents` (AI) plugin's own
license check, not to core bot accounts — [confirmed by inspecting the issue](https://github.com/mattermost/mattermost-plugin-agents/issues/299),
unrelated to how Agentcy creates bots.

The real gap: **channel moderation (restricting who can post — i.e., our "agents post, human
reads" channels) is not in the MIT-licensed Team Edition build we run**. Mattermost's advanced
permissions documentation marks it "Available on Entry and Enterprise Advanced plans"
([Advanced permissions](https://docs.mattermost.com/administration-guide/onboard/advanced-permissions.html)).
"Entry" is not a paid plan: it is the free, unlicensed mode of the Enterprise Edition build, which
has the Enterprise Advanced features but limits viewable and searchable history to 10,000
messages across all channels
([Editions and Offerings](https://docs.mattermost.com/product-overview/editions-and-offerings)).
So the trade is Team Edition (MIT, no history cap, no channel moderation) against Entry (free,
channel moderation, 10k history cap, not MIT). Guest accounts, SSO/SAML/LDAP and HA are likewise
outside Team Edition.
None of the gated items except channel moderation matter for a one-operator localhost box; we
don't need SSO, guests, HA, or >10k history depth in the near term (design.md already treats the
history cap as verified-absent for TE). Full-text search runs on Postgres, fine below ~2.5M posts
([Enterprise search docs](https://docs.mattermost.com/administration-guide/scale/enterprise-search.html)).

### Zulip

Zulip is the strongest challenger specifically because it is **entirely Apache-2.0 with no
feature paywall** — the self-hosted build has the exact same permission model as Zulip Cloud,
including per-stream "who can post" settings, which gets us free "agents post / human reads"
channels that Mattermost cannot do without a paid plan.

The real question is topics vs. threads. Zulip's structural unit is **stream → topic**, where
every message must be filed under a topic (a short subject line), and topics are flat lists of
messages rather than a tree of replies
([Zulip Wikipedia](https://en.wikipedia.org/wiki/Zulip), [Zulip API: get-stream-topics](https://zulip.com/api/get-stream-topics)).
For Agentcy this is a mixed fit:
- **Better for "one durable subject, many short updates"** — e.g., a ticket or a running
  investigation maps naturally onto one topic that several agents post into over hours or days,
  and Zulip's UI/API let you mark a topic read, resolve it, or move it — closer to a lightweight
  work item than a chat thread.
- **Worse for "reply to this specific message"** — Mattermost/Slack-style threads let an agent
  reply to one message inside a busy channel without hijacking the whole subject; Zulip's topic
  is the addressing unit, so two unrelated exchanges under the same nominal subject collide unless
  agents are disciplined about topic-naming (and LLM agents are not naturally disciplined about
  that). Agentcy's design already leans on "replies always go into the thread of the message
  being answered" (design.md §4.3) — porting that literally to Zulip means one topic per message,
  which defeats topics' purpose, or accepting flatter threading than we have today.
- There is emerging agent tooling for Zulip (a Zulip channel plugin for the OpenClaw/ZeroClaw
  agent-framework ecosystem exists and explicitly adds "topic directives" for organizing
  agent-thread conversations, evidence that others are hitting the same threading question — see
  [openclaw-channel-zulip](https://github.com/FtlC-ian/openclaw-channel-zulip) and
  [zeroclaw issue #6437](https://github.com/zeroclaw-labs/zeroclaw/issues/6437)), but this is
  third-party/unverified maturity, not a first-party fit-for-agents statement from Zulip itself.

Resource footprint is heavier: minimum 2 GB RAM + 2 GB swap for the five-service Docker Compose
stack (Postgres, Redis, RabbitMQ, memcached, Django/Tornado), scaling up with active users
([Zulip requirements and scalability docs](https://zulip.readthedocs.io/en/stable/production/requirements.html)).
That's a real cost on a single laptop-class machine versus Mattermost's measured ~196 MiB.

### Rocket.Chat Community Edition

Rocket.Chat CE supports read-only channels and bot accounts natively and has historically been
a reasonable Slack-alternative for this shape of workload. However, RC relicensed parts of its
stack in recent years and narrowed what Community Edition includes (Omnichannel, some engagement
and audit features moved to paid tiers), and self-hosted push notifications have historically had
to route through Rocket.Chat's own cloud gateway rather than being fully self-contained — a
detail worth re-checking before adoption since it cuts against "no cloud dependency."
Community sentiment threads (forum posts on user/seat limits, e.g.
[Rocket.Chat forum: Community Edition user limit](https://forums.rocket.chat/t/community-edition-user-limit-1000/13380))
suggest the free tier's limits have moved around over time and are worth re-verifying at
deploy time rather than trusting a single snapshot. Footprint is MongoDB-based and comparable to
or heavier than Mattermost's Postgres stack. **Unverified**: exact 2026 CE feature list and
whether push-notification self-hosting friction still applies — we did not get a definitive
primary-source answer in this pass.

### Matrix (Synapse vs. Conduit-family: Conduit / Tuwunel / continuwuity) + Element/Cinny

Matrix is the most "correct" long-term architecture for Q13 (later multi-machine, agents connect
by URL) because it's designed for federation and has genuine appservice/bot primitives. But it
carries real friction for our specific shape:
- **Synapse** (the reference/most complete server) is heavy and was historically the main reason
  people avoid self-hosting Matrix for small deployments; the newer Rust servers (Conduit and its
  more actively maintained successors, Tuwunel and continuwuity) are lighter but younger, with
  narrower bridge/appservice compatibility — e.g. Python-based bridges need manual bot-account
  registration on Conduit-family servers where Go bridges don't
  ([Hermes Agent Matrix docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/matrix)).
- **E2EE friction**: encryption is stable for bridges in general use as of 2025, but
  *appservice*-level E2EE (letting a bot/bridge act with proper encrypted-device semantics rather
  than a plaintext-listening appservice) is still an active spec effort (MSC3202), with only
  experimental Synapse support
  ([MSC3202 PR](https://github.com/matrix-org/matrix-spec-proposals/pull/3202)). For Agentcy this
  mostly nets out to "disable E2EE for agent-facing rooms," which is fine for a localhost/LAN
  deployment but removes one of Matrix's headline features.
- Every "agent = one bot identity" in Matrix is a real homeserver user or an appservice
  registration — heavier per-agent setup than Mattermost's lightweight bot-account API, which
  matters when hiring/forking/retiring agents is a routine CLI operation in Agentcy (`office
  hire`/`fork`/`retire`).

Matrix would be the right call if Agentcy needed federation with other people's servers or a
long-term guarantee of protocol longevity; it's over-engineered for one human + a handful of
local bots and adds operational surface we don't need yet.

### Revolt / Stoat

Revolt renamed to **Stoat** (a rename, not a fork) and remains AGPL-3.0, Discord-shaped, with a
bot API and OpenAPI client generation
([Stoat Wikipedia](https://en.wikipedia.org/wiki/Stoat_(software)), [self-host guide](https://www.dedimax.com/en/blog/self-host-your-own-discord-the-complete-guide-to-stoat-ex-revolt)).
It's plausible technically but is a small team's project mid-rename in 2025-2026 — real
maintenance-activity risk for something we'd depend on for a persistent-agent office, and its
threading/permission model is less battle-tested for "read-only announcement style" channels than
Mattermost's Slack-like conventions. **Unverified**: whether Stoat's free/self-hosted tier has any
feature gating at all (early signs say no, it's fully open, but we did not find a definitive
2026 feature matrix).

### Campfire (ONCE)

37signals open-sourced Campfire (and Writebook, Fizzy) and is building **ONCE**, a small
self-hostable app server for running this suite ([ONCE — Campfire](https://once.com/campfire),
[dev.37signals.com ONCE app server](https://dev.37signals.com/once-app-server/)). It is simple,
Rails-based, and light — a good fit for "one human, one machine" resource-wise. But Campfire has
**no threads**, a flat-room chat model, and is built around human users chatting, not a many-bot,
API-driven identity model; it has no realtime bot-friendly event/webhook story comparable to
Mattermost's WebSocket API. It solves a different problem (simple team chat) and would require us
to build most of Agentcy's chat semantics (threads, reactions-as-claims, per-channel bot
permissions) from scratch. Not a fit.

### Discourse (+ Discourse Chat)

Discourse is a forum with a bundled realtime Chat plugin
([Discourse Chat](https://www.discourse.org/plugins/chat)). Categories/topics give strong
search and structured discussion, and Discourse AI already ships bot/agent integration patterns
(admin API for streaming agent replies) which shows the ecosystem is agent-aware
([Using the AI bot via the Discourse API](https://meta.discourse.org/t/using-the-ai-bot-via-the-discourse-api/412826)).
But the mental model is forum-first (topics/categories) with chat as an add-on, which is a worse
fit for "colleagues talking in channels and DMs all day" than a chat-first tool, and per-bot
identity at Agentcy's density (many always-on bot accounts, high message velocity) is not
Discourse's design center. Reasonable fallback if Agentcy pivoted toward "agents file structured
reports," not a better fit for what Agentcy is today.

### Other agent-native chat servers (2025-2026)

Early, small projects exist that are explicitly framed as chat for agents rather than for humans:
"Agent-Native Chat" (BuilderIO, "Slack for AI agents") and "AgentsChat" (agent-to-agent rooms,
OKR voting, human handoff) — see
[Agent-Native Chat connector](https://glama.ai/mcp/connectors/io.github.BuilderIO/agent-native-chat)
and [AgentsChat MCP server](https://www.pulsemcp.com/servers/agentschat). These are **unverified,
early-stage, and agent-to-agent focused rather than human-in-the-loop chat with a daily-use UI** —
they lack the file-upload/search/reactions/read-only-channel maturity of an established chat
server. Worth re-checking in 6-12 months; not worth adopting today.

## Verdict: keep Mattermost, with mitigations

**Keep Mattermost Team Edition.** For Agentcy's actual shape — one human, several bot colleagues,
Slack-style channels/threads/DMs/reactions, a realtime WS event stream driving the wake logic, a
tiny footprint on one machine, an existing verified 3-container setup — Mattermost remains the
best match. Zulip is the only alternative that beats it on one specific axis (free read-only
channels), but it costs us native reply-threading (topics are a different, and for "many bots
replying inside busy channels," worse-fitting primitive) and roughly 10x the idle RAM. Nothing
else scored better than "workable with caveats" on enough axes to justify a rewrite of the MCP
wake/delivery/policy layer that's already built and verified against Mattermost's API
(`src/lib/mattermost.ts`, `src/mcp/policy.ts`).

**The one real gap to mitigate**: Mattermost's built-in channel moderation (server-enforced
"only admins can post") requires a paid Entry-or-above plan
([Advanced permissions docs](https://docs.mattermost.com/administration-guide/onboard/advanced-permissions.html)),
so today's `ag-*`/announcement-style "agents post, human reads" and "human-only admin" channels
are **social convention plus MCP-side guards, not server-enforced ACLs** — design.md already
reflects this honestly ("by convention does not post there"; a human post there is relabelled
"FYI from the owner" rather than blocked). Concrete mitigations, cheapest first:
1. **Keep the convention + MCP guard as-is** for agent-only channels (already implemented) —
   acceptable for a one-operator system where the only "attacker" is the operator's own typos.
2. **Add a lightweight bot-side enforcer**: a small system-bot listens on channels flagged
   `readOnlyForHuman` in config and auto-deletes/redirects non-bot posts, or reacts with a warning
   — a few hours of work, no license needed, closes the gap without buying a license.
3. **Switch to the Enterprise Edition build in its free Entry mode** only if/when this actually
   bites in practice (e.g. the human fat-fingers a post into a monitoring channel). It costs
   nothing, but it brings the 10k-message history cap (see `docs/research/infra-notes.md`) and a
   non-MIT build, and a paid license is the only way to lift that cap. Entry-vs-Team-Edition
   boundaries have moved before, so re-verify against Mattermost's current docs before switching.
4. **Migration cost if we ever needed real server-enforced read-only channels for a hard
   trust boundary** (e.g. multi-human, or agents that shouldn't be able to see each other trust the
   human's own channel): switching to Zulip would need porting `src/lib/mattermost.ts`,
   `src/mcp/policy.ts`'s digest/thread-cap logic (redesigned around topics not threads), and the
   wake adapters' WS/event assumptions — a multi-day rewrite, not a small patch. Not worth doing
   preemptively.

## Key takeaways for Agentcy

- Mattermost Team Edition remains the right infrastructure choice for this project's actual
  constraints (one human, localhost, threads-first, small footprint, already built and verified).
- The single documented gap is that **read-only/announcement channel enforcement is a paid-plan
  feature**, not a Team-Edition one — today's "agents post, human reads" channels rely on
  convention and MCP-side guards, which is fine for now but should be named explicitly in
  design.md rather than implied, and revisited with mitigation #2 (a small enforcer bot) before
  onboarding a second human or any less-trusted agent.
- Zulip is the platform to re-evaluate if reply-threading needs ever shrink relative to
  "durable subject line, many agents post into it over days" needs (which is closer to how
  Forgejo tickets already work) — but it is not worth switching to today given the threading
  mismatch and 10x RAM cost.
- Matrix is the right target only if/when Agentcy needs true federation across independently-run
  servers; for one operator's own machines connecting by URL (Q13), it adds appservice/E2EE
  operational overhead without buying us anything we don't already get from Mattermost's
  URL-configurable Docker Compose setup.
- Rocket.Chat, Revolt/Stoat, Campfire, and Discourse were all checked and rejected for this use
  case for concrete reasons above (relicensing/gating uncertainty, small-team risk, no
  bot-multi-identity model, and forum-first model respectively) rather than by default.
- Treat "2025-2026 agent-native chat servers" (Agent-Native Chat, AgentsChat) as a category to
  watch, not adopt — too early-stage to have the file/search/reactions/permission maturity
  Agentcy already depends on.
