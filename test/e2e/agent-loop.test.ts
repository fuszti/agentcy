import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, loadSecrets, repoRoot, agentStateDir } from '../../src/lib/config.js'
import { MattermostClient } from '../../src/lib/mattermost.js'
import { setSecret } from '../../src/lib/vault.js'
import { requireDevInstance } from '../helpers/dev-instance.js'

const run = promisify(execFile)
const REPLY_TIMEOUT_MS = 240_000

describe.skipIf(!process.env.OFFICE_E2E)('agent loop e2e', () => {
  const root = repoRoot()
  const name = `e2e-${Date.now().toString(36)}`
  const office = path.join(root, 'bin', 'office')
  let hired = false
  let mm: MattermostClient
  let ownerId: string
  let helperModel: string

  beforeAll(async () => {
    requireDevInstance()
    const cfg = await loadConfig()
    const secrets = await loadSecrets()
    if (!secrets) throw new Error('no secrets: run `bin/office dev init` first')
    mm = new MattermostClient(cfg.mattermostUrl, secrets.mattermost.adminToken)
    ownerId = secrets.mattermost.humanUserId
    helperModel = cfg.defaults.helperModel
    // office vault set needs a TTY, so store the key directly; otherwise the machine's own opencode login is used
    if (process.env.OPENCODE_GO_API_KEY) setSecret(root, 'opencode-go', process.env.OPENCODE_GO_API_KEY, cfg.resourceGroups)
    hired = true // set before hire: a half-failed hire may still have created the identity
    await run(office, ['hire', name, '--harness', 'opencode', '--model', helperModel], { cwd: root, timeout: 240_000 })
    // hire returns before the agent's office-mcp is listening, and a DM posted before that is never delivered
    const mcpLog = path.join(agentStateDir(name), 'mcp.log')
    const up = () => { try { return fs.readFileSync(mcpLog, 'utf8').includes('office-mcp up for') } catch { return false } }
    const end = Date.now() + 120_000
    while (!up() && Date.now() < end) await new Promise((r) => setTimeout(r, 1000))
    if (!up()) throw new Error(`office-mcp of @${name} did not come up within 120s`)
  }, 300_000)

  afterAll(async () => {
    if (!hired) return
    try {
      await run(office, ['retire', name], { cwd: root, timeout: 90_000 })
    } catch (e) {
      console.warn(`retire ${name} failed: ${e instanceof Error ? e.message : e}`)
    }
  }, 120_000)

  function mcpLogTail(): string {
    try {
      const lines = fs.readFileSync(path.join(agentStateDir(name), 'mcp.log'), 'utf8').trimEnd().split('\n')
      return `\n--- last lines of state/agents/${name}/mcp.log ---\n${lines.slice(-40).join('\n')}`
    } catch {
      return ''
    }
  }

  it('replies in chat to a DM from the owner', async () => {
    const bot = await mm.getUserByUsername(name)
    const ch = await mm.createDirectChannel(ownerId, bot.id)
    const sent = await mm.createPost({ channelId: ch.id, message: 'Hello! Please reply with one short sentence.' })
    const end = Date.now() + REPLY_TIMEOUT_MS
    let reply = undefined as Awaited<ReturnType<typeof mm.getChannelPosts>>[number] | undefined
    while (!reply && Date.now() < end) {
      const posts = await mm.getChannelPosts(ch.id, { perPage: 30 })
      reply = posts.find((p) => p.userId === bot.id && p.createAt > sent.createAt)
      if (!reply) await new Promise((r) => setTimeout(r, 3000))
    }
    if (!reply) throw new Error(`@${name} did not post in the DM within ${REPLY_TIMEOUT_MS / 1000}s${mcpLogTail()}`)
    expect(reply.userId).toBe(bot.id)
  }, 300_000)
})
