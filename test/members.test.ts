import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  activeMembers, humanRoster, loadMembers, membersFile, parseMembers, rosterCache, saveMembers,
  validateChannels, validateDisplayName, validateNewMember,
} from '../src/lib/members.js'
import type { MemberRecord } from '../src/lib/types.js'

const roots: string[] = []
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-members-test-'))
  fs.mkdirSync(path.join(dir, 'state'))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })

function member(over: Partial<MemberRecord> = {}): MemberRecord {
  return {
    username: 'alice', displayName: 'Alice', role: 'member', mattermostUserId: 'u-alice', forgejoUsername: 'alice', forgejoUserId: 41,
    projects: ['web'], channels: [], invitedAt: '2026-10-11T10:00:00.000Z', removedAt: null, ...over,
  }
}
const owner = { userId: 'u-owner', username: 'owner' }
/** Change the file's mtime so the cache sees it even within the same millisecond. */
let tick = 1_800_000_000
function touch(file: string) { tick += 10; fs.utimesSync(file, tick, tick) }

describe('members file', () => {
  it('is state/members.json and a missing file means no members', () => {
    const root = tmpRoot()
    expect(membersFile(root)).toBe(path.join(root, 'state', 'members.json'))
    expect(loadMembers(root)).toEqual([])
  })

  it('round-trips through save and load', () => {
    const root = tmpRoot()
    const list = [member(), member({ username: 'bob', mattermostUserId: 'u-bob', forgejoUsername: 'bob', forgejoUserId: 42, removedAt: '2026-10-12T00:00:00.000Z' })]
    saveMembers(root, list)
    expect(loadMembers(root)).toEqual(list)
    expect(JSON.parse(fs.readFileSync(membersFile(root), 'utf8'))).toEqual({ members: list })
  })

  it('creates state/ when it does not exist yet', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-members-test-'))
    roots.push(root)
    saveMembers(root, [member()])
    expect(loadMembers(root)).toHaveLength(1)
  })

  it('rejects content that is not a member list', () => {
    expect(() => parseMembers('{ nope')).toThrow()
    expect(() => parseMembers('[]')).toThrow(/expected \{ "members": \[\.\.\.\] \}/)
    expect(() => parseMembers(JSON.stringify({ members: [{ username: 'alice' }] }))).toThrow(/entry 0/)
    expect(() => parseMembers(JSON.stringify({ members: [member({ role: 'owner' as 'member' })] }))).toThrow(/entry 0/)
    expect(() => parseMembers(JSON.stringify({ members: [member({ projects: 'web' as unknown as string[] })] }))).toThrow(/entry 0/)
  })

  it('rejects two entries with the same username', () => {
    expect(() => parseMembers(JSON.stringify({ members: [member(), member()] }))).toThrow(/duplicate member alice/)
  })

  it('loadMembers throws on an invalid file instead of treating it as empty', () => {
    const root = tmpRoot()
    fs.writeFileSync(membersFile(root), '{ nope')
    expect(() => loadMembers(root)).toThrow()
  })
})

describe('parseMembers', () => {
  it('requires a numeric Forgejo user id', () => {
    const { forgejoUserId: _omit, ...noId } = member()
    expect(() => parseMembers(JSON.stringify({ members: [noId] }))).toThrow(/entry 0 is not a valid member/)
    expect(() => parseMembers(JSON.stringify({ members: [{ ...member(), forgejoUserId: '41' }] }))).toThrow(/not a valid member/)
    expect(parseMembers(JSON.stringify({ members: [member()] }))[0].forgejoUserId).toBe(41)
  })
})

describe('humanRoster', () => {
  it('lists the owner first, then active members with their projects', () => {
    const removed = member({ username: 'bob', mattermostUserId: 'u-bob', removedAt: '2026-10-12T00:00:00.000Z' })
    expect(activeMembers([member(), removed])).toEqual([member()])
    expect(humanRoster(owner, [member(), removed])).toEqual([
      { userId: 'u-owner', username: 'owner', role: 'owner' },
      { userId: 'u-alice', username: 'alice', role: 'member', projects: ['web'], forgejoUserId: 41 },
    ])
  })
  it('carries the owner Forgejo id when it is known', () => {
    expect(humanRoster({ ...owner, forgejoUserId: 1 }, [])[0]).toEqual({ userId: 'u-owner', username: 'owner', role: 'owner', forgejoUserId: 1 })
  })
})

