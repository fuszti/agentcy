import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  KIND_LABELS,
  RESERVED_GROUP_IDS,
  addGroup,
  checkGroupForAgent,
  claudeConfigDir,
  defaultGroup,
  groupAgents,
  groupIdForAgent,
  isDefaultGroup,
  kindForAgent,
  pickAutoGroup,
  removeGroup,
  suggestMoveText,
  validateNewGroupId,
} from '../src/finance/groups.js'
import type { ResourceGroup } from '../src/lib/types.js'

const groups: ResourceGroup[] = [
  { id: 'claude-sub', kind: 'claude-subscription', label: 'Claude subscription' },
  { id: 'opencode-go', kind: 'opencode-go', label: 'OpenCode Go' },
  { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter' },
]

// Several groups per kind: the first of each kind is its default.
const multi: ResourceGroup[] = [
  { id: 'claude-sub', kind: 'claude-subscription', label: 'Claude subscription' },
  { id: 'opencode-go', kind: 'opencode-go', label: 'OpenCode Go' },
  { id: 'claude-b', kind: 'claude-subscription', label: 'Claude B', configDir: 'state/claude/claude-b' },
  { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter' },
  { id: 'go-2', kind: 'opencode-go', label: 'OpenCode Go (go-2)' },
  { id: 'claude-c', kind: 'claude-subscription', label: 'Claude C', configDir: 'state/claude/claude-c' },
]

describe('constants', () => {
  it('reserves the static vault entry ids and the legacy claude-oauth id', () => {
    expect([...RESERVED_GROUP_IDS].sort()).toEqual(['anthropic', 'claude-oauth', 'opencode-zen'])
  })

  it('labels every kind', () => {
    expect(KIND_LABELS).toEqual({
      'claude-subscription': 'Claude subscription',
      'opencode-go': 'OpenCode Go',
      openrouter: 'OpenRouter',
    })
  })
})

describe('kindForAgent', () => {
  it('maps claude agents to claude-subscription regardless of model', () => {
    expect(kindForAgent({ harness: 'claude', model: 'sonnet' })).toBe('claude-subscription')
    expect(kindForAgent({ harness: 'claude', model: 'opencode-go/kimi' })).toBe('claude-subscription')
  })

  it('maps opencode agents by model prefix', () => {
    expect(kindForAgent({ harness: 'opencode', model: 'opencode-go/kimi-k2.7-code' })).toBe('opencode-go')
    expect(kindForAgent({ harness: 'opencode', model: 'openrouter/anthropic/claude-3.5-sonnet' })).toBe('openrouter')
  })

  it('returns undefined for other opencode providers', () => {
    expect(kindForAgent({ harness: 'opencode', model: 'mystery/foo' })).toBeUndefined()
    expect(kindForAgent({ harness: 'opencode', model: 'opencode/big-pickle' })).toBeUndefined()
    expect(kindForAgent({ harness: 'opencode', model: 'openrouter' })).toBeUndefined()
  })
})

describe('defaultGroup / isDefaultGroup', () => {
  it('returns the first group of the kind in config order', () => {
    expect(defaultGroup('claude-subscription', multi)?.id).toBe('claude-sub')
    expect(defaultGroup('opencode-go', multi)?.id).toBe('opencode-go')
    expect(defaultGroup('openrouter', multi)?.id).toBe('openrouter')
  })

  it('returns undefined when no group of the kind exists', () => {
    expect(defaultGroup('openrouter', [groups[0]])).toBeUndefined()
    expect(defaultGroup('claude-subscription', [])).toBeUndefined()
  })

  it('tells defaults from extra groups', () => {
    const byId = (id: string) => multi.find((g) => g.id === id)!
    expect(isDefaultGroup(byId('claude-sub'), multi)).toBe(true)
    expect(isDefaultGroup(byId('opencode-go'), multi)).toBe(true)
    expect(isDefaultGroup(byId('openrouter'), multi)).toBe(true)
    expect(isDefaultGroup(byId('claude-b'), multi)).toBe(false)
    expect(isDefaultGroup(byId('claude-c'), multi)).toBe(false)
    expect(isDefaultGroup(byId('go-2'), multi)).toBe(false)
  })
})

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

  it('returns undefined for an unknown provider prefix even when rec.group is set', () => {
    expect(groupIdForAgent({ harness: 'opencode', model: 'mystery/foo', group: 'go-2' }, multi)).toBeUndefined()
  })

  it('resolves to the default group of the kind when group is unset', () => {
    expect(groupIdForAgent({ harness: 'claude', model: 'sonnet' }, multi)).toBe('claude-sub')
    expect(groupIdForAgent({ harness: 'opencode', model: 'opencode-go/kimi' }, multi)).toBe('opencode-go')
  })

  it('honours rec.group when it exists and matches the kind', () => {
    expect(groupIdForAgent({ harness: 'claude', model: 'sonnet', group: 'claude-b' }, multi)).toBe('claude-b')
    expect(groupIdForAgent({ harness: 'claude', model: 'opus', group: 'claude-c' }, multi)).toBe('claude-c')
    expect(groupIdForAgent({ harness: 'opencode', model: 'opencode-go/kimi', group: 'go-2' }, multi)).toBe('go-2')
    expect(groupIdForAgent({ harness: 'claude', model: 'sonnet', group: 'claude-sub' }, multi)).toBe('claude-sub')
  })

  it('falls back to the default when rec.group is unknown', () => {
    expect(groupIdForAgent({ harness: 'claude', model: 'sonnet', group: 'gone' }, multi)).toBe('claude-sub')
  })

  it('falls back to the default when rec.group is of another kind', () => {
    expect(groupIdForAgent({ harness: 'claude', model: 'sonnet', group: 'go-2' }, multi)).toBe('claude-sub')
    expect(groupIdForAgent({ harness: 'opencode', model: 'openrouter/x/y', group: 'go-2' }, multi)).toBe('openrouter')
    expect(groupIdForAgent({ harness: 'opencode', model: 'opencode-go/kimi', group: 'claude-b' }, multi)).toBe('opencode-go')
  })

  it('returns undefined when no group of the kind is configured', () => {
    expect(groupIdForAgent({ harness: 'opencode', model: 'openrouter/x/y' }, [groups[0]])).toBeUndefined()
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

  it('honours rec.group, with fallback for unknown/mismatched groups', () => {
    const agents = [
      { name: 'ada', harness: 'claude' as const, model: 'sonnet' },
      { name: 'bob', harness: 'claude' as const, model: 'sonnet', group: 'claude-b' },
      { name: 'cy', harness: 'claude' as const, model: 'opus', group: 'nope' },
      { name: 'dee', harness: 'claude' as const, model: 'opus', group: 'go-2' },
      { name: 'eve', harness: 'opencode' as const, model: 'opencode-go/kimi', group: 'go-2' },
      { name: 'fin', harness: 'opencode' as const, model: 'opencode-go/glm' },
    ]
    const grouped = groupAgents(agents, multi)
    expect(grouped.get('claude-sub')?.map((a) => a.name)).toEqual(['ada', 'cy', 'dee'])
    expect(grouped.get('claude-b')?.map((a) => a.name)).toEqual(['bob'])
    expect(grouped.get('go-2')?.map((a) => a.name)).toEqual(['eve'])
    expect(grouped.get('opencode-go')?.map((a) => a.name)).toEqual(['fin'])
    expect(grouped.has('claude-c')).toBe(false)
  })
})

describe('checkGroupForAgent', () => {
  it('accepts a group of the matching kind', () => {
    expect(checkGroupForAgent({ harness: 'claude', model: 'sonnet' }, 'claude-b', multi)).toBeUndefined()
    expect(checkGroupForAgent({ harness: 'claude', model: 'sonnet' }, 'claude-sub', multi)).toBeUndefined()
    expect(checkGroupForAgent({ harness: 'opencode', model: 'opencode-go/kimi' }, 'go-2', multi)).toBeUndefined()
    expect(checkGroupForAgent({ harness: 'opencode', model: 'openrouter/x/y' }, 'openrouter', multi)).toBeUndefined()
  })

  it('rejects an unknown group and lists the known ids', () => {
    const err = checkGroupForAgent({ harness: 'claude', model: 'sonnet' }, 'nope', multi)
    expect(typeof err).toBe('string')
    expect(err).toContain('nope')
    for (const g of multi) expect(err).toContain(g.id)
  })

  it('rejects a group of another kind with a human message', () => {
    expect(checkGroupForAgent({ harness: 'claude', model: 'sonnet' }, 'go-2', multi)).toBe(
      'group go-2 is an OpenCode Go group, but sonnet needs a Claude subscription group',
    )
    const err = checkGroupForAgent({ harness: 'opencode', model: 'opencode-go/kimi' }, 'claude-b', multi)
    expect(typeof err).toBe('string')
    expect(err).toContain('claude-b')
    expect(err).toContain('Claude subscription')
    expect(err).toContain('OpenCode Go')
  })
})

describe('validateNewGroupId', () => {
  it('accepts well-formed unused ids', () => {
    expect(validateNewGroupId('claude-z', multi)).toBeUndefined()
    expect(validateNewGroupId('ab', multi)).toBeUndefined()
    expect(validateNewGroupId('go3', multi)).toBeUndefined()
    expect(validateNewGroupId('a' + 'b'.repeat(30), multi.slice(0, 1))).toBeUndefined() // 31 chars
  })

  it('rejects ids not matching ^[a-z][a-z0-9-]{1,30}$', () => {
    for (const bad of ['', 'a', 'Claude-b', '1abc', '-abc', 'ab_c', 'ab c', 'ab.c', 'a' + 'b'.repeat(31)]) {
      expect(typeof validateNewGroupId(bad, groups), bad).toBe('string')
    }
  })

  it('rejects ids already in use', () => {
    const err = validateNewGroupId('go-2', multi)
    expect(typeof err).toBe('string')
    expect(err).toContain('go-2')
    expect(typeof validateNewGroupId('claude-sub', groups)).toBe('string')
  })

  it('rejects reserved ids', () => {
    for (const id of ['opencode-zen', 'anthropic', 'claude-oauth']) {
      const err = validateNewGroupId(id, groups)
      expect(typeof err, id).toBe('string')
      expect(err).toContain(id)
    }
  })
})

describe('addGroup', () => {
  it('returns a new array with the group appended, leaving the input untouched', () => {
    const input = groups.map((g) => ({ ...g }))
    const snapshot = JSON.parse(JSON.stringify(input))
    const out = addGroup(input, { kind: 'opencode-go', id: 'go-2' })
    expect(out).not.toBe(input)
    expect(input).toEqual(snapshot)
    expect(out.length).toBe(4)
    expect(out.slice(0, 3)).toEqual(snapshot)
    expect(out[3]).toEqual({ id: 'go-2', kind: 'opencode-go', label: 'OpenCode Go (go-2)' })
    expect(out[3].configDir).toBeUndefined()
  })

  it('defaults the label from the kind', () => {
    expect(addGroup(groups, { kind: 'openrouter', id: 'or-2' })[3].label).toBe('OpenRouter (or-2)')
    expect(addGroup(groups, { kind: 'claude-subscription', id: 'claude-b' })[3].label).toBe('Claude subscription (claude-b)')
  })

  it('keeps an explicit label', () => {
    expect(addGroup(groups, { kind: 'openrouter', id: 'or-2', label: 'Team key' })[3].label).toBe('Team key')
  })

  it('gives an extra claude group its own configDir under state/claude', () => {
    const out = addGroup(groups, { kind: 'claude-subscription', id: 'claude-b', label: 'B' })
    expect(out[3]).toEqual({ id: 'claude-b', kind: 'claude-subscription', label: 'B', configDir: 'state/claude/claude-b' })
  })

  it('gives the first claude group no configDir', () => {
    const noClaude = groups.filter((g) => g.kind !== 'claude-subscription')
    const out = addGroup(noClaude, { kind: 'claude-subscription', id: 'claude-sub' })
    const added = out[out.length - 1]
    expect(added.id).toBe('claude-sub')
    expect(added.configDir).toBeUndefined()
    expect(added.label).toBe('Claude subscription (claude-sub)')
  })

  it('throws on an invalid, duplicate or reserved id', () => {
    expect(() => addGroup(groups, { kind: 'opencode-go', id: 'Bad Id' })).toThrow(Error)
    expect(() => addGroup(groups, { kind: 'opencode-go', id: 'opencode-go' })).toThrow(Error)
    expect(() => addGroup(groups, { kind: 'opencode-go', id: 'opencode-zen' })).toThrow(Error)
  })

  it('throws on an unknown kind', () => {
    expect(() => addGroup(groups, { kind: 'bogus' as never, id: 'fine-id' })).toThrow(Error)
  })
})

describe('removeGroup', () => {
  const hired = [
    { name: 'ada', harness: 'claude' as const, model: 'sonnet' },
    { name: 'bob', harness: 'claude' as const, model: 'sonnet', group: 'claude-b' },
    { name: 'eve', harness: 'opencode' as const, model: 'opencode-go/kimi', group: 'go-2' },
    { name: 'fay', harness: 'opencode' as const, model: 'opencode-go/glm', group: 'go-2' },
  ]

  it('returns a new array without the group, leaving the input untouched', () => {
    const input = multi.map((g) => ({ ...g }))
    const snapshot = JSON.parse(JSON.stringify(input))
    const out = removeGroup(input, 'claude-c', hired)
    expect(out).not.toBe(input)
    expect(input).toEqual(snapshot)
    expect(out.map((g) => g.id)).toEqual(['claude-sub', 'opencode-go', 'claude-b', 'openrouter', 'go-2'])
  })

  it('removes a group whose only agents resolve elsewhere', () => {
    // bob names claude-b; nobody resolves to openrouter.
    expect(removeGroup(multi, 'openrouter', hired).map((g) => g.id)).not.toContain('openrouter')
    // A stale group of another kind does not pin a group.
    const stale = [{ name: 'dee', harness: 'claude' as const, model: 'opus', group: 'go-2' }]
    expect(removeGroup(multi, 'go-2', stale).map((g) => g.id)).not.toContain('go-2')
  })

  it('throws on an unknown id', () => {
    expect(() => removeGroup(multi, 'nope', hired)).toThrow(/nope/)
  })

  it('refuses while agents resolve to it explicitly, naming them and suggesting group move', () => {
    let msg = ''
    try {
      removeGroup(multi, 'go-2', hired)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('eve')
    expect(msg).toContain('fay')
    expect(msg).not.toContain('ada')
    expect(msg).toContain('office group move')
  })

  it('refuses while agents resolve to it via the default fallback', () => {
    let msg = ''
    try {
      removeGroup(multi, 'claude-sub', hired)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('ada')
    expect(msg).not.toContain('bob')
    expect(msg).toContain('office group move')
    // An agent pointing at an unknown group falls back to the default too.
    expect(() => removeGroup(multi, 'claude-sub', [{ name: 'cy', harness: 'claude', model: 'opus', group: 'gone' }])).toThrow(/cy/)
  })
})

describe('claudeConfigDir', () => {
  it('resolves the configDir relative to the office root', () => {
    const root = path.resolve('/srv/office')
    expect(claudeConfigDir(root, multi[2])).toBe(path.resolve(root, 'state/claude/claude-b'))
  })

  it('returns undefined without a configDir or group', () => {
    expect(claudeConfigDir('/srv/office', multi[0])).toBeUndefined()
    expect(claudeConfigDir('/srv/office', undefined)).toBeUndefined()
  })
})

describe('pickAutoGroup', () => {
  it('picks the group of the kind with the lowest known used %', () => {
    expect(pickAutoGroup('claude-subscription', multi, { 'claude-sub': 80, 'claude-b': 20, 'claude-c': 50 })?.id).toBe('claude-b')
    expect(pickAutoGroup('opencode-go', multi, { 'opencode-go': 10, 'go-2': 40, 'claude-b': 0 })?.id).toBe('opencode-go')
  })

  it('ranks unknown % after every known one', () => {
    expect(pickAutoGroup('claude-subscription', multi, { 'claude-c': 99 })?.id).toBe('claude-c')
    expect(pickAutoGroup('claude-subscription', multi, { 'claude-sub': undefined, 'claude-b': 95 })?.id).toBe('claude-b')
  })

  it('breaks ties in config order', () => {
    expect(pickAutoGroup('claude-subscription', multi, { 'claude-sub': 50, 'claude-b': 30, 'claude-c': 30 })?.id).toBe('claude-b')
    expect(pickAutoGroup('claude-subscription', multi, { 'claude-sub': 30, 'claude-b': 30, 'claude-c': 30 })?.id).toBe('claude-sub')
  })

  it('falls back to config order (the default) when every % is unknown', () => {
    expect(pickAutoGroup('claude-subscription', multi, {})?.id).toBe('claude-sub')
    expect(pickAutoGroup('opencode-go', multi, {})?.id).toBe('opencode-go')
  })

  it('returns undefined when no group of the kind exists', () => {
    expect(pickAutoGroup('openrouter', [multi[0]], { 'claude-sub': 1 })).toBeUndefined()
  })
})

describe('suggestMoveText', () => {
  it('names the other group of the same kind with the most headroom', () => {
    const used = { 'claude-sub': 92, 'claude-b': 40, 'claude-c': 15, 'go-2': 0 }
    expect(suggestMoveText('claude-sub', multi, used, ['ada', 'bob'])).toBe(
      ' Most headroom: **Claude C** (15% used) — `group move ada claude-c`',
    )
  })

  it('uses <agent> when no agent names are given', () => {
    expect(suggestMoveText('opencode-go', multi, { 'opencode-go': 90, 'go-2': 10 }, [])).toBe(
      ' Most headroom: **OpenCode Go (go-2)** (10% used) — `group move <agent> go-2`',
    )
  })

  it('works from a non-default source towards the default', () => {
    expect(suggestMoveText('claude-b', multi, { 'claude-sub': 5, 'claude-b': 70 }, ['bob'])).toBe(
      ' Most headroom: **Claude subscription** (5% used) — `group move bob claude-sub`',
    )
  })

  it('treats an unknown source % as beaten by any known one', () => {
    expect(suggestMoveText('claude-sub', multi, { 'claude-b': 88 }, ['ada'])).toBe(
      ' Most headroom: **Claude B** (88% used) — `group move ada claude-b`',
    )
  })

  it('returns undefined when no other group is strictly better', () => {
    expect(suggestMoveText('claude-sub', multi, { 'claude-sub': 10, 'claude-b': 40, 'claude-c': 10 }, ['ada'])).toBeUndefined()
    expect(suggestMoveText('claude-sub', multi, { 'claude-sub': 90 }, ['ada'])).toBeUndefined()
    expect(suggestMoveText('claude-sub', multi, {}, ['ada'])).toBeUndefined()
    // Only groups of other kinds are emptier.
    expect(suggestMoveText('openrouter', multi, { openrouter: 95, 'go-2': 0, 'claude-b': 0 }, ['x'])).toBeUndefined()
  })
})
