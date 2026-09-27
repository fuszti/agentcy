import { describe, expect, it } from 'vitest'
import { createFinanceAlertState, detectAgentSpikeAlerts, detectGroupAlerts, detectSpendSpike } from '../src/finance/alerts.js'
import type { GroupRow } from '../src/finance/render.js'

function group(over: Partial<GroupRow> = {}): GroupRow {
  return { id: 'claude-sub', label: 'Claude subscription', status: 'ok', agents: ['ada'], ...over }
}

describe('detectGroupAlerts', () => {
  it('fires once per threshold bucket crossed, ascending', () => {
    const state = createFinanceAlertState()
    const a1 = detectGroupAlerts([group({ usagePercent: 80 })], [75, 90, 100], state)
    expect(a1).toHaveLength(1)
    expect(a1[0].message).toContain('80%')
    expect(a1[0].message).toContain('75%')

    // Same bucket again: no repeat alert.
    const a2 = detectGroupAlerts([group({ usagePercent: 82 })], [75, 90, 100], state)
    expect(a2).toHaveLength(0)

    // Crosses into 90 bucket: fires again.
    const a3 = detectGroupAlerts([group({ usagePercent: 91 })], [75, 90, 100], state)
    expect(a3).toHaveLength(1)
    expect(a3[0].message).toContain('90%')
  })

  it('clears the bucket once usage drops below all thresholds', () => {
    const state = createFinanceAlertState()
    detectGroupAlerts([group({ usagePercent: 80 })], [75, 90, 100], state)
    detectGroupAlerts([group({ usagePercent: 10 })], [75, 90, 100], state)
    const again = detectGroupAlerts([group({ usagePercent: 80 })], [75, 90, 100], state)
    expect(again).toHaveLength(1) // re-fires since it dropped and came back
  })

  it('fires one alert for exhausted/throttled and clears when resolved', () => {
    const state = createFinanceAlertState()
    const a1 = detectGroupAlerts([group({ status: 'exhausted' })], [75, 90, 100], state)
    expect(a1).toHaveLength(1)
    expect(a1[0].message).toContain('exhausted')

    const a2 = detectGroupAlerts([group({ status: 'exhausted' })], [75, 90, 100], state)
    expect(a2).toHaveLength(0) // no repeat

    const a3 = detectGroupAlerts([group({ status: 'ok' })], [75, 90, 100], state)
    expect(a3).toHaveLength(0)

    const a4 = detectGroupAlerts([group({ status: 'exhausted' })], [75, 90, 100], state)
    expect(a4).toHaveLength(1) // re-fires after clearing
  })

  it('ignores groups with unknown usage percent', () => {
    const state = createFinanceAlertState()
    expect(detectGroupAlerts([group({ usagePercent: undefined })], [75, 90, 100], state)).toHaveLength(0)
  })
})

describe('detectSpendSpike', () => {
  const now = Date.parse('2026-09-26T12:00:00Z')

  it('returns undefined with no prior-week history', () => {
    expect(detectSpendSpike([{ at: now - 1000, amount: 5 }], now, 5)).toBeUndefined()
  })

  it('flags a spike when last-hour spend exceeds N times the 7-day hourly average', () => {
    const events = [
      // Steady low spend over the prior week: 0.01/hour average.
      ...Array.from({ length: 7 }, (_, d) => ({ at: now - (d + 1) * 86_400_000, amount: 0.24 })),
      // A burst in the last hour.
      { at: now - 60_000, amount: 5 },
    ]
    const result = detectSpendSpike(events, now, 5)!
    expect(result.isSpike).toBe(true)
    expect(result.lastHour).toBe(5)
  })

  it('does not flag normal variation', () => {
    const events = [
      ...Array.from({ length: 7 }, (_, d) => ({ at: now - (d + 1) * 86_400_000, amount: 24 })), // 1/hour avg
      { at: now - 60_000, amount: 2 },
    ]
    const result = detectSpendSpike(events, now, 5)!
    expect(result.isSpike).toBe(false)
  })
})

describe('detectAgentSpikeAlerts', () => {
  it('fires once per agent while spiking, clears when it stops', () => {
    const state = createFinanceAlertState()
    const now = Date.parse('2026-09-26T12:00:00Z')
    const spiking = new Map([
      ['rex', [...Array.from({ length: 7 }, (_, d) => ({ at: now - (d + 1) * 86_400_000, amount: 0.24 })), { at: now - 60_000, amount: 5 }]],
    ])
    const a1 = detectAgentSpikeAlerts(spiking, now, 5, state)
    expect(a1).toHaveLength(1)
    expect(a1[0].message).toContain('@rex')

    const a2 = detectAgentSpikeAlerts(spiking, now, 5, state)
    expect(a2).toHaveLength(0)

    const calm = new Map([['rex', [{ at: now - 60_000, amount: 0 }]]])
    const a3 = detectAgentSpikeAlerts(calm, now, 5, state)
    expect(a3).toHaveLength(0)
  })
})
