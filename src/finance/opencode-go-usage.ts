// OpenCode Go's own usage endpoint: exact rolling/weekly/monthly plan-limit percentages,
// straight from the provider (same numbers the opencode.ai/workspace dashboard shows).
// Falls back to a local $-based estimate (opencode-limits.ts) only when this fails.
import fs from 'node:fs'
import { opencodeAuthFile } from './openrouter.js'

export type OpencodeGoWindowStatus = 'ok' | 'rate-limited' | 'exhausted' | string

export interface OpencodeGoUsageWindow {
  status: OpencodeGoWindowStatus
  percent: number
  resetsAt: string // ISO
}

export interface OpencodeGoUsage {
  rolling?: OpencodeGoUsageWindow // 5-hour
  weekly?: OpencodeGoUsageWindow
  monthly?: OpencodeGoUsageWindow
}

interface OpencodeGoUsageResponse {
  usage?: { rolling?: OpencodeGoUsageWindow; weekly?: OpencodeGoUsageWindow; monthly?: OpencodeGoUsageWindow }
}

/** Parse the GET https://opencode.ai/zen/go/v1/usage response body. */
export function parseOpencodeGoUsage(json: string): OpencodeGoUsage | undefined {
  let parsed: OpencodeGoUsageResponse
  try {
    parsed = JSON.parse(json) as OpencodeGoUsageResponse
  } catch {
    return undefined
  }
  if (!parsed.usage) return undefined
  return { rolling: parsed.usage.rolling, weekly: parsed.usage.weekly, monthly: parsed.usage.monthly }
}

/** Read the OpenCode Go API key from opencode's auth.json. Never logged or returned. */
export function readOpencodeGoKey(): string | undefined {
  try {
    const raw = fs.readFileSync(opencodeAuthFile(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, { type?: string; key?: string }>
    return parsed['opencode-go']?.key
  } catch {
    return undefined
  }
}

/** Fetch exact rolling/weekly/monthly plan-usage percentages. Returns undefined on any failure. */
export async function fetchOpencodeGoUsage(key: string | undefined = readOpencodeGoKey()): Promise<OpencodeGoUsage | undefined> {
  if (!key) return undefined
  try {
    const res = await fetch('https://opencode.ai/zen/go/v1/usage', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return undefined
    return parseOpencodeGoUsage(await res.text())
  } catch {
    return undefined
  }
}
