// Bootstrap the agent-office infrastructure: docker compose, human admin accounts, default team/channels, repo + labels.
// Safe to re-run.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadConfig, repoRoot, saveSecrets, loadSecrets, agentStateDir, saveAgent, loadAgent } from '../lib/config.js'
import { MattermostClient } from '../lib/mattermost.js'
import { ForgejoClient } from '../lib/forgejo.js'
import type { OfficeSecrets, ChatChannel } from '../lib/types.js'
import { assertStackOwnership, composeEnv, composeFileArgs, writeInfraEnv } from '../lib/infra.js'

const INFRA_DIR = path.join(repoRoot(), 'infra')
const ENV_PATH = path.join(INFRA_DIR, '.env')

function randomPassword(): string {
  return randomBytes(24).toString('base64url')
}

function dockerCompose(args: string[], options?: { capture?: boolean; quiet?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = spawn('docker', ['compose', ...composeFileArgs(repoRoot()), ...args], {
      stdio: options?.capture ? ['ignore', 'pipe', 'pipe'] : options?.quiet ? ['ignore', 'ignore', 'ignore'] : 'inherit',
      env: composeEnv(),
    })
    let out = ''
    let err = ''
    if (cp.stdout) cp.stdout.on('data', (d) => (out += d.toString()))
    if (cp.stderr) cp.stderr.on('data', (d) => (err += d.toString()))
    cp.on('close', (code) => {
      if (code !== 0) reject(new Error(`docker compose ${args.join(' ')} failed: ${err || out || code}`))
      else resolve(out)
    })
    cp.on('error', reject)
  })
}

/** Through compose, not by container name, so it hits this checkout's stack (live or dev) only. */
function dockerExec(service: 'mattermost' | 'forgejo', user: string | undefined, command: string[], capture = true): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['compose', ...composeFileArgs(repoRoot()), 'exec', '-T']
    if (user) args.push('-u', user)
    args.push(service, ...command)
    const cp = spawn('docker', args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: composeEnv(),
    })
    let out = ''
    let err = ''
    if (cp.stdout) cp.stdout.on('data', (d) => (out += d.toString()))
    if (cp.stderr) cp.stderr.on('data', (d) => (err += d.toString()))
    cp.on('close', (code) => {
      if (code !== 0) reject(new Error(`docker compose exec ${service} ${command.join(' ')} failed: ${err || out}`))
      else resolve(out)
    })
    cp.on('error', reject)
  })
}

async function ensureInfraEnv(): Promise<void> {
  if (existsSync(ENV_PATH)) {
    // `office setup` may have written only the public URLs so far.
    if (!(await readEnv()).POSTGRES_PASSWORD) writeInfraEnv(repoRoot(), { POSTGRES_PASSWORD: randomPassword() })
    await chmod(ENV_PATH, 0o600)
    return
  }
  const password = randomPassword()
  const env = `BIND_ADDR=127.0.0.1\nPOSTGRES_PASSWORD=${password}\n`
  await mkdir(INFRA_DIR, { recursive: true })
  await writeFile(ENV_PATH, env, { mode: 0o600 })
}

