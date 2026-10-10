// Helper agent for the #office-admin "generate" command.
// One-shot LLM call via `opencode run` with a tool-denied config.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OfficeConfig, OfficeRequest, ResourceGroup } from '../lib/types.js'
import { allowedCommands, helpText } from './commands.js'
import { opencodeProviderOverrides, vaultEnvDefaults } from '../lib/vault.js'

export interface HelperProposal {
  /** argv arrays WITHOUT the leading "office". */
  commands: string[][]
  explanation: string
  questions: string[]
}

export interface HelperConversationTurn {
  role: 'owner' | 'helper'
  text: string
}

export interface BuildHelperPromptInput {
  /** Full command reference (help text + CLI usage). */
  commandReference: string
  /** Output of `bin/office status --md --all`. */
  statusOutput: string
  /** Pending self-management requests, if any. */
  pendingRequests: OfficeRequest[]
  /** opencode-go models known to be available. */
  availableModels: string[]
  /** Contents of templates/helper-notes.md. */
  helperNotes: string
  /** Owner request + previous proposals/feedback. */
  conversation: HelperConversationTurn[]
}

const CLAUDE_ALIASES = [
  'sonnet — default for Claude agents, auto mode',
  'opus — strongest, drains quota fastest',
  'haiku — cheap, NO auto mode (permission prompts)',
]

/** Pure function that builds the full system+user prompt for the helper. */
export function buildHelperPrompt(input: BuildHelperPromptInput): string {
  const modelLines = [
    ...input.availableModels.map((m) => `- ${m}`),
    ...CLAUDE_ALIASES.map((a) => `- ${a}`),
  ].join('\n')

  const pending = input.pendingRequests.length
    ? input.pendingRequests.map((r) => `- ${r.id} @${r.agent} ${r.type}: ${JSON.stringify(r.args)}`).join('\n')
    : '(none)'

  const conversation = input.conversation
    .map((t) => {
      const label = t.role === 'owner' ? 'Owner' : 'Helper (previous proposal)'
      return `${label}:\n${t.text}`
    })
    .join('\n\n')

  const rules = [
    '- "commands" is an array of argv arrays. Each argv array is the command WITHOUT the leading "office" word.',
    '- Only use commands from the reference above. Never invent flags.',
    '- Never include "admin-stop".',
    '- Prefer the fewest commands that satisfy the request.',
    '- If the request is unclear, impossible, or would exceed limits, leave "commands" empty and ask 1-2 clarifying "questions".',
    '- "explanation" must be one or two sentences.',
  ].join('\n')

  return `You are the #office-admin command helper. Your job is to turn the owner's plain-language request into the exact "office" command(s) that should run.

## Command reference

${input.commandReference}

## Current office state

\`\`\`
${input.statusOutput}
\`\`\`

## Pending self-management requests

${pending}

## Available models

${modelLines}

## Guidance

${input.helperNotes}

## Conversation

${conversation}

## Output contract

Reply with ONE fenced json code block and nothing else outside it. The JSON must have this exact shape:

\`\`\`json
{
  "commands": [["hire","rita","--harness","opencode"], ...],
  "explanation": "one or two sentences",
  "questions": ["..."]
}
\`\`\`

Rules:
${rules}
`.trim()
}

/** Build the command reference injected into every helper prompt. */
export function buildCommandReference(): string {
  const usage = `"bin/office" usage:
  init                         bring up Mattermost + Forgejo, create owner, team, channels, brain
  up                           docker compose up -d
  hire <name> [--harness claude|opencode] [--model M] [--focus "..."] [--display N] [--chrome] [--no-start]
  start|stop|restart [names…]  manage agent sessions (tmux session "office")
  admin                        run the #office-admin chat-ops daemon in the foreground
  admin-stop                   stop the admin daemon window
  status [--md] [--all]        agents, windows, idle/busy, pending prompts
  finance [today|week|limits|<agent>|<group>]  resource-group usage/cost + rolling-window limits report
  attach [name]                open the tmux session (watch / talk to agents directly)
  fork <agent> [--name N] [--task "..."]    clone an agent's live session into a new colleague
  merge <src> [--into dst] [--keep]         replay src's experience into dst's session + merge memory
  shift <agent>                memory write-back, then fresh session
  model <agent> <model>        switch the agent's model (e.g. sonnet, opus, opencode-go/deepseek-v4-pro) and restart it in the same session
  retire <agent>               stop and deactivate
  freeze | unfreeze            stop agent chatter (only the owner's messages get through)
  say <text> [--channel c] [--thread id]    post as the owner (testing)
  prompt <agent> <text>        queue a raw prompt for an agent
  project new <name> --desc "..." [--members a,b]
                               create a new project repo, channel and brain folder
  project list                 list projects
  project staff <name> [--add a,b] [--remove c]
                               update project members and channel membership
  project archive <name>       archive the project repo
  logs <agent> [--n 50]        office-mcp log
  requests                     list pending + recent self-management requests
  approve <id> / deny <id>     approve or deny a self-management request`
  return `${helpText}\n\n${usage}`
}

