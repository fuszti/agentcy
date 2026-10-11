import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrap, createAgentIdentity, ensureOfficePolicies, retireAgentIdentity } from '../../src/cli/bootstrap.js'
import { loadConfig, loadSecrets } from '../../src/lib/config.js'
import { MEMBER_DENIED, chatRolesReady } from '../../src/lib/chat-roles.js'
import { MattermostClient } from '../../src/lib/mattermost.js'
import { ForgejoClient } from '../../src/lib/forgejo.js'
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from '../../src/lib/config.js'
import { cmdInvite, cmdMember, cmdUninvite, type MemberDeps } from '../../src/cli/member-cmd.js'
import { realMemberDeps } from '../../src/cli/member-deps.js'
import { loadMembers } from '../../src/lib/members.js'
import { saveProject } from '../../src/lib/projects.js'
import { classifyPost, channelTypeOf, findHuman } from '../../src/mcp/policy.js'
import { rosterCache } from '../../src/lib/members.js'
import { prepareAgentGitIdentity, workspaceDir } from '../../src/lib/workspace.js'
import type { AgentRecord, ChatPost } from '../../src/lib/types.js'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { requireDevInstance } from '../helpers/dev-instance.js'

const tag = Date.now().toString(36)

describe.skipIf(!process.env.OFFICE_INTEGRATION)('invited members on a real stack', () => {
  let config: Awaited<ReturnType<typeof loadConfig>>
  let mmAdmin: MattermostClient
  let fjAdmin: ForgejoClient
  let teamId: string
  let botMm: MattermostClient
  let botFj: ForgejoClient
  let botToken: string
  let botFjToken = ''
  let botMmId = ''
  const botName = `itest-m-${tag}`

  /** A plain team user, the way `office invite` creates one, logged in with its own session. */
  async function plainUser(username: string): Promise<{ id: string; mm: MattermostClient }> {
    const password = `It-${tag}-${username}-Zq9`
    const u = await mmAdmin.createUser({ username, email: `${username}@office.local`, password })
    await mmAdmin.addUserToTeam(teamId, u.id)
    const res = await fetch(`${config.mattermostUrl}/api/v4/users/login`, { method: 'POST', body: JSON.stringify({ login_id: username, password }) })
    const token = res.headers.get('Token')
    if (!token) throw new Error('member login failed')
    return { id: u.id, mm: new MattermostClient(config.mattermostUrl, token) }
  }

  beforeAll(async () => {
    requireDevInstance()
    await bootstrap()
    config = await loadConfig()
    const secrets = await loadSecrets()
    if (!secrets) throw new Error('no secrets after bootstrap')
    teamId = secrets.mattermost.teamId
    mmAdmin = new MattermostClient(config.mattermostUrl, secrets.mattermost.adminToken)
    fjAdmin = new ForgejoClient(config.forgejoUrl, secrets.forgejo.adminToken)
    const bot = await createAgentIdentity(botName, 'Members Test Bot', 'bot for the members integration test')
    botToken = bot.mattermost.token
    botFjToken = bot.forgejo.token
    botMmId = bot.mattermost.userId
    botMm = new MattermostClient(config.mattermostUrl, botToken)
    botFj = new ForgejoClient(config.forgejoUrl, bot.forgejo.token)
  }, 300_000)

  afterAll(async () => { await retireAgentIdentity(botName) }, 60_000)

  it('bootstrap restricts plain team users', async () => {
    expect(await chatRolesReady(mmAdmin)).toBe(true)
  })

  it('a plain team user sees only channels they were added to', async () => {
    const shared = await mmAdmin.createChannel({ teamId, name: `shared-${tag}`, displayName: 'shared', purpose: 'itest', type: 'O' })
    const hidden = await mmAdmin.createChannel({ teamId, name: `hidden-${tag}`, displayName: 'hidden', purpose: 'itest', type: 'O' })
    await mmAdmin.createPost({ channelId: hidden.id, message: `secret-${tag}` })
    const member = await plainUser(`mem-${tag}`)
    await mmAdmin.addToChannel(shared.id, member.id)

    const post = await member.mm.createPost({ channelId: shared.id, message: 'hello from the member' })
    expect(post.id).toBeTruthy()
    await expect(member.mm.getPublicChannels(teamId)).rejects.toThrow(/403/)
    await expect(member.mm.getChannelByName(teamId, hidden.name)).rejects.toThrow(/403/)
    await expect(member.mm.getChannelPosts(hidden.id)).rejects.toThrow(/403/)
    await expect(member.mm.addToChannel(hidden.id, member.id)).rejects.toThrow(/403/)
    expect(await member.mm.searchPosts(teamId, `secret-${tag}`)).toEqual([])
    await expect(member.mm.createChannel({ teamId, name: `mine-${tag}`, displayName: 'mine', purpose: '', type: 'O' })).rejects.toThrow(/403/)
  }, 60_000)

  it('an agent bot still lists, reads, joins and creates channels', async () => {
    const other = await mmAdmin.createChannel({ teamId, name: `later-${tag}`, displayName: 'later', purpose: 'itest', type: 'O' })
    await mmAdmin.createPost({ channelId: other.id, message: 'for the bot' })
    const me = await botMm.me()
    expect((await botMm.getPublicChannels(teamId)).some(c => c.id === other.id)).toBe(true)
    expect((await botMm.getChannelByName(teamId, other.name)).id).toBe(other.id)
    await botMm.addToChannel(other.id, me.id)
    expect((await botMm.getChannelPosts(other.id)).length).toBeGreaterThan(0)
    const created = await botMm.createChannel({ teamId, name: `bot-${tag}`, displayName: 'bot', purpose: 'itest', type: 'O' })
    expect(created.id).toBeTruthy()
  }, 60_000)

  it('an agent bot cannot manage the team', async () => {
    const victim = await plainUser(`vic-${tag}`)
    const res = await fetch(`${config.mattermostUrl}/api/v4/teams/${teamId}/members/${victim.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${botToken}` },
    })
    expect(res.status).toBe(403)
  }, 30_000)

  it('the org and every repo are private, and agents still reach them', async () => {
    expect((await fjAdmin.getOrg(config.forgejoOrg))?.visibility).toBe('private')
    const repos = await fjAdmin.listOrgRepos(config.forgejoOrg)
    expect(repos.length).toBeGreaterThan(0)
    expect(repos.every(r => r.private)).toBe(true)
    expect(await botFj.getRepo(config.forgejoOrg, config.ticketsRepo)).toBeTruthy()
    const anon = await fetch(`${config.forgejoUrl}/api/v1/repos/${config.forgejoOrg}/${config.ticketsRepo}`)
    expect(anon.status).toBe(404)
  }, 30_000)

  it('an office from before this change converges: stock roles, a demoted bot and public repos', async () => {
    // Put the stack back into the state an older office is in.
    const secrets = await loadSecrets()
    if (!secrets) throw new Error('no secrets')
    const admin = { Authorization: `Bearer ${secrets.mattermost.adminToken}`, 'Content-Type': 'application/json' }
    const role = await mmAdmin.getRoleByName('team_user')
    await mmAdmin.patchRolePermissions(role.id, [...new Set([...role.permissions, ...MEMBER_DENIED])])
    const bot = await botMm.me()
    await fetch(`${config.mattermostUrl}/api/v4/teams/${teamId}/members/${bot.id}/schemeRoles`, { method: 'PUT', headers: admin, body: JSON.stringify({ scheme_admin: false, scheme_user: true }) })
    const fj = { Authorization: `token ${secrets.forgejo.adminToken}`, 'Content-Type': 'application/json' }
    await fetch(`${config.forgejoUrl}/api/v1/orgs/${config.forgejoOrg}`, { method: 'PATCH', headers: fj, body: JSON.stringify({ visibility: 'public' }) })
    await fetch(`${config.forgejoUrl}/api/v1/repos/${config.forgejoOrg}/${config.ticketsRepo}`, { method: 'PATCH', headers: fj, body: JSON.stringify({ private: false }) })
    expect(await chatRolesReady(mmAdmin)).toBe(false)
    expect((await mmAdmin.getTeamMember(teamId, bot.id)).scheme_admin).toBe(false)

    await ensureOfficePolicies()

    expect(await chatRolesReady(mmAdmin)).toBe(true)
    expect((await mmAdmin.getTeamMember(teamId, bot.id)).scheme_admin).toBe(true)
    expect((await fjAdmin.getOrg(config.forgejoOrg))?.visibility).toBe('private')
    expect((await fjAdmin.listOrgRepos(config.forgejoOrg)).every(r => r.private)).toBe(true)
    // The bot still works after the round trip.
    expect((await botMm.getPublicChannels(teamId)).length).toBeGreaterThan(0)
  }, 60_000)
  describe('office invite end to end', () => {
    const username = `inv-${tag}`.slice(0, 22)
    const web = `web-${tag}`
    const api = `api-${tag}`
    let deps: MemberDeps
    const printed: string[] = []
    let chatPassword = ''
    let gitPassword = ''
    const passwordAfter = (label: string) => new RegExp(`${label}:\\s+\\S+ / (\\S+)`).exec(printed.join('\n'))?.[1] ?? ''
    const fjAs = (user: string, password: string) => (p: string, init: RequestInit = {}) =>
      fetch(`${config.forgejoUrl}/api/v1${p}`, { ...init, headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'Content-Type': 'application/json' } })

    beforeAll(async () => {
      for (const name of [web, api]) {
        await fjAdmin.createOrgRepo(config.forgejoOrg, name, { autoInit: true })
        const ch = await mmAdmin.createChannel({ teamId, name: `proj-${name}`, displayName: `proj-${name}`, purpose: 'itest', type: 'O' })
        await mmAdmin.createPost({ channelId: ch.id, message: `welcome to ${name}` })
        await saveProject(repoRoot(), { name, description: 'itest', repo: `${config.forgejoOrg}/${name}`, channel: `proj-${name}`, members: [], createdAt: new Date().toISOString() })
      }
      deps = { ...(await realMemberDeps(repoRoot(), config)), log: (l) => printed.push(l) }
    }, 120_000)

    afterAll(() => {
      for (const name of [web, api]) fs.rmSync(path.join(repoRoot(), 'state', 'projects', `${name}.json`), { force: true })
    })

    it('invites a member onto one project', async () => {
      await cmdInvite([username], { projects: web, name: 'Integration Member' }, deps)
      chatPassword = passwordAfter('chat')
      gitPassword = passwordAfter('tickets')
      expect(chatPassword).not.toBe('')
      expect(gitPassword).not.toBe('')
      expect(loadMembers(repoRoot()).find(m => m.username === username)).toMatchObject({ projects: [web], removedAt: null })
    }, 60_000)

    it('the member reads their project channel and nothing else', async () => {
      const res = await fetch(`${config.mattermostUrl}/api/v4/users/login`, { method: 'POST', body: JSON.stringify({ login_id: username, password: chatPassword }) })
      expect(res.status).toBe(200)
      const mm = new MattermostClient(config.mattermostUrl, res.headers.get('Token') ?? '')
      const mine = (await mm.getChannelsForUser(teamId)).map(c => c.name)
      expect(mine).toContain(`proj-${web}`)
      expect(mine).not.toContain(`proj-${api}`)
      expect(mine).not.toContain(config.adminChannel)
      await expect(mm.getChannelByName(teamId, `proj-${api}`)).rejects.toThrow(/403/)
      await expect(mm.getChannelByName(teamId, 'office')).rejects.toThrow(/403/)
    }, 30_000)

    it('the member reaches only their project repo', async () => {
      // The invite forces a password change at first login, which blocks the API; lift it to test access.
      expect((await fjAs(username, gitPassword)('/user')).status).toBe(403)
      await fjAdmin.adminResetPassword(username, gitPassword, false)
      const fj = fjAs(username, gitPassword)
      expect((await fj(`/repos/${config.forgejoOrg}/${web}`)).status).toBe(200)
      expect((await fj(`/repos/${config.forgejoOrg}/${api}`)).status).toBe(404)
      expect((await fj(`/repos/${config.forgejoOrg}/${config.ticketsRepo}`)).status).toBe(404)
      const issue = await fj(`/repos/${config.forgejoOrg}/${web}/issues`, { method: 'POST', body: JSON.stringify({ title: 'from the member', body: 'x' }) })
      expect(issue.status).toBe(201)
      const push = await fj(`/repos/${config.forgejoOrg}/${web}/contents/member.txt`, {
        method: 'POST', body: JSON.stringify({ content: Buffer.from('hi').toString('base64'), message: 'member commit', new_branch: 'member-branch' }),
      })
      expect(push.status).toBe(201)
    }, 30_000)

    it('grant and revoke change what the member reaches', async () => {
      const fj = fjAs(username, gitPassword)
      await cmdMember(['grant', username], { projects: api }, deps)
      expect((await fj(`/repos/${config.forgejoOrg}/${api}`)).status).toBe(200)
      await cmdMember(['revoke', username], { projects: api }, deps)
      expect((await fj(`/repos/${config.forgejoOrg}/${api}`)).status).toBe(404)
    }, 60_000)

    it('the invite queued a signed notice for the hired agent', () => {
      const inbox = path.join(repoRoot(), 'state', 'agents', botName, 'inbox')
      const files = fs.readdirSync(inbox).filter(f => f.includes('member-joined'))
      expect(files.length).toBe(1)
      expect(fs.readFileSync(path.join(inbox, files[0]), 'utf8')).toContain(`@${username} (Integration Member) joined the office`)
    })

    it('re-running after a half-finished invite adopts the account, and refuses accounts that are not ours', async () => {
      const left = `re-${tag}`.slice(0, 22)
      await mmAdmin.createUser({ username: left, email: `${left}@office.local`, password: `It-${tag}-left-Zq9` })
      printed.length = 0
      await cmdInvite([left], { projects: web }, deps)
      expect(loadMembers(repoRoot()).filter(m => m.username === left)).toHaveLength(1)
      const res = await fetch(`${config.mattermostUrl}/api/v4/users/login`, { method: 'POST', body: JSON.stringify({ login_id: left, password: passwordAfter('chat') }) })
      expect(res.status).toBe(200)

      const other = `ot-${tag}`.slice(0, 22)
      await mmAdmin.createUser({ username: other, email: `someone-else-${tag}@example.com`, password: `It-${tag}-other-Zq9` })
      await expect(cmdInvite([other], { projects: web }, deps)).rejects.toThrow(/already exists and was not created by `office invite`/)
      expect(loadMembers(repoRoot()).some(m => m.username === other)).toBe(false)

      // A Forgejo account that is an administrator is never adopted, even with the matching email.
      const admin = `fa-${tag}`.slice(0, 22)
      await fjAdmin.createUser({ username: admin, email: `${admin}@office.local`, password: `It-${tag}-fa-Zq9`, mustChangePassword: false })
      await fetch(`${config.forgejoUrl}/api/v1/admin/users/${admin}`, {
        method: 'PATCH', headers: { Authorization: `token ${(await loadSecrets())?.forgejo.adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin: true, login_name: admin, source_id: 0 }),
      })
      await expect(cmdInvite([admin], { projects: web }, deps)).rejects.toThrow(/already exists and was not created by `office invite`/)
      expect(loadMembers(repoRoot()).some(m => m.username === admin)).toBe(false)
    }, 90_000)

    it("a member's post in the project channel reaches an agent as a person with role member", async () => {
      const login = await fetch(`${config.mattermostUrl}/api/v4/users/login`, { method: 'POST', body: JSON.stringify({ login_id: username, password: chatPassword }) })
      const memberMm = new MattermostClient(config.mattermostUrl, login.headers.get('Token') ?? '')
      const channel = await mmAdmin.getChannelByName(teamId, `proj-${web}`)
      const bot = await botMm.me()
      await mmAdmin.addToChannel(channel.id, bot.id)
      const owner = await mmAdmin.getUserByUsername(config.human.username)
      const humans = rosterCache(repoRoot(), { userId: owner.id, username: owner.username })

      const received = await new Promise<{ post: ChatPost; meta: { mentions: string[]; channelType: string; channelName: string } }>((resolve, reject) => {
        const ws = botMm.connectWebSocket((post, meta) => {
          if (post.message.includes(`ping-${tag}`)) { ws.close(); resolve({ post, meta }) }
        }, () => {})
        const send = setTimeout(() => { memberMm.createPost({ channelId: channel.id, message: `can someone look at ping-${tag}?` }).catch(reject) }, 3000)
        setTimeout(() => { clearTimeout(send); ws.close(); reject(new Error('the bot did not receive the member post')) }, 20_000)
      })

      const ev = classifyPost(
        { username: bot.username, userId: bot.id, humans: humans(), agentChannelPrefix: config.agentChannelPrefix, watch: {}, defaultWatch: 'digest', participatedThreads: new Set() },
        received.post,
        { ...received.meta, channelType: channelTypeOf(received.meta.channelName, received.meta.channelType, config.agentChannelPrefix) },
      )
      expect(ev).toMatchObject({ kind: 'room', from: username, fromHuman: true, role: 'member' })

      // `!freeze` is owner-only in server.ts: the member's user id resolves to the member role, not the owner.
      const memberId = received.post.userId
      expect(findHuman(humans(), { userId: memberId })?.role).toBe('member')
      expect(findHuman(humans(), { userId: owner.id })?.role).toBe('owner')
    }, 40_000)

    it("a member's comment on a ticket in their project notifies an assigned agent, authored by the member", async () => {
      // The forced password change is lifted by the earlier repo test; do it again so this test stands alone.
      await fjAdmin.adminResetPassword(username, gitPassword, false)
      const issue = await fjAdmin.createIssue(config.forgejoOrg, web, { title: `member ticket ${tag}`, body: 'x', assignees: [botName] })
      const comment = await fjAs(username, gitPassword)(`/repos/${config.forgejoOrg}/${web}/issues/${issue.number}/comments`, {
        method: 'POST', body: JSON.stringify({ body: `a comment from the member ${tag}` }),
      })
      expect(comment.status).toBe(201)

      let note: Awaited<ReturnType<ForgejoClient['listNotifications']>>[number] | undefined
      for (let i = 0; i < 20 && !note; i++) {
        note = (await botFj.listNotifications({ unreadOnly: true })).find(n => n.subject.url.endsWith(`/${web}/issues/${issue.number}`) && n.subject.latest_comment_url)
        if (!note) await new Promise(r => setTimeout(r, 1000))
      }
      if (!note?.subject.latest_comment_url) throw new Error('the assigned bot got no notification for the member comment')
      const author = await botFj.latestCommentAuthor(note.subject.latest_comment_url)
      expect(author).toBe(username)
      const owner = await mmAdmin.getUserByUsername(config.human.username)
      const humans = rosterCache(repoRoot(), { userId: owner.id, username: owner.username })
      expect(findHuman(humans(), { username: author })?.role).toBe('member')
    }, 60_000)

    it('an agent clones a private project repo with its own credentials, the way the harness does', async () => {
      const rec: AgentRecord = {
        name: botName, displayName: 'Members Test Bot', harness: 'opencode', model: 'x', status: 'hired', pastSessions: [], chrome: false,
        mattermost: { userId: botMmId, token: botToken }, forgejo: { token: botFjToken }, createdAt: new Date().toISOString(),
      }
      const ws = workspaceDir(repoRoot(), botName)
      fs.mkdirSync(ws, { recursive: true })
      execFileSync('git', ['init', '-q'], { cwd: ws })
      const prefix = await prepareAgentGitIdentity(repoRoot(), config, rec)
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'))
      try {
        const out = execFileSync('bash', ['-c', `${prefix} GIT_TERMINAL_PROMPT=0 git clone ${config.forgejoUrl}/${config.forgejoOrg}/${web}.git ${path.join(dest, 'web')}`], { encoding: 'utf8', stdio: 'pipe' })
        expect(out).toBeDefined()
        expect(fs.existsSync(path.join(dest, 'web', '.git'))).toBe(true)
      } finally {
        fs.rmSync(dest, { recursive: true, force: true })
        fs.rmSync(ws, { recursive: true, force: true })
      }
    }, 60_000)

    it('uninvite locks the member out of both systems', async () => {
      await cmdUninvite([username], deps)
      const res = await fetch(`${config.mattermostUrl}/api/v4/users/login`, { method: 'POST', body: JSON.stringify({ login_id: username, password: chatPassword }) })
      expect(res.status).toBe(401)
      expect((await fjAs(username, gitPassword)('/user')).status).toBe(401)
      expect(loadMembers(repoRoot()).find(m => m.username === username)?.removedAt).not.toBeNull()
    }, 60_000)
  })
})
