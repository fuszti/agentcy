// Claude subscription collector: account/plan from `claude auth status`, weekly/session
// usage from an agent's tmux pane text, and per-agent/model/day token counts from
// Claude Code session transcripts. Read-only; never touches or logs auth tokens.

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseWeeklyPercent } from '../admin/monitor.js'
import { findClaudeSessionFile } from '../lib/transcript.js'

/** Parsed `claude auth status --json` output, stripped of anything but plan/org name. */
export interface ClaudeAccountInfo {
  loggedIn: boolean
  plan?: string // subscriptionType, e.g. "pro", "max"
  orgName?: string
}

/** Raw shape of `claude auth status --json`. Only the safe-to-show fields are kept. */
interface ClaudeAuthStatusJson {
  loggedIn?: boolean
  subscriptionType?: string
  orgName?: string
}

/** Parse `claude auth status --json` stdout into the safe subset (no email/tokens). */
export function parseClaudeAuthStatus(json: string): ClaudeAccountInfo | undefined {
  let parsed: ClaudeAuthStatusJson
  try {
    parsed = JSON.parse(json) as ClaudeAuthStatusJson
  } catch {
    return undefined
  }
  return {
    loggedIn: parsed.loggedIn === true,
    plan: parsed.subscriptionType,
    // orgName on a personal account is often the user's email address ("x@y's Organization"
    // or just the email). The owner explicitly allows showing the org name; we do not show
    // anything else (no email field, no tokens) from this command's output.
    orgName: parsed.orgName,
  }
}

/** Run `claude auth status --json` and parse it. Returns undefined on any failure. */
export function readClaudeAccountInfo(configDir?: string): ClaudeAccountInfo | undefined {
  try {
    const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env
    const out = execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 10_000, env })
    return parseClaudeAuthStatus(out)
  } catch {
    return undefined
  }
}

/** Weekly/session usage percent parsed from a captured tmux pane (reuses monitor.ts's parser). */
export function parseClaudeWeeklyUsageFromPane(paneText: string): number | undefined {
  return parseWeeklyPercent(paneText)
}

// ---------------------------------------------------------------- token usage from transcripts

export interface ClaudeTokenUsage {
  agent: string
  model: string
  day: string // YYYY-MM-DD (local date of the message)
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

interface UsageJsonLine {
  type?: string
  timestamp?: string
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

/**
 * Parse a Claude Code session JSONL for per-day/per-model token usage.
 * Sums usage across all assistant messages (usage is reported per API call, not cumulative).
 */
export function parseClaudeTokenUsage(jsonl: string, agent: string): ClaudeTokenUsage[] {
  const byKey = new Map<string, ClaudeTokenUsage>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let o: UsageJsonLine
    try {
      o = JSON.parse(line) as UsageJsonLine
    } catch {
      continue
    }
    if (o.type !== 'assistant') continue
    const usage = o.message?.usage
    if (!usage) continue
    const model = o.message?.model ?? 'unknown'
    const day = (o.timestamp ?? '').slice(0, 10) || 'unknown'
    const key = `${model}\u0000${day}`
    const entry = byKey.get(key) ?? { agent, model, day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    entry.inputTokens += usage.input_tokens ?? 0
    entry.outputTokens += usage.output_tokens ?? 0
    entry.cacheReadTokens += usage.cache_read_input_tokens ?? 0
    entry.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0
    byKey.set(key, entry)
  }
  return [...byKey.values()]
}

/**
 * Read and parse token usage for one agent's current + past Claude sessions. Tolerates
 * missing files. Searches each config dir in order (undefined = env/default dir) and
 * uses the first hit per session id — e.g. after `office group move`, a session copied
 * into a new group's dir shouldn't be double-counted from the old one.
 */
export function readAgentClaudeTokenUsage(agent: string, sessionIds: string[], configDirs: (string | undefined)[] = [undefined]): ClaudeTokenUsage[] {
  const out: ClaudeTokenUsage[] = []
  const seen = new Set<string>()
  for (const id of sessionIds) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    let file: string | undefined
    for (const dir of configDirs) {
      file = findClaudeSessionFile(id, dir)
      if (file) break
    }
    if (!file) continue
    try {
      const jsonl = fs.readFileSync(file, 'utf8')
      out.push(...parseClaudeTokenUsage(jsonl, agent))
    } catch {
      // unreadable transcript: skip, caller shows "-" for this agent
    }
  }
  return out
}

/** Merge same (model, day) entries across multiple usage lists (e.g. several agents). */
export function sumTokenUsage(entries: ClaudeTokenUsage[]): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  for (const e of entries) {
    totals.inputTokens += e.inputTokens
    totals.outputTokens += e.outputTokens
    totals.cacheReadTokens += e.cacheReadTokens
    totals.cacheCreationTokens += e.cacheCreationTokens
  }
  return totals
}
