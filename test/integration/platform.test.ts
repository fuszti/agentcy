import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { bootstrap, createAgentIdentity, retireAgentIdentity } from '../../src/cli/bootstrap.js'
import { loadConfig, loadSecrets } from '../../src/lib/config.js'
import { MattermostClient } from '../../src/lib/mattermost.js'
import { ForgejoClient } from '../../src/lib/forgejo.js'
import type { ChatPost } from '../../src/lib/types.js'

describe.skipIf(!process.env.OFFICE_INTEGRATION)('platform integration', () => {
  let mmAdmin: MattermostClient
  let fjAdmin: ForgejoClient
  let config: Awaited<ReturnType<typeof loadConfig>>
  let secrets: Awaited<ReturnType<typeof loadSecrets>>
  let teamId: string
  let aMm: MattermostClient
  let bMm: MattermostClient
  let bFj: ForgejoClient

  beforeAll(async () => {
    await bootstrap()
    config = await loadConfig()
    secrets = await loadSecrets()
    if (!secrets) throw new Error('no secrets after bootstrap')
    mmAdmin = new MattermostClient(config.mattermostUrl, secrets.mattermost.adminToken)
    fjAdmin = new ForgejoClient(config.forgejoUrl, secrets.forgejo.adminToken)
    teamId = secrets.mattermost.teamId

    const a = await createAgentIdentity('itest-a', 'Integration Test A', 'agent a for integration test')
    const b = await createAgentIdentity('itest-b', 'Integration Test B', 'agent b for integration test')

    aMm = new MattermostClient(config.mattermostUrl, a.mattermost.token)
    bMm = new MattermostClient(config.mattermostUrl, b.mattermost.token)
    bFj = new ForgejoClient(config.forgejoUrl, b.forgejo.token)
  }, 300_000)

  afterAll(async () => {
    await retireAgentIdentity('itest-a')
    await retireAgentIdentity('itest-b')
  }, 60_000)

  it('mentions arrive over websocket and thread reads work', async () => {
    const officeChannel = await mmAdmin.getChannelByName(teamId, 'office')

    const received = await new Promise<{ post: ChatPost; meta: { mentions: string[]; channelName: string } }>((resolve, reject) => {
      const ws = bMm.connectWebSocket(
        (post, meta) => {
          if (meta.mentions.includes('itest-b')) {
            ws.close()
            resolve({ post, meta })
          }
        },
        () => {},
      )

      // Post after giving the websocket time to authenticate.
      const postDelay = setTimeout(() => {
        aMm.createPost({ channelId: officeChannel.id, message: 'hello @itest-b from websocket test' }).catch(reject)
      }, 3000)

      const timeout = setTimeout(() => {
        clearTimeout(postDelay)
        ws.close()
        reject(new Error('websocket did not receive mention in time'))
      }, 20_000)
    })

    expect(received.meta.channelName).toBe('office')
    expect(received.post.username).toBe('itest-a')
    expect(received.post.message).toContain('@itest-b')

    const reply = await bMm.createPost({
      channelId: officeChannel.id,
      message: 'received the mention, replying in thread',
      rootId: received.post.rootId || received.post.id,
    })

    const thread = await mmAdmin.getPostThread(received.post.rootId || received.post.id)
    const ids = thread.map((p) => p.id)
    expect(ids).toContain(received.post.id)
    expect(ids).toContain(reply.id)
  }, 30_000)

  it('direct messages work between agents', async () => {
    const me = await aMm.me()
    const other = await bMm.me()
    const ch = await aMm.createDirectChannel(me.id, other.id)
    const dm = await aMm.createPost({ channelId: ch.id, message: 'hello from a to b via dm' })
    const fetched = await bMm.getPost(dm.id)
    expect(fetched.id).toBe(dm.id)
    expect(fetched.message).toBe(dm.message)
  }, 15_000)

  it('forgejo issue assignment creates a notification', async () => {
    const title = `integration test issue ${Date.now()}`
    const issue = await fjAdmin.createIssue(config.forgejoOrg, config.ticketsRepo, {
      title,
      body: 'created by integration test',
      assignees: ['itest-b'],
      labels: ['status/todo', 'kind/chore'],
    })

    // Poll notifications for itest-b.
    let found = false
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const notes = await bFj.listNotifications({ unreadOnly: true })
      if (notes.some((n) => n.subject.title === title && n.repository.full_name === `${config.forgejoOrg}/${config.ticketsRepo}`)) {
        found = true
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(found).toBe(true)

    await fjAdmin.createComment(config.forgejoOrg, config.ticketsRepo, issue.number, 'integration test comment')
    const comments = await bFj.listComments(config.forgejoOrg, config.ticketsRepo, issue.number)
    expect(comments.some((c) => c.body === 'integration test comment')).toBe(true)

    await fjAdmin.editIssue(config.forgejoOrg, config.ticketsRepo, issue.number, { state: 'closed' })
    const closed = await fjAdmin.getIssue(config.forgejoOrg, config.ticketsRepo, issue.number)
    expect(closed.state).toBe('closed')
  }, 60_000)
})
