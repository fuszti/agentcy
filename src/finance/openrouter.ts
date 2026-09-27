// OpenRouter collector: GET /api/v1/credits with the key from opencode's auth.json.
// Read-only; the API key itself is never logged, returned or posted anywhere.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface OpenrouterCredits {
  totalCredits: number
  totalUsage: number
  remaining: number
}

interface OpenrouterCreditsResponse {
  data?: { total_credits?: number; total_usage?: number }
}

/** Parse the OpenRouter /api/v1/credits response body. */
export function parseOpenrouterCredits(json: string): OpenrouterCredits | undefined {
  let parsed: OpenrouterCreditsResponse
  try {
    parsed = JSON.parse(json) as OpenrouterCreditsResponse
  } catch {
    return undefined
  }
  const total = parsed.data?.total_credits
  const used = parsed.data?.total_usage
  if (total === undefined || used === undefined) return undefined
  return { totalCredits: total, totalUsage: used, remaining: total - used }
}

/** Path to opencode's auth store (holds provider API keys), overridable via OPENCODE_DATA_DIR. */
export function opencodeAuthFile(): string {
  const dir = process.env.OPENCODE_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'opencode')
  return path.join(dir, 'auth.json')
}

/** Read the OpenRouter API key from opencode's auth.json. Returns undefined if absent/unreadable. */
export function readOpenrouterKey(): string | undefined {
  try {
    const raw = fs.readFileSync(opencodeAuthFile(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, { type?: string; key?: string }>
    return parsed.openrouter?.key
  } catch {
    return undefined
  }
}

/** Fetch current OpenRouter credit balance. Returns undefined on any failure (network, auth, parse). */
export async function fetchOpenrouterCredits(key: string | undefined = readOpenrouterKey()): Promise<OpenrouterCredits | undefined> {
  if (!key) return undefined
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return undefined
    return parseOpenrouterCredits(await res.text())
  } catch {
    return undefined
  }
}

/** What the office's own key has spent (GET /api/v1/key), as opposed to the account's lifetime total. */
export interface OpenrouterKeyUsage {
  limit?: number // monthly (or other) cap on this key, undefined = no cap
  limitRemaining?: number
  usageDaily: number
  usageWeekly: number
  usageMonthly: number
}

/** Parse the OpenRouter /api/v1/key response body. */
export function parseOpenrouterKey(json: string): OpenrouterKeyUsage | undefined {
  try {
    const d = (JSON.parse(json) as { data?: Record<string, unknown> }).data
    if (!d) return undefined
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
    return {
      limit: num(d.limit), limitRemaining: num(d.limit_remaining),
      usageDaily: num(d.usage_daily) ?? 0, usageWeekly: num(d.usage_weekly) ?? 0, usageMonthly: num(d.usage_monthly) ?? 0,
    }
  } catch {
    return undefined
  }
}

export async function fetchOpenrouterKeyUsage(key: string | undefined = readOpenrouterKey()): Promise<OpenrouterKeyUsage | undefined> {
  if (!key) return undefined
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
    return res.ok ? parseOpenrouterKey(await res.text()) : undefined
  } catch {
    return undefined
  }
}
