import { describe, expect, it } from 'vitest'
import { parseClaudeAuthStatus, parseClaudeTokenUsage, parseClaudeWeeklyUsageFromPane, sumTokenUsage } from '../src/finance/claude.js'

describe('parseClaudeAuthStatus', () => {
  it('extracts plan and org name, nothing else', () => {
    const json = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'example@example.com',
      orgId: 'abc-123',
      orgName: "Example Org",
      subscriptionType: 'pro',
    })
    const info = parseClaudeAuthStatus(json)
    expect(info).toEqual({ loggedIn: true, plan: 'pro', orgName: "Example Org" })
  })

  it('returns undefined on invalid JSON', () => {
    expect(parseClaudeAuthStatus('not json')).toBeUndefined()
  })

  it('reports loggedIn false when not logged in', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({ loggedIn: false, plan: undefined, orgName: undefined })
  })
})

describe('parseClaudeWeeklyUsageFromPane', () => {
  it('reuses monitor.ts weekly-percent parsing', () => {
    expect(parseClaudeWeeklyUsageFromPane("You've used 89% of your weekly limit · resets Tuesday")).toBe(89)
    expect(parseClaudeWeeklyUsageFromPane('nothing here')).toBeUndefined()
  })
})

describe('parseClaudeTokenUsage', () => {
  const jsonl = [
    { type: 'user', message: { content: 'hi' } },
    {
      type: 'assistant',
      timestamp: '2026-09-25T10:00:00.000Z',
      message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-25T14:00:00.000Z',
      message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 200, output_tokens: 80 } },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-26T09:00:00.000Z',
      message: { model: 'claude-opus-4-20250514', usage: { input_tokens: 40, output_tokens: 10 } },
    },
  ].map((l) => JSON.stringify(l)).join('\n')

  it('sums usage per model/day', () => {
    const rows = parseClaudeTokenUsage(jsonl, 'ada')
    expect(rows).toHaveLength(2)
    const day25 = rows.find((r) => r.day === '2026-09-25')!
    expect(day25.model).toBe('claude-sonnet-4-5-20250929')
    expect(day25.inputTokens).toBe(300)
    expect(day25.outputTokens).toBe(130)
    expect(day25.cacheReadTokens).toBe(10)
    expect(day25.cacheCreationTokens).toBe(5)
    const day26 = rows.find((r) => r.day === '2026-09-26')!
    expect(day26.model).toBe('claude-opus-4-20250514')
    expect(day26.inputTokens).toBe(40)
  })

  it('ignores malformed lines and non-assistant lines', () => {
    const rows = parseClaudeTokenUsage('not json\n' + jsonl, 'ada')
    expect(rows).toHaveLength(2)
  })

  it('sumTokenUsage totals across entries', () => {
    const rows = parseClaudeTokenUsage(jsonl, 'ada')
    const total = sumTokenUsage(rows)
    expect(total.inputTokens).toBe(340)
    expect(total.outputTokens).toBe(140)
  })
})
