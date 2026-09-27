import { describe, expect, it } from 'vitest'
import { buildClaudeLimitRows, buildOpencodeGoLimitRowsExact, buildOpencodeGoLimitRowsEstimate, buildOpenrouterLimitRows } from '../src/finance/limits.js'
import { renderLimitsTable } from '../src/finance/render.js'

describe('buildClaudeLimitRows', () => {
  it('renders session/week rows with "-" used/limit and a % remaining', () => {
    const rows = buildClaudeLimitRows('Claude subscription', {
      session: { percent: 25, resets: '1:09pm (Europe/Budapest)' },
      week: { percent: 15, resets: 'Sep 29, 8:59pm (Europe/Budapest)' },
    })
    const session = rows.find((r) => r.window === '5-hour session')!
    expect(session.usedText).toBe('–')
    expect(session.limitText).toBe('–')
    expect(session.percent).toBe(25)
    expect(session.remainingText).toBe('75%')
    expect(session.resets).toBe('1:09pm (Europe/Budapest)')
  })

  it('shows an "extra credits" row noting it is off when disabled', () => {
    const rows = buildClaudeLimitRows('Claude subscription', { session: { percent: 4, resets: 'x' }, extraUsage: { enabled: false } })
    const extra = rows.find((r) => r.window.startsWith('extra credits'))!
    expect(extra.note).toMatch(/off/)
  })

  it('falls back to a single unavailable row when the probe failed', () => {
    const rows = buildClaudeLimitRows('Claude subscription', undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toMatch(/unavailable/)
  })
})

describe('buildOpencodeGoLimitRowsExact', () => {
  it('maps rolling/weekly/monthly with status + countdown resets', () => {
    const rows = buildOpencodeGoLimitRowsExact(
      'OpenCode Go',
      {
        rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-27T12:38:29.990Z' },
        weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-28T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 50, resetsAt: '2026-10-25T13:52:49.000Z' },
      },
      Date.parse('2026-09-27T10:00:00.000Z'),
    )
    const weekly = rows.find((r) => r.window === 'Weekly')!
    expect(weekly.percent).toBe(100)
    expect(weekly.status).toBe('rate-limited')
    expect(weekly.resets).toMatch(/in /)
    expect(rows.find((r) => r.window === 'extra credits')?.note).toBeTruthy()
  })
})

describe('buildOpencodeGoLimitRowsEstimate', () => {
  it('renders dollar used/limit and marks as estimate', () => {
    const rows = buildOpencodeGoLimitRowsEstimate('OpenCode Go', [
      { window: '5h', windowLabel: '5h', usedCost: 1.5, limitCost: 12 },
      { window: 'week', windowLabel: '7d', usedCost: 10, limitCost: undefined },
    ])
    const first = rows.find((r) => r.window === 'Rolling (5h)')!
    expect(first.usedText).toBe('$1.50')
    expect(first.limitText).toBe('$12.00')
    expect(first.isEstimate).toBe(true)
    expect(first.percent).toBeCloseTo(12.5)
    const second = rows.find((r) => r.window === 'Weekly')!
    expect(second.limitText).toBe('–')
    expect(second.note).toMatch(/no published/)
  })
})

describe('buildOpenrouterLimitRows', () => {
  it('renders a balance row and a key-month row', () => {
    const rows = buildOpenrouterLimitRows(
      'OpenRouter',
      { totalCredits: 440, totalUsage: 434.1, remaining: 5.9 },
      { limit: 20, usageDaily: 1, usageWeekly: 5, usageMonthly: 18 },
    )
    expect(rows.find((r) => r.window === 'balance')?.remainingText).toBe('$5.90')
    const keyMonth = rows.find((r) => r.window === 'key month')!
    expect(keyMonth.usedText).toBe('$18.00')
    expect(keyMonth.limitText).toBe('$20.00')
    expect(keyMonth.percent).toBe(90)
  })
})

describe('renderLimitsTable', () => {
  it('renders a bar next to the percent and a status icon', () => {
    const md = renderLimitsTable([
      { group: 'OpenCode Go', window: 'Weekly', usedText: '–', limitText: '–', percent: 100, remainingText: '0%', resets: 'in 5h', status: 'rate-limited' },
    ])
    expect(md).toContain('🟠')
    expect(md).toContain('▰▰▰▰▰▰▰▰▰▰')
    expect(md).toContain('100%')
  })
})
