// Finance watchdog: incident detection (pure) + persisted alert state so the admin
// daemon posts exactly one alert per incident in #office-finance, cleared once resolved.
// Modeled after src/admin/watchdog.ts's alerted-key pattern.

import fs from 'node:fs'
import path from 'node:path'
import { shouldAlertThreshold } from '../admin/monitor.js'
import type { GroupRow, LimitRow } from './render.js'

export interface FinanceAlertState {
  /** Last threshold bucket fired per group (e.g. "claude-sub" -> 90). */
  thresholdBucket: Map<string, number>
  /** Groups currently alerted as exhausted/throttled (cleared when back to ok). */
  healthAlerted: Set<string>
  /** Agents currently alerted for a spend spike this hour (cleared next hour). */
  spikeAlerted: Set<string>
  /** Local date (YYYY-MM-DD) the daily report was last posted, to post at most once/day. */
  lastDailyReportDate?: string
}

export function createFinanceAlertState(): FinanceAlertState {
  return { thresholdBucket: new Map(), healthAlerted: new Set(), spikeAlerted: new Set() }
}

export interface FinanceAlert {
  key: string
  message: string
}

/** Detect usage-threshold crossings and exhausted/throttled groups. Mutates state to record what fired. */
export function detectGroupAlerts(groups: GroupRow[], thresholds: number[], state: FinanceAlertState): FinanceAlert[] {
  const alerts: FinanceAlert[] = []
  for (const g of groups) {
    // Threshold crossing.
    if (g.usagePercent !== undefined) {
      const bucket = shouldAlertThreshold(g.usagePercent, thresholds)
      const key = `group:${g.id}:usage`
      const last = state.thresholdBucket.get(key)
      if (bucket !== undefined && bucket !== last) {
        alerts.push({ key: `${key}:${bucket}`, message: `📊 **${g.label}** usage is ${Math.round(g.usagePercent)}% (crossed ${bucket}%).` })
        state.thresholdBucket.set(key, bucket)
      } else if (bucket === undefined) {
        state.thresholdBucket.delete(key)
      }
    }

    // Exhausted / throttled.
    const healthKey = `group:${g.id}:health`
    if (g.status === 'exhausted' || g.status === 'throttled') {
      if (!state.healthAlerted.has(healthKey)) {
        const icon = g.status === 'exhausted' ? '🔴' : '🟠'
        alerts.push({ key: healthKey, message: `${icon} **${g.label}** is ${g.status}. Agents billed to it (${g.agents.map((a) => `@${a}`).join(', ') || 'none'}) may be blocked.` })
        state.healthAlerted.add(healthKey)
      }
    } else {
      state.healthAlerted.delete(healthKey)
    }
  }
  return alerts
}

/**
 * Detect a rolling-window Limits row crossing an alert threshold (e.g. 80%, 95%), including
 * Claude's weekly %. Same one-per-incident-bucket pattern as `detectGroupAlerts`, keyed by
 * group + window so Claude session/week and each OpenCode Go window alert independently.
 */
export function detectLimitAlerts(rows: LimitRow[], thresholds: number[], state: FinanceAlertState): FinanceAlert[] {
  const alerts: FinanceAlert[] = []
  for (const r of rows) {
    const key = `limit:${r.group}:${r.window}`
    if (r.percent === undefined) {
      state.thresholdBucket.delete(key)
      continue
    }
    const bucket = shouldAlertThreshold(r.percent, thresholds)
    const last = state.thresholdBucket.get(key)
    if (bucket !== undefined && bucket !== last) {
      alerts.push({ key: `${key}:${bucket}`, message: `⏳ **${r.group}** · ${r.window} is ${Math.round(r.percent)}% used (crossed ${bucket}%)${r.resets && r.resets !== '–' ? ` — resets ${r.resets}` : ''}.` })
      state.thresholdBucket.set(key, bucket)
    } else if (bucket === undefined) {
      state.thresholdBucket.delete(key)
    }
  }
  return alerts
}

/** A timestamped cost/token amount for one agent, used for spike detection. */
export interface UsageEvent {
  at: number // epoch ms
  amount: number
}

/**
 * True if the sum of events in the last hour exceeds `multiplier` times the agent's
 * trailing-7-day hourly average (computed over the 7 days before the last hour).
 * Returns undefined when there isn't enough history to judge (avoids false positives
 * on a brand-new agent).
 */
export function detectSpendSpike(events: UsageEvent[], nowMs: number, multiplier: number): { isSpike: boolean; lastHour: number; hourlyAvg7d: number } | undefined {
  const hourAgo = nowMs - 3_600_000
  const weekAgo = nowMs - 7 * 86_400_000
  const lastHour = events.filter((e) => e.at >= hourAgo && e.at <= nowMs).reduce((s, e) => s + e.amount, 0)
  const priorWeek = events.filter((e) => e.at >= weekAgo && e.at < hourAgo)
  if (priorWeek.length === 0) return undefined
  const priorHours = Math.max(1, (hourAgo - weekAgo) / 3_600_000)
  const hourlyAvg7d = priorWeek.reduce((s, e) => s + e.amount, 0) / priorHours
  if (hourlyAvg7d <= 0) return lastHour > 0 ? { isSpike: true, lastHour, hourlyAvg7d } : { isSpike: false, lastHour, hourlyAvg7d }
  return { isSpike: lastHour > multiplier * hourlyAvg7d, lastHour, hourlyAvg7d }
}

/** Detect per-agent spend spikes from a map of agent name -> usage events. */
export function detectAgentSpikeAlerts(
  usageByAgent: Map<string, UsageEvent[]>,
  nowMs: number,
  multiplier: number,
  state: FinanceAlertState,
): FinanceAlert[] {
  const alerts: FinanceAlert[] = []
  for (const [agent, events] of usageByAgent) {
    const result = detectSpendSpike(events, nowMs, multiplier)
    const key = `agent:${agent}:spike`
    if (result?.isSpike) {
      if (!state.spikeAlerted.has(key)) {
        alerts.push({
          key,
          message: `⚡ @${agent} spent ${result.lastHour.toFixed(3)} in the last hour vs a 7-day hourly average of ${result.hourlyAvg7d.toFixed(3)} (>${multiplier}×).`,
        })
        state.spikeAlerted.add(key)
      }
    } else {
      state.spikeAlerted.delete(key)
    }
  }
  return alerts
}

// ---------------------------------------------------------------- persistence

interface PersistedFinanceAlertState {
  thresholdBucket?: [string, number][]
  healthAlerted?: string[]
  spikeAlerted?: string[]
  lastDailyReportDate?: string
}

function stateFile(root: string): string {
  return path.join(root, 'state', 'admin', 'finance.json')
}

export function loadFinanceAlertState(root: string): FinanceAlertState {
  try {
    const raw = fs.readFileSync(stateFile(root), 'utf8')
    const parsed = JSON.parse(raw) as PersistedFinanceAlertState
    return {
      thresholdBucket: new Map(parsed.thresholdBucket ?? []),
      healthAlerted: new Set(parsed.healthAlerted ?? []),
      spikeAlerted: new Set(parsed.spikeAlerted ?? []),
      lastDailyReportDate: parsed.lastDailyReportDate,
    }
  } catch {
    return createFinanceAlertState()
  }
}

export function saveFinanceAlertState(root: string, state: FinanceAlertState): void {
  const file = stateFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        thresholdBucket: [...state.thresholdBucket],
        healthAlerted: [...state.healthAlerted],
        spikeAlerted: [...state.spikeAlerted],
        lastDailyReportDate: state.lastDailyReportDate,
      },
      null,
      2,
    ) + '\n',
  )
}
