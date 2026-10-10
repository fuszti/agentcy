// Admin-channel command parser and pure helpers for the office chat-ops console.

export const allowedCommands = new Set([
  'help',
  'status',
  'hire',
  'start',
  'stop',
  'restart',
  'fork',
  'merge',
  'shift',
  'retire',
  'model',
  'freeze',
  'unfreeze',
  'logs',
  'prompt',
  'say',
  'requests',
  'approve',
  'deny',
  'project',
  'inspect',
  'peek',
  'activity',
  'finance',
  'vault',
  'group',
])

export interface ParsedCommand {
  kind: 'command'
  command: string
  args: string[]
}

export interface ParseError {
  kind: 'error'
  error: string
}

export interface GenerateRequest {
  kind: 'generate'
  text: string
}

export type ParsedAdminInput = ParsedCommand | ParseError | GenerateRequest

/** Split a line into argv-like tokens, respecting single and double quotes. */
function shellSplit(input: string): string[] | { error: string } {
  const tokens: string[] = []
  let i = 0
  while (i < input.length) {
    // skip whitespace
    while (i < input.length && /\s/.test(input[i]!)) i++
    if (i >= input.length) break
    let token = ''
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i]!
      i++
      const start = i
      while (i < input.length && input[i] !== quote) i++
      if (i >= input.length) return { error: `unmatched ${quote}` }
      token = input.slice(start, i)
      i++ // skip closing quote
      // optionally a quoted token can be directly followed by another quoted token
    } else {
      while (i < input.length && !/\s/.test(input[i]!)) {
        token += input[i]!
        i++
      }
    }
    tokens.push(token)
  }
  return tokens
}

/**
 * Parse a command entered in #office-admin.
 * Accepts an optional leading `office ` or `!`.
 * Recognises `generate <text>`, `gen <text>`, `? <text>` and any top-level
 * message that is not a known console command as a generate request.
 * Returns an error for empty input or unmatched quotes only.
 */
export function parseCommandLine(text: string, opts: { threadParentIsProposal?: boolean } = {}): ParsedAdminInput {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'error', error: 'empty command' }

  // Replies to a helper proposal are refinement requests.
  if (opts.threadParentIsProposal) {
    return { kind: 'generate', text: trimmed }
  }

  // Explicit generate triggers.
  if (/^(generate|gen|\?)\s+/i.test(trimmed)) {
    return { kind: 'generate', text: trimmed.replace(/^(generate|gen|\?)\s+/i, '').trim() }
  }

  let body = trimmed
  if (body.startsWith('office ')) body = body.slice(7)
  else if (body.startsWith('!')) body = body.slice(1)
  const parsed = shellSplit(body.trimStart())
  if ('error' in parsed) return { kind: 'error', error: parsed.error }
  if (parsed.length === 0) return { kind: 'error', error: 'empty command' }
  const command = parsed[0]!.toLowerCase()
  if (!allowedCommands.has(command)) {
    return { kind: 'generate', text: trimmed }
  }
  return { kind: 'command', command, args: parsed.slice(1) }
}

/**
 * Entry id when a chat message is `vault set <id> <value>`, i.e. a key was pasted into chat.
 * Works on the raw text so it also catches thread replies that would be parsed as `generate`.
 */
export function vaultSetLeak(text: string): string | undefined {
  return /^\s*(?:office\s+|!)?vault\s+set\s+(\S+)\s+\S/i.exec(text)?.[1]
}

