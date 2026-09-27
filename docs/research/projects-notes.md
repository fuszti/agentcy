# Task J — Multi-project company: notes and verification

Completed 2026-09-26. The colleague's uncommitted work (project registry, CLI, Forgejo branch/PR methods, policy systemUsernames, office rules) was kept and extended.

## What was built

1. **Project registry + CLI** (`src/lib/projects.ts`, `src/cli/office.ts`)
   - Registry in `state/projects/<name>.json` with name validation (lowercase, digits, hyphens, ≤ 40 chars).
   - `office project new|list|staff|archive` create the repo, labels, branch protection, `#proj-<name>` channel, brain folder and registry record.
   - Project creation now also adds the office admin bot to the channel so the dispatcher can post there.

2. **MCP project/code tools** (`src/mcp/server.ts`)
   - `project_list`, `project_join`, `project_leave`
   - `repo_clone` — clones/fetches the project repo in the agent's workspace
   - `pr_create`, `pr_list`, `pr_get`, `pr_diff`, `pr_review`, `pr_merge`
   - `ticket_*` tools now accept `project` as an alternative to `repo`
   - `office_directory` includes each colleague's projects
   - Ticket events for Pull notifications now say "PR … review requested / commented / approved / changes requested"

3. **Admin dispatcher** (`src/admin/dispatcher.ts`, wired into `src/admin/daemon.ts`)
   - Polls every 30 s.
   - Announces new unassigned issues and PRs without reviewers in `#proj-<name>`.
   - Tracks first-seen time per project and already-announced ids so it doesn't spam.

4. **Office rules** (`templates/office-rules.md`)
   - Added "Projects and code" section describing repo + channel + ticket workflow.

5. **Tests**
   - `test/projects.test.ts` — registry validation and persistence
   - `test/dispatcher.test.ts` — dispatcher announcement logic
   - `test/policy.test.ts` — system username room-request detection
   - `test/forgejo.test.ts` — PR fields, reviewer request body, merge body, APPROVE→APPROVED mapping

6. **Docs**
   - README: Projects section + console command table
   - `docs/design.md` §2: Q15–Q18 decisions

## Bug found and fixed during live check

The MCP `pr_review` tool originally sent Forgejo review event `APPROVE`. In our Forgejo 10.x this created a **PENDING** review instead of an approval. The correct event is `APPROVED`. `submitReview` in `src/lib/forgejo.ts` now maps `APPROVE` → `APPROVED`; `REQUEST_CHANGES` and `COMMENT` are sent unchanged and work.

Also, the `pr_get` tool originally called the separate `/pulls/{n}/requested_reviewers` endpoint, which returns **404** in this Forgejo build. Requested reviewers are now read from the PR object itself (`requested_reviewers` field), which Forgejo returns.

## Live verification: hello-agents project

Agents involved: `@kim` (opencode, Kimi K2.7 Code) and `@rex` (opencode, DeepSeek V4 Pro).

### Setup

```bash
bin/office hire rex --harness opencode --model opencode-go/deepseek-v4-pro --focus "code review, testing"
bin/office project new hello-agents --desc "Tiny demo project for the office workflow" --members kim,rex
bin/office restart kim rex
```

### Ticket and PR

Created issue http://127.0.0.1:3033/office/hello-agents/issues/1 assigned to kim:

> Add scripts/hello.sh that prints 'hello from the agent office' and a README section 'Usage' describing it. Open a PR and get it reviewed by @rex.

Timeline:

1. **01:43:07** — kim notified of assigned ticket.
2. **01:43:48** — kim opened PR http://127.0.0.1:3033/office/hello-agents/pulls/2 (`kim/1-add-hello-script-readme`) requesting rex as reviewer. Body included `Closes #1`.
3. **01:44:09** — rex submitted an APPROVED review (after the first MCP attempt registered as COMMENT/PENDING; rex then used the Forgejo API directly with event `APPROVED` before the fix was deployed).
4. **01:45–01:49** — kim attempted to merge but the PR still showed 0/1 approvals because the first review was not an official approval. I nudged kim once with `bin/office prompt kim "PR office/hello-agents#2 has been approved by @rex. Please merge it..."`.
5. **After nudge** — kim merged PR #2 with squash. Branch deleted. Issue #1 auto-closed via `Closes #1`.

Final state:

- PR #2: **merged** — http://127.0.0.1:3033/office/hello-agents/pulls/2
- Issue #1: **closed** — http://127.0.0.1:3033/office/hello-agents/issues/1
- `main` contains `scripts/hello.sh` and README Usage section.

### Protection checks

1. **Direct push to main rejected** — from kim's workspace clone:

```
remote: Forgejo: Not allowed to push to protected branch main
 ! [remote rejected] main -> main (pre-receive hook declined)
```

2. **Self-approval rejected by Forgejo** — creating a test PR by kim and submitting `event: APPROVED` returned:

```json
{"message":"approve your own pull is not allowed"}
```

The MCP `pr_review` tool also refuses `APPROVE` on the author's own PR before calling the API.

### Dispatcher check

After restarting the admin daemon, a new unassigned issue (#9, "Dispatcher test issue") was announced in `#proj-hello-agents` by `@office`:

> 🎫 New ticket office/hello-agents#9: Dispatcher test issue — http://127.0.0.1:3033/office/hello-agents/issues/9. Room request: claim with 👀, then ticket_claim.

## Unit-test results

```bash
npx vitest run
# Test Files  11 passed | 1 skipped
# Tests       137 passed | 4 skipped
```

## Open issues / follow-ups

- The `requested_reviewers` endpoint is 404 in this Forgejo build; using the PR object's field is a working fallback but may need revisiting on newer Forgejo versions.
- The review-event mapping (`APPROVE`→`APPROVED`) is Forgejo-version specific. If the API changes, the mapping may need adjustment.
- The live check required one nudge for kim because the first review attempt was not registered as an official approval. After the fix, the workflow should complete without nudging.
