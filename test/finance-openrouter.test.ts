import { describe, expect, it } from 'vitest'
import { parseOpenrouterCredits } from '../src/finance/openrouter.js'

describe('parseOpenrouterCredits', () => {
  it('parses a real /api/v1/credits response shape', () => {
    const credits = parseOpenrouterCredits(JSON.stringify({ data: { total_credits: 440, total_usage: 434.105234067 } }))
    expect(credits).toEqual({ totalCredits: 440, totalUsage: 434.105234067, remaining: 440 - 434.105234067 })
  })

  it('returns undefined on invalid JSON or missing fields', () => {
    expect(parseOpenrouterCredits('not json')).toBeUndefined()
    expect(parseOpenrouterCredits(JSON.stringify({ data: {} }))).toBeUndefined()
    expect(parseOpenrouterCredits(JSON.stringify({}))).toBeUndefined()
  })
})