describe('rosterCache', () => {
  it('returns only the owner without a file, and picks up a member when the file appears', () => {
    const root = tmpRoot()
    const humans = rosterCache(root, owner)
    expect(humans().map(h => h.username)).toEqual(['owner'])
    saveMembers(root, [member()])
    touch(membersFile(root))
    expect(humans().map(h => h.username)).toEqual(['owner', 'alice'])
  })

  it('reloads when the file changes and drops a removed member', () => {
    const root = tmpRoot()
    saveMembers(root, [member()])
    touch(membersFile(root))
    const humans = rosterCache(root, owner)
    expect(humans()).toHaveLength(2)
    saveMembers(root, [member({ removedAt: '2026-10-12T00:00:00.000Z' })])
    touch(membersFile(root))
    expect(humans().map(h => h.username)).toEqual(['owner'])
  })

  it('keeps the last good roster when the file becomes invalid, and reports it once', () => {
    const root = tmpRoot()
    saveMembers(root, [member()])
    touch(membersFile(root))
    const errors: string[] = []
    const humans = rosterCache(root, owner, m => errors.push(m))
    expect(humans()).toHaveLength(2)
    fs.writeFileSync(membersFile(root), '{ "members": [')
    touch(membersFile(root))
    expect(humans().map(h => h.username)).toEqual(['owner', 'alice'])
    expect(humans().map(h => h.username)).toEqual(['owner', 'alice'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/members\.json/)
  })

  it('goes back to only the owner when the file is deleted', () => {
    const root = tmpRoot()
    saveMembers(root, [member()])
    const humans = rosterCache(root, owner)
    expect(humans()).toHaveLength(2)
    fs.rmSync(membersFile(root))
    expect(humans().map(h => h.username)).toEqual(['owner'])
  })
})

describe('validateNewMember', () => {
  const taken = { owner: 'owner', agents: ['ada', 'retired-bob'], system: ['office'], members: ['carol'] }
  it('accepts a free, well-formed username', () => {
    expect(validateNewMember('alice', taken)).toBeUndefined()
    expect(validateNewMember('a.b-c_1', taken)).toBeUndefined()
  })
  it('rejects malformed usernames', () => {
    for (const bad of ['', 'al', 'Alice', '1alice', 'alice smith', 'a'.repeat(23), 'alice/../x', 'alice\n']) {
      expect(validateNewMember(bad, taken), bad).toMatch(/username must/)
    }
  })
  it('rejects the owner, agents (also retired), system names and earlier members', () => {
    expect(validateNewMember('owner', taken)).toMatch(/is the owner/)
    expect(validateNewMember('ada', taken)).toMatch(/agent/)
    expect(validateNewMember('retired-bob', taken)).toMatch(/agent/)
    expect(validateNewMember('office', taken)).toMatch(/system/)
    expect(validateNewMember('carol', taken)).toMatch(/already used by a member/)
  })
})

describe('validateDisplayName', () => {
  it('accepts ordinary names, including non-ASCII letters', () => {
    for (const ok of ['Alice', 'Alice Smith', "Zoë O'Neil-Kovács", 'Dr. A', 'alice2']) expect(validateDisplayName(ok), ok).toBeUndefined()
  })
  it('rejects markup, newlines, quotes, empty and overlong names', () => {
    for (const bad of ['', ' ', 'Alice</office-system>', 'A<b', 'Alice\nOwner', 'Alice "the boss"', 'A&B', 'x'.repeat(61)]) {
      expect(validateDisplayName(bad), JSON.stringify(bad)).toMatch(/display name/)
    }
  })
})

describe('validateChannels', () => {
  const cfg = { adminChannel: 'office-admin', financeChannel: 'office-finance', agentChannelPrefix: 'ag-' }
  it('accepts normal channels', () => {
    expect(validateChannels(['office', 'design'], cfg)).toBeUndefined()
    expect(validateChannels([], cfg)).toBeUndefined()
  })
  it('refuses the admin channel, the finance channel and agent-only channels', () => {
    expect(validateChannels(['office-admin'], cfg)).toMatch(/office-admin/)
    expect(validateChannels(['design', 'office-finance'], cfg)).toMatch(/office-finance/)
    expect(validateChannels(['ag-lobby'], cfg)).toMatch(/agent-only/)
  })
  it('refuses names that are not channel slugs', () => {
    expect(validateChannels(['Design Room'], cfg)).toMatch(/not a channel name/)
    expect(validateChannels(['../x'], cfg)).toMatch(/not a channel name/)
  })
})