async function readEnv(): Promise<Record<string, string>> {
  const raw = await readFile(ENV_PATH, 'utf-8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/**
 * fetch with a deadline held by a normal (ref'd) timer. While a container is still starting, a
 * request can stall with nothing left on the event loop, and Node then exits 0 in the middle of
 * bootstrap. The timer keeps the process alive and turns the stall into a retry.
 */
async function probe<T>(url: string, read: (res: Response) => Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer from ${url} in ${ms}ms`)), ms) })
  try {
    return await Promise.race([fetch(url).then(read), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForMattermost(baseUrl: string, timeoutMs = 120000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await probe(`${baseUrl}/api/v4/system/ping?get_server_status=true`, async (res) => res.ok && ((await res.json()) as { status?: string }).status === 'OK')
      if (ok) return
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Mattermost did not become healthy in time')
}

async function waitForForgejo(baseUrl: string, timeoutMs = 120000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await probe(`${baseUrl}/api/forgejo/v1/version`, async (res) => res.ok)) return
    } catch {
      // try fallback endpoint
      try {
        if (await probe(`${baseUrl}/api/v1/version`, async (res) => res.ok)) return
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Forgejo did not become healthy in time')
}

async function ensureMattermostHuman(config: Awaited<ReturnType<typeof loadConfig>>, secrets: OfficeSecrets): Promise<{ userId: string; password: string }> {
  const username = config.human.username
  const email = `${username}@office.local`
  const password = secrets.mattermost.humanPassword || randomPassword()

  // Check whether user already exists via mmctl local.
  let userId: string | undefined
  try {
    await dockerExec('mattermost', undefined, ['mmctl', '--local', 'user', 'search', username], true)
    const existing = await dockerExec(
      'mattermost',
      undefined,
      ['mmctl', '--local', 'user', 'search', '--json', username],
      true,
    )
    const parsed = JSON.parse(existing)
    userId = (Array.isArray(parsed) ? parsed[0]?.id : parsed.id) as string
  } catch {
    // Create fresh.
  }

  if (!userId) {
    await dockerExec(
      'mattermost',
      undefined,
      ['mmctl', '--local', 'user', 'create', '--email', email, '--username', username, '--password', password, '--system-admin', '--email-verified'],
      true,
    )

    const out = await dockerExec(
      'mattermost',
      undefined,
      ['mmctl', '--local', 'user', 'search', '--json', username],
      true,
    )
    const parsed = JSON.parse(out)
    userId = (Array.isArray(parsed) ? parsed[0]?.id : parsed.id) as string
    if (!userId) throw new Error('could not parse newly created Mattermost user')
  }

  // Always set the password to the one we will store.
  await dockerExec(
    'mattermost',
    undefined,
    ['mmctl', '--local', 'user', 'change-password', username, '--password', password],
    true,
  )

  return { userId, password }
}

async function ensureMattermostAdminToken(
  config: Awaited<ReturnType<typeof loadConfig>>,
  humanPassword: string,
): Promise<string> {
  const secrets = await loadSecrets()
  if (secrets?.mattermost.adminToken) {
    try {
      const test = new MattermostClient(config.mattermostUrl, secrets.mattermost.adminToken)
      await test.me()
      return secrets.mattermost.adminToken
    } catch {
      // fall through to create a new one
    }
  }

  // Login via API to obtain a session token.
  const loginRes = await fetch(`${config.mattermostUrl}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login_id: config.human.username,
      password: humanPassword,
    }),
  })
  if (!loginRes.ok) throw new Error(`Mattermost login failed: ${await loginRes.text()}`)
  const sessionToken = loginRes.headers.get('Token')
  if (!sessionToken) throw new Error('Mattermost login did not return a session token')

  const admin = new MattermostClient(config.mattermostUrl, sessionToken)
  const me = await admin.me()

  // Reuse existing token named "office-admin" if present.
  const tokens = await admin.listUserTokens(me.id)
  const existing = tokens.find((t) => t.description === 'office-admin')
  if (existing) return existing.token

  return admin.createUserAccessToken(me.id, 'office-admin')
}

async function ensureMattermostTeamAndChannels(
  client: MattermostClient,
  config: Awaited<ReturnType<typeof loadConfig>>,
  humanUserId: string,
): Promise<string> {
  let team: { id: string; name: string }
  try {
    team = await client.getTeamByName(config.team)
  } catch {
    team = await client.createTeam(config.team, config.team)
  }

  try {
    await client.addUserToTeam(team.id, humanUserId)
  } catch {
    // already in team
  }

  for (const channelName of config.defaultChannels) {
    const purpose = channelName.startsWith(config.agentChannelPrefix)
      ? 'Agent-only channel: the human reads but does not post'
      : 'Mixed channel: humans and agents'
    try {
      await client.getChannelByName(team.id, channelName)
    } catch {
      await client.createChannel({
        teamId: team.id,
        name: channelName,
        displayName: channelName,
        purpose,
        type: 'O',
      })
    }
  }

  return team.id
}

async function ensureOfficeBot(
  client: MattermostClient,
  config: Awaited<ReturnType<typeof loadConfig>>,
  secrets: OfficeSecrets,
  teamId: string,
): Promise<{ userId: string; token: string }> {
  const name = 'office'
  let userId: string | undefined
  try {
    const bot = await client.createBot({ username: name, displayName: 'Office', description: 'Office-wide admin bot for #office-admin' })
    userId = bot.id
  } catch (err) {
    if (!`${err}`.toLowerCase().includes('exists')) throw err
    const u = await client.getUserByUsername(name)
    userId = u.id
    await client.enableBot(userId)
  }

  await client.updateUserRoles(userId, 'system_user')
  try {
    await client.addUserToTeam(teamId, userId)
  } catch {
    // already in team
  }

  // Mattermost's token-list endpoint never returns the raw token value (only id/description),
  // so the only way to "reuse" a token is to keep testing the one already in secrets; a stale
  // or missing one means minting a fresh access token (the old row, if any, is simply orphaned).
  if (secrets.officeBot?.userId === userId && secrets.officeBot.token) {
    try {
      await new MattermostClient(config.mattermostUrl, secrets.officeBot.token).me()
      return { userId, token: secrets.officeBot.token }
    } catch {
      // stale: fall through and mint a new one
    }
  }
  const token = await client.createUserAccessToken(userId, 'office-bot')

  return { userId, token }
}

