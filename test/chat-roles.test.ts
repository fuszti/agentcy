import { describe, expect, it } from 'vitest'
import {
  AGENT_GRANTED, MEMBER_DENIED, chatRolesReady, ensureChatRoles, planRoleChanges, type RoleClient,
} from '../src/lib/chat-roles.js'

// What Mattermost Team Edition 11.11.1 ships (probed 2026-10-10).
const STOCK_USER = [
  'add_user_to_team', 'create_private_channel', 'create_public_channel', 'invite_user', 'join_public_channels',
  'list_team_channels', 'playbook_private_create', 'playbook_public_create', 'read_public_channel', 'view_team',
]
const STOCK_ADMIN = [
  'add_reaction', 'create_post', 'delete_others_posts', 'delete_post', 'import_team', 'manage_channel_roles',
  'manage_public_channel_members', 'manage_private_channel_members', 'delete_private_channel', 'manage_team', 'manage_team_roles', 'remove_reaction', 'remove_user_from_team',
  'upload_file', 'use_channel_mentions', 'convert_public_channel_to_private', 'manage_others_slash_commands',
]

function fake(opts: { ignorePatchOf?: string; ignoreAdmin?: boolean; inTeam?: string[] } = {}) {
  const calls: string[] = []
  const roles: Record<string, { id: string; name: string; permissions: string[] }> = {
    team_user: { id: 'r-user', name: 'team_user', permissions: [...STOCK_USER] },
    team_admin: { id: 'r-admin', name: 'team_admin', permissions: [...STOCK_ADMIN] },
  }
  const inTeam = new Set(opts.inTeam ?? ['b1', 'b2'])
  const admins = new Set<string>()
  const mm: RoleClient = {
    getRoleByName: async (name) => ({ ...roles[name], permissions: [...roles[name].permissions] }),
    patchRolePermissions: async (id, permissions) => {
      calls.push(`patch ${id}`)
      if (opts.ignorePatchOf === id) return
      const role = Object.values(roles).find(r => r.id === id)
      if (role) role.permissions = [...permissions]
    },
    getTeamMember: async (_team, userId) => {
      if (!inTeam.has(userId)) throw new Error('Mattermost GET failed: 404 not found')
      return { scheme_admin: admins.has(userId) }
    },
    setTeamAdmin: async (_team, userId) => {
      calls.push(`admin ${userId}`)
      if (!opts.ignoreAdmin) admins.add(userId)
    },
  }
  return { mm, calls, roles, admins }
}

describe('permission lists', () => {
  it('denies members the public-channel, channel-creation and invite rights', () => {
    expect([...MEMBER_DENIED].sort()).toEqual([
      'add_user_to_team', 'create_private_channel', 'create_public_channel', 'invite_user',
      'join_public_channels', 'list_team_channels', 'read_public_channel',
    ])
  })
  it('gives agents back channel listing, joining, reading and creation, but not inviting', () => {
    expect([...AGENT_GRANTED].sort()).toEqual([
      'create_private_channel', 'create_public_channel', 'join_public_channels', 'list_team_channels', 'read_public_channel',
    ])
  })
})

describe('planRoleChanges', () => {
  it('computes both target permission sets from the stock roles', () => {
    const plan = planRoleChanges({ teamUser: STOCK_USER, teamAdmin: STOCK_ADMIN })
    expect(plan.teamUser).toEqual(['playbook_private_create', 'playbook_public_create', 'view_team'])
    expect(plan.teamAdmin).toEqual([...AGENT_GRANTED].sort())
  })
  it('is a fixed point: planning the result changes nothing', () => {
    const once = planRoleChanges({ teamUser: STOCK_USER, teamAdmin: STOCK_ADMIN })
    expect(planRoleChanges(once)).toEqual(once)
  })
  it('keeps unknown team_user permissions but removes unknown team_admin ones', () => {
    const plan = planRoleChanges({ teamUser: ['view_team', 'some_future_permission'], teamAdmin: ['another_future_permission', 'manage_private_channel_members'] })
    expect(plan.teamUser).toContain('some_future_permission')
    expect(plan.teamAdmin).toEqual([...AGENT_GRANTED].sort())
  })
})

