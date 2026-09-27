// Pure builders that turn each collector's raw data into the group-level `LimitRow`s
// rendered in the "Limits" section (`finance limits`, the combined report, and the daily
// report). No I/O here — see collect.ts for the calls that gather the raw data.
import type { ClaudeUsageLimits, ClaudeUsageWindow } from './claude-usage.js'
import type { OpencodeGoUsage, OpencodeGoUsageWindow } from './opencode-go-usage.js'
import type { OpencodeGoGroupLimitRow } from './opencode-limits.js'
import type { OpenrouterCredits, OpenrouterKeyUsage } from './openrouter.js'
import type { LimitRow } from './render.js'

const DASH = '–'

function fmtCountdown(resetsAtIso: string, now = Date.now()): string {
  const at = Date.parse(resetsAtIso)
  if (!Number.isFinite(at)) return resetsAtIso
  const local = new Date(at).toLocaleString()
  const ms = at - now
  if (ms <= 0) return local
  const totalMin = Math.round(ms / 60_000)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (days || hours) parts.push(`${hours}h`)
  parts.push(`${mins}m`)
  return `${local} (in ${parts.join(' ')})`
}

// ---------------------------------------------------------------- Claude subscription

/** Claude session/weekly (+ per-model weekly) rows, plus an "extra credits" (pay-as-you-go) row. */
export function buildClaudeLimitRows(label: string, limits: ClaudeUsageLimits | undefined): LimitRow[] {
  if (!limits) {
    return [{
      group: label, window: '5-hour session', usedText: DASH, limitText: DASH, remainingText: DASH, resets: DASH,
      note: 'usage probe unavailable (claude CLI failed, or no fresh cache yet)',
    }]
  }
  const rows: LimitRow[] = []
  const push = (window: string, w?: ClaudeUsageWindow) => {
    if (!w) return
    rows.push({ group: label, window, usedText: DASH, limitText: DASH, percent: w.percent, remainingText: `${Math.max(0, 100 - w.percent)}%`, resets: w.resets })
  }
  push('5-hour session', limits.session)
  push('week (all models)', limits.week)
  push('week (Opus)', limits.weekOpus)
  push('week (Sonnet)', limits.weekSonnet)

  const e = limits.extraUsage
  if (e?.enabled) {
    const hasAmounts = e.amount !== undefined
    rows.push({
      group: label, window: 'extra credits: 🟢 on',
      usedText: hasAmounts ? `$${e.amount!.toFixed(2)}` : DASH,
      limitText: e.limit !== undefined ? `$${e.limit.toFixed(2)}` : DASH,
      percent: hasAmounts && e.limit ? (e.amount! / e.limit) * 100 : undefined,
      remainingText: hasAmounts && e.limit !== undefined ? `$${Math.max(0, e.limit - e.amount!).toFixed(2)}` : DASH,
      resets: DASH,
    })
  } else {
    rows.push({
      group: label, window: e ? 'extra credits: ⚪ off' : 'extra credits', usedText: DASH, limitText: DASH, remainingText: DASH, resets: DASH,
      note: e ? 'extra usage (pay-as-you-go) is off' : 'not shown in /usage output',
    })
  }
  return rows
}

// ---------------------------------------------------------------- OpenCode Go

const OPENCODE_GO_WINDOW_LABEL: Record<string, string> = { '5h': 'Rolling (5h)', week: 'Weekly', month: 'Monthly' }

function opencodeGoStatus(status: string): LimitRow['status'] {
  if (status === 'rate-limited') return 'rate-limited'
  if (status === 'exhausted') return 'exhausted'
  return 'ok'
}

/** Exact plan-usage rows from GET opencode.ai/zen/go/v1/usage (same numbers as the dashboard). */
export function buildOpencodeGoLimitRowsExact(label: string, usage: OpencodeGoUsage, now = Date.now()): LimitRow[] {
  const mk = (window: string, w?: OpencodeGoUsageWindow): LimitRow | undefined => {
    if (!w) return undefined
    return {
      group: label, window, usedText: DASH, limitText: DASH, percent: w.percent,
      remainingText: `${Math.max(0, 100 - w.percent)}%`, resets: fmtCountdown(w.resetsAt, now), status: opencodeGoStatus(w.status),
    }
  }
  const rows = [mk('Rolling (5h)', usage.rolling), mk('Weekly', usage.weekly), mk('Monthly', usage.monthly)].filter((r): r is LimitRow => !!r)
  rows.push({ group: label, window: 'extra credits', usedText: DASH, limitText: DASH, remainingText: DASH, resets: DASH, note: 'not exposed by the usage endpoint' })
  return rows
}

/** Local $-based fallback rows, used only when the exact usage endpoint is unreachable. */
export function buildOpencodeGoLimitRowsEstimate(label: string, groupRows: OpencodeGoGroupLimitRow[]): LimitRow[] {
  const rows: LimitRow[] = groupRows.map((r) => ({
    group: label,
    window: OPENCODE_GO_WINDOW_LABEL[r.window] ?? r.windowLabel,
    usedText: `$${r.usedCost.toFixed(2)}`,
    limitText: r.limitCost !== undefined ? `$${r.limitCost.toFixed(2)}` : DASH,
    percent: r.limitCost ? (r.usedCost / r.limitCost) * 100 : undefined,
    remainingText: r.limitCost !== undefined ? `$${Math.max(0, r.limitCost - r.usedCost).toFixed(2)}` : DASH,
    resets: 'rolling',
    isEstimate: true,
    note: r.limitCost === undefined
      ? 'no published $ cap for the models in use; showing spend only'
      : 'local estimate (opencode.ai/zen/go/v1/usage unreachable) — dashboard is authoritative: https://opencode.ai/workspace',
  }))
  rows.push({ group: label, window: 'extra credits', usedText: DASH, limitText: DASH, remainingText: DASH, resets: DASH, note: 'unavailable in fallback estimate mode' })
  return rows
}

// ---------------------------------------------------------------- OpenRouter

export function buildOpenrouterLimitRows(label: string, credits?: OpenrouterCredits, keyUse?: OpenrouterKeyUsage): LimitRow[] {
  const rows: LimitRow[] = []
  if (credits) {
    const percent = credits.totalCredits ? (credits.totalUsage / credits.totalCredits) * 100 : undefined
    rows.push({ group: label, window: 'balance', usedText: DASH, limitText: DASH, percent: undefined, remainingText: `$${credits.remaining.toFixed(2)}`, resets: DASH })
  }
  if (keyUse) {
    const percent = keyUse.limit ? (keyUse.usageMonthly / keyUse.limit) * 100 : undefined
    rows.push({
      group: label, window: 'key month',
      usedText: `$${keyUse.usageMonthly.toFixed(2)}`,
      limitText: keyUse.limit !== undefined ? `$${keyUse.limit.toFixed(2)}` : DASH,
      percent, remainingText: keyUse.limit !== undefined ? `$${Math.max(0, keyUse.limit - keyUse.usageMonthly).toFixed(2)}` : DASH,
      resets: 'monthly',
    })
  }
  if (!rows.length) rows.push({ group: label, window: 'balance', usedText: DASH, limitText: DASH, remainingText: DASH, resets: DASH, note: 'unavailable' })
  return rows
}