/** Extract the LAST fenced JSON block from the helper's text output. */
export function extractJsonBlock(text: string): unknown {
  // Find all occurrences of ```json ... ```, case-insensitive on the opener.
  const blocks: string[] = []
  const pattern = /^\s*```\s*(?:json)?\s*\n?([\s\S]*?)```\s*$/gim
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    blocks.push(match[1]!.trim())
  }
  if (blocks.length === 0) return undefined
  const last = blocks[blocks.length - 1]!
  try {
    return JSON.parse(last)
  } catch {
    return undefined
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isCommandArray(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((c) => isStringArray(c) && c.length > 0)
}

/**
 * Validate that the parsed JSON matches the helper output contract and that
 * every command is on the admin-channel allowlist. Rejects `admin-stop`.
 */
export function validateProposal(parsed: unknown): { ok: true; proposal: HelperProposal } | { ok: false; error: string } {
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'helper did not return a JSON object' }
  }
  const obj = parsed as Record<string, unknown>

  if (!isCommandArray(obj.commands)) {
    return { ok: false, error: 'commands must be an array of non-empty argv arrays' }
  }
  if (typeof obj.explanation !== 'string') {
    return { ok: false, error: 'explanation must be a string' }
  }
  if (!Array.isArray(obj.questions) || !obj.questions.every((q) => typeof q === 'string')) {
    return { ok: false, error: 'questions must be an array of strings' }
  }

  for (const argv of obj.commands) {
    const command = argv[0]!.toLowerCase()
    if (!allowedCommands.has(command)) {
      return { ok: false, error: `disallowed command: ${command}` }
    }
    if (command === 'admin-stop') {
      return { ok: false, error: 'admin-stop is not allowed through the helper' }
    }
  }

  return {
    ok: true,
    proposal: {
      commands: obj.commands,
      explanation: obj.explanation.trim(),
      questions: obj.questions as string[],
    },
  }
}

/** Render a validated proposal as the Mattermost reply message. */
export function renderProposalMessage(proposal: HelperProposal): string {
  const lines: string[] = []
  if (proposal.commands.length > 0) {
    const commandLines = proposal.commands.map((argv) => `office ${shellEscape(argv)}`)
    lines.push('```bash', ...commandLines, '```')
  }
  if (proposal.explanation) {
    lines.push('', proposal.explanation)
  }
  if (proposal.questions.length > 0) {
    lines.push('', 'Questions:')
    for (const q of proposal.questions) lines.push(`- ${q}`)
  }
  lines.push(
    '',
    'React :white_check_mark: to run, :x: to discard, or reply in this thread to change it.',
  )
  return lines.join('\n').trim()
}

/** Escape an argv array back to a single shell word for display. */
export function shellEscape(argv: string[]): string {
  return argv
    .map((a) => {
      if (/^[a-zA-Z0-9_.@/:-]+$/.test(a)) return a
      const escaped = a.replace(/'/g, "'\"'\"'")
      return `'${escaped}'`
    })
    .join(' ')
}

/** Config that denies every tool the helper must not use. */
export function buildHelperConfig(provider?: Record<string, unknown>): object {
  return {
    $schema: 'https://opencode.ai/schemas/config.json',
    ...(provider && Object.keys(provider).length ? { provider } : {}),
    permission: {
      bash: { '*': 'deny' },
      edit: 'deny',
      write: 'deny',
      read: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      grep: 'deny',
      glob: 'deny',
      git: 'deny',
      docker: 'deny',
      npm: 'deny',
      python: 'deny',
      node: 'deny',
      tsx: 'deny',
      npx: 'deny',
      curl: 'deny',
      wget: 'deny',
      ssh: 'deny',
      gh: 'deny',
    },
  }
}

export interface RunHelperInput {
  root: string
  helperModel: string
  prompt: string
  timeoutMs?: number
  /** Resource groups whose default entries the helper's opencode config should see. */
  groups?: ResourceGroup[]
}

export interface RunHelperResult {
  output: string
  exitCode: number
}

