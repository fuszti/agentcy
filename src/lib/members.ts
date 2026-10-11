// Invited human members: state/members.json (no secrets). The owner is cfg.human and is not in
// this file. Spec: docs/superpowers/specs/2026-10-10-multi-human-design.md.

import fs from 'node:fs'
import path from 'node:path'
import type { Human, MemberRecord } from './types.js'

export const MEMBER_USERNAME_RE = /^[a-z][a-z0-9._-]{2,21}$/
/** Letters, digits, spaces and . , ' - only: the name is quoted into signed system notices. */
const DISPLAY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,'-]{0,59}$/u
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function membersFile(root: string): string {
  return path.join(root, 'state', 'members.json')
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

function isMember(v: unknown): v is MemberRecord {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return isString(m.username) && MEMBER_USERNAME_RE.test(m.username) && isString(m.displayName) && m.role === 'member' &&
    isString(m.mattermostUserId) && isString(m.forgejoUsername) && isStringList(m.projects) && isStringList(m.channels) &&
    isString(m.invitedAt) && (m.removedAt === null || isString(m.removedAt))
}

/** Parse the roster file. Throws on anything that is not a valid member list. */
export function parseMembers(raw: string): MemberRecord[] {
  const data = JSON.parse(raw) as { members?: unknown }
  if (!data || typeof data !== 'object' || !Array.isArray(data.members)) throw new Error('members.json: expected { "members": [...] }')
  const seen = new Set<string>()
  data.members.forEach((m, i) => {
    if (!isMember(m)) throw new Error(`members.json: entry ${String(i)} is not a valid member`)
    if (seen.has(m.username)) throw new Error(`members.json: duplicate member ${m.username}`)
    seen.add(m.username)
  })
  return data.members as MemberRecord[]
}

/** All members, removed ones included. A missing file means none; an invalid file throws. */
export function loadMembers(root: string): MemberRecord[] {
  let raw: string
  try {
    raw = fs.readFileSync(membersFile(root), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return parseMembers(raw)
}

export function saveMembers(root: string, members: MemberRecord[]): void {
  const file = membersFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ members }, null, 2) + '\n')
  fs.renameSync(`${file}.tmp`, file)
}

export function activeMembers(members: MemberRecord[]): MemberRecord[] {
  return members.filter(m => m.removedAt === null)
}

/** Everyone the office treats as a person: the owner, then the active members. */
export function humanRoster(owner: { userId: string; username: string }, members: MemberRecord[]): Human[] {
  return [
    { userId: owner.userId, username: owner.username, role: 'owner' },
    ...activeMembers(members).map((m): Human => ({ userId: m.mattermostUserId, username: m.username, role: 'member', projects: m.projects })),
  ]
}

/**
 * The roster for a long-running process: re-read when the file changes, so a running MCP sees a
 * new member without a restart. An invalid file keeps the last good roster and is reported once.
 */
export function rosterCache(root: string, owner: { userId: string; username: string }, onError?: (msg: string) => void): () => Human[] {
  let stamp = ''
  let list = humanRoster(owner, [])
  return () => {
    let now = 'missing'
    try {
      const st = fs.statSync(membersFile(root))
      now = `${String(st.mtimeMs)}:${String(st.size)}`
    } catch { /* no file: no members */ }
    if (now === stamp) return list
    stamp = now
    try {
      list = humanRoster(owner, loadMembers(root))
    } catch (e) {
      onError?.(`members.json is invalid, keeping the previous roster: ${(e as Error).message}`)
    }
    return list
  }
}

/** Why `username` cannot become a member, or undefined when it can. */
export function validateNewMember(username: string, taken: { owner: string; agents: string[]; system: string[]; members: string[] }): string | undefined {
  if (!MEMBER_USERNAME_RE.test(username)) return 'username must be 3-22 characters: a lowercase letter first, then lowercase letters, digits, dot, underscore or hyphen'
  if (username === taken.owner) return `@${username} is the owner`
  if (taken.agents.includes(username)) return `@${username} is (or was) an agent; usernames are never reused`
  if (taken.system.includes(username)) return `@${username} is a system username`
  if (taken.members.includes(username)) return `@${username} is already used by a member (also removed ones count); usernames are never reused`
  return undefined
}

export function validateDisplayName(name: string): string | undefined {
  return DISPLAY_NAME_RE.test(name) ? undefined : "display name must be 1-60 characters: letters, digits, spaces and . , ' - only"
}

/** Channels a member may be added to: never admin, finance or agent-only ones. */
export function validateChannels(channels: string[], cfg: { adminChannel: string; financeChannel: string; agentChannelPrefix: string }): string | undefined {
  for (const c of channels) {
    if (!CHANNEL_RE.test(c)) return `not a channel name: ${c}`
    if (c === cfg.adminChannel || c === cfg.financeChannel) return `#${c} is owner-only and cannot be shared with a member`
    if (c.startsWith(cfg.agentChannelPrefix)) return `#${c} is an agent-only channel and cannot be shared with a member`
  }
  return undefined
}
