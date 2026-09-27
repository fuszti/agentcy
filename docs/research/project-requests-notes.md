# Task K — agents can create new projects themselves

## What was built

Added agent-initiated project creation (`office_create_project`) to the office MCP, with bounded, auditable self-approval.

### Files changed
- `src/lib/types.ts`
  - `RequestType` now includes `'project'`.
  - `SelfManagementConfig` gained `autoApproveProject`, `maxActiveProjects`, `maxNewProjectsPerAgentPerDay`.
  - `ProjectRecord` gained optional `createdBy`.
- `office.config.json`
  - `selfManagement.autoApproveProject: true`
  - `selfManagement.maxActiveProjects: 10`
  - `selfManagement.maxNewProjectsPerAgentPerDay: 2`
- `src/lib/project-requests.ts` (new)
  - Pure helpers: `validateProjectRequestArgs`, `validateProjectRequest`, `countActiveProjects`, `countProjectsCreatedTodayByAgent`, `formatProjectCreatedFyi`, `formatProjectCreatedNotice`.
- `src/mcp/server.ts`
  - New tool `office_create_project({ name, description, members?, reason })`.
  - Validates name, checks project existence, active cap and per-agent daily cap, then writes a signed request auto-approved or pending.
- `src/admin/daemon.ts`
  - `argvForRequest` now builds `office project new ... --created-by <agent>` for `type: 'project'`.
  - On successful execution, posts the 📁 FYI in `#office-admin` and queues a signed system prompt to the requester with repo URL, clone URL and channel.
  - Approval prompt and `requests` list render project requests.
- `src/cli/office.ts`
  - `office project new` accepts `--created-by <agent>` and records it in the project registry.
- `templates/office-rules.md`
  - Added the "Need a new project?" guidance under **Projects and code**.
- `test/project-requests.test.ts` (new)
  - Tests for argument validation, active cap, daily cap, auto-approve vs pending, FYI and notice formatting.

## Verification

### Static checks
```
npx tsc --noEmit                 # passed
npx vitest run test/project-requests.test.ts test/requests.test.ts test/projects.test.ts test/admin.test.ts
# 45 passed
```

The full `npx vitest run` also passes all office tests; 3 unrelated agent workspace test files fail because they are not Vitest suites.

### Live end-to-end check
The office was live with 5 agents. The running admin daemon was the pre-change binary, so the first test request failed with `unknown request type`. Following the task instruction, I restarted only the console:

```
bin/office admin-stop
bin/office start
```

Then wrote a signed request as `webre` for `zz-selfcreate-test` using `src/lib/requests.ts` helpers.

Confirmed:
- Request executed by the daemon and reached `status: "done"`.
- Project registry `state/projects/zz-selfcreate-test.json` created with `"createdBy": "webre"`.
- Repo `office/zz-selfcreate-test` created in Forgejo.
- Mattermost channel `#proj-zz-selfcreate-test` exists.
- FYI post appeared in `#office-admin`: `📁 @webre created project \`zz-selfcreate-test\`: ...`.
- Signed system prompt delivered to `state/agents/webre/inbox/...req-req_fe7ad9b1cef74ab397a80baaaaf19ce1.md.delivered` containing repo URL, clone URL and channel.

After verification, archived the test project:

```
bin/office project archive zz-selfcreate-test
```

It now shows as `[archived]` in `office project list`.

## Notes / open issues
- The daemon must be restarted after this code change for project request execution to work. The live check confirmed that; agents did not need restarting.
- The per-agent daily cap counts calendar days in UTC (the `createdAt` timestamp's date part). This matches the existing request machinery and is deterministic.
- `office_create_project` rejects attempts before writing a request, so invalid/excessive requests never pollute `state/requests/`.