/** Create (idempotently) a private channel with only the owner and the office bot as members. */
async function ensureOwnerBotChannel(
  client: MattermostClient,
  teamId: string,
  humanUserId: string,
  botUserId: string,
  name: string,
  purpose: string,
): Promise<string> {
  let channel: ChatChannel
  try {
    channel = await client.getChannelByName(teamId, name)
  } catch {
    channel = await client.createChannel({
      teamId,
      name,
      displayName: name,
      purpose,
      type: 'P',
    })
  }

  for (const uid of [humanUserId, botUserId]) {
    try {
      await client.addToChannel(channel.id, uid)
    } catch {
      // already member
    }
  }

  // Keep only the owner and the office bot as members.
  const allowed = new Set([humanUserId, botUserId])
  const members = await client.getChannelMembers(channel.id)
  for (const m of members) {
    if (!allowed.has(m.user_id)) {
      try {
        await client.removeFromChannel(channel.id, m.user_id)
      } catch {
        // ignore
      }
    }
  }

  return channel.id
}

async function ensureForgejoAdmin(
  config: Awaited<ReturnType<typeof loadConfig>>,
  secrets: OfficeSecrets,
): Promise<{ adminToken: string; humanPassword: string }> {
  const username = config.human.username
  const email = `${username}@office.local`
  const password = secrets.forgejo.humanPassword || randomPassword()

  // Check if admin user exists by trying to create it.
  try {
    await dockerExec(
      'forgejo',
      'git',
      ['forgejo', 'admin', 'user', 'create', '--admin', '--username', username, '--email', email, '--password', password, '--must-change-password=false'],
      true,
    )
  } catch (err) {
    if (!`${err}`.toLowerCase().includes('already exists')) throw err
  }

  // Create admin access token via basic auth.
  const client = new ForgejoClient(config.forgejoUrl, '')
  const tokenRes = await client.createTokenForUser(username, password, 'office-admin', [
    'read:user',
    'write:user',
    'read:admin',
    'write:admin',
    'read:repository',
    'write:repository',
    'read:organization',
    'write:organization',
    'read:issue',
    'write:issue',
    'read:notification',
    'write:notification',
  ])

  return { adminToken: tokenRes.token ?? tokenRes.sha1, humanPassword: password }
}

async function ensureForgejoOrgAndRepo(
  client: ForgejoClient,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  try {
    await client.createOrg(config.forgejoOrg, config.forgejoOrg)
  } catch (err) {
    if (!`${err}`.includes('already exists') && !`${err}`.includes('422')) throw err
  }

  const team = await client.ensureOrgTeam(config.forgejoOrg, 'agents', 'write')
  try {
    await client.addTeamMember(config.forgejoOrg, 'agents', config.human.username)
  } catch {
    // already member
  }

  try {
    await client.createOrgRepo(config.forgejoOrg, config.ticketsRepo, { autoInit: true })
  } catch (err) {
    if (!`${err}`.includes('already exists') && !`${err}`.includes('422')) throw err
  }

  await client.ensureLabels(config.forgejoOrg, config.ticketsRepo, [
    { name: 'status/todo', color: '#7f8c8d' },
    { name: 'status/in-progress', color: '#3498db' },
    { name: 'status/review', color: '#f1c40f' },
    { name: 'status/blocked', color: '#e74c3c' },
    { name: 'status/done', color: '#2ecc71' },
    { name: 'kind/bug', color: '#e74c3c' },
    { name: 'kind/feature', color: '#9b59b6' },
    { name: 'kind/research', color: '#1abc9c' },
    { name: 'kind/chore', color: '#95a5a6' },
  ])
}

/** Idempotent bootstrap of the whole local office. */
export async function bootstrap(): Promise<void> {
  assertStackOwnership(repoRoot())
  await ensureInfraEnv()
  await dockerCompose(['up', '-d'], { quiet: true })

  const config = await loadConfig()
  await waitForMattermost(config.mattermostUrl)
  await waitForForgejo(config.forgejoUrl)

  let secrets = (await loadSecrets()) ?? {
    mattermost: { adminToken: '', teamId: '', humanUserId: '', humanPassword: '' },
    forgejo: { adminToken: '', humanPassword: '' },
  }

  const mmHuman = await ensureMattermostHuman(config, secrets)
  const adminToken = await ensureMattermostAdminToken(config, mmHuman.password)
  const mm = new MattermostClient(config.mattermostUrl, adminToken)
  const teamId = await ensureMattermostTeamAndChannels(mm, config, mmHuman.userId)

  const officeBot = await ensureOfficeBot(mm, config, secrets, teamId)
  await ensureOwnerBotChannel(mm, teamId, mmHuman.userId, officeBot.userId, config.adminChannel, 'Owner console: type office commands here (help for the list)')
  await ensureOwnerBotChannel(mm, teamId, mmHuman.userId, officeBot.userId, config.financeChannel, 'Owner finance console: resource-group usage/cost report and alerts (type `finance` for the list)')

  const fjAdmin = await ensureForgejoAdmin(config, secrets)
  const fj = new ForgejoClient(config.forgejoUrl, fjAdmin.adminToken)
  await ensureForgejoOrgAndRepo(fj, config)

  secrets = {
    mattermost: {
      adminToken,
      teamId,
      humanUserId: mmHuman.userId,
      humanPassword: mmHuman.password,
    },
    forgejo: {
      adminToken: fjAdmin.adminToken,
      humanPassword: fjAdmin.humanPassword,
    },
    officeBot,
  }
  await saveSecrets(secrets)

  console.log('\nAgent Office bootstrapped.')
  console.log(`Mattermost: ${config.mattermostUrl}`)
  console.log(`Forgejo:    ${config.forgejoUrl}`)
  console.log(`Human user: ${config.human.username}`)
  console.log(`Password:   ${secrets.mattermost.humanPassword}`)
  console.log(`Team:       ${config.team}`)
  console.log(`Org/repo:   ${config.forgejoOrg}/${config.ticketsRepo}`)
  console.log('(secrets written to state/office.json)')
}

