# Knowledge accumulation, fork & merge — research notes

*Research pass for Agentcy's memory/fork/merge design (§4.7–4.9 of `docs/design.md`,
"expertise loop" in `templates/office-rules.md`). Today: 2026-09-28. Claims below are marked
`[unverified]` where I could not confirm them against a primary source; everything else is
sourced inline.*

## 1. How persistent agents accumulate expertise

**The consensus 2025–2026 framing.** Long-running agents don't get better by having a bigger
context window; they get better by having a *governed*, structured place to put durable
knowledge outside the transcript, plus a process that writes to it deliberately rather than by
accumulation. Mem0's 2026 state-of-memory report frames this explicitly: memory is now "a
first-class architectural component with its own benchmark suite... and a measurable performance
gap between approaches" ([Mem0, state-of-ai-agent-memory-2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).

**Memory-block architectures (Letta/MemGPT).** MemGPT's original contribution was treating
context as an OS-style memory hierarchy: fixed, always-resident "core memory" blocks (e.g.
persona, human) versus recall/archival storage the agent pages in via tool calls
([Letta, memory-blocks](https://www.letta.com/blog/memory-blocks/)). Letta's *sleep-time compute*
extends this with a second, idle-time agent that reorganizes and rewrites shared memory blocks
without blocking the primary agent's turn ([Letta, sleep-time-compute](https://www.letta.com/blog/sleep-time-compute/)).
This is close to Agentcy's proposed "librarian" — the useful precedent is that curation is
explicitly a *separate* agent/process from the one doing task work, not something the working
agent is expected to do well as a side effect of its main job.

**Mem0.** Extracts, updates and retrieves discrete memory facts via LLM-driven tool calls rather
than storing raw transcripts; on the LOCOMO benchmark it beats prior baselines by 5–11% on
single-hop/temporal/multi-hop QA while cutting p95 latency >90% versus full-context baselines
([Mem0 paper, arXiv:2504.19413](https://arxiv.org/pdf/2504.19413)). The load-bearing idea for
Agentcy: incremental extract-then-update, not append-then-summarize.

**Zep/Graphiti.** A temporal knowledge graph where every edge carries a validity interval
(`t_valid`/`t_invalid`); when a fact changes, the old edge is invalidated rather than deleted, so
the agent is never stuck choosing between a stale and current fact
([Zep paper, arXiv:2501.13956](https://arxiv.org/abs/2501.13956); [Graphiti/Neo4j](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)).
This bi-temporal, invalidate-don't-delete pattern is the cleanest existing answer to "what should
conflict resolution look like" and maps directly onto a markdown memory file if you're willing to
timestamp and strike through instead of silently deleting lines.

**A-MEM.** Applies a Zettelkasten-style approach: each new memory note gets structured metadata
(context, keywords, tags) and is dynamically linked into existing notes, rather than stored as an
isolated blob. Reports up to 6x improvement on multi-hop reasoning and 85–93% less memory-op
token usage than baselines ([A-MEM, arXiv:2502.12110](https://arxiv.org/abs/2502.12110)). Relevant
to Agentcy's wiki: cross-linking notes (rather than one flat memory.md) is what made retrieval
cheap and accurate in their evals.

**ACE (Agentic Context Engineering).** Names the two failure modes Agentcy most needs to avoid.
*Context collapse*: repeatedly rewriting/summarizing a context each cycle strips out
domain-specific detail until nothing useful is left. *Context rot*: performance degrades
continuously as token count grows, not just at the context limit — confirmed independently by
Chroma's 2025 "Context Rot" study across 18 frontier models. ACE's fix is a three-role pipeline —
Generator (produces trajectories), Reflector (distills concrete insights), Curator (integrates
insights as *structured, incremental* updates rather than full rewrites) — giving +10.6% on
agentic benchmarks and +8.6% on finance tasks over strong baselines
([ACE, arXiv:2510.04618](https://arxiv.org/abs/2510.04618); [Chroma, Context Rot](https://research.trychroma.com/context-rot) `[secondary source, not directly fetched]`).
The Generator/Reflector/Curator split is essentially "worker agent / self-review / librarian" and
is the strongest single piece of evidence for giving Agentcy a distinct curator role rather than
asking the working agent to self-curate memory.md inline, as today's office-rules.md does.

**Dynamic Cheatsheet.** A much simpler test-time-only mechanism: a persistent, evolving scratchpad
of strategies/code snippets that a second "curator" prompt updates after each task, with no
fine-tuning. Reported results include Claude 3.5 Sonnet's AIME accuracy more than doubling and
GPT-4o's Game-of-24 success rate rising from 10% to 99% once it could store and reuse a working
solution ([Dynamic Cheatsheet, arXiv:2504.07952](https://arxiv.org/abs/2504.07952)). This is
essentially a minimal, low-effort version of memory.md curation and is a good "cheap floor" for
what Agentcy already does.

**ReasoningBank.** Distills *generalizable reasoning strategies* (not raw trajectories, not only
successful routines) from both successes and self-judged failures, retrieves relevant ones at
test time, and folds new learnings back in; combined with memory-aware test-time scaling (MaTTS)
it beats memory systems that store raw trajectories or success-only routines on web-browsing and
SWE benchmarks ([ReasoningBank, arXiv:2509.25140](https://arxiv.org/abs/2509.25140)). Two points
transferable to Agentcy: (a) storing *failures* with their lesson is as valuable as storing
successes — memory.md and journal.md today skew toward "what I did," not "what I got wrong and
why"; (b) raw trajectory storage underperforms distilled strategy storage, which argues against
ever replaying a whole fork transcript into memory.md verbatim.

**Voyager.** The original "growing skill library" pattern for embodied agents: an
embedding-indexed library of executable skills, where a successful solution is stored and the
top-k relevant skills are retrieved and injected for new tasks; this alone tripled item discovery
in Minecraft without any fine-tuning ([Voyager, arXiv:2305.16291](https://arxiv.org/abs/2305.16291)).
Directly analogous to a per-agent or shared "playbook" of reusable procedures (e.g. how to
triage a Forgejo ticket, how this repo's CI works) distinct from the free-text memory.md.

**Claude Code auto-memory / Skills, opencode Skills (2025–2026).** Claude Code ships a
`/memory` auto-memory mode where the harness itself decides what corrections/preferences to
persist, plus a newer "Auto Dream" consolidation pass that runs periodically over the memory
directory and normalizes relative dates to absolute ones (so "yesterday we decided X" becomes
"On 2026-03-15 we decided X") specifically to prevent temporal confusion as memories age
([Claude Code memory docs](https://code.claude.com/docs/en/memory); [claudefa.st, auto-dream](https://claudefa.st/blog/guide/mechanics/auto-dream) `[secondary/blog source]`).
Agent Skills became a cross-platform open standard (SKILL.md) in Dec 2025, adopted by both Claude
Code and opencode, letting a single skill file work across harnesses
([firecrawl.dev, opencode skills](https://www.firecrawl.dev/blog/best-opencode-skills)). This is
relevant background for Agentcy's mixed Claude/opencode office: shared, harness-agnostic
SKILL.md files are a natural home for procedural "how we work" knowledge that today lives only
in `brain/wiki/how-we-work.md` prose.

**What measurably helps vs. what causes rot (synthesis across the above).**
Helps: incremental/structured updates instead of full rewrites (ACE); explicit provenance and
timestamps rather than flattened facts (Zep, A-MEM); separating extraction/curation from the
task-doing agent (Letta sleep-time, ACE Curator); storing distilled strategies/lessons rather than
raw transcripts (ReasoningBank, Dynamic Cheatsheet); decay/half-life on unverified facts rather
than permanent retention (SSGM framework, below). Causes rot: naive summarize-in-place each cycle
(context collapse); unbounded append-only logs read back in full every session (this is
Agentcy's current `journal.md` pattern — append-only by design, per §4.7); merging raw transcripts
into long-term memory without distillation; keeping contradicting facts without invalidation
markers.

**Curation strategies in the literature.** A 2026 survey frames memory curation as
distinguishing *validated* knowledge (backed by task outcome) from unvalidated notes, and treats
consolidation as its own operation (abstraction, dedup, restructuring, archival) run periodically,
not per-write ([Hindsight, "The Consolidation Problem in Agent Memory"](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation)).
The "Stability and Safety Governed Memory" (SSGM) framework proposes confidence-decay by
half-life applied at *read* time (not destructively at write time), so old unverified facts lose
influence but remain auditable ([SSGM, arXiv:2603.11768](https://arxiv.org/pdf/2603.11768)).
Practical conflict-resolution guidance converges on three cases — temporal supersession (newer
replaces older), explicit correction (marked wrong), and contextual coexistence (both true in
different contexts) — with "recency wins, but mark the old fact invalid rather than deleting it"
as the defensible default, matching Zep's invalidate-don't-delete edges
([provenance/conflict synthesis, arXiv:2606.22030](https://arxiv.org/html/2606.22030v2)). The
same literature repeatedly flags **provenance collapse** — consolidation is lossy by design and
strips the ability to trace a fact back to its origin, which becomes a problem exactly when that
fact is later challenged — as the main audit failure mode to design against.

## 2. Fork & merge

**Letta Agent File (.af).** An open serialization format for a full agent's state — model config,
message history, system prompt, memory blocks, tool rules — so an agent can be exported, shared,
and re-instantiated with identical behavior and memories on another Letta server
([agent-file README](https://github.com/letta-ai/agent-file); [Letta docs](https://docs.letta.com/guides/core-concepts/agent-file)).
This is a **clone/checkpoint** primitive, not a merge primitive — .af has no notion of reconciling
two divergent agents' state back together. That gap is exactly what Agentcy's `office merge` has
to invent itself; there is no off-the-shelf agent-merge tool to borrow from Letta.

**OpenAI Responses API forking.** Branching via `previous_response_id` (and a `stream_id` for
concurrent lanes) lets you fork execution at any prior turn to explore alternative paths without
re-sending history — but multiple 2026 sources note this parallel-branching mechanism is not
actually present in the public OpenAI SDK as of writing, so treat the API-level claims here as
`[unverified / possibly aspirational docs]` ([community + course pages](https://theneuralbase.com/openai-responses-api/learn/advanced/conversation-forking/)).
Conceptually still useful: it treats forking as *branching a linear history*, with no merge-back
operation defined at all — same gap as Letta. Claude Code's own `--fork-session` (the mechanism
Agentcy already uses per §4.8) and opencode's session `/fork` are both **fork-without-merge**
primitives in production tools today; opencode's GitHub issues confirm users are actively
requesting the missing pieces (forking from an assistant message, a CLI flag for automation,
visibility into which skills a forked session inherited) — i.e. the ecosystem hasn't solved this
yet either ([opencode issue #21341](https://github.com/anomalyco/opencode/issues/21341), [#11137](https://github.com/anomalyco/opencode/issues/11137)).
**Conclusion: Agentcy's merge step (condense transcript + inject as `<office-merge>` + 3-way
`git merge-file` on memory.md) is not a reimplementation of an existing pattern — it appears to be
one of the few concrete "merge agent experience back" designs attempted anywhere**, which is
worth stating plainly rather than assuming there's a reference implementation to align with.

**Model merging as an analogy, not a mechanism.** Weight-space model merging (task-vector
arithmetic, averaging fine-tuned checkpoints) is a mature technique for combining *parametric*
skill ([survey](https://futureagi.com/glossary/model-merging/)), and a 2026 paper on
Agent-Role Merging explicitly does "conflict-aware transplantation of role-salient neurons" to
consolidate benchmark-specialized agents into one generalist checkpoint while correcting for
overlap ([ARM, arXiv:2601.07309](https://arxiv.org/pdf/2601.07309)). The transferable idea, even
though Agentcy has no weights to merge, is **conflict-aware, salience-weighted merging** rather
than naive concatenation: ARM's "Activation-Overlap Score" is analogous to asking "does ada-2's
new memory line actually conflict with or duplicate something ada already believes" before
splicing it in — which `git merge-file`'s line-based 3-way merge cannot detect (it merges text,
not meaning).

**What "merging experience" should mean.** Synthesizing ReasoningBank + ACE + ARM: merging should
(a) merge *distilled lessons/strategies*, never raw transcripts, because raw-trajectory reuse
underperforms distilled strategy reuse and bloats the target session's context (ReasoningBank);
(b) be conflict-aware at the semantic level, not just line-based (ARM, Zep's
invalidate-don't-delete); (c) preserve provenance — a merged memory.md line should be traceable to
which fork/agent/date produced it, or it becomes unauditable exactly when it's later found wrong
(provenance-collapse literature above). Agentcy's current design gets (a) partially right (it
condenses long transcripts with a cheap model before replay) but does nothing for (b) or (c): the
transcript replay goes into the live session as raw prose for the agent to "integrate as its own
experience" with no distillation step, and the memory.md 3-way merge has no conflict-awareness
beyond git's line-level diff, and no provenance tagging at all.

**Failure modes to watch for**, drawn directly from the literature above plus first-principles
reasoning about Agentcy's design:
- **Contradiction**: fork and parent independently update memory.md with conflicting claims
  about the same fact; `git merge-file` either silently picks one side or produces a conflict
  marker the agent may not resolve correctly. Zep's answer (invalidate, don't overwrite) has no
  analogue in a flat markdown file with line-based merge.
- **Duplicated commitments**: if a fork acted on a ticket and the parent, unaware, later acts on
  the "same" ticket post-merge, the transcript replay can make the parent believe it already
  knows something it hasn't actually verified itself, or double-count a decision. This is the
  provenance-collapse failure specifically: the merged experience reads like the parent's own
  memory with no marker that it's secondhand.
- **Identity confusion**: office-rules.md tells a fork "your new name is yours," but the merge
  step replays the fork's transcript into the parent's session framed as `<office-merge
  from="ada-2">`, asking the parent to "integrate it as its own experience." Nothing in the
  design distinguishes *I did this* from *ada-2 did this and I am now folding in the lesson* — the
  same ambiguity ARM addresses at the neuron level and ReasoningBank addresses by storing a
  strategy plus its outcome rather than a first-person trajectory.
- **Context rot from the merge injection itself**: injecting a condensed-but-still-substantial
  transcript block into a live session is exactly the kind of one-time large context injection
  that Chroma's Context Rot findings suggest degrades subsequent turns' quality, independent of
  whether the content is "true."

## Recommendations for Agentcy

Ranked by value/effort (highest first):

1. **Tag every memory.md line with provenance and a date, retire silent overwrites in favor of
   strike-through/invalidate.** (High value, low effort.) Adopt Zep's pattern in
   markdown: `- [2026-09-28, from merge:ada-2] <fact>` and `~~[stale as of 2026-10-02]~~ <old
   fact>` instead of deleting on edit. This alone would close the biggest gap between current
   design (curated by the agent, "edit and dedupe; don't just append" — office-rules.md line 75 —
   with no provenance requirement) and the literature's consensus that provenance collapse is the
   main audit failure. Directly actionable in `templates/office-rules.md` and the merge script.

2. **Split "curator" from "worker" — give the librarian role from §6 of design.md a concrete job
   before shift change or merge, not just as an idle backlog item.** (High value, medium effort.)
   Mirrors Letta sleep-time compute and ACE's Reflector/Curator split, both of which show
   curation quality drops when the task-doing agent is also responsible for editing its own
   memory under time pressure. Concretely: a scheduled or shift-change-triggered pass (could be a
   cheap-model subagent, matching the merge condenser Agentcy already has) that reviews one
   agent's memory.md diff since last curation, flags contradictions against the wiki and other
   agents' memory files, and dedupes — before the agent's own edit is trusted as final.

3. **On merge, distill before replaying — never inject a raw (even condensed) transcript as
   "your own experience."** (High value, medium effort.) Change §4.8's merge step so the
   cheap-model condensation step produces *ReasoningBank-style* strategy+outcome entries ("tried
   X, failed because Y, use Z instead") rather than a narrative transcript summary, and inject
   those, clearly marked as secondhand (`<office-merge from="ada-2" as="lesson">`), rather than
   framed as "integrate this as your own experience." This directly targets the identity-confusion
   and duplicated-commitment failure modes above and reduces the one-shot context-rot risk of a
   large injected block.

4. **Make shift-change context-percentage-triggered, not just manual.** (Medium value, low
   effort — design.md §6 already lists "automatic shift change on context size" as a known gap.)
   Given Context Rot's finding that degradation is continuous from early in the context, not just
   near the limit, a conservative trigger (e.g. shift at 60–70% context usage, not 90%+) is
   better justified than waiting for near-exhaustion. `bin/office status`'s existing context-usage
   % column is already the input this trigger needs.

5. **Add a lightweight semantic-conflict check to the memory.md 3-way merge**, e.g. having the
   merging agent (or a cheap-model pass) re-read the merged memory.md specifically for
   contradictions before committing, rather than trusting `git merge-file`'s line-level result.
   (Medium value, medium effort.) This is the ARM "conflict-aware" idea applied to text instead of
   weights; git merge-file cannot detect that two non-conflicting lines assert incompatible facts.

6. **Instrument "does expertise actually accumulate" before investing further**, since none of
   the above is verifiable without a metric. (Medium value, low effort — mostly logging that
   should exist anyway.) Concretely track, per agent, over time: (a) repeat-mistake rate — does
   the same class of error (tagged in journal.md) recur after it was supposedly captured in
   memory.md; (b) memory.md size and dedup ratio over shift changes, to catch unbounded
   append-and-never-curate growth; (c) time-to-resolution on repeat-shaped tickets before vs.
   after a relevant memory.md entry exists; (d) post-merge contradiction count (how often the
   librarian/conflict-check in #5 actually finds something). None of these require new
   infrastructure beyond parsing existing journal/memory/git history — they just need to be
   computed and reviewed periodically, e.g. by the same librarian role from #2.

7. **Consider a Voyager-style separate "playbook" file for reusable procedures**, distinct from
   memory.md's free-text learnings — e.g. `brain/agents/<name>/playbook.md` or a shared
   `brain/wiki/playbooks/` for procedures like "how to triage a Forgejo ticket in this repo."
   (Lower value given current scale, low-medium effort.) Worth doing once the wiki has enough
   entries that retrieval, not writing, becomes the bottleneck — premature at Agentcy's current
   single-operator scale, but cheap to start structuring for now.

## Sources

- Letta, [Memory Blocks](https://www.letta.com/blog/memory-blocks/); [Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute/); [Agent File README](https://github.com/letta-ai/agent-file); [Agent File docs](https://docs.letta.com/guides/core-concepts/agent-file)
- Mem0, [Building Production-Ready AI Agents with Scalable Long-Term Memory, arXiv:2504.19413](https://arxiv.org/pdf/2504.19413); [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- Zep, [A Temporal Knowledge Graph Architecture for Agent Memory, arXiv:2501.13956](https://arxiv.org/abs/2501.13956); [Graphiti overview, Neo4j](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- A-MEM: Agentic Memory for LLM Agents, [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)
- Agentic Context Engineering (ACE), [arXiv:2510.04618](https://arxiv.org/abs/2510.04618)
- Dynamic Cheatsheet: Test-Time Learning with Adaptive Memory, [arXiv:2504.07952](https://arxiv.org/abs/2504.07952)
- ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory, [arXiv:2509.25140](https://arxiv.org/abs/2509.25140)
- Voyager: An Open-Ended Embodied Agent with LLMs, [arXiv:2305.16291](https://arxiv.org/abs/2305.16291)
- Claude Code, [Memory docs](https://code.claude.com/docs/en/memory); Auto Dream overview, [claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-dream) `[secondary]`
- opencode fork feature requests: [#21341](https://github.com/anomalyco/opencode/issues/21341), [#11137](https://github.com/anomalyco/opencode/issues/11137); [opencode skills, firecrawl.dev](https://www.firecrawl.dev/blog/best-opencode-skills)
- OpenAI Responses API branching (status unverified against SDK), [theneuralbase.com course pages](https://theneuralbase.com/openai-responses-api/learn/advanced/conversation-forking/)
- Model merging survey, [futureagi.com](https://futureagi.com/glossary/model-merging/); Agent-Role Merging (ARM), [arXiv:2601.07309](https://arxiv.org/pdf/2601.07309)
- Context Rot: Salesforce explainer, [salesforce.com](https://www.salesforce.com/artificial-intelligence/ai-context/context-rot/); Chroma technical report (cited secondhand, not directly fetched)
- Memory consolidation / provenance / decay: [Hindsight, Consolidation Problem](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation); SSGM framework, [arXiv:2603.11768](https://arxiv.org/pdf/2603.11768); conflict-resolution/provenance synthesis, [arXiv:2606.22030](https://arxiv.org/html/2606.22030v2)
