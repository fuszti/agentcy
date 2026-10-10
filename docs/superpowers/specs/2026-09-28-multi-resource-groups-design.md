# Multiple resource groups per kind (Claude subscriptions, OpenCode Go keys, OpenRouter keys)

Status: implemented on `feature/home-server` (TDD: Opus-written tests, Sonnet-written code, per unit).
This file was the **contract** the implementation units coded against.

Review follow-ups (fixed in a second TDD round):
- A fresh `CLAUDE_CONFIG_DIR` opens Claude Code's first-run theme picker, which blocks agents and
  the `/usage` probe (verified with claude 2.1.283). `ensureClaudeOnboarded(dir)` seeds
  `.claude.json` with `hasCompletedOnboarding` plus a few UI-hint keys copied from the default
  config; it never copies account or credential keys.
- `hire --group` is now validated before the chat and Forgejo identities are created
  (`resolveHireGroup`).

## Decisions (grilled 2026-09-27/28)

- **Registry.** `config.resourceGroups` in `office.config.json` stays the registry, and any
  kind can have several groups.
  - The **first group of a kind is its default**. Existing offices (`claude-sub`,
    `opencode-go`, `openrouter`) keep working unchanged.
- **Claude groups** each have their own `CLAUDE_CONFIG_DIR`.
  - `ResourceGroup.configDir` is **relative to the office root**, e.g. `state/claude/claude-b`.
  - The default Claude group has no `configDir`: it uses `$CLAUDE_CONFIG_DIR` or `~/.claude`.
  - Login happens on the server shell only: `office group login <id>` runs `claude auth login`
    with that directory.
- **Agent → group.** `AgentRecord.group` names the group. An agent resolves to the default group
  of its kind when `group` is unset, unknown, or of a different kind than its harness/model
  needs.
  - `hire --group <id|auto>`. `auto` picks the group of the right kind with the lowest usage %.
- **Moving an agent.** `office group move <agent> <group>`:
  - Claude: copy the session transcript into the new config dir and resume. If no transcript is
    found, start a fresh session.
  - opencode: restart the same session with the new group's key.
- **Forks** inherit the parent's group. **Merge and finance** read transcripts from the agent's
  group dir.
- **Vault.** An entry is named after its group: `office vault set <groupId>`.
  - For a Claude group the entry is an optional `claude setup-token` token
    (`CLAUDE_CODE_OAUTH_TOKEN`). For opencode-go and openrouter groups it is the API key.
  - Static, non-group entries: `opencode-zen`, `anthropic`.
  - The legacy milestone-1 `claude-oauth` entry migrates to the default Claude group.
- **Out of scope:** automatic failover. Alerts only suggest a `group move`.
- **Export** excludes `state/claude/*/.credentials.json`. Each machine logs in by itself.

## Unit A — group model (`src/finance/groups.ts`, `src/finance/headroom.ts`, `LimitRow.groupId`)