/** Create (or refresh the token for) an agent identity. */
export async function createAgentIdentity(
  name: string,
  displayName: string,
  description: string,
): Promise<{ mattermost: { userId: string; token: string }; forgejo: { token: string } }> {
  const config = await loadConfig()
  const secrets = await loadSecrets()
  if (!secrets) throw new Error('bootstrap must be run before createAgentIdentity')

  const mm = new MattermostClient(config.mattermostUrl, secrets.mattermost.adminToken)
  const fj = new ForgejoClient(config.forgejoUrl, secrets.forgejo.adminToken)

  // --- Mattermost bot
  let userId: string
  try {
    const bot = await mm.createBot({ username: name, displayName, description })
    userId = bot.id
  } catch (err) {
    if (!`${err}`.toLowerCase().includes('exists')) throw err
    const u = await mm.getUserByUsername(name)
    userId = u.id
    await mm.enableBot(userId)
  }

  await mm.updateUserRoles(userId, 'system_user')
  await mm.addUserToTeam(secrets.mattermost.teamId, userId)
  const channels = await mm.getPublicChannels(secrets.mattermost.teamId)
  for (const ch of channels) {
    try {
      await mm.addToChannel(ch.id, userId)
    } catch {
      // already in channel
    }
  }

  const mmToken = await mm.createUserAccessToken(userId, `office-agent-${name}`)

  // --- Forgejo user
  const email = `${name}@office.local`
  const password = randomPassword()
  let userExisted = false
  try {
    await fj.createUser({ username: name, email, password, mustChangePassword: false })
  } catch (err) {
    if (!`${err}`.toLowerCase().includes('already exists')) throw err
    userExisted = true
  }

  // If the user already existed, reset its password via admin so basic auth works.
  if (userExisted) {
    await fj.adminResetPassword(name, password)
  }

  const fjToken = await fj.createTokenForUser(name, password, `office-agent-${name}`, [
    'read:user',
    'write:user',
    'read:repository',
    'write:repository',
    'read:organization',
    'write:organization',
    'read:issue',
    'write:issue',
    'read:notification',
    'write:notification',
  ])

  try {
    await fj.addTeamMember(config.forgejoOrg, 'agents', name)
  } catch {
    // already member
  }

  // Persist agent record.
  const existing = await loadAgent(name)
  const record = existing ?? {
    name,
    displayName,
    harness: 'opencode' as const,
    model: config.defaults.opencodeModel,
    status: 'hired' as const,
    pastSessions: [],
    chrome: false,
    mattermost: { userId, token: mmToken },
    forgejo: { token: fjToken.token ?? fjToken.sha1 },
    createdAt: new Date().toISOString(),
  }
  record.mattermost = { userId, token: mmToken }
  record.forgejo = { token: fjToken.token ?? fjToken.sha1 }
  await saveAgent(record)

  return {
    mattermost: { userId, token: mmToken },
    forgejo: { token: fjToken.token ?? fjToken.sha1 },
  }
}

/** Disable an agent's Mattermost bot. Forgejo user is left untouched. */
export async function retireAgentIdentity(name: string): Promise<void> {
  const config = await loadConfig()
  const secrets = await loadSecrets()
  if (!secrets) throw new Error('bootstrap must be run before retireAgentIdentity')

  const mm = new MattermostClient(config.mattermostUrl, secrets.mattermost.adminToken)
  try {
    const u = await mm.getUserByUsername(name)
    await mm.disableBot(u.id)
  } catch {
    // ignore if not found
  }

  const rec = await loadAgent(name)
  if (rec) {
    rec.status = 'retired'
    await saveAgent(rec)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
