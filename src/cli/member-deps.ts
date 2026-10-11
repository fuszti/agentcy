// The real collaborators of `office invite | member | uninvite` (src/cli/member-cmd.ts).
// Kept out of office.ts so the integration tests can use it (office.ts runs main() on import).

import { randomBytes } from 'node:crypto'
import { listAgents, loadAgent, loadSecrets } from '../lib/config.js'
import { chatRolesReady } from '../lib/chat-roles.js'
import { ForgejoClient } from '../lib/forgejo.js'
import { queueSystemPrompt } from '../lib/inbox.js'
import { MattermostClient } from '../lib/mattermost.js'
import { listProjects } from '../lib/projects.js'
import type { AgentRecord, OfficeConfig } from '../lib/types.js'
import type { MemberDeps } from './member-cmd.js'

const notOurs = (name: string): string => `@${name} already exists and was not created by \`office invite\`; remove or rename it first`
const exists = (e: unknown): boolean => /exist/i.test((e as Error).message)

export async function realMemberDeps(root: string, cfg: OfficeConfig): Promise<MemberDeps> {
  const secrets = await loadSecrets()
  if (!secrets) throw new Error('run `office init` first')
  const mm = new MattermostClient(cfg.mattermostUrl, secrets.mattermost.adminToken)
  const fj = new ForgejoClient(cfg.forgejoUrl, secrets.forgejo.adminToken)
  const teamId = secrets.mattermost.teamId
  const agents = async (): Promise<AgentRecord[]> =>
    (await Promise.all((await listAgents()).map(n => loadAgent(n)))).filter((r): r is AgentRecord => r !== undefined)
  const channelId = async (name: string): Promise<string> => (await mm.getChannelByName(teamId, name)).id
  const split = (repo: string): [string, string] => {
    const [owner, name] = repo.split('/')
    if (!owner || !name) throw new Error(`repo must look like "org/name", got "${repo}"`)
    return [owner, name]
  }

  return {
    root,
    cfg,
    now: () => new Date().toISOString(),
    randomPassword: () => randomBytes(24).toString('base64url'),
    log: console.log,
    agentNames: async () => (await agents()).map(a => a.name),
    hiredAgents: async () => (await agents()).filter(a => a.status === 'hired').map(a => a.name),
    projects: () => listProjects(root),
    rolesReady: () => chatRolesReady(mm),
    chat: {
      ensureUser: async (u) => {
        try {
          return (await mm.createUser(u)).id
        } catch (e) {
          if (!exists(e)) throw e
          // Adopt only what looks like an invite that failed half way, never someone else's account.
          const existing = await mm.getUserByUsername(u.username)
          const ours = !existing.is_bot && !existing.delete_at && !existing.roles.includes('system_admin') && existing.email.toLowerCase() === u.email.toLowerCase()
          if (!ours) throw new Error(notOurs(u.username))
          await mm.setUserPassword(existing.id, u.password)
          return existing.id
        }
      },
      addToTeam: async (userId) => {
        try { await mm.addUserToTeam(teamId, userId) } catch (e) { if (!exists(e)) throw e }
      },
      channelExists: async (channel) => {
        try { await channelId(channel); return true } catch (e) { if (/404/.test((e as Error).message)) return false; throw e }
      },
      addToChannel: async (channel, userId) => { await mm.addToChannel(await channelId(channel), userId) },
      removeFromChannel: async (channel, userId) => {
        try { await mm.removeFromChannel(await channelId(channel), userId) } catch (e) { if (!/404/.test((e as Error).message)) throw e }
      },
      setPassword: (userId, password) => mm.setUserPassword(userId, password),
      deactivate: (userId) => mm.deactivateUser(userId),
    },
    git: {
      ensureUser: async (u) => {
        try {
          await fj.createUser({ ...u, mustChangePassword: true })
        } catch (e) {
          if (!exists(e)) throw e
          const existing = await fj.adminGetUser(u.username)
          const ours = existing && !existing.is_admin && !existing.prohibit_login && existing.email.toLowerCase() === u.email.toLowerCase()
            && !(await fj.isTeamMember(cfg.forgejoOrg, 'agents', u.username))
          if (!ours) throw new Error(notOurs(u.username))
          await fj.adminResetPassword(u.username, u.password, true)
        }
      },
      addCollaborator: (repo, username) => fj.addCollaborator(...split(repo), username, 'write'),
      removeCollaborator: (repo, username) => fj.removeCollaborator(...split(repo), username),
      setPassword: (username, password) => fj.adminResetPassword(username, password, true),
      prohibitLogin: (username) => fj.setProhibitLogin(username, true),
    },
    notify: async (agent, label, text) => { await queueSystemPrompt(root, agent, label, text) },
  }
}
