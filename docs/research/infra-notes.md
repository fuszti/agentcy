# Agent Office — infrastructure notes

Report for **Task A — infrastructure + platform clients + bootstrap**.

## What was built

- `infra/docker-compose.yml` — project `agent-office`, services:
  - `postgres:16-alpine` for Mattermost (data in `infra/data/postgres`).
  - `mattermost/mattermost-team-edition:11.11.1` on `127.0.0.1:8065` (container port 8065). Team Edition, local mode enabled, telemetry disabled, open server off, rate limiting off, API post edit/delete enabled.
  - `codeberg.org/forgejo/forgejo:16.0.5` on `127.0.0.1:3033` HTTP and `127.0.0.1:2222` SSH, SQLite backend.
- `infra/.env.example` — template for the generated `infra/.env`.
- `src/lib/config.ts` — repo-root discovery, atomic JSON writes, `state/office.json` + `state/agents/<name>/agent.json` helpers.
- `src/lib/mattermost.ts` — typed Mattermost REST v4 client + WebSocket listener (auto-reconnect, resolves mentions to usernames).
- `src/lib/forgejo.ts` — typed Forgejo (Gitea-compatible) REST client.
- `src/cli/bootstrap.ts` — idempotent bootstrap, agent identity creation/retirement.
- `scripts/check-history-limit.ts` — posts 10,050 messages and verifies the oldest post is still retrievable.
- `test/integration/platform.test.ts` — vitest integration test (skipped unless `OFFICE_INTEGRATION=1`).

## How to use

```bash
# Start / reset the whole stack and create the human admin accounts
npx tsx src/cli/bootstrap.ts

# Run integration tests
OFFICE_INTEGRATION=1 npx vitest run test/integration/platform.test.ts

# History-limit smoke test
npx tsx scripts/check-history-limit.ts
```

The stack is left running after bootstrap. Credentials are stored in `state/office.json` (gitignored, chmod 600).

## Verified versions

| Service | Image | Runtime version |
|---|---|---|
| Mattermost | `mattermost/mattermost-team-edition:11.11.1` | 11.11.1 (Build 35958890150) |
| Forgejo | `codeberg.org/forgejo/forgejo:16.0.5` | 16.0.5+gitea-1.22.0 |
| Postgres | `postgres:16-alpine` | 16-alpine |

Tags were verified by pulling them before use.

## Verification results

### Bootstrap idempotency

Ran `npx tsx src/cli/bootstrap.ts` twice. The second run reused the existing human accounts, regenerated the Forgejo admin access token, and reported success:

```
Agent Office bootstrapped.
Mattermost: http://127.0.0.1:8065
Forgejo:    http://127.0.0.1:3033
Human user: owner
Team:       office
Org/repo:   office/tasks
```

### Integration test

```bash
OFFICE_INTEGRATION=1 npx vitest run test/integration/platform.test.ts
```

Result:

```
Test Files  1 passed (1)
     Tests  3 passed (3)
  Duration  9.86s
```

Covered:
- Creating agents `itest-a` and `itest-b`.
- `itest-a` posts `@itest-b` in `#office`; `itest-b`'s WebSocket receives the mention.
- Thread reply and full thread read-back.
- Direct message between agents.
- Forgejo issue creation, assignment to `itest-b`, notification delivery, comment, and close.

### History-limit check

```bash
npx tsx scripts/check-history-limit.ts
```

Result:

```
Total posts:            10050
Post elapsed:           52.8s (190.2 posts/s)
Retrieve by id:         OK (14ms)
Retrieve by page:       OK (37ms)
Retrieve by search:     OK (6ms)
VERDICT: No 10k cap observed
```

The oldest post was retrievable by id, by channel paging (using `per_page=200`), and by search. This confirms Mattermost **Team Edition** does **not** enforce a 10,000-message history cap.

### Resource usage

After the final history check:

```
CONTAINER ID   NAME                      CPU %   MEM USAGE / LIMIT
agent-office-postgres     0.06%   114.2MiB / 15.55GiB
agent-office-mattermost   0.02%   195.8MiB / 15.55GiB
agent-office-forgejo      0.07%   119.2MiB / 15.55GiB
```

## Notes / open issues

- The Mattermost container runs as `user: "0:0"` (root inside the container) because the distroless image cannot `chown` bind-mounted host directories. This is acceptable for the local prototype but should be hardened for a shared server.
- The Mattermost healthcheck uses `mattermost db ping` because the distroless image does not include `wget` or `curl`.
- `src/mcp/server.ts` and `src/cli/office.ts` currently do **not** type-check because they depend on modules (`./policy.js`, `../lib/harness/opencode.js`, etc.) that are outside the scope of this task. The files built for Task A type-check independently.
- Forgejo issue create/update/set-labels APIs accept label **IDs**, so `ForgejoClient.createIssue` and `setLabels` resolve names to IDs internally.
- Mattermost WebSocket `posted` events deliver mention lists as user IDs; `connectWebSocket` resolves them to usernames before invoking the callback.
