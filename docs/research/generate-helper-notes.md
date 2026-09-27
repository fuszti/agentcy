# Generate helper — Task I report

## What was built

### 1. Helper agent (`src/admin/helper.ts`)

A one-shot LLM helper that turns plain-language owner requests in `#office-admin` into exact `office` command proposals.

Exports:
- `buildHelperPrompt(input)` — pure function that assembles the system prompt from the command reference, current office status, pending self-management requests, available models, `templates/helper-notes.md`, and the conversation so far.
- `buildCommandReference()` — combines the existing `helpText` with full `bin/office` usage for every command.
- `extractJsonBlock(text)` — parses the **last** fenced `json` block from the model output.
- `validateProposal(parsed)` — checks the output contract and rejects any command not in the admin-channel allowlist; specifically rejects `admin-stop`.
- `renderProposalMessage(proposal)` — renders the proposal as a Mattermost message: bash code block for the commands, explanation, questions, and the reaction instructions.
- `runHelper({root, helperModel, prompt})` — invokes `opencode run -m <helperModel> -- "<prompt>"` with `cwd=state/helper/` and `OPENCODE_CONFIG` pointing to a generated `state/helper/opencode.json` that denies every tool.
- `loadOrRefreshModels(root)` — runs `opencode models`, filters to `opencode-go/*`, and caches the result in `state/helper/models.json` for 1 hour.
- `isGenerateTrigger(text)` / `stripGenerateTrigger(text)` — detect and strip `generate`, `gen`, and `?` prefixes.
- `buildHelperConfig()` — returns an opencode config whose `permission` block denies `bash`, `edit`, `write`, `read`, `webfetch`, `websearch`, `task`, `grep`, `glob`, `git`, `docker`, `npm`, `python`, `node`, `tsx`, `npx`, `curl`, `wget`, `ssh`, and `gh`.

### 2. Trigger handling (`src/admin/commands.ts`)

`parseCommandLine` now returns a discriminated union:
- `kind: 'command'` — known office command.
- `kind: 'error'` — empty input or unmatched quotes.
- `kind: 'generate'` — explicit `generate`/`gen`/`?` prefix, any unknown top-level message, or any reply in a thread whose root is a helper proposal.

The help text now includes a `generate` entry.

### 3. Daemon integration (`src/admin/daemon.ts`)

The admin daemon:
- Detects generate requests and runs the helper.
- Builds a prompt that includes the current conversation (owner request + previous proposals + owner feedback for refinements).
- Retries once if the helper returns invalid JSON or disallowed commands, appending the validation error.
- Posts the proposal in the thread and stores it in `state/admin/proposals/<rootPostId>.json`.
- Polls reactions every 5 s (reusing the existing Task H polling interval pattern).
- On owner ✅, runs the proposed commands in order through the existing command queue, stopping at the first failure, and posts each result as usual.
- On owner ❌, marks the proposal discarded and posts a note.

`PendingJob` was extended to carry `generated: { commands: string[][] }` so the existing queue executes multi-command proposals.

### 4. Config and types

- `office.config.json`: added `defaults.helperModel: "opencode-go/deepseek-v4.1-flash"`.
- `src/lib/types.ts`: added `helperModel` to `OfficeConfig.defaults`.

### 5. Model guidance (`templates/helper-notes.md`)

New file covering:
- OpenCode Go 5-hour request limits (Kimi K2.7 Code, DeepSeek V4 Pro, MiMo V2.6 Pro, DeepSeek V4.1 Flash, MiMo V2.6 Flash, Kimi K3, GLM-5.3).
- Claude subscription scarcity.
- Lowercase short agent names.
- `selfManagement` limits from `office.config.json`.
- When to ask clarifying questions instead of proposing commands.

### 6. Tests

- `test/helper.test.ts`: 30 new tests covering prompt content, JSON extraction (multiple blocks, garbage, missing), validation (reject disallowed/unknown commands and `admin-stop`), proposal rendering, shell escaping, config denial, and `opencode models` output parsing.
- `test/admin.test.ts`: updated existing `parseCommandLine` tests for the new discriminated union and added tests for generate triggers and refinement replies.

## Verification

### Type-check and unit tests

```bash
npx tsc --noEmit
npx vitest run
```

Result: `127 passed, 4 skipped` across 9 test files (1 skipped integration file).

### Live stack

Restarted only the admin window:

```bash
bin/office admin-stop
bin/office start
```

Output:
```
admin: stopped
admin: started
ada: already running
kim: already running
```

#### Check 1 — status proposal

Posted as owner:
```
generate is anyone stuck or busy right now?
```

The daemon ran the helper and proposed:
```bash
office status
```

Stored proposal (`state/admin/proposals/ioinpigxn7y89nruh3ifqkforc.json`):
```json
{
  "commands": [["status"]],
  "status": "approved"
}
```

Reacted ✅ as the owner via REST using the `MattermostClient`. The daemon executed `office status` and posted the result in the thread.

#### Check 2 — hire proposal

Posted as owner:
```
generate hire a cheap fast researcher that follows reddit AI trends
```

The helper proposed:
```bash
office hire rita --harness opencode --model opencode-go/mimo-v2.6-flash --focus 'research: follow Reddit AI trends and summarize what'"'"'s emerging'
```

Stored proposal (`state/admin/proposals/39oiegczoiyn3kce6oadhm1mde.json`):
```json
{
  "commands": [
    ["hire", "rita", "--harness", "opencode", "--model", "opencode-go/mimo-v2.6-flash", "--focus", "research: follow Reddit AI trends and summarize what's emerging"]
  ],
  "status": "discarded"
}
```

Reacted ❌ as the owner. The daemon marked the proposal discarded and posted `❌ discarded` in the thread.

## Files changed

- `office.config.json`
- `src/lib/types.ts`
- `src/admin/commands.ts`
- `src/admin/daemon.ts`
- `src/admin/helper.ts` (new)
- `templates/helper-notes.md` (new)
- `test/admin.test.ts`
- `test/helper.test.ts` (new)
- `README.md`
- `docs/research/generate-helper-notes.md` (this file)

## Notes / open issues

- The helper is intentionally tool-less: it runs with `OPENCODE_CONFIG` pointing to a config that denies every tool. It is not listed in `office_directory` and has no brain/memory.
- The first live check proposed `status` without `--md`, so the executed result was rendered as a plain console table rather than the markdown table. This is acceptable (it is still a status table), but future prompt tuning could encourage the helper to add `--md` for prettier output.
- Adding owner reactions via raw `curl` returned `Reaction is not valid` for unknown reasons, but the same request through `MattermostClient.addReaction()` succeeded. The live checks therefore used the client.
- Proposals survive daemon restarts because they are stored in `state/admin/proposals/<rootPostId>.json` and loaded at startup.
- Thread replies to a proposal are treated as refinement requests and are folded into the conversation passed to the helper.
