# Admin channel notes — Task F

## What was built

- `office.config.json` + `src/lib/types.ts`: added `adminChannel: "office-admin"` and an optional `officeBot?: { userId; token }` field in `OfficeSecrets`.
- `src/cli/bootstrap.ts`: idempotent bootstrap now creates the `office` bot (display "Office") with an access token, joins it to the team, creates the private `office-admin` channel, and ensures only the owner and the bot are members.
- `src/admin/commands.ts`: pure helpers for the chat-ops console:
  - `parseCommandLine` with shell-like quoting, optional `office ` / `!` prefix, and an allow-list.
  - `renderStatusMarkdown` for the Mattermost-renderable status table.
  - `helpText` markdown help.
- `src/admin/daemon.ts`: WebSocket daemon that runs as the `office` bot in `#office-admin`.
  - Listens only to new posts/thread replies from the owner in `#office-admin`.
  - Adds an `hourglass_flowing_sand` reaction, runs one command at a time (15 min timeout, queue for the rest), replies in the thread with ANSI-stripped output in a code block (status is posted as a markdown table), and replaces the reaction with `white_check_mark` / `x`.
  - Posts "Office console online. Type `help`." on startup.
  - Logs to `state/admin.log`.
  - Watches agent status files every 30 s and posts one-line alerts for dead windows or `blocked` > 2 min (once per incident).
- `src/cli/office.ts`: wired in `admin`, `admin-stop`, ensured the admin window is alive on `start`, added `status --md`, and kept `stop --all` from touching the admin window.
- `src/lib/mattermost.ts`: added `getChannelMembers` and `removeReaction`.
- `test/admin.test.ts`: unit tests for the parser and markdown status renderer.
- README.md: added an "Admin channel" section and updated the commands table.

## Verification

### Type-check and unit tests

```
npx tsc --noEmit           # no errors
npx vitest run             # 85 passed, 4 skipped, 1 skipped integration file
```

### Live stack

- Ran `bin/office init` (idempotent; agents left running).
- Ran `bin/office start` — admin window started:

```
admin: started
ada: already running
kim: already running
```

- Confirmed the admin channel is private and has only two members:

```json
["o9ycp4iyxpyyubedfh3fikym4h", "op4i8511gifz3brjzx8iui8ubo"]
```

(owner and the `office` bot).

- Posted `status` as the owner via `POST /api/v4/posts`. The daemon replied in the thread with the markdown table and `✅ exit 0`:

```
| Name | Harness | Model | Status | Window | State | Since | Pending | Session | Fork |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ada | claude | sonnet | hired | up | idle | 21:29:37 | 0 | ef757a37-7d0a |  |
| kim | opencode | opencode-go/kimi-k2.7-code | hired | up | idle | 21:19:37 | 0 | ses_f2618ee3e |  |

chat: http://127.0.0.1:8065   tickets: http://127.0.0.1:3033   sessions: tmux attach -t office

✅ exit 0
```

- Posted `help` as the owner. The daemon replied with the markdown help list (truncated):

```
Available office commands (prefix with `office ` or `!`):

- **help** — show this list
  - `help`
- **status** — agent windows, idle/busy/blocked, pending prompts
  - `status`, `status --all`
- **hire** — add a new agent
  - `hire <name> [--harness claude|opencode] [--model M] [--focus "..."]`
...
- **say** — post as the owner
  - `say "<text>" [--channel c] [--thread id]`
```

- Confirmed `bin/office status --md` prints the same markdown table from the CLI:

```
| Name | Harness | Model | Status | Window | State | Since | Pending | Session | Fork |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ada | claude | sonnet | hired | up | idle | 21:29:37 | 0 | ef757a37-7d0a |  |
| kim | opencode | opencode-go/kimi-k2.7-code | hired | up | idle | 21:19:37 | 0 | ses_f2618ee3e |  |

chat: http://127.0.0.1:8065   tickets: http://127.0.0.1:3033   sessions: tmux attach -t office
```

## Open issues / notes

- The daemon uses `bin/office` directly via `spawn` with an argv array; no shell is invoked for command execution, satisfying the security requirement.
- The `help` command is handled directly by the daemon (it does not spawn `bin/office help`), because the CLI's built-in usage text is not formatted as the requested short markdown list.
- `office stop --all` only iterates hired agent records, so the `admin` tmux window is never touched.
- `readStatus` is imported from the Claude harness module; it works for opencode agents because both write the same `status.json` shape, but a shared status reader would be cleaner.
