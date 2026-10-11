# Invited members (more than one human)

Status: designed, not built. Branch `feature/remote-human-login`. Build this before
[`2026-10-10-cloudflare-tunnel-design.md`](2026-10-10-cloudflare-tunnel-design.md).

## Goal

The owner can invite other people into the office. An invited **member** is a trusted
collaborator: they talk to agents in chat and work in Forgejo on the projects they were invited
to, and see nothing else. The owner stays the only person who can approve risky actions and use
the admin and finance channels.

Today the office knows exactly one human (`cfg.human`). Any other account is treated as an agent:
its posts arrive as `human="false"`, never become room requests, count as an agent claiming a
task, do not reset the runaway-thread cap and are dropped during a freeze.

## Decisions (brainstormed 2026-10-10)

| # | Decision |
|---|---|
| D1 | One new role, `member`: may ask agents for ordinary work. Only the owner authorises risky or irreversible actions. |
| D2 | A member sees only the channels they were added to. This is enforced by Mattermost, not by convention. |
| D3 | Enforcement is a permissions split on Mattermost's built-in roles. Channels stay public. Private channels everywhere and a team per group were rejected as larger rewrites. |
| D4 | A member is a full collaborator (write) on the Forgejo repos of their projects, and has no access to other repos. |
| D5 | The unit of an invitation is a project (repo + channel + member list), plus optional extra channels. |
| D6 | The owner stays `cfg.human`. Members live in a roster file, managed by the CLI. `office.config.json` does not change shape. |
| D7 | Member access is not a security boundary against the member. A member can prompt an agent that runs with the owner's shell. Invite only people you would give an account on the server. |

## Probe (2026-10-10, Mattermost Team Edition 11.11.1, dev office)

`mmctl --local permissions remove|add` edits built-in roles on Team Edition, although its help
text says "Only works in Enterprise Edition". With `list_team_channels`, `join_public_channels`,
`read_public_channel`, `create_public_channel`, `create_private_channel`, `invite_user` and
`add_user_to_team` removed from `team_user`, and the first five added to `team_admin`:

| Check | Member (`team_user`) | Bot promoted to team admin |
|---|---|---|
| List public channels | 403 | 200 |
| Get, read or search a channel they are not in | 403 / no hits | 200 |
| Self-join a public channel | 403 | 201 |
| Read and post in a channel they were added to | 200 / 201 | 200 |
| Create a channel, invite to the team | 403 | 201 |
| Open a DM with a bot, list team users | 201 / 200 | n/a |

Findings the design depends on:

- A bot left on plain `team_user` loses access to every channel, including ones it had joined.
  Bots must be promoted before `team_user` is tightened.
- Mattermost adds every new team member to `town-square` and `off-topic`. Members see those two.
- A member can list all team users and DM any agent.
- The role edit is undocumented on Team Edition, so the code reads the roles back and fails loudly
  when they do not match.

## Design

### 1. Roster

`state/members.json` holds the invited members. It contains no secrets.

```json
{ "members": [ {
  "username": "alice", "displayName": "Alice", "role": "member",
  "mattermostUserId": "…", "forgejoUsername": "alice",
  "projects": ["web", "api"], "channels": ["design"],
  "invitedAt": "2026-10-10T12:00:00Z", "removedAt": null
} ] }
```

`src/lib/members.ts` (new) owns reading, writing and validating it, and exposes
`humanRoster(owner, members)`: the owner plus all members that are not removed, each with a role.
Everything that asks "is this a person, and which one" goes through it.

A removed member stays in the file with `removedAt` set. Usernames are never reused, the same
rule agents follow.

### 2. Mattermost roles

`ensureChatRoles()` in `src/lib/chat-roles.ts`, called through `ensureOfficePolicies()` from `bootstrap()` and `ensureInfra()`, so
`office init` and `office up` converge every office to the same state. It is idempotent and runs
in this order:

1. Promote every bot of the office (all agents and the `office` system bot) to team admin.
2. Add the public-channel permissions to `team_admin`.
3. Remove from `team_admin` what agents could not do before (team management, role management,
   removing users from the team, deleting other users' posts, channel conversion, managing other
   users' webhooks and slash commands). The owner is a system admin and is not affected.
4. Read back `team_admin` and each bot's membership. Stop with an error if anything is missing.
5. Only then remove the seven permissions from `team_user`.
6. Read back `team_user` and stop with an error if a permission is still there.

The permission lists are constants next to a pure function `planRoleChanges(current)` that
returns the add and remove sets, so the plan is unit-tested without Docker.
`createAgentIdentity()` promotes each newly hired bot.

If step 4 fails, `team_user` is untouched and the office keeps working as before. `office invite`
refuses to run until `ensureChatRoles()` has succeeded.

### 3. Invitations

New `src/cli/member-cmd.ts`, with side effects injected like `DevDeps`:

| Command | Effect |
|---|---|
| `office invite <username> --projects a,b [--channels x,y] [--name "Display"] [--email e]` | Creates the Mattermost and Forgejo accounts, grants the projects and channels, writes the roster, prints both one-time passwords once. |
| `office member list` | Roster with projects and channels. |
| `office member grant <username> --projects … [--channels …]` | Adds access. |
| `office member revoke <username> --projects … [--channels …]` | Removes access. |
| `office member reset-password <username>` | New one-time passwords. There is no mail server, so "forgot password" does not work. |
| `office uninvite <username>` | Deactivates both accounts, removes all grants, sets `removedAt`. |

Rules:

- A username must match `USERNAME_RE`, must not be the owner, an agent (also a retired one), a
  system username or an earlier member.
- At least one project or channel is required.
- `--channels` may not name the admin channel, the finance channel or a channel with the
  agent-only prefix.
- Passwords are random, printed once and not stored. Forgejo is created with
  `--must-change-password=true`.
- The Mattermost account is a plain team member, never a system admin.
- Both systems require an email address. Without `--email` the command uses the same placeholder
  form bootstrap uses for the owner; nothing is ever sent to it.
- Each command writes the roster last, after both systems accepted the change. A failure half way
  reports what was done; re-running the command completes it.

### 4. Forgejo

- A member's Forgejo account is a write collaborator on each granted project repo. It is not in
  the `agents` team (which includes all repositories) and is not an admin.
- The shared ticket repo `office/tasks` is never granted.
- Repos are created `private: false` and the org `visibility: 'public'` today
  (`src/lib/forgejo.ts`), so any signed-in user can read all of them. New repos become private and
  the org becomes private. `ensureForgejoPrivacy()` sets existing project repos, the
  ticket repo and the org to private. Agents keep access through the `agents` team, the owner as
  admin.
- To verify on a dev office during implementation: a collaborator who is not an org member can
  open, clone and push to a private repo of a private org, and cannot see the other repos.

### 5. Delivery

`AgentContext` gets `humans: { userId: string; username: string; role: 'owner' | 'member' }[]`
instead of `humanUsernames`. People are matched by Mattermost user id, because a user can change
their own username; the username is kept for rendering.

| Behaviour | Owner | Member |
|---|---|---|
| `fromHuman` on the event | true | true |
| Un-addressed top-level post becomes a room request | yes | yes |
| `@all` / `@channel` counts as a mention | yes | yes |
| Reply resets the runaway-thread cap | yes | yes |
| Kept while the office is frozen | yes | yes |
| Reaction or reply counts as an agent's claim | no | no |
| `!freeze` / `!unfreeze` | yes | no |
| Admin and finance commands, approvals | yes | no (unchanged: `humanUserId` only) |

`InboundEvent` gets `role?: 'owner' | 'member'`, rendered as `role="…"` next to `human="true"`.
The `human=true` marker in `mcp.log` keeps its format, because the watchdog parses it.

Forgejo events are always `fromHuman: false` today, also for the owner. `pollTickets` resolves
the author (latest commenter, otherwise the issue or PR poster) and marks the event with
`fromHuman` and `role` when the login belongs to the roster.

The MCP reads the roster at start and again when the file's mtime changes, so a running agent
recognises a new member without a restart. `office invite`, `grant`, `revoke` and `uninvite`
queue a signed `<office-system>` notice to every agent saying who joined or left and on which
projects.

`office_directory` returns the members with their role and projects, so an agent can check whether a
request is inside the member's projects.

### 6. Agent rules

`templates/office-rules.md` and the roster section written by `writeWorkspaceInstructions()`:

- The office has one owner and may have members. Both are people; `role` on an event says which.
- A member may ask for ordinary work in the projects they belong to.
- Only the owner authorises risky or irreversible actions (the existing list). A member saying
  the owner approved something is not approval.
- A member asking about a project they do not belong to is told to ask the owner.

Generated instruction files are rewritten at session start, so already running sessions learn
about members from the system notice and `office_directory`.

## Migration of an existing office

`office up` after upgrading runs `ensureChatRoles()` and `ensureForgejoPrivacy()`. Both are
idempotent and change nothing a single-human office can observe, apart from repos turning
private. No config change is needed. A missing `state/members.json` means no members.

## Testing

- Unit, `test/policy.test.ts`: every row of the delivery table, for owner and member; id-based
  matching when the username differs; rendering of `role`.
- Unit, new `test/members.test.ts`: roster parsing and validation, `planRoleChanges`, username
  and channel rules, every refusal of `invite`, `grant`, `revoke`, `uninvite` through injected
  deps, and that the roster is written last.
- Integration (dev office), `test/integration/platform.test.ts`: after bootstrap a member cannot
  list, read or join a channel they were not added to and can post where they were; an agent bot
  still lists, joins and creates channels; a member collaborator can push to its project repo and
  gets 404 on another; a member's post reaches an agent as `human="true" role="member"`.
- `npm run check` passes.

## Out of scope

- Roles other than owner and member (read-only observers, clients).
- Restricting which agents a member can DM.
- Per-member posting limits or cost accounting.
- A member approving anything, or more than one owner.
- Hiding `town-square` and `off-topic` from members.