/** Run the helper model via `opencode run` with cwd=state/helper and a denied-tools config. */
export function runHelper(input: RunHelperInput): RunHelperResult {
  const helperDir = path.join(input.root, 'state', 'helper')
  const configPath = path.join(helperDir, 'opencode.json')
  const groups = input.groups ?? []
  const vaultEnv = vaultEnvDefaults(input.root, groups, 'opencode')

  // Best-effort, but synchronous: the config must be on disk before opencode starts.
  try {
    mkdirSync(helperDir, { recursive: true })
    writeFileSync(configPath, JSON.stringify(buildHelperConfig(opencodeProviderOverrides(groups, vaultEnv)), null, 2) + '\n', { mode: 0o600 })
    chmodSync(configPath, 0o600)
  } catch { /* opencode then runs with its defaults */ }

  const env = { ...process.env, ...vaultEnv, OPENCODE_CONFIG: configPath }
  const result = spawnSync('opencode', ['run', '-m', input.helperModel, '--', input.prompt], {
    cwd: helperDir,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: input.timeoutMs ?? 120_000,
  })

  const output = (result.stdout ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const exitCode = result.status ?? (result.signal ? 1 : 0)
  return { output, exitCode }
}

export interface ModelsCache {
  fetchedAt: string
  models: string[]
}

const MODELS_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Return opencode-go models from `opencode models`, cached in
 * state/helper/models.json for 1 hour. Falls back to the cache on failure.
 */
export async function loadOrRefreshModels(
  root: string,
  ttlMs: number = MODELS_CACHE_TTL_MS,
): Promise<string[]> {
  const helperDir = path.join(root, 'state', 'helper')
  const cachePath = path.join(helperDir, 'models.json')

  let cached: ModelsCache | undefined
  try {
    const raw = await readFile(cachePath, 'utf8')
    cached = JSON.parse(raw) as ModelsCache
  } catch {
    cached = undefined
  }

  const now = Date.now()
  if (cached && now - new Date(cached.fetchedAt).getTime() < ttlMs && cached.models.length > 0) {
    return cached.models
  }

  const result = spawnSync('opencode', ['models'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  })

  let models: string[] = []
  if (result.status === 0) {
    models = parseModelsOutput(result.stdout)
  }

  if (models.length === 0 && cached) {
    return cached.models
  }

  const next: ModelsCache = { fetchedAt: new Date().toISOString(), models }
  await mkdir(helperDir, { recursive: true })
  await writeFile(cachePath, JSON.stringify(next, null, 2) + '\n')
  return models
}

/** Parse `opencode models` stdout and keep only opencode-go/* ids. */
export function parseModelsOutput(stdout: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Common formats: a plain provider/model id, a bullet, or a table column.
    const candidates: string[] = []
    // Try the whole line if it looks like a model id.
    if (/^opencode-go\//.test(trimmed)) candidates.push(trimmed.split(/\s+/)[0]!)
    // Try quoted / parenthesized tokens.
    for (const m of trimmed.matchAll(/opencode-go\/[^\s"'`,;)]+/g)) {
      candidates.push(m[0]!)
    }
    for (const id of candidates) {
      const clean = id.replace(/[,:]$/, '')
      if (!seen.has(clean)) {
        seen.add(clean)
        out.push(clean)
      }
    }
  }
  return out
}

/** Convenience: build a prompt from config + live state. */
export async function buildHelperPromptFromState(
  root: string,
  config: OfficeConfig,
  conversation: HelperConversationTurn[],
): Promise<string> {
  const { spawnSync } = await import('node:child_process')
  const statusResult = spawnSync(path.join(root, 'bin', 'office'), ['status', '--md', '--all'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  })
  const statusOutput = (statusResult.stdout ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') || '(status unavailable)'

  let pendingRequests: OfficeRequest[] = []
  try {
    const { listRequests } = await import('../lib/requests.js')
    pendingRequests = (await listRequests(root)).filter((r) => r.status === 'pending')
  } catch {
    pendingRequests = []
  }

  let helperNotes = ''
  try {
    helperNotes = await readFile(path.join(root, 'templates', 'helper-notes.md'), 'utf8')
  } catch {
    helperNotes = ''
  }

  const availableModels = await loadOrRefreshModels(root)

  return buildHelperPrompt({
    commandReference: buildCommandReference(),
    statusOutput,
    pendingRequests,
    availableModels,
    helperNotes,
    conversation,
  })
}

/** True if the message text starts with a generate trigger. */
export function isGenerateTrigger(text: string): boolean {
  const t = text.trim()
  return t.startsWith('generate ') || t.startsWith('gen ') || t.startsWith('? ')
}

/** Strip the trigger prefix and return the owner request text. */
export function stripGenerateTrigger(text: string): string {
  const t = text.trim()
  if (t.startsWith('generate ')) return t.slice(9).trim()
  if (t.startsWith('gen ')) return t.slice(4).trim()
  if (t.startsWith('? ')) return t.slice(2).trim()
  return t
}
