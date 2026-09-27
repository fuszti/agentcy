import { describe, expect, it } from 'vitest'
import { parseOpencodeGoUsage } from '../src/finance/opencode-go-usage.js'

describe('parseOpencodeGoUsage', () => {
  it('parses a real capture from opencode.ai/zen/go/v1/usage', () => {
    const json = JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-27T12:38:29.990Z' },
        weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-28T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 50, resetsAt: '2026-10-25T13:52:49.000Z' },
      },
    })
    const usage = parseOpencodeGoUsage(json)
    expect(usage?.rolling).toEqual({ status: 'ok', percent: 0, resetsAt: '2026-09-27T12:38:29.990Z' })
    expect(usage?.weekly).toEqual({ status: 'rate-limited', percent: 100, resetsAt: '2026-09-28T00:00:00.000Z' })
    expect(usage?.monthly).toEqual({ status: 'ok', percent: 50, resetsAt: '2026-10-25T13:52:49.000Z' })
  })

  it('returns undefined on invalid JSON or missing usage field', () => {
    expect(parseOpencodeGoUsage('not json')).toBeUndefined()
    expect(parseOpencodeGoUsage(JSON.stringify({ foo: 1 }))).toBeUndefined()
  })
})
