# Self-management tools — Task H report

## What was built

### 1. Config and types
- `office.config.json` now contains `selfManagement` (`maxAgents`, `maxForksPerAgent`, `autoApproveFork`, `autoMergeOnDone`, `allowSelfShift`) and `git` (`allowGithubPush`).
- `src/lib/types.ts` got `SelfManagementConfig`, `GitConfig`, `RequestType`, `RequestStatus`, and `OfficeRequest`.

### 2. Signed requests (`src/lib/requests.ts`)
- Requests live in `state/requests/{id}.json` and are signed with the shared inbox HMAC (`src/lib/inbox.ts`).
- `canonicalizeRequest` sorts keys at every depth so the signature is stable.
- Invalid/unsigned files are ignored when listing.

### 3. Inbox helper moved
- `queueSystemPrompt` moved from `src/cli/office.ts` to `src/lib/inbox.ts` and is now exported so the admin daemon and MCP can send signed system notices.

### 4. MCP self-management tools (`src/mcp/server.ts`)
Added five tools:
- `office_fork_self({ task, name? })` — rejects if the agent is already a fork, has too many live forks, or the office is at the agent limit. Auto-approved for opencode, pending for Claude.
- `office_fork_done({ summary })` — only for forks; writes a merge request (auto-approved when `autoMergeOnDone`).
- `office_request_shift()` — writes an auto-approved shift request when `allowSelfShift` is true.
- `office_request_hire({ name, harness, model?, focus, reason })` — always pending.
- `office_requests()` — lists the calling agent's requests.

### 5. Admin daemon request executor (`src/admin/daemon.ts`)
- Polls `state/requests` every 3 s.
- For `approved` requests, runs the matching `bin/office` command through the existing one-at-a-time queue, marks the request `done`/`failed`, posts a one-line note to `#office-admin`, and notifies the agent with a signed system prompt.
- For `pending` requests, posts once in `#office-admin` with the owner-only ✅/❌ reaction instructions and stores the approval post id.
- Polls reactions every 5 s; only the owner's `white_check_mark`/`heavy_check_mark` or `x` count.
- New console commands: `requests`, `approve <id>`, `deny <id>`.

### 6. Per-agent git identity
- `prepareAgentGitIdentity` in `src/lib/workspace.ts` writes `state/agents/<name>/git-credentials` (chmod 600), sets the workspace repo's local `user.name`/`user.email`, and returns an env prefix.
- Both harness launch commands (`claudeLaunchCommand`, `opencodeLaunchCommand`) accept and prepend the env prefix.
- The env sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` to `"<displayName> (agent)"` / `<name>@office.local`.
- It injects a Forgejo credential helper via `GIT_CONFIG_COUNT/KEY_n/VALUE_n`.
- When `git.allowGithubPush` is false, it adds `url.https://push-blocked.invalid/.pushInsteadOf` for both `https://github.com/` and `git@github.com:` and sets `GH_TOKEN=blocked-by-agent-office`.

### 7. Office rules and colleagues
- `templates/office-rules.md` added `Working in parallel`, `Working together`, and `Commits and pushes` sections.
- `writeWorkspaceInstructions` is now async and appends a `## Your colleagues` section generated from hired agents + owner, excluding the agent itself and marking forks.

### 8. Tests
- `test/requests.test.ts` covers canonicalization, signing, verification, tampering, write/load/list/update.
- `test/admin.test.ts` covers the new `parseRequestId` helper.
- All existing tests still pass.

## Verification

### Unit tests
```
npx tsc --noEmit
npx vitest run
```
Result: 95 passed, 4 skipped, 1 skipped integration file.

### Live stack — kim fork (auto-approved, auto-merged)
Command:
```bash
bin/office prompt kim "Call office_fork_self with task: reply 'fork ok' in #ag-lobby, then call office_fork_done with a one-sentence summary. Do not do anything else."
```
Evidence:
- `#ag-lobby` showed `[kim-fork] fork ok`.
- `bin/office status` briefly listed `kim-fork` and then returned to only `ada` + `kim`.
- `#office-admin` posted:
  - `✅ fork request req_912a71ba4afb41aa9842183603914176 completed for @kim`
  - `✅ merge request req_d9d5d3eda0e54958a16f1afab7d8d17d completed for @kim-fork`

### Live stack — ada fork (owner approval required)
Command:
```bash
bin/office prompt ada "Call office_fork_self with a tiny task: reply 'claude fork ok' in #ag-lobby, then call office_fork_done with a one-sentence summary. Do not do anything else."
```
Evidence:
- `#office-admin` posted: `🙋 @ada requests a fork: ... (req_fdc94794685e4abcaf7cb3322e7f737f). React ✅ to approve or ❌ to deny...`
- Added the owner's `white_check_mark` reaction via REST (`POST /api/v4/reactions`) using the admin token.
- `#office-admin` then posted:
  - `✅ fork request req_fdc94794685e4abcaf7cb3322e7f737f completed for @ada`
  - `✅ merge request req_be4fc5f78e6e48cbac06b61a18af5210 completed for @ada-3`
- `#ag-lobby` showed `[ada-3] claude fork ok`.
- `bin/office status` returned to only `ada` + `kim`.

### Git identity verification
Verified for `kim` by reconstructing the launch env from `prepareAgentGitIdentity` and using it in a scratch clone of `office/tasks`:
- `git push --dry-run` to Forgejo: exit 0, "Everything up-to-date".
- `git push --dry-run https://github.com/example/repo.git`: exit 128, redirected to `https://push-blocked.invalid/example/repo.git/` which cannot resolve.
- `gh auth status`: GH_TOKEN login failed (token invalid); the keyring-stored owner account is shown but inactive. GitHub operations would use the invalid GH_TOKEN, so the agent cannot use the owner's GitHub login.
- Workspace git config:
  - `workspaces/kim`: `user.name=Kim (agent)`, `user.email=kim@office.local`
  - `workspaces/ada`: `user.name=Ada (agent)`, `user.email=ada@office.local`
- Credential files are chmod 600.

### Colleagues section
After restarting `kim` and `ada`, both workspace instruction files contain:
```markdown
## Your colleagues
- @ada (Ada) — claude, sonnet; focus: architecture, planning, tricky debugging
- @owner (Owner) — human owner
```
and vice versa for `ada`.

## Files changed
- `office.config.json`
- `src/lib/types.ts`
- `src/lib/inbox.ts`
- `src/lib/requests.ts` (new)
- `src/lib/workspace.ts`
- `src/lib/harness/claude.ts`
- `src/lib/harness/opencode.ts`
- `src/mcp/server.ts`
- `src/admin/commands.ts`
- `src/admin/daemon.ts`
- `src/cli/office.ts`
- `templates/office-rules.md`
- `test/requests.test.ts` (new)
- `test/admin.test.ts`
- `test/opencode.test.ts`

## Notes / open issues
- The `gh auth status` output still lists the owner's keyring account as inactive. The active credential is the invalid `GH_TOKEN`, so the agent cannot actually use the owner's GitHub login. A stricter isolation would run agents in containers or with a separate `GH_CONFIG_DIR`.
- opencode forks inherit the parent's workspace directory (known v0.1 limitation); the fork still posts correctly because its MCP acts under its own identity.
- The admin daemon executes requests sequentially through the same queue used for console commands, keeping live operations cheap and safe.
