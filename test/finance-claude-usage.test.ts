import { describe, expect, it } from 'vitest'
import { parseClaudeUsageOutput, isEmptyClaudeUsage } from '../src/finance/claude-usage.js'

describe('parseClaudeUsageOutput', () => {
  it('parses the real multi-line /usage block format', () => {
    const pane = `
Current session
████████████▌   25% used
Resets 1:09pm (Europe/Budapest)

Current week (all models)
███████▌   15% used
Resets Sep 29, 8:59pm (Europe/Budapest)

Usage credits
Usage credits are off · /usage-credits to turn them on
`
    const limits = parseClaudeUsageOutput(pane)
    expect(limits.session).toEqual({ percent: 25, resets: '1:09pm (Europe/Budapest)' })
    expect(limits.week).toEqual({ percent: 15, resets: 'Sep 29, 8:59pm (Europe/Budapest)' })
    expect(limits.extraUsage).toEqual({ enabled: false })
    expect(isEmptyClaudeUsage(limits)).toBe(false)
  })

  it('parses per-model weekly lines (Opus/Sonnet)', () => {
    const pane = `
Current week (Opus)
██▌   12% used
Resets Sep 27, 10am

Current week (Sonnet)
██████████████▌   60% used
Resets Sep 27, 10am
`
    const limits = parseClaudeUsageOutput(pane)
    expect(limits.weekOpus).toEqual({ percent: 12, resets: 'Sep 27, 10am' })
    expect(limits.weekSonnet).toEqual({ percent: 60, resets: 'Sep 27, 10am' })
  })

  it('accepts the older single-line format', () => {
    const limits = parseClaudeUsageOutput('Current session: 4% used · resets Sep 26, 5:50am (Europe/Budapest)\nCurrent week (all models): 84% used · resets Sep 27, 10am')
    expect(limits.session).toEqual({ percent: 4, resets: 'Sep 26, 5:50am (Europe/Budapest)' })
    expect(limits.week).toEqual({ percent: 84, resets: 'Sep 27, 10am' })
  })

  it('parses extra usage credits when enabled with amounts', () => {
    const pane = 'Usage credits\nUsage credits are on · $12.34 spent of $50.00 limit'
    const limits = parseClaudeUsageOutput(pane)
    expect(limits.extraUsage).toEqual({ enabled: true, amount: 12.34, limit: 50.0 })
  })

  it('returns empty limits and isEmptyClaudeUsage=true for unrelated text', () => {
    const limits = parseClaudeUsageOutput('nothing here')
    expect(isEmptyClaudeUsage(limits)).toBe(true)
  })
})