```ts
// src/finance/groups.ts  (pure: no I/O except path math)
export const RESERVED_GROUP_IDS: string[] // ['opencode-zen', 'anthropic', 'claude-oauth']
export const KIND_LABELS: Record<ResourceGroupKind, string> // 'Claude subscription' | 'OpenCode Go' | 'OpenRouter'
export function kindForAgent(rec: Pick<AgentRecord, 'harness' | 'model'>): ResourceGroupKind | undefined
//   claude -> 'claude-subscription'; opencode + model prefix 'opencode-go/' -> 'opencode-go',
//   'openrouter/' -> 'openrouter'; anything else -> undefined
export function defaultGroup(kind: ResourceGroupKind, groups: ResourceGroup[]): ResourceGroup | undefined // first of kind
export function isDefaultGroup(group: ResourceGroup, groups: ResourceGroup[]): boolean
export function groupIdForAgent(rec: Pick<AgentRecord, 'harness' | 'model' | 'group'>, groups: ResourceGroup[]): string | undefined
//   rec.group when it exists and its kind === kindForAgent(rec); else defaultGroup(kind)?.id; undefined when no kind
export function groupAgents<T extends Pick<AgentRecord, 'name' | 'harness' | 'model' | 'group'>>(agents: T[], groups: ResourceGroup[]): Map<string, T[]> // existing, now honours rec.group
export function checkGroupForAgent(rec: Pick<AgentRecord, 'harness' | 'model'>, groupId: string, groups: ResourceGroup[]): string | undefined
//   undefined = ok; else a human error: unknown group (list known ids) / kind mismatch
//   (e.g. 'group go-2 is an OpenCode Go group, but sonnet needs a Claude subscription group')
export function validateNewGroupId(id: string, groups: ResourceGroup[]): string | undefined
//   must match /^[a-z][a-z0-9-]{1,30}$/, not already used, not in RESERVED_GROUP_IDS
export function addGroup(groups: ResourceGroup[], input: { kind: ResourceGroupKind; id: string; label?: string }): ResourceGroup[]
//   returns a NEW array (input untouched) with the group appended; throws Error on invalid id/unknown kind.
//   label defaults to `${KIND_LABELS[kind]} (${id})`.
//   claude-subscription: configDir = `state/claude/${id}` unless it is the first claude group (then no configDir).
export function removeGroup(groups: ResourceGroup[], id: string, hiredAgents: Pick<AgentRecord, 'name' | 'harness' | 'model' | 'group'>[]): ResourceGroup[]
//   NEW array without it; throws on unknown id; throws if any agent currently resolves to it
//   (message lists the agent names and suggests `office group move`).
export function claudeConfigDir(root: string, group: ResourceGroup | undefined): string | undefined
//   group?.configDir ? path.resolve(root, group.configDir) : undefined  (undefined = harness default)
export function pickAutoGroup(kind: ResourceGroupKind, groups: ResourceGroup[], usedPercent: Record<string, number | undefined>): ResourceGroup | undefined
//   among groups of that kind: lowest known used %; groups with unknown % rank after all known ones;
//   ties and all-unknown -> config order (so the default wins). undefined when no group of kind.
export function suggestMoveText(fromGroupId: string, groups: ResourceGroup[], usedPercent: Record<string, number | undefined>, agentNames: string[]): string | undefined
//   another group of the same kind with a KNOWN used % lower than the source's (source unknown = any known)
//   -> ` Most headroom: **<label>** (<n>% used) — \`group move <agent> <id>\`` using the first agent name
//   (or `<agent>` when agentNames is empty). undefined when there is no better group.
```

```ts
// src/finance/headroom.ts  (state/finance/headroom.json, written by the finance collector)
export interface HeadroomFile { at: string; usedPercent: Record<string, number | undefined> }
export function headroomFromSnapshot(limits: LimitRow[], groups: GroupRow[]): Record<string, number | undefined>
//   per group id: max of every LimitRow.percent with that groupId and GroupRow.usagePercent of that id; undefined if none
export function writeHeadroom(root: string, usedPercent: Record<string, number | undefined>): void // atomic, creates dirs
export function readHeadroom(root: string): HeadroomFile | undefined // undefined when missing/corrupt
```

`LimitRow` in `src/finance/render.ts` gets an optional `groupId?: string`.

## Unit B — Claude config-dir plumbing

All new parameters are optional and trailing, so existing callers keep compiling. `configDir`
undefined means today's behaviour: `$CLAUDE_CONFIG_DIR`, then `~/.claude`.

- `src/lib/transcript.ts`
  - `claudeProjectsDir(configDir?)`
  - `claudeSessionFile(cwd, sessionId, configDir?)`
  - `findClaudeSessionFile(sessionId, configDir?)`
  - New: `copyClaudeSession(opts: { sessionId: string; cwd: string; fromDir?: string; toDir?: string }): boolean`.
    - Finds the transcript under `fromDir` with `findClaudeSessionFile`.
    - Copies it to `claudeSessionFile(cwd, sessionId, toDir)`, creating the directories. If a
      sibling directory named `<sessionId>` (subagent / tool-result files) sits next to the
      source file, it is copied recursively to the same place.
    - Returns false when the source isn't found; overwrites the destination when it exists.
- `src/lib/harness/claude.ts`
  - `claudeSessionExists(sessionId, configDir?)` uses `claudeProjectsDir(configDir)`.
  - `ClaudeLaunch` gets `configDir?: string`. When it is set, the launch command's env part
    contains `CLAUDE_CONFIG_DIR=<shell-quoted abs path>` on the `exec env …` of the harness
    command itself (not on `cd`).
- `src/finance/claude.ts`
  - `readClaudeAccountInfo(configDir?)` runs `claude auth status --json` with
    `CLAUDE_CONFIG_DIR` in its env when a dir is given.
  - `readAgentClaudeTokenUsage(agent, sessionIds, configDirs?: (string | undefined)[])` searches
    each dir in order (`undefined` = default) and takes the first hit per session id. Its default
    is `[undefined]`.
- `src/finance/claude-usage-probe.ts`
  - New pure `probeCommand(configDir?: string): string`. It returns
    `claude --model haiku --strict-mcp-config`, prefixed with `env CLAUDE_CONFIG_DIR='<dir>' `
    when a dir is given.
  - `runClaudeUsageProbe(root, configDir?)` uses it.
  - New `claudeUsageCacheFile(root, groupId?: string)`:
    `state/finance/claude-usage.json` without a group id (the default group),
    `state/finance/claude-usage-<groupId>.json` with one.
  - `getClaudeUsageLimits(root, cacheFile?, configDir?)`.

## Unit C — vault per group (`src/lib/vault.ts` + its callers)

```ts
export interface VaultEntrySpec {
  id: string; label: string; env: string; harness: Harness
  opencodeProviders?: string[]; authJsonId?: string; groupId?: string
}
export const STATIC_ENTRIES: VaultEntrySpec[]
//   opencode-zen  (env OPENCODE_API_KEY, harness opencode, providers ['opencode'], authJsonId 'opencode')
//   anthropic     (env ANTHROPIC_API_KEY, harness opencode, providers ['anthropic'], authJsonId 'anthropic')
export function vaultSpecs(groups: ResourceGroup[]): VaultEntrySpec[]
//   one per group, in config order, then STATIC_ENTRIES:
//   claude-subscription -> env CLAUDE_CODE_OAUTH_TOKEN, harness claude
//   opencode-go         -> env OPENCODE_GO_API_KEY, harness opencode, providers ['opencode-go'], authJsonId 'opencode-go' ONLY on the default opencode-go group
//   openrouter          -> env OPENROUTER_API_KEY, harness opencode, providers ['openrouter'], authJsonId 'openrouter' ONLY on the default openrouter group
//   label = group label; groupId = group id
export function vaultSpec(id: string, groups: ResourceGroup[]): VaultEntrySpec | undefined
export function setSecret(root: string, id: string, value: string, groups: ResourceGroup[]): void // throws on unknown id (lists known), empty, multi-line
export function getSecret(root: string, id: string): string | undefined            // unchanged
export function removeSecret(root: string, id: string): boolean                     // unchanged
export function markValidated(root: string, id: string, valid: boolean): void       // unchanged
export function listSecrets(root: string, groups: ResourceGroup[]): VaultEntryInfo[] // one row per vaultSpecs entry, metadata only
export function vaultEnvForAgent(root: string, groups: ResourceGroup[], rec: Pick<AgentRecord, 'harness' | 'model' | 'group'>): Record<string, string>
//   STATIC_ENTRIES for rec.harness that are set + the entry of groupIdForAgent(rec, groups) when set and its harness === rec.harness
export function vaultEnvDefaults(root: string, groups: ResourceGroup[], harness: Harness): Record<string, string>
//   for the admin helper / merge summarizer: STATIC_ENTRIES for harness + the DEFAULT group of each kind whose spec harness matches
export function opencodeProviderOverrides(groups: ResourceGroup[], env: Record<string, string>): Record<string, { options: { apiKey: string } }>
//   for every opencode spec whose env var is a key of `env`: each provider -> { options: { apiKey: '{env:VAR}' } }
export function writeAgentEnvFile(agentDir: string, env: Record<string, string>): string // chmod 600 provider.env, returns path
export function withEnvFile(command: string, envFile: string): string // unchanged
export function renderEnvFile(env: Record<string, string>): string   // unchanged
export function importableFromAuthJson(authJson: string, groups: ResourceGroup[]): { id: string; value: string }[]
//   api-type auth.json entries mapped through specs' authJsonId (so only default groups + static)
export function migrateLegacyVault(root: string, groups: ResourceGroup[]): boolean
//   if a 'claude-oauth' entry exists (encrypted with AAD 'claude-oauth') and the default claude group
//   exists and has no entry: re-encrypt the value under the group id, delete 'claude-oauth', return true.
//   Otherwise false (legacy entry left alone). Idempotent.
export async function validateSecret(spec: VaultEntrySpec, value: string): Promise<boolean | undefined>
//   by spec.env: OPENROUTER_API_KEY -> GET https://openrouter.ai/api/v1/key; OPENCODE_GO_API_KEY -> GET https://opencode.ai/zen/go/v1/usage;
//   Bearer auth; 401/403 -> false; 2xx -> true; else/network error -> undefined. Others -> undefined.
export function renderVaultStatus(entries: VaultEntryInfo[]): string // unchanged
```

`PROVIDERS` and `providerSpec` are removed. Callers that must be updated:
- `src/cli/vault-cmd.ts` (every function takes `groups`; calls `migrateLegacyVault` first);
- `src/cli/setup.ts` (the key step offers opencode-kind group entries and `opencode-zen`);
- `src/cli/office.ts`:
  - `startAgent` uses `vaultEnvForAgent`, `writeAgentEnvFile(dir, env)` and
    `opencodeProviderOverrides(groups, env)`;
  - the summarizer uses `vaultEnvDefaults` with an overrides config;
- `src/admin/helper.ts` (`vaultEnvDefaults` + `opencodeProviderOverrides`);
- `src/finance/collect.ts` (it keeps using `getSecret` with the default group ids; Unit E does the
  real per-group work).

## Unit D — group CLI (`src/cli/group-cmd.ts`) + integration

```ts
export interface GroupDeps {
  root: string
  cfg: OfficeConfig
  saveConfig(cfg: OfficeConfig): Promise<void>
  agents(): Promise<AgentRecord[]>            // all records (filter hired yourself)
  saveAgent(rec: AgentRecord): Promise<void>
  stopAgent(rec: AgentRecord): Promise<void>
  startAgent(rec: AgentRecord): Promise<void>
  claudeAuthStatus(configDir?: string): { loggedIn: boolean } | undefined
  runClaudeLogin(configDir?: string): number  // exit code of `claude auth login`
  isTTY: boolean
  log(line: string): void
}
export async function cmdGroup(pos: string[], flags: Record<string, string | boolean>, deps: GroupDeps): Promise<void>
```

Sub-commands (`pos[0]`; none → `list`). Errors are thrown as `Error` with a human message.

- **`list`**: one line per group. It shows `id`, kind, label, `default` for defaults, and the
  hired agents resolving to it.
  - Key: from `listSecrets` — `key: set` / `key: not set`. Claude groups show
    `token: set|not set`.
  - Claude groups also show `login: ok` / `login: not logged in` / `login: unknown`, from
    `claudeAuthStatus(claudeConfigDir(root, g))`.
- **`add <kind> --id <id> [--label L]`**:
  - `kind` is one of `claude` (alias of `claude-subscription`), `opencode-go` or `openrouter`.
  - It uses `addGroup` and, for Claude, creates the config dir with `mode 0o700`.
  - Then `saveConfig`, and a log line with the next step: Claude →
    `office group login <id>` (on the server shell); others → `office vault set <id>`.
- **`rm <id>`**:
  - Uses `removeGroup` with the hired agents, then `saveConfig`.
  - For Claude, it logs that the config dir was kept, with its path.
- **`login <id>`**:
  - Claude groups only. For other kinds it throws, pointing to `office vault set <id>`.
  - If `!isTTY` it throws, telling you to run it on the office server's shell.
  - Otherwise it calls `runClaudeLogin(dir)` and throws on a non-zero exit. On success it logs
    the result of `claudeAuthStatus`.
- **`move <agent> <groupId>`**:
  - The agent must exist and be hired. `checkGroupForAgent` must pass. Moving to the group it
    already resolves to logs "already in" and does nothing.
  - Claude with a different config dir and a `sessionId`:
    1. `stopAgent`.
    2. `copyClaudeSession({ sessionId, cwd: workspaceDir(root, name), fromDir, toDir })`.
    3. If nothing was copied: push `sessionId` to `pastSessions`, unset it, and log that a fresh
       session starts.
    4. Set `group`, `saveAgent`, `startAgent`.
  - Otherwise (opencode, or same dir): `stopAgent`, set `group`, `saveAgent`, `startAgent`.

Integration (not unit-tested, keep thin):
- `src/cli/office.ts`
  - `case 'group'` builds real deps.
  - `hire --group <id|auto>`:
    - `auto` → `pickAutoGroup(kind, groups, readHeadroom(root)?.usedPercent ?? {})`;
    - otherwise `checkGroupForAgent` must pass;
    - store the result on `rec.group`.
  - `startAgent` passes `configDir` to `claudeSessionExists` and `claudeLaunchCommand`.
  - `fork`: the child's `group` is the parent's `group`, and `findClaudeSessionFile(…, parentDir)`.
  - `merge`: `findClaudeSessionFile(src.sessionId, srcDir)`.
  - `model`: if `checkGroupForAgent` fails for the new model, unset `group` and log the new
    default.
  - `inspect`: an identity line `- **group:** <id>`.
  - Help text entries.
- `src/admin/commands.ts`: `'group'` in `allowedCommands`, plus help text.
- `src/lib/migrate.ts`: `office.tar.gz` excludes `state/claude/*/.credentials.json`. The export
  message says to run `office group login <id>` on the new machine for each extra Claude group.

## Unit E — per-group finance

- **`src/finance/collect.ts`**: members come from `groupIdForAgent`, which now honours
  `rec.group`.
  - Claude groups:
    - `dir = claudeConfigDir(root, g)`;
    - `readClaudeAccountInfo(dir)`;
    - token usage via `readAgentClaudeTokenUsage(name, ids, [dir, …every other Claude group's dir])`;
    - limit rows from `getClaudeUsageLimits(root, claudeUsageCacheFile(root, default ? undefined : g.id), dir)`.
  - opencode-go groups:
    - key = `getSecret(root, g.id)`, falling back to `readOpencodeGoKey()` for the default
      group only;
    - exact usage per group;
    - the local-DB estimate only for the default group;
    - `opencode stats` totals only on the default group. Other groups' totals are the sum of
      their agents' rows, marked as estimates.
  - OpenRouter groups: key = `getSecret(root, g.id)`, falling back to `readOpenrouterKey()` for
    the default group only.
  - Every `LimitRow` gets `groupId`.
  - At the end: `writeHeadroom(root, headroomFromSnapshot(limits, groupsWeek))`.
- **`src/finance/alerts.ts`**: `detectLimitAlerts(rows, thresholds, state, suggest?: (groupId: string) => string | undefined)`.
  - The key is `limit:${groupId ?? group}:${window}`.
  - When `suggest` returns text, it is appended to the alert message.
  - `detectGroupAlerts` gets the same optional `suggest` for usage/health alerts.
- **`src/admin/daemon.ts`**: passes
  `id => suggestMoveText(id, groups, headroomFromSnapshot(snapshot.limits, snapshot.groupsWeek), agentsInGroup(id))`.

## Ground rules for every unit

- Don't touch the live office: no `bin/office start/stop/init`, no `docker`/`docker compose`,
  and nothing under `state/`, `workspaces/`, `brain/` or `infra/data/` of this checkout.
- Tests use temp dirs (`fs.mkdtempSync(os.tmpdir())`).
- `npx tsc --noEmit` and `npx vitest run` must pass when you finish. Other units may be editing
  other files in parallel: fix only what belongs to your unit, and report anything else.
- Match the surrounding style: 2-space indent, no semicolons, single quotes, and the existing
  comment density.