// Known API-key shapes only: purging is permanent, so a generic "looks random" rule that could
// also hit commit hashes, session ids or links is deliberately not used.
const KEY_PATTERNS: [kind: string, re: RegExp][] = [
  ['OpenRouter', /(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{32,}/],
  ['Anthropic', /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{32,}/],
  ['API', /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{40,}/], // OpenCode Go/Zen, OpenAI-style
]

/** Which kind of API key a chat message contains, if any. Never returns the key. */
export function leakedKeyKind(text: string): string | undefined {
  return KEY_PATTERNS.find(([, re]) => re.test(text))?.[0]
}

/** True if `name` is an admin-channel command. */
export function isAllowedCommand(name: string): boolean {
  return allowedCommands.has(name.toLowerCase())
}

/** Parse the request id from `approve <id>` or `deny <id>`. */
export function parseRequestId(args: string[]): { id: string } | { error: string } {
  if (args.length < 1) return { error: 'missing request id' }
  const id = args[0]
  if (!/^req_[a-zA-Z0-9_-]+$/.test(id)) return { error: `invalid request id: ${id}` }
  return { id }
}

/** Markdown help text for the admin console. */
export const helpText = `
Available office commands (prefix with \`office \` or \`!\`):

- **help** — show this list
  - \`help\`
- **status** — agent windows, idle/busy/blocked, pending prompts, context, alerts
  - \`status\`, \`status --all\`
- **inspect** / **peek** — deep report on one agent (pane, log, pending, posts, work)
  - \`inspect <agent>\`, \`peek <agent>\`
- **activity** — timeline of agent + owner posts and ticket/PR events
  - \`activity [minutes]\`
- **finance** — resource-group usage/cost report (also usable in #office-finance)
  - \`finance\`, \`finance today\`, \`finance week\`, \`finance <agent>\`, \`finance <group>\`
- **hire** — add a new agent
  - \`hire <name> [--harness claude|opencode] [--model M] [--focus "..."]\`
- **start** / **stop** / **restart** — manage agent sessions
  - \`start [names…]\`, \`stop [names…]\`, \`restart [names…]\`, \`stop --all\`
- **fork** — clone an agent's live session
  - \`fork <agent> [--name n] [--task "..."]\`
- **merge** — replay a fork's experience into another agent
  - \`merge <src> [--into dst] [--keep]\`
- **shift** — shift change: write memory, fresh session
  - \`shift <agent>\`
- **model** — switch an agent's model and restart it (same session)
  - \`model <agent> <model>\`, e.g. \`model kim opencode-go/deepseek-v4-pro\`
- **retire** — stop and deactivate an agent
  - \`retire <agent>\`
- **freeze** / **unfreeze** — stop all agent chatter
  - \`freeze\`, \`unfreeze\`
- **logs** — tail an agent's office-mcp log
  - \`logs <agent> [--n 50]\`
- **prompt** — queue a raw prompt for an agent
  - \`prompt <agent> <text>\`
- **say** — post as the owner
  - \`say "<text>" [--channel c] [--thread id]\`
- **requests** — list pending + recent self-management requests
  - \`requests\`
- **approve** / **deny** — approve or deny a self-management request
  - \`approve <id>\`, \`deny <id>\`
- **project** — create, list, staff or archive projects
  - \`project new <name> --desc "..." [--members a,b]\`
  - \`project list\`
  - \`project staff <name> [--add a,b] [--remove c]\`
  - \`project archive <name>\`
- **vault** — provider API key status (keys are set on the server shell, never in chat)
  - \`vault\`, \`vault check\`
- **group** — resource groups (Claude subscriptions, OpenCode Go / OpenRouter keys)
  - \`group\`, \`group add <kind> --id X [--label L]\`, \`group rm <id>\`, \`group move <agent> <id>\`
  - \`group login <id>\` only works on the office server's own shell, not from chat
- **generate** — describe what you want in plain words and get the matching office command(s)
  - \`generate <text>\`, \`gen <text>\`, \`? <text>\`
`.trim()

export interface StatusRow {
  name: string
  harness: string
  model: string
  status: string
  window: string
  state: string
  since: string
  pending: number
  session: string
  fork: string
}

/** Render the same rows as a GitHub/Mattermost markdown table. */
export function renderStatusMarkdown(
  rows: StatusRow[],
  opts: { footer: string; includeRetired?: boolean },
): string {
  const visible = opts.includeRetired ? rows : rows.filter((r) => r.status !== 'retired')
  const headers = ['Name', 'Harness', 'Model', 'Status', 'Window', 'State', 'Since', 'Pending', 'Session', 'Fork']
  const lines: string[] = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...visible.map((r) => `| ${[r.name, r.harness, r.model, r.status, r.window, r.state, r.since, String(r.pending), r.session, r.fork].join(' | ')} |`),
  ]
  if (opts.footer) lines.push('', opts.footer)
  return lines.join('\n')
}
