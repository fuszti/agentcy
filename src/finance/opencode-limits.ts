// OpenCode Go rolling-window limit estimator: counts opencode-go model requests in the
// local opencode SQLite store (read-only) and compares against the published per-model
// caps in office.config.json's finance.opencodeGoLimits. Machine-local count only — an
// estimate, always marked with "~".
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpencodeGoModelLimits } from '../lib/types.js'

export const DEFAULT_OPENCODE_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db')

export interface OpencodeGoWindow {
  key: '5h' | 'week' | 'month'
  label: string
  windowMs: number
}

export const OPENCODE_GO_WINDOWS: OpencodeGoWindow[] = [
  { key: '5h', label: '5h', windowMs: 5 * 60 * 60_000 },
  { key: 'week', label: '7d', windowMs: 7 * 86_400_000 },
  { key: 'month', label: '30d', windowMs: 30 * 86_400_000 },
]

interface SqliteCountRow {
  provider: string | null
  model: string | null
  n: number
}

/**
 * Count opencode-go model requests since `sinceMs` (epoch ms). One "request" is one
 * assistant step (a step-start/step-finish part pair, counted once via step-finish) —
 * this is more accurate than counting whole assistant messages when a single message
 * makes several model calls (e.g. tool-use loops).
 */
export function countOpencodeGoRequestsSince(dbPath: string, sinceMs: number): Map<string, number> {
  const counts = new Map<string, number>()
  if (!fs.existsSync(dbPath)) return counts
  const sql = `select json_extract(m.data,'$.providerID') as provider, json_extract(m.data,'$.modelID') as model, count(*) as n
    from part p join message m on p.message_id = m.id
    where json_extract(p.data,'$.type') = 'step-finish' and p.time_created >= ${Math.floor(sinceMs)}
    group by provider, model;`
  let out: string
  try {
    out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return counts
  }
  let rows: SqliteCountRow[]
  try {
    rows = out.trim() ? (JSON.parse(out) as SqliteCountRow[]) : []
  } catch {
    return counts
  }
  for (const r of rows) {
    if (r.provider !== 'opencode-go' || !r.model) continue
    counts.set(r.model, (counts.get(r.model) ?? 0) + (r.n ?? 0))
  }
  return counts
}

export interface OpencodeGoLimitRow {
  model: string
  window: OpencodeGoWindow['key']
  windowLabel: string
  used: number
  limit?: number
  percent?: number
}

/**
 * Build per-model used/limit/% request-count rows for every window. Kept as an internal
 * fallback (unit-tested) — the rendered finance output shows a GROUP-level, dollar-based
 * view instead (see `buildOpencodeGoGroupLimits` below), per the owner's request that the
 * Limits table be per resource group, not per model.
 */
export function buildOpencodeGoLimitRows(
  dbPath: string,
  limits: Record<string, OpencodeGoModelLimits>,
  modelsOfInterest: Set<string>,
  now = Date.now(),
): OpencodeGoLimitRow[] {
  const rows: OpencodeGoLimitRow[] = []
  for (const w of OPENCODE_GO_WINDOWS) {
    const counts = countOpencodeGoRequestsSince(dbPath, now - w.windowMs)
    const models = new Set([...counts.keys(), ...modelsOfInterest])
    for (const model of models) {
      const used = counts.get(model) ?? 0
      const cap = limits[model]
      const limit = cap ? cap[w.key] : undefined
      const percent = limit ? (used / limit) * 100 : undefined
      rows.push({ model, window: w.key, windowLabel: w.label, used, limit, percent })
    }
  }
  return rows
}

// ---------------------------------------------------------------- group-level, dollar-based

/**
 * OpenCode Go's published caps are per-model MONTHLY dollar amounts, applied as a rolling
 * window at 20% (5h) / 50% (week) / 100% (month) of that monthly figure
 * (https://opencode.ai/docs/go/). There is no single combined cap across models, so the
 * office's "OpenCode Go" group limit for a window is the sum of (monthly cap x window
 * fraction) over the models actually in use, and "used" is this office's actual recorded
 * spend on those same models in that window. Always an estimate (`~`): it's a machine-local
 * count of this office's opencode sessions, not an authoritative account-wide figure.
 */
export const OPENCODE_GO_DOLLAR_WINDOWS: { key: OpencodeGoWindow['key']; label: string; windowMs: number; fraction: number }[] = [
  { key: '5h', label: '5h', windowMs: 5 * 60 * 60_000, fraction: 0.2 },
  { key: 'week', label: '7d', windowMs: 7 * 86_400_000, fraction: 0.5 },
  { key: 'month', label: '30d', windowMs: 30 * 86_400_000, fraction: 1.0 },
]

/** Sum recorded opencode-go dollar cost per model since `sinceMs`, from step-finish parts. */
export function sumOpencodeGoCostSince(dbPath: string, sinceMs: number): Map<string, number> {
  const costs = new Map<string, number>()
  if (!fs.existsSync(dbPath)) return costs
  const sql = `select json_extract(m.data,'$.providerID') as provider, json_extract(m.data,'$.modelID') as model, sum(json_extract(p.data,'$.cost')) as cost
    from part p join message m on p.message_id = m.id
    where json_extract(p.data,'$.type') = 'step-finish' and p.time_created >= ${Math.floor(sinceMs)}
    group by provider, model;`
  let out: string
  try {
    out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return costs
  }
  let rows: { provider: string | null; model: string | null; cost: number | null }[]
  try {
    rows = out.trim() ? JSON.parse(out) : []
  } catch {
    return costs
  }
  for (const r of rows) {
    if (r.provider !== 'opencode-go' || !r.model) continue
    costs.set(r.model, (costs.get(r.model) ?? 0) + (r.cost ?? 0))
  }
  return costs
}

export interface OpencodeGoGroupLimitRow {
  window: OpencodeGoWindow['key']
  windowLabel: string
  usedCost: number
  limitCost?: number
}

/**
 * Build the group-level (all models combined) used/limit rows for 5h/7d/30d, restricted to
 * models with usage in the trailing 30 days plus the office's configured opencode models.
 */
export function buildOpencodeGoGroupLimits(
  dbPath: string,
  monthlyDollarCap: Record<string, number>,
  configuredModels: Set<string>,
  now = Date.now(),
): OpencodeGoGroupLimitRow[] {
  const usedInMonth = sumOpencodeGoCostSince(dbPath, now - 30 * 86_400_000)
  const modelsOfInterest = new Set<string>([...usedInMonth.keys(), ...configuredModels])
  return OPENCODE_GO_DOLLAR_WINDOWS.map((w) => {
    const costs = w.key === 'month' ? usedInMonth : sumOpencodeGoCostSince(dbPath, now - w.windowMs)
    let usedCost = 0
    let limitCost: number | undefined
    for (const model of modelsOfInterest) {
      usedCost += costs.get(model) ?? 0
      const cap = monthlyDollarCap[model]
      if (cap !== undefined) limitCost = (limitCost ?? 0) + cap * w.fraction
    }
    return { window: w.key, windowLabel: w.label, usedCost, limitCost }
  })
}

/** Resolve the local opencode SQLite store path, overridable via OPENCODE_DATA_DIR (mirrors openrouter.ts's auth.json lookup). */
export function resolveOpencodeDbPath(): string {
  const dir = process.env.OPENCODE_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'opencode')
  return path.join(dir, 'opencode.db')
}
