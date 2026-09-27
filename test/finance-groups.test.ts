import { describe, expect, it } from 'vitest'
import { groupAgents, groupIdForAgent } from '../src/finance/groups.js'
import type { ResourceGroup } from '../src/lib/types.js'

const groups: ResourceGroup[] = [
  { id: 'claude-sub', kind: 'claude-subscription', label: 'Claude subscription' },
  { id: 'opencode-go', kind: 'opencode-go', label: 'OpenCode Go' },
  { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter' },
]

describe('groupIdForAgent', () => {
  it('maps claude agents to the claude-subscription group regardless of model', () => {
    expect(groupIdForAgent({ harness: 'claude', model: 'sonnet' }, groups)).toBe('claude-sub')
    expect(groupIdForAgent({ harness: 'claude', model: 'opus' }, groups)).toBe('claude-sub')
  })

  it('maps opencode agents by model prefix', () => {
    expect(groupIdForAgent({ harness: 'opencode', model: 'opencode-go/kimi-k2.7-code' }, groups)).toBe('opencode-go')
    expect(groupIdForAgent({ harness: 'opencode', model: 'openrouter/anthropic/claude-3.5-sonnet' }, groups)).toBe('openrouter')
  })

  it('returns undefined for an unknown provider prefix', () => {
    expect(groupIdForAgent({ harness: 'opencode', model: 'mystery/foo' }, groups)).toBeUndefined()
  })
})

describe('groupAgents', () => {
  it('buckets agents by resolved group, dropping unmatched ones', () => {
    const agents = [
      { name: 'ada', harness: 'claude' as const, model: 'sonnet' },
      { name: 'rex', harness: 'opencode' as const, model: 'opencode-go/kimi-k2.7-code' },
      { name: 'ghost', harness: 'opencode' as const, model: 'mystery/foo' },
    ]
    const grouped = groupAgents(agents, groups)
    expect(grouped.get('claude-sub')?.map((a) => a.name)).toEqual(['ada'])
    expect(grouped.get('opencode-go')?.map((a) => a.name)).toEqual(['rex'])
    expect(grouped.has('mystery')).toBe(false)
    expect([...grouped.values()].flat().find((a) => a.name === 'ghost')).toBeUndefined()
  })
})