describe('ensureChatRoles', () => {
  it('updates team_admin, then promotes the bots, then updates team_user, in that order', async () => {
    const f = fake()
    await ensureChatRoles(f.mm, 't1', ['b1', 'b2'])
    expect(f.calls).toEqual(['patch r-admin', 'admin b1', 'admin b2', 'patch r-user'])
    expect(f.roles.team_user.permissions.sort()).toEqual(['playbook_private_create', 'playbook_public_create', 'view_team'])
    expect(f.roles.team_admin.permissions.sort()).toEqual([...AGENT_GRANTED].sort())
  })

  it('does nothing on a second run', async () => {
    const f = fake()
    await ensureChatRoles(f.mm, 't1', ['b1', 'b2'])
    f.calls.length = 0
    await ensureChatRoles(f.mm, 't1', ['b1', 'b2'])
    expect(f.calls).toEqual([])
  })

  it('promotes a bot hired after the roles were set, without touching the roles', async () => {
    const f = fake({ inTeam: ['b1', 'b2', 'b3'] })
    await ensureChatRoles(f.mm, 't1', ['b1', 'b2'])
    f.calls.length = 0
    await ensureChatRoles(f.mm, 't1', ['b1', 'b2', 'b3'])
    expect(f.calls).toEqual(['admin b3'])
  })

  it('leaves team_user untouched when a bot is not in the team', async () => {
    const f = fake({ inTeam: ['b1'] })
    await expect(ensureChatRoles(f.mm, 't1', ['b1', 'b2'])).rejects.toThrow(/bot b2 is not in the team.*team_user left unchanged/s)
    expect(f.calls).not.toContain('patch r-user')
    expect(f.roles.team_user.permissions).toEqual(STOCK_USER)
  })

  it('leaves team_user untouched when the promotion did not stick', async () => {
    const f = fake({ ignoreAdmin: true })
    await expect(ensureChatRoles(f.mm, 't1', ['b1'])).rejects.toThrow(/bot b1 is not a team admin.*team_user left unchanged/s)
    expect(f.calls).not.toContain('patch r-user')
    expect(f.roles.team_user.permissions).toEqual(STOCK_USER)
  })

  it('leaves team_user untouched when Mattermost ignores the team_admin update', async () => {
    const f = fake({ ignorePatchOf: 'r-admin' })
    await expect(ensureChatRoles(f.mm, 't1', ['b1'])).rejects.toThrow(/team_admin is .* after the update, expected exactly .*list_team_channels.*team_user left unchanged/s)
    expect(f.calls).not.toContain('patch r-user')
    expect(f.calls.filter(c => c.startsWith('admin'))).toEqual([])
  })

  it('promotes no bot when the team_admin update leaves extra permissions in place', async () => {
    const f = fake()
    f.mm.patchRolePermissions = async (id, permissions) => {
      f.calls.push(`patch ${id}`)
      const role = Object.values(f.roles).find(r => r.id === id)
      if (role && id === 'r-admin') role.permissions = [...new Set([...role.permissions, ...permissions])]
    }
    await expect(ensureChatRoles(f.mm, 't1', ['b1'])).rejects.toThrow(/team_admin is .*manage_team.* after the update, expected exactly .*team_user left unchanged/s)
    expect(f.calls.filter(c => c.startsWith('admin'))).toEqual([])
    expect(f.calls).not.toContain('patch r-user')
  })

  it('fails loudly when Mattermost ignores the team_user update', async () => {
    const f = fake({ ignorePatchOf: 'r-user' })
    await expect(ensureChatRoles(f.mm, 't1', ['b1'])).rejects.toThrow(/team_user still has .*join_public_channels/s)
  })

  it('works for an office with no bots yet', async () => {
    const f = fake()
    await ensureChatRoles(f.mm, 't1', [])
    expect(f.calls).toEqual(['patch r-admin', 'patch r-user'])
  })
})

describe('chatRolesReady', () => {
  it('is false on stock roles and true after ensureChatRoles', async () => {
    const f = fake()
    expect(await chatRolesReady(f.mm)).toBe(false)
    await ensureChatRoles(f.mm, 't1', ['b1'])
    expect(await chatRolesReady(f.mm)).toBe(true)
  })
  it('is false when team_admin has an extra permission', async () => {
    const f = fake()
    await ensureChatRoles(f.mm, 't1', ['b1'])
    f.roles.team_admin.permissions.push('manage_private_channel_members')
    expect(await chatRolesReady(f.mm)).toBe(false)
  })
  it('is false when the role cannot be read', async () => {
    expect(await chatRolesReady({ getRoleByName: async () => { throw new Error('down') } })).toBe(false)
  })
})
