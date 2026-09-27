import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectOpencodeHealth, parseAgentOpencodeUsage, parseOpencodeStats } from '../src/finance/opencode.js'
import type { OpencodeMessage } from '../src/lib/harness/opencode.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = fs.readFileSync(path.join(here, 'fixtures', 'opencode-stats-days1-models.txt'), 'utf8')

describe('parseOpencodeStats', () => {
  it('parses the overview totals from a real `opencode stats --days 1 --models` capture', () => {
    const stats = parseOpencodeStats(fixture)
    expect(stats.overview.sessions).toBe(47)
    expect(stats.overview.messages).toBe(1977)
    expect(stats.overview.days).toBe(1)
    expect(stats.overview.totalCost).toBeCloseTo(27.41, 2)
    expect(stats.overview.inputTokens).toBe(5_900_000)
    expect(stats.overview.outputTokens).toBe(416_300)
    expect(stats.overview.cacheReadTokens).toBe(165_100_000)
  })

  it('parses per-model rows', () => {
    const stats = parseOpencodeStats(fixture)
    expect(stats.models.length).toBeGreaterThan(0)
    const kimi = stats.models.find((m) => m.model === 'opencode-go/kimi-k2.7-code')!
    expect(kimi).toBeDefined()
    expect(kimi.messages).toBe(1133)
    expect(kimi.inputTokens).toBe(3_500_000)
    expect(kimi.outputTokens).toBe(352_500)
    expect(kimi.cost).toBeCloseTo(23.8307, 3)

    const deepseek = stats.models.find((m) => m.model === 'opencode-go/deepseek-v4-pro')!
    expect(deepseek.cost).toBeCloseTo(1.5001, 3)
  })

  it('handles empty input without throwing', () => {
    expect(parseOpencodeStats('')).toEqual({ overview: {}, models: [] })
  })
})

describe('parseAgentOpencodeUsage', () => {
  function msg(role: string, extra: Record<string, unknown> = {}): OpencodeMessage {
    return { info: { id: 'm1', role, ...extra } as never, parts: [] }
  }

  it('sums tokens and cost per model/day from assistant messages', () => {
    const messages: OpencodeMessage[] = [
      msg('user'),
      msg('assistant', { time: { created: Date.parse('2026-09-25T10:00:00Z') }, providerID: 'opencode-go', modelID: 'kimi-k2.7-code', tokens: { total: 100 }, cost: 0.01 }),
      msg('assistant', { time: { created: Date.parse('2026-09-25T14:00:00Z') }, providerID: 'opencode-go', modelID: 'kimi-k2.7-code', tokens: { total: 50 }, cost: 0.005 }),
      msg('assistant', { time: { created: Date.parse('2026-09-26T09:00:00Z') }, providerID: 'opencode-go', modelID: 'deepseek-v4-pro', tokens: { total: 30 }, cost: 0.002 }),
    ]
    const rows = parseAgentOpencodeUsage(messages)
    expect(rows).toHaveLength(2)
    const day25 = rows.find((r) => r.day === '2026-09-25')!
    expect(day25.model).toBe('opencode-go/kimi-k2.7-code')
    expect(day25.tokens).toBe(150)
    expect(day25.cost).toBeCloseTo(0.015, 5)
  })

  it('ignores messages without token usage', () => {
    expect(parseAgentOpencodeUsage([msg('assistant', {})])).toEqual([])
  })
})

describe('detectOpencodeHealth', () => {
  it('flags insufficient funds as exhausted', () => {
    expect(detectOpencodeHealth('Error: Insufficient account funds for this request')).toBe('exhausted')
  })
  it('flags rate limit / 429 as throttled', () => {
    expect(detectOpencodeHealth('request failed: 429 Too Many Requests')).toBe('throttled')
    expect(detectOpencodeHealth('rate limit exceeded, retry later')).toBe('throttled')
  })
  it('reports ok when nothing matches', () => {
    expect(detectOpencodeHealth('all good, session idle')).toBe('ok')
  })
})
