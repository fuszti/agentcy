// Who can see what in chat. Channels stay public; Mattermost's built-in roles are split:
//   - plain team users (invited members) lose the public-channel rights, so they only see
//     channels they were added to;
//   - agents (bots) are team admins, a role trimmed to what agents could do before plus those rights.
// The owner is a system admin and is not affected. Editing built-in roles is undocumented on
// Team Edition (probed on 11.11.1), so every change is read back.
// Spec: docs/superpowers/specs/2026-10-10-multi-human-design.md §2.

/** Removed from team_user. */
export const MEMBER_DENIED: readonly string[] = [
  'list_team_channels', 'join_public_channels', 'read_public_channel',
  'create_public_channel', 'create_private_channel', 'invite_user', 'add_user_to_team',
]

/** Added to team_admin: what agents had through team_user, minus inviting people. */
export const AGENT_GRANTED: readonly string[] = [
  'list_team_channels', 'join_public_channels', 'read_public_channel', 'create_public_channel', 'create_private_channel',
]

/** Removed from team_admin: things agents could not do as plain team users. */
export const TEAM_ADMIN_REMOVED: readonly string[] = [
  'manage_team', 'manage_team_roles', 'manage_team_access_rules', 'manage_channel_roles', 'manage_channel_access_rules',
  'manage_channel_join_requests', 'remove_user_from_team', 'delete_others_posts', 'import_team',
  'convert_public_channel_to_private', 'convert_private_channel_to_public',
  'manage_others_incoming_webhooks', 'manage_others_outgoing_webhooks', 'manage_others_slash_commands',
  'manage_own_incoming_webhooks', 'manage_own_outgoing_webhooks', 'manage_own_slash_commands',
  'bypass_incoming_webhook_channel_lock',
  'manage_private_channel_auto_translation', 'manage_public_channel_auto_translation',
  'manage_private_channel_banner', 'manage_public_channel_banner', 'manage_private_channel_discoverability',
  'playbook_private_manage_roles', 'playbook_public_manage_roles',
]

export interface RoleSet { teamUser: string[]; teamAdmin: string[] }

/** Target permission sets for both roles, sorted. Unknown permissions are kept. */
export function planRoleChanges(current: RoleSet): RoleSet {
  const teamAdmin = [...new Set([...current.teamAdmin.filter(p => !TEAM_ADMIN_REMOVED.includes(p)), ...AGENT_GRANTED])].sort()
  const teamUser = current.teamUser.filter(p => !MEMBER_DENIED.includes(p)).sort()
  return { teamUser, teamAdmin }
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
}

export interface RoleClient {
  getRoleByName(name: string): Promise<{ id: string; name: string; permissions: string[] }>
  patchRolePermissions(roleId: string, permissions: string[]): Promise<void>
  getTeamMember(teamId: string, userId: string): Promise<{ scheme_admin: boolean }>
  setTeamAdmin(teamId: string, userId: string): Promise<void>
}

/**
 * Converge the chat roles. Idempotent. Bots are promoted and team_admin is verified before
 * team_user is tightened: a bot left on plain team_user would lose every channel.
 */
export async function ensureChatRoles(mm: RoleClient, teamId: string, botUserIds: string[]): Promise<void> {
  const isAdmin = async (id: string): Promise<boolean> => {
    try {
      return (await mm.getTeamMember(teamId, id)).scheme_admin
    } catch (e) {
      throw new Error(`chat roles: bot ${id} is not in the team (${(e as Error).message}); team_user left unchanged`)
    }
  }
  for (const id of botUserIds) if (!(await isAdmin(id))) await mm.setTeamAdmin(teamId, id)

  const admin = await mm.getRoleByName('team_admin')
  const user = await mm.getRoleByName('team_user')
  const plan = planRoleChanges({ teamUser: user.permissions, teamAdmin: admin.permissions })
  if (!sameSet(admin.permissions, plan.teamAdmin)) await mm.patchRolePermissions(admin.id, plan.teamAdmin)

  const adminNow = await mm.getRoleByName('team_admin')
  const missing = AGENT_GRANTED.filter(p => !adminNow.permissions.includes(p))
  if (missing.length) throw new Error(`chat roles: team_admin is missing ${missing.join(', ')} after the update; team_user left unchanged`)
  for (const id of botUserIds) {
    if (!(await isAdmin(id))) throw new Error(`chat roles: bot ${id} is not a team admin after the update; team_user left unchanged`)
  }

  if (!sameSet(user.permissions, plan.teamUser)) await mm.patchRolePermissions(user.id, plan.teamUser)
  const userNow = await mm.getRoleByName('team_user')
  const left = MEMBER_DENIED.filter(p => userNow.permissions.includes(p))
  if (left.length) throw new Error(`chat roles: team_user still has ${left.join(', ')}; an invited member would see every channel`)
}

/** True when a plain team user is already restricted. `office invite` refuses otherwise. */
export async function chatRolesReady(mm: Pick<RoleClient, 'getRoleByName'>): Promise<boolean> {
  try {
    const user = await mm.getRoleByName('team_user')
    return !MEMBER_DENIED.some(p => user.permissions.includes(p))
  } catch {
    return false
  }
}
