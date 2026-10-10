import { describe, expect, it } from 'vitest'
import { createFinanceAlertState, detectAgentSpikeAlerts, detectGroupAlerts, detectLimitAlerts, detectSpendSpike } from '../src/finance/alerts.js'
import type { GroupRow, LimitRow } from '../src/finance/render.js'

function group(over: Partial<GroupRow> = {}): GroupRow {
  return { id: 'claude-sub', label: 'Claude subscription', status: 'ok', agents: ['ada'], ...over }
}

function limit(over: Partial<LimitRow> = {}): LimitRow {
  return { group: 'Claude subscription', window: 'week (all models)', usedText: '-', limitText: '-', percent: 80, remainingText: '20%', resets: 'Mon 09:00', ...over }
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

describe('detectGroupAlerts with suggest', () => {
  it('keeps the exact messages when no suggest is given', () => {
    const state = createFinanceAlertState()
    const a1 = detectGroupAlerts([group({ usagePercent: 80 })], [75, 90, 100], state)
    expect(a1.map((a) => a.message)).toEqual(['📊 **Claude subscription** usage is 80% (crossed 75%).'])
    const a2 = detectGroupAlerts([group({ status: 'exhausted' })], [75, 90, 100], createFinanceAlertState())
    expect(a2.map((a) => a.message)).toEqual(['🔴 **Claude subscription** is exhausted. Agents billed to it (@ada) may be blocked.'])
  })

  it('appends the suggestion to usage-threshold alerts', () => {
    const state = createFinanceAlertState()
    const calls: string[] = []
    const suggest = (id: string) => {
      calls.push(id)
      return `Move @ada to claude-2.`
    }
    const a = detectGroupAlerts([group({ id: 'claude-1', usagePercent: 91 })], [75, 90, 100], state, suggest)
    expect(a).toHaveLength(1)
    expect(a[0].message.startsWith('📊 **Claude subscription** usage is 91% (crossed 90%).')).toBe(true)
    expect(a[0].message).toContain('Move @ada to claude-2.')
    expect(a[0].key).toBe('group:claude-1:usage:90')
    expect(calls).toContain('claude-1')
  })

  it('appends the suggestion to exhausted and throttled alerts', () => {
    const suggest = (id: string) => `Suggest for ${id}.`
    const ex = detectGroupAlerts([group({ id: 'claude-1', status: 'exhausted' })], [75, 90, 100], createFinanceAlertState(), suggest)
    expect(ex).toHaveLength(1)
    expect(ex[0].message.startsWith('🔴 **Claude subscription** is exhausted.')).toBe(true)
    expect(ex[0].message).toContain('Suggest for claude-1.')

    const th = detectGroupAlerts([group({ id: 'og-2', label: 'OpenCode Go', status: 'throttled' })], [75, 90, 100], createFinanceAlertState(), suggest)
    expect(th).toHaveLength(1)
    expect(th[0].message.startsWith('🟠 **OpenCode Go** is throttled.')).toBe(true)
    expect(th[0].message).toContain('Suggest for og-2.')
  })

  it('leaves messages unchanged when suggest returns undefined', () => {
    const suggest = () => undefined
    const a = detectGroupAlerts([group({ usagePercent: 80, status: 'exhausted' })], [75, 90, 100], createFinanceAlertState(), suggest)
    expect(a.map((x) => x.message)).toEqual([
      '📊 **Claude subscription** usage is 80% (crossed 75%).',
      '🔴 **Claude subscription** is exhausted. Agents billed to it (@ada) may be blocked.',
    ])
  })
})

describe('detectLimitAlerts', () => {
  it('fires once per bucket and resets below threshold (unchanged behaviour)', () => {
    const state = createFinanceAlertState()
    const a1 = detectLimitAlerts([limit({ percent: 80 })], [75, 90], state)
    expect(a1).toHaveLength(1)
    expect(detectLimitAlerts([limit({ percent: 85 })], [75, 90], state)).toHaveLength(0)
    expect(detectLimitAlerts([limit({ percent: 91 })], [75, 90], state)).toHaveLength(1)
    expect(detectLimitAlerts([limit({ percent: 10 })], [75, 90], state)).toHaveLength(0)
    expect(detectLimitAlerts([limit({ percent: 80 })], [75, 90], state)).toHaveLength(1)
  })

  it('keeps the exact message when no suggest is given', () => {
    const a = detectLimitAlerts([limit({ percent: 80 })], [75, 90], createFinanceAlertState())
    expect(a[0].message).toBe('⏳ **Claude subscription** · week (all models) is 80% used (crossed 75%) — resets Mon 09:00.')
  })

  it('keys by the label when the row has no groupId', () => {
    const state = createFinanceAlertState()
    const a = detectLimitAlerts([limit({ percent: 80 })], [75, 90], state)
    expect(a[0].key).toBe('limit:Claude subscription:week (all models):75')
    expect(state.thresholdBucket.get('limit:Claude subscription:week (all models)')).toBe(75)
  })

  it('keys by groupId when the row has one', () => {
    const state = createFinanceAlertState()
    const a = detectLimitAlerts([limit({ groupId: 'claude-2', percent: 80 })], [75, 90], state)
    expect(a[0].key).toBe('limit:claude-2:week (all models):75')
    expect(state.thresholdBucket.get('limit:claude-2:week (all models)')).toBe(75)
    expect(state.thresholdBucket.has('limit:Claude subscription:week (all models)')).toBe(false)
  })

  it('alerts independently for two groups sharing a label but not a groupId', () => {
    const state = createFinanceAlertState()
    const a1 = detectLimitAlerts([limit({ groupId: 'claude-1', percent: 80 }), limit({ groupId: 'claude-2', percent: 80 })], [75, 90], state)
    expect(a1).toHaveLength(2)
    expect(a1.map((a) => a.key).sort()).toEqual(['limit:claude-1:week (all models):75', 'limit:claude-2:week (all models):75'])

    // claude-1 drops below threshold; claude-2 stays: only claude-1's bucket resets.
    const a2 = detectLimitAlerts([limit({ groupId: 'claude-1', percent: 10 }), limit({ groupId: 'claude-2', percent: 82 })], [75, 90], state)
    expect(a2).toHaveLength(0)
    const a3 = detectLimitAlerts([limit({ groupId: 'claude-1', percent: 80 }), limit({ groupId: 'claude-2', percent: 83 })], [75, 90], state)
    expect(a3.map((a) => a.key)).toEqual(['limit:claude-1:week (all models):75'])
  })

  it('calls suggest with the row groupId and appends its text', () => {
    const calls: string[] = []
    const suggest = (id: string) => {
      calls.push(id)
      return `Move @ada to claude-1.`
    }
    const a = detectLimitAlerts([limit({ groupId: 'claude-2', percent: 91 })], [75, 90], createFinanceAlertState(), suggest)
    expect(a).toHaveLength(1)
    expect(calls).toEqual(['claude-2'])
    expect(a[0].message.startsWith('⏳ **Claude subscription** · week (all models) is 91% used (crossed 90%) — resets Mon 09:00.')).toBe(true)
    expect(a[0].message).toContain('Move @ada to claude-1.')
  })

  it('leaves the message unchanged when suggest returns undefined', () => {
    const a = detectLimitAlerts([limit({ groupId: 'claude-2', percent: 80 })], [75, 90], createFinanceAlertState(), () => undefined)
    expect(a[0].message).toBe('⏳ **Claude subscription** · week (all models) is 80% used (crossed 75%) — resets Mon 09:00.')
  })

  it('does not call suggest for rows without a groupId', () => {
    const calls: string[] = []
    const suggest = (id: string) => {
      calls.push(id)
      return 'should not appear'
    }
    const a = detectLimitAlerts([limit({ percent: 80 })], [75, 90], createFinanceAlertState(), suggest)
    expect(a).toHaveLength(1)
    expect(calls).toEqual([])
    expect(a[0].message).not.toContain('should not appear')
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
