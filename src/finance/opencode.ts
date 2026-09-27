// OpenCode Go collector: `opencode stats` box-drawing output parsed into per-model
// tokens/cost, per-agent tokens/cost from each opencode agent's own server (info.tokens/
// info.cost on assistant messages), and exhausted/throttled detection from pane/log text.

import { execFileSync } from 'node:child_process'
import type { OpencodeMessage } from '../lib/harness/opencode.js'

const BOX_CHARS = /[┌┐└┘├┤┬┴┼─━│┃]/g

/** Strip box-drawing characters from `opencode stats` output, keeping text content. */
function stripBox(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(BOX_CHARS, ' '))
    .map((l) => l.replace(/\s+$/g, ''))
}

/** Parse a compact number like "3.5M", "352.5K", "1,133" or "$23.8307" into a plain number. */
function parseCompactNumber(raw: string): number {
  const s = raw.replace(/[$,]/g, '').trim()
  const m = s.match(/^([\d.]+)\s*([KM])?$/i)
  if (!m) return Number(s) || 0
  const n = Number(m[1])
  if (m[2]?.toUpperCase() === 'K') return n * 1_000
  if (m[2]?.toUpperCase() === 'M') return n * 1_000_000
  return n
}

export interface OpencodeOverview {
  sessions?: number
  messages?: number
  days?: number
  totalCost?: number
  avgCostPerDay?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface OpencodeModelStats {
  model: string
  messages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export interface OpencodeStats {
  overview: OpencodeOverview
  models: OpencodeModelStats[]
}

const OVERVIEW_FIELDS: Record<string, keyof OpencodeOverview> = {
  Sessions: 'sessions',
  Messages: 'messages',
  Days: 'days',
  'Total Cost': 'totalCost',
  'Avg Cost/Day': 'avgCostPerDay',
  Input: 'inputTokens',
  Output: 'outputTokens',
  'Cache Read': 'cacheReadTokens',
  'Cache Write': 'cacheWriteTokens',
}

const MODEL_FIELD_RE = /^\s{2,}(Messages|Input Tokens|Output Tokens|Cache Read|Cache Write|Cost)\s{2,}(.+)$/
const SECTION_TITLES = new Set(['OVERVIEW', 'COST & TOKENS', 'MODEL USAGE', 'TOOL USAGE'])

/** Parse `opencode stats [--days N] --models` stdout into overview + per-model rows. */
export function parseOpencodeStats(raw: string): OpencodeStats {
  const lines = stripBox(raw)
  const overview: OpencodeOverview = {}
  const models: OpencodeModelStats[] = []
  let current: OpencodeModelStats | undefined
  let inModelSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (SECTION_TITLES.has(trimmed)) {
      inModelSection = trimmed === 'MODEL USAGE'
      continue
    }
    if (!inModelSection) {
      // Overview / cost & tokens rows: "Label   value" with >=2 spaces between.
      const m = line.match(/^(.+?)\s{2,}(\S.*)$/)
      if (m) {
        const key = OVERVIEW_FIELDS[m[1].trim()]
        if (key) (overview as Record<string, number>)[key] = parseCompactNumber(m[2])
      }
      continue
    }
    // Inside MODEL USAGE: a field line, or a new model name (single-space indent, no field match).
    const fieldMatch = line.match(MODEL_FIELD_RE)
    if (fieldMatch && current) {
      const value = parseCompactNumber(fieldMatch[2])
      switch (fieldMatch[1]) {
        case 'Messages': current.messages = value; break
        case 'Input Tokens': current.inputTokens = value; break
        case 'Output Tokens': current.outputTokens = value; break
        case 'Cache Read': current.cacheReadTokens = value; break
        case 'Cache Write': current.cacheWriteTokens = value; break
        case 'Cost': current.cost = value; break
      }
      continue
    }
    // A bare, non-field line inside MODEL USAGE is a model name.
    current = { model: trimmed, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }
    models.push(current)
  }

  return { overview, models }
}

/** Run `opencode stats --days N [--models]` and parse it. Returns undefined on failure. */
export function readOpencodeStats(days: number, withModels: boolean): OpencodeStats | undefined {
  try {
    const args = ['stats', '--days', String(days)]
    if (withModels) args.push('--models')
    const out = execFileSync('opencode', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
    return parseOpencodeStats(out)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- per-agent usage via server API

export interface AgentOpencodeUsage {
  model: string
  day: string // YYYY-MM-DD (local date of the message)
  tokens: number
  cost: number
}

interface OpencodeAssistantInfo {
  role?: string
  time?: { created?: number }
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

/** Extract per-model/per-day token+cost usage from one opencode agent's message list. */
export function parseAgentOpencodeUsage(messages: OpencodeMessage[]): AgentOpencodeUsage[] {
  const byKey = new Map<string, AgentOpencodeUsage>()
  for (const msg of messages) {
    const info = msg.info as unknown as OpencodeAssistantInfo
    if (info.role !== 'assistant' || !info.tokens) continue
    const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : info.modelID ?? 'unknown'
    const created = info.time?.created
    const day = created ? new Date(created).toISOString().slice(0, 10) : 'unknown'
    const key = `${model}\u0000${day}`
    const entry = byKey.get(key) ?? { model, day, tokens: 0, cost: 0 }
    entry.tokens += info.tokens.total ?? 0
    entry.cost += info.cost ?? 0
    byKey.set(key, entry)
  }
  return [...byKey.values()]
}

// ---------------------------------------------------------------- exhausted / throttled detection

export type OpencodeGroupHealth = 'ok' | 'exhausted' | 'throttled'

const EXHAUSTED_RE = /insufficient account funds/i
const THROTTLED_RE = /(rate limit|\b429\b|too many requests)/i

/** Scan pane/log text for opencode funds/rate-limit signals. */
export function detectOpencodeHealth(text: string): OpencodeGroupHealth {
  if (EXHAUSTED_RE.test(text)) return 'exhausted'
  if (THROTTLED_RE.test(text)) return 'throttled'
  return 'ok'
}
