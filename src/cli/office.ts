// `office` — manage the agent office: infra, hiring, sessions, fork/merge, shifts.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import type { AgentRecord, Harness } from '../lib/types.js'
import { agentStateDir, listAgents, loadAgent, loadConfig, loadSecrets, repoRoot, saveAgent, saveConfig, stateDir } from '../lib/config.js'
import { bootstrap, createAgentIdentity, retireAgentIdentity } from './bootstrap.js'
import { MattermostClient } from '../lib/mattermost.js'
import { ForgejoClient } from '../lib/forgejo.js'
import { agentBrainDir, commitBrain, ensureBrain, prepareAgentGitIdentity, projectBrainDir, seedAgentBrain, workspaceDir, writeWorkspaceInstructions } from '../lib/workspace.js'
import { isProjectMember, listProjects, loadProject, saveProject, validateProjectName } from '../lib/projects.js'
import { claudeLaunchCommand, claudeMcpConfig, claudeSessionExists, claudeSettings, ensureClaudeOnboarded, readStatus, settleClaudeStartup, writeStatus } from '../lib/harness/claude.js'
import { OpencodeClient, buildOpencodeConfig, forkOpencodeSession, opencodeLaunchCommand, opencodeTranscript } from '../lib/harness/opencode.js'
import { queueSystemPrompt } from '../lib/inbox.js'
import { composeFileArgs } from '../lib/infra.js'
import { MOVED_PROMPT, exportOffice, importOffice } from '../lib/migrate.js'
import { cmdVault } from './vault-cmd.js'
import { runSetup } from './setup.js'
import { opencodeProviderOverrides, vaultEnvDefaults, vaultEnvForAgent, withEnvFile, writeAgentEnvFile } from '../lib/vault.js'
import { findClaudeSessionFile, readClaudeTranscript, renderTranscript } from '../lib/transcript.js'
import { capturePane, killWindow, openWindow, paneAlive, windowExists, windowTarget } from '../lib/tmux.js'
import { run as runAdminDaemon } from '../admin/daemon.js'
import { renderStatusMarkdown } from '../admin/commands.js'
import { collectFinanceSnapshot } from '../finance/collect.js'
import { renderAgentDetail, renderFinanceReport, renderGroupDetail, renderLimitsSection } from '../finance/render.js'
import { checkGroupForAgent, claudeConfigDir, groupIdForAgent } from '../finance/groups.js'
import { readHeadroom } from '../finance/headroom.js'
import { readClaudeAccountInfo } from '../finance/claude.js'
import { cmdGroup, resolveHireGroup, type GroupDeps } from './group-cmd.js'
import {
  buildActivityTimeline,
  buildRichStatusRow,
  buildRichStatusMarkdown,
  buildRichStatusPlain,
  buildTerminalBlock,
  detectStaleWork,
  formatDuration,
  formatInspectReport,
  isDmChannelName,
  lastDeliveredFromLog,
  otherDmParticipant,
  parsePaneMetrics,
  pendingByKind,
  readPending,
  tailMcpLog,
  type RichStatusRow,
} from '../admin/monitor.js'

const root = repoRoot()
const cfg = await loadConfig()
/** What the owner opens in a browser (LAN/Tailscale on a home server); agents use cfg.*Url. */
const publicUrls = cfg.publicUrls ?? { mattermost: cfg.mattermostUrl, forgejo: cfg.forgejoUrl }

async function agent(name: string): Promise<AgentRecord> {
  const r = await loadAgent(name)
  if (!r) throw new Error(`no such agent: ${name}`)
  return r
}
async function allAgents(): Promise<AgentRecord[]> {
  return (await Promise.all((await listAgents()).map(n => loadAgent(n)))).filter(Boolean) as AgentRecord[]
}

async function adminClients() {
  const secrets = await loadSecrets()
  if (!secrets) throw new Error('run `office init` first')
  const mm = new MattermostClient(cfg.mattermostUrl, secrets.mattermost.adminToken)
  const fj = new ForgejoClient(cfg.forgejoUrl, secrets.forgejo.adminToken)
  const team = await mm.getTeamByName(cfg.team)
  return { mm, fj, team, secrets }
}

// ------------------------------------------------------------------ small helpers
function parseArgs(argv: string[]) {
  const pos: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2)
      if (v !== undefined) flags[k] = v
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else pos.push(a)
  }
  return { pos, flags }
}
const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')

function writeJsonFile(f: string, v: unknown) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n') }

async function nextOpencodePort(): Promise<number> {
  const used = new Set((await allAgents()).map(a => a.opencodePort).filter(Boolean))
  let p = cfg.opencodeBasePort
  while (used.has(p)) p++
  return p
}

async function ensureInfra() {
  const r = spawnSync('docker', ['compose', ...composeFileArgs(root), 'up', '-d'], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('docker compose up failed')
}

// ------------------------------------------------------------------ start / stop
async function startAgent(rec: AgentRecord, opts: { forkParentSession?: string } = {}): Promise<void> {
  if (rec.status === 'retired') throw new Error(`${rec.name} is retired`)
  if (await windowExists(cfg.tmuxSession, rec.name) && await paneAlive(windowTarget(cfg.tmuxSession, rec.name))) {
    console.log(`${rec.name}: already running`); return
  }
  await killWindow(cfg.tmuxSession, rec.name) // dead pane left by remain-on-exit
  const dir = agentStateDir(rec.name)
  fs.mkdirSync(dir, { recursive: true })
  const ws = workspaceDir(root, rec.name)
  await writeWorkspaceInstructions(root, cfg, rec)
  const envPrefix = await prepareAgentGitIdentity(root, cfg, rec)
  const statusFile = path.join(dir, 'status.json')
  writeStatus(statusFile, 'starting')
  // Vault keys reach the harness through a chmod-600 env file, never the command line.
  const env = vaultEnvForAgent(root, cfg.resourceGroups, rec)
  const envFile = writeAgentEnvFile(dir, env)

  if (rec.harness === 'claude') {
    const configDir = claudeConfigDir(root, cfg.resourceGroups.find(g => g.id === groupIdForAgent(rec, cfg.resourceGroups)))
    if (configDir) ensureClaudeOnboarded(configDir)
    const settingsFile = path.join(dir, 'claude-settings.json')
    const mcpFile = path.join(dir, 'mcp.json')
    writeJsonFile(settingsFile, claudeSettings(root, statusFile, ws))
    // rec.chrome means "this agent launches with --chrome"; non-chrome agents get Playwright MCP.
    writeJsonFile(mcpFile, claudeMcpConfig(root, rec.name, { playwright: !rec.chrome }))
    let mode: Parameters<typeof claudeLaunchCommand>[0]['mode']
    if (opts.forkParentSession) {
      rec.sessionId = randomUUID()
      mode = { kind: 'fork', parentSessionId: opts.forkParentSession, sessionId: rec.sessionId }
    } else if (rec.sessionId && claudeSessionExists(rec.sessionId, configDir)) {
      mode = { kind: 'resume', sessionId: rec.sessionId }
    } else {
      rec.sessionId = rec.sessionId ?? randomUUID()
      mode = { kind: 'new', sessionId: rec.sessionId }
    }
    await saveAgent(rec)
    const cmd = withEnvFile(claudeLaunchCommand({ root, agent: rec, workspace: ws, settingsFile, mcpFile, mode, envPrefix, configDir }), envFile)
    const { openWindow } = await import('../lib/tmux.js')
    await openWindow(cfg.tmuxSession, rec.name, ws, cmd)
    const r = await settleClaudeStartup(windowTarget(cfg.tmuxSession, rec.name))
    console.log(`${rec.name}: claude ${mode.kind} session ${rec.sessionId} → ${r}`)
    if (r !== 'ready') console.log((await capturePane(windowTarget(cfg.tmuxSession, rec.name), 30).catch(() => '')).trim())
    return
  }

  // opencode
  rec.opencodePort = rec.opencodePort ?? await nextOpencodePort()
  await saveAgent(rec)
  const configPath = path.join(dir, 'opencode.json')
  writeJsonFile(configPath, buildOpencodeConfig({ root, agent: rec.name, model: rec.model, instructions: [path.join(ws, 'AGENTS.md')], provider: opencodeProviderOverrides(cfg.resourceGroups, env) }))
  const client = new OpencodeClient(`http://127.0.0.1:${rec.opencodePort}`)
  if (!rec.sessionId) {
    // Create the desk session headless first so the TUI can open it by id.
    const cmd0 = withEnvFile(opencodeLaunchCommand({ root, agent: rec.name, workspace: ws, configPath, port: rec.opencodePort, model: rec.model, headless: true, envPrefix }), envFile)
    const { spawn } = await import('node:child_process')
    const p = spawn('sh', ['-c', cmd0], { stdio: 'ignore', detached: true })
    try {
      await client.waitForServer(30_000)
      rec.sessionId = (await client.createSession(`desk: ${rec.name}`)).id
      await saveAgent(rec)
    } finally { try { process.kill(-p.pid!) } catch { p.kill() } }
    await sleep(1000)
  }
  const cmd = withEnvFile(opencodeLaunchCommand({ root, agent: rec.name, workspace: ws, configPath, port: rec.opencodePort, model: rec.model, sessionId: rec.sessionId, envPrefix }), envFile)
  const { openWindow } = await import('../lib/tmux.js')
  await openWindow(cfg.tmuxSession, rec.name, ws, cmd)
  await client.waitForServer(45_000)
  writeStatus(statusFile, 'idle', 'server-up')
  console.log(`${rec.name}: opencode session ${rec.sessionId} on :${rec.opencodePort}`)
}

async function stopAgent(rec: AgentRecord): Promise<void> {
  await killWindow(cfg.tmuxSession, rec.name)
  writeStatus(path.join(agentStateDir(rec.name), 'status.json'), 'stopped')
  console.log(`${rec.name}: stopped`)
}

async function ensureAdminDaemon(): Promise<void> {
  if (await windowExists(cfg.tmuxSession, 'admin') && await paneAlive(windowTarget(cfg.tmuxSession, 'admin'))) {
    console.log('admin: already running')
    return
  }
  await killWindow(cfg.tmuxSession, 'admin').catch(() => {})
  const cmd = path.join(root, 'bin', 'office') + ' admin'
  await openWindow(cfg.tmuxSession, 'admin', root, cmd)
  console.log('admin: started')
}

async function stopAdminDaemon(): Promise<void> {
  await killWindow(cfg.tmuxSession, 'admin')
  console.log('admin: stopped')
}

/** Stop every agent session and the admin daemon (systemd ExecStop). The Docker stack keeps running. */
async function shutdownOffice(): Promise<void> {
  for (const a of (await allAgents()).filter(a => a.status === 'hired')) await stopAgent(a)
  await stopAdminDaemon()
}

async function cmdExport(pos: string[]) {
  const out = path.resolve(pos[0] ?? `agentcy-export-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`)
  console.log('stopping agents, admin daemon and the chat/tickets stack for a consistent copy…')
  await shutdownOffice()
  const m = exportOffice(root, out)
  // Claude subscription logins never travel (see migrate.ts): each extra group needs a fresh login on the new machine.
  const claudeGroupIds = cfg.resourceGroups.filter(g => g.kind === 'claude-subscription' && g.configDir).map(g => g.id)
  console.log(`exported ${m.agents.length} agent(s) to ${out}
This bundle holds every token and the vault key: copy it straight to the server (e.g. scp -r) and delete it afterwards.
On the server: ./install.sh and choose "import", or \`office setup --import ${path.basename(out)}\`.${claudeGroupIds.length ? `
Then log in each extra Claude subscription group on the new machine: ${claudeGroupIds.map(id => `\`office group login ${id}\``).join(', ')}.` : ''}
This office is left stopped. Don't start it again here, or you'll have two offices drifting apart.`)
}

async function cmdImport(pos: string[], flags: Record<string, string | boolean>) {
  if (!pos[0]) throw new Error('usage: office import <export-dir> [--force]   (office setup --import <dir> also sets up access/keys)')
  const { moved } = importOffice(root, path.resolve(pos[0]), { force: flags.force === true })
  for (const name of moved) await queueSystemPrompt(root, name, 'moved', MOVED_PROMPT)
  console.log(`imported; ${moved.length} agent(s) start fresh sessions from their brains. Next: office init (re-checks the stack), then office start`)
}

// ------------------------------------------------------------------ commands
async function cmdHire(pos: string[], flags: Record<string, string | boolean>) {
  const name = slug(pos[0] ?? '')
  if (!name) throw new Error('usage: office hire <name> [--harness claude|opencode] [--model M] [--focus "..."] [--display "Name"] [--chrome] [--group <id|auto>] [--no-start]')
  if ((await allAgents()).some(a => a.name === name)) throw new Error(`${name} already exists`)
  const harness = (str(flags.harness) ?? 'claude') as Harness
  const model = str(flags.model) ?? (harness === 'claude' ? cfg.defaults.claudeModel : cfg.defaults.opencodeModel)
  const displayName = str(flags.display) ?? name[0].toUpperCase() + name.slice(1)
  const focus = str(flags.focus) ?? 'general'
  const group = resolveHireGroup(str(flags.group), { harness, model }, cfg.resourceGroups, readHeadroom(root)?.usedPercent ?? {})
  ensureBrain(root)
  const identity = await createAgentIdentity(name, displayName, `${harness} agent (${model}) — ${focus}`)
  const rec: AgentRecord = {
    name, displayName, harness, model, status: 'hired', pastSessions: [], chrome: flags.chrome === true,
    mattermost: identity.mattermost, forgejo: identity.forgejo, createdAt: new Date().toISOString(),
  }
  if (group) rec.group = group
  await saveAgent(rec)
  seedAgentBrain(root, rec, focus)
  commitBrain(root, `Hire @${name}`)
  await queueSystemPrompt(root, name, 'welcome',
    `<office-system kind="welcome">You just joined the office as @${name}. Read your instructions (CLAUDE.md / AGENTS.md), look around with office_directory and chat_channels, then post ONE short hello in #ag-lobby saying what you focus on (${focus}). After that, wait for events.</office-system>`)
  console.log(`hired @${name} (${harness}, ${model}${rec.group ? `, group ${rec.group}` : ''})`)
  if (flags['no-start'] !== true) await startAgent(rec)
}

async function lastAgentPost(mm: MattermostClient, teamId: string, username: string): Promise<import('../lib/types.js').ChatPost | undefined> {
  try {
    const posts = await mm.searchPosts(teamId, `from:${username}`)
    return posts.sort((a, b) => b.createAt - a.createAt)[0]
  } catch {
    return undefined
  }
}

async function buildRichStatusRows(includeRetired: boolean): Promise<RichStatusRow[]> {
  const { mm, team } = await adminClients()
  const nowMs = Date.now()
  const rows: RichStatusRow[] = []
  for (const a of await allAgents()) {
    if (!includeRetired && a.status === 'retired') continue
    const target = windowTarget(cfg.tmuxSession, a.name)
    const alive = await paneAlive(target)
    const st = readStatus(path.join(agentStateDir(a.name), 'status.json'))
    const pane = alive ? await capturePane(target, 35).catch(() => '') : ''
    const metrics = parsePaneMetrics(pane, a.harness)
    const pending = readPending(path.join(agentStateDir(a.name), 'pending.json'))
    const lastPost = await lastAgentPost(mm, team.id, a.name)
    let lastPostDmOtherUsername: string | undefined
    if (lastPost && isDmChannelName(lastPost.channel)) {
      const otherId = otherDmParticipant(lastPost.channel, a.mattermost.userId)
      if (otherId) lastPostDmOtherUsername = await mm.getUser(otherId).then(u => u.username).catch(() => undefined)
    }
    rows.push(buildRichStatusRow(a, {
      alive, status: st, paneMetrics: metrics, lastPost, lastPostDmOtherUsername, pending,
      logFile: path.join(agentStateDir(a.name), 'mcp.log'), nowMs,
    }))
  }
  return rows
}

async function cmdStatus(flags: Record<string, string | boolean>) {
  const md = flags.md === true
  const all = flags.all === true
  const rows = await buildRichStatusRows(all)
  const footer = `chat: ${publicUrls.mattermost}   tickets: ${publicUrls.forgejo}   sessions: tmux attach -t ${cfg.tmuxSession}${fs.existsSync(path.join(stateDir(), 'freeze')) ? '   ❄ FROZEN' : ''}`
  console.log(md ? buildRichStatusMarkdown(rows, { footer }) : buildRichStatusPlain(rows, { footer }))
}

async function cmdInspect(pos: string[]) {
  const name = slug(pos[0] ?? '')
  if (!name) throw new Error('usage: office inspect <agent>')
  const a = await agent(name)
  const { mm, fj, team } = await adminClients()
  const dir = agentStateDir(a.name)
  const target = windowTarget(cfg.tmuxSession, a.name)
  const alive = await paneAlive(target)
  const st = readStatus(path.join(dir, 'status.json'))
  const pane = alive ? await capturePane(target, 35).catch(() => '') : ''
  const metrics = parsePaneMetrics(pane, a.harness)
  const nowMs = Date.now()
  const state = `${st?.state ?? 'unknown'} ${st?.at ? formatDuration(nowMs - Date.parse(st.at)) : ''}`.trim()

  // Identity block.
  const identityLines = [
    `- **harness:** ${a.harness}`,
    `- **model:** ${a.model}`,
    `- **group:** ${groupIdForAgent(a, cfg.resourceGroups) ?? '–'}`,
    `- **session:** ${a.sessionId ?? '–'}`,
    `- **status:** ${a.status}`,
    `- **projects:** ${(await listProjects(root)).filter(p => !p.archived && p.members.includes(a.name)).map(p => p.name).join(', ') || '–'}`,
  ]
  if (a.forkedFrom) identityLines.push(`- **fork of:** @${a.forkedFrom.parent} (${a.forkedFrom.forkedAt.slice(0, 16)})`)

  // Work items: assigned or authored open tickets across office/tasks and all projects.
  const workItems: { repo: string; number: number; title: string; age: string; url?: string }[] = []
  const repos = [cfg.ticketsRepo, ...(await listProjects(root)).filter(p => !p.archived).map(p => p.name)]
  for (const repo of repos) {
    try {
      const [assigned, authored] = await Promise.all([
        fj.listIssues(cfg.forgejoOrg, repo, { state: 'open', assignee: a.name }),
        fj.listIssues(cfg.forgejoOrg, repo, { state: 'open' }).then(issues => issues.filter(i => i.user.login === a.name)),
      ])
      for (const i of [...assigned, ...authored]) {
        workItems.push({
          repo: `${cfg.forgejoOrg}/${repo}`,
          number: i.number,
          title: i.title,
          age: formatDuration(nowMs - new Date(i.updated_at).getTime()),
          url: i.html_url,
        })
      }
    } catch { /* ignore per-repo errors */ }
  }

  // Last 3 chat posts.
  const lastPosts = (await lastAgentPost(mm, team.id, a.name))
    ? await mm.searchPosts(team.id, `from:${a.name}`).then(pp => pp.sort((x, y) => y.createAt - x.createAt).slice(0, 3))
    : []

  const weeklyLine = metrics.weeklyPercent !== undefined
    ? `You've used ${metrics.weeklyPercent}% of your weekly limit`
    : undefined

  const report = formatInspectReport(a.name, {
    identity: identityLines.join('\n'),
    state,
    condition: metrics.condition,
    context: metrics.context,
    terminal: buildTerminalBlock(pane),
    log: tailMcpLog(path.join(dir, 'mcp.log')),
    pending: pendingByKind(readPending(path.join(dir, 'pending.json'))),
    lastPosts: lastPosts.map(p => ({
      time: new Date(p.createAt).toISOString().slice(11, 16),
      channel: p.channel,
      text: p.message.slice(0, 140).replace(/\n/g, ' ') + (p.message.length > 140 ? '…' : ''),
    })),
    workItems,
    weeklyLine,
  })
  console.log(report)
}

async function cmdFinance(pos: string[]) {
  const arg = pos[0]?.toLowerCase()
  const snapshot = await collectFinanceSnapshot(root, cfg)
  const footer = `chat: ${publicUrls.mattermost}#${cfg.financeChannel}`

  if (!arg || arg === 'today') {
    console.log(renderFinanceReport('today', snapshot.groupsToday, snapshot.agentsMerged, { footer, limits: snapshot.limits }))
    return
  }
  if (arg === 'week') {
    console.log(renderFinanceReport('week', snapshot.groupsWeek, snapshot.agentsMerged, { footer, limits: snapshot.limits }))
    return
  }
  if (arg === 'limits') {
    console.log(renderLimitsSection(snapshot.limits))
    return
  }
  const group = snapshot.groupsWeek.find((g) => g.id === arg || g.label.toLowerCase() === arg)
  if (group) {
    const agents = snapshot.agentsMerged.filter((a) => a.group === group.label)
    console.log(renderGroupDetail(group, agents))
    return
  }
  const agent = snapshot.agentsMerged.find((a) => a.name === arg)
  if (agent) {
    console.log(renderAgentDetail(agent))
    return
  }
  throw new Error(`usage: office finance [today|week|limits|<agent>|<group>] — no agent or group named "${pos[0]}"`)
}

async function cmdActivity(pos: string[], flags: Record<string, string | boolean>) {
  const minutes = Number(str(flags.minutes) ?? pos[0] ?? '60')
  if (Number.isNaN(minutes) || minutes <= 0) throw new Error('usage: office activity [--minutes N] [N]')
  const { mm, fj, team } = await adminClients()
  const since = Date.now() - minutes * 60_000
  const agents = (await allAgents()).filter(a => a.status !== 'retired').map(a => a.name)
  const watchedUsernames = new Set([cfg.human.username, ...agents])

  // Chat posts from channels the bot can see.
  const allPosts: import('../lib/types.js').ChatPost[] = []
  const channels = await mm.getChannelsForUser(team.id).catch(() => [] as import('../lib/types.js').ChatChannel[])
  for (const ch of channels) {
    try {
      const posts = await mm.getChannelPosts(ch.id, { since, perPage: 200 })
      allPosts.push(...posts.filter(p => watchedUsernames.has(p.username)))
    } catch { /* ignore per-channel errors */ }
  }

  // Ticket/PR events from notifications in the window.
  const ticketEvents: { at: string; repo: string; number: number; title: string; action: string; url?: string }[] = []
  try {
    const notes = await fj.listNotifications({ unreadOnly: false })
    for (const n of notes) {
      const at = new Date(n.updated_at).getTime()
      if (at < since) continue
      const url = n.subject.html_url || n.subject.url
      const num = Number(/\/(?:issues|pulls)\/(\d+)/.exec(url)?.[1] ?? 0)
      const action = n.subject.type === 'Pull' ? 'PR update' : 'ticket update'
      ticketEvents.push({ at: n.updated_at, repo: n.repository.full_name, number: num, title: n.subject.title, action, url })
    }
  } catch { /* ignore */ }

  const timeline = buildActivityTimeline(allPosts, ticketEvents)
  if (timeline.length === 0) { console.log(`No activity in the last ${minutes} minutes.`); return }
  console.log(`Activity in the last ${minutes} minutes:\n`)
  for (const e of timeline) {
    const url = e.url ? ` (${e.url})` : ''
    console.log(`${e.time} ${e.who} ${e.channel}:${url} ${e.text}`)
  }
}

async function cmdFork(pos: string[], flags: Record<string, string | boolean>) {
  const parent = await agent(slug(pos[0] ?? ''))
  if (!parent.sessionId) throw new Error(`${parent.name} has no session to fork`)
  const existing = new Set((await allAgents()).map(a => a.name))
  let name = slug(str(flags.name) ?? '')
  if (!name) { let i = 2; while (existing.has(`${parent.name}-${i}`)) i++; name = `${parent.name}-${i}` }
  if (existing.has(name)) throw new Error(`${name} already exists`)
  const task = str(flags.task)

  // Count what the fork inherits so a later merge replays only the new part.
  let inherited = 0
  if (parent.harness === 'claude') {
    const parentDir = claudeConfigDir(root, cfg.resourceGroups.find(g => g.id === groupIdForAgent(parent, cfg.resourceGroups)))
    const f = findClaudeSessionFile(parent.sessionId, parentDir)
    inherited = f ? readClaudeTranscript(f).length : 0
  } else {
    inherited = opencodeTranscript(await new OpencodeClient(`http://127.0.0.1:${parent.opencodePort}`).messages(parent.sessionId)).length
  }

  const identity = await createAgentIdentity(name, `${parent.displayName} (fork ${name})`, `Fork of @${parent.name}`)
  const rec: AgentRecord = {
    name, displayName: `${parent.displayName}·${name.split('-').pop()}`, harness: parent.harness, model: parent.model, status: 'hired',
    pastSessions: [], chrome: parent.chrome, mattermost: identity.mattermost, forgejo: identity.forgejo, createdAt: new Date().toISOString(),
    group: parent.group,
    forkedFrom: { parent: parent.name, parentSessionId: parent.sessionId, inheritedMessages: inherited, forkedAt: new Date().toISOString() },
  }
  // Brain: copy the parent's files; keep the parent's memory as the 3-way merge base.
  const src = agentBrainDir(root, parent.name), dst = agentBrainDir(root, name)
  fs.cpSync(src, dst, { recursive: true })
  fs.mkdirSync(agentStateDir(name), { recursive: true })
  fs.copyFileSync(path.join(src, 'memory.md'), path.join(agentStateDir(name), 'fork-base-memory.md'))
  fs.appendFileSync(path.join(dst, 'persona.md'), `\n\n> Forked from @${parent.name} on ${rec.forkedFrom!.forkedAt.slice(0, 16)}${task ? ` for: ${task}` : ''}.\n`)
  fs.appendFileSync(path.join(dst, 'journal.md'), `- ${rec.createdAt.slice(0, 10)}: forked from @${parent.name}${task ? ` — ${task}` : ''}.\n`)
  commitBrain(root, `Fork @${parent.name} → @${name}`)

  if (parent.harness === 'opencode') {
    rec.opencodePort = await nextOpencodePort()
    rec.sessionId = await forkOpencodeSession({ baseUrl: `http://127.0.0.1:${parent.opencodePort}`, sessionId: parent.sessionId })
  }
  await saveAgent(rec)
  await queueSystemPrompt(root, name, 'fork-intro',
    `<office-system kind="fork">You are now @${name}, a FORK of @${parent.name}. Everything above this point is the shared past you inherited from @${parent.name}. ` +
    `From now on you are a separate colleague with your own chat identity (@${name}) and brain folder (brain/agents/${name}/). Your office tools now act as @${name}.\n` +
    (task ? `Your task: ${task}\nWhen finished, report ONCE: where the task says, otherwise in #office, mentioning @${parent.name}, and say you are ready to be merged back.` : 'Wait for instructions.') +
    `</office-system>`)
  await startAgent(rec, parent.harness === 'claude' ? { forkParentSession: parent.sessionId } : {})
  console.log(`forked @${parent.name} → @${name} (inherited ${inherited} messages)`)
}

async function summarize(raw: string, from: string, into: string): Promise<string> {
  const tmp = path.join(stateDir(), `merge-${from}-${Date.now()}.md`)
  fs.writeFileSync(tmp, raw)
  const prompt = `The attached file is the work transcript of agent @${from} since it forked from (or independently of) agent @${into}. ` +
    `Write a dense merge memo (max ~1500 words) that lets @${into} continue as if it had lived this experience itself: goals, what was done (files, commits, tickets, threads by id), decisions and why, facts learned, open questions, promises made to others, and next steps. Preserve exact identifiers, paths and numbers. Output ONLY the memo in markdown.`
  const summarizerConfig = path.join(stateDir(), 'summarizer-opencode.json')
  const env = vaultEnvDefaults(root, cfg.resourceGroups, 'opencode')
  writeJsonFile(summarizerConfig, { $schema: 'https://opencode.ai/config.json', provider: opencodeProviderOverrides(cfg.resourceGroups, env) })
  const r = spawnSync('opencode', ['run', '-m', cfg.defaults.summarizerModel, '-f', tmp, '--', prompt], { cwd: stateDir(), env: { ...process.env, ...env, OPENCODE_CONFIG: summarizerConfig }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 })
  fs.rmSync(tmp, { force: true })
  const out = (r.stdout ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
  if (r.status !== 0 || out.length < 200) throw new Error(`summariser failed (${r.status}): ${(r.stderr ?? '').slice(-500)}`)
  return out
}

async function cmdMerge(pos: string[], flags: Record<string, string | boolean>) {
  const src = await agent(slug(pos[0] ?? ''))
  const dstName = slug(str(flags.into) ?? src.forkedFrom?.parent ?? '')
  if (!dstName) throw new Error('usage: office merge <src> [--into <dst>] [--keep]')
  const dst = await agent(dstName)
  if (!src.sessionId) throw new Error(`${src.name} has no session`)

  const srcDir = claudeConfigDir(root, cfg.resourceGroups.find(g => g.id === groupIdForAgent(src, cfg.resourceGroups)))
  const entries = src.harness === 'claude'
    ? readClaudeTranscript(findClaudeSessionFile(src.sessionId, srcDir) ?? (() => { throw new Error('transcript not found') })())
    : opencodeTranscript(await new OpencodeClient(`http://127.0.0.1:${src.opencodePort}`).messages(src.sessionId))
  let start = 0
  if (src.forkedFrom && src.forkedFrom.parent === dst.name) {
    const byContent = entries.findIndex(
      (e, i) =>
        e.role === 'user' &&
        i < entries.length - 1 &&
        e.text.includes('kind="fork"') &&
        e.text.includes(`You are now @${src.name}`)
    )
    start = byContent >= 0 ? byContent + 1 : Math.min(src.forkedFrom.inheritedMessages, entries.length)
  }
  const tail = entries.slice(start)
  const raw = renderTranscript(tail, { maxChars: 400_000 })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const mergesDir = path.join(agentBrainDir(root, dst.name), 'merges')
  fs.mkdirSync(mergesDir, { recursive: true })
  const rawFile = path.join(mergesDir, `${stamp}-${src.name}.md`)
  fs.writeFileSync(rawFile, `# Transcript of @${src.name} merged into @${dst.name} (${tail.length} entries after the fork point)\n\n${raw}\n`)
  const memo = raw.length > 12_000 ? await summarize(raw, src.name, dst.name) : raw

  // 3-way merge of memory.md (base = parent memory at fork time).
  const dstMem = path.join(agentBrainDir(root, dst.name), 'memory.md')
  const srcMem = path.join(agentBrainDir(root, src.name), 'memory.md')
  const baseFile = path.join(agentStateDir(src.name), 'fork-base-memory.md')
  const base = fs.existsSync(baseFile) ? baseFile : (() => { const f = path.join(stateDir(), 'empty.md'); fs.writeFileSync(f, ''); return f })()
  let conflicts = false
  if (fs.existsSync(srcMem)) {
    const r = spawnSync('git', ['merge-file', '-p', '-L', dst.name, '-L', 'fork-base', '-L', src.name, dstMem, base, srcMem], { encoding: 'utf8' })
    if (r.status !== null && r.status >= 0 && r.stdout) { fs.writeFileSync(dstMem, r.stdout); conflicts = r.status > 0 }
  }
  fs.appendFileSync(path.join(agentBrainDir(root, dst.name), 'journal.md'), `- ${new Date().toISOString().slice(0, 10)}: merged @${src.name} (${tail.length} entries; raw: merges/${path.basename(rawFile)}).\n`)
  commitBrain(root, `Merge @${src.name} into @${dst.name}`)

  await queueSystemPrompt(root, dst.name, `merge-${src.name}`,
    `<office-merge from="${src.name}" into="${dst.name}" entries="${tail.length}" raw="${rawFile}">\n${memo}\n</office-merge>\n` +
    `<office-system kind="merge">The block above is the experience of @${src.name}${src.forkedFrom?.parent === dst.name ? ', your fork, since the fork point' : ''}. ` +
    `Integrate it as your OWN experience: you now know what @${src.name} knew and you inherit its open commitments (threads, tickets). ` +
    `Your memory.md was 3-way merged with @${src.name}'s${conflicts ? ' and has CONFLICT MARKERS — resolve them now' : ''}. ` +
    `Take over any unfinished work or hand it off explicitly. No chat post is needed unless something is pending.</office-system>`)
  console.log(`merged @${src.name} → @${dst.name}: ${tail.length} entries, memo ${memo.length} chars${conflicts ? ', memory conflicts' : ''}`)

  if (flags.keep !== true) {
    await stopAgent(src)
    await retireAgentIdentity(src.name).catch(e => console.log(`retire identity: ${(e as Error).message}`))
    src.status = 'retired'; await saveAgent(src)
    console.log(`@${src.name} retired`)
  }
}

async function cmdShift(pos: string[], flags: Record<string, string | boolean>) {
  const rec = await agent(slug(pos[0] ?? ''))
  const ready = path.join(agentStateDir(rec.name), 'shift-ready')
  fs.rmSync(ready, { force: true })
  await queueSystemPrompt(root, rec.name, 'shift',
    '<office-system kind="shift-change">Shift change. Update your memory.md (curated, deduplicated) and journal.md with anything worth keeping from this session, commit the brain, then call office_shift_ready. Your session will be restarted fresh.</office-system>')
  const timeoutMs = Number(str(flags.timeout) ?? 600) * 1000
  const end = Date.now() + timeoutMs
  process.stdout.write(`waiting for @${rec.name} to call office_shift_ready`)
  while (!fs.existsSync(ready) && Date.now() < end) { await sleep(3000); process.stdout.write('.') }
  console.log(fs.existsSync(ready) ? ' ready' : ' timeout — restarting anyway')
  await stopAgent(rec)
  if (rec.sessionId) rec.pastSessions.push(rec.sessionId)
  rec.sessionId = undefined
  await saveAgent(rec)
  await queueSystemPrompt(root, rec.name, 'new-shift', '<office-system kind="new-shift">New shift. Your persona and memory are loaded from the brain. Check ticket_list(assignee=you) for open work; otherwise wait for events.</office-system>')
  await startAgent(rec)
}

async function cmdSay(pos: string[], flags: Record<string, string | boolean>) {
  const secrets = await loadSecrets()
  if (!secrets) throw new Error('run `office init` first')
  const mm = new MattermostClient(cfg.mattermostUrl, secrets.mattermost.adminToken)
  const team = await mm.getTeamByName(cfg.team)
  const ch = await mm.getChannelByName(team.id, str(flags.channel) ?? 'office')
  const post = await mm.createPost({ channelId: ch.id, message: pos.join(' '), rootId: str(flags.thread) })
  console.log(`posted ${post.id} in #${ch.name} as @${cfg.human.username}`)
}

async function projectAdminClients() {
  const secrets = await loadSecrets()
  if (!secrets) throw new Error('run `office init` first')
  const mm = new MattermostClient(cfg.mattermostUrl, secrets.mattermost.adminToken)
  const fj = new ForgejoClient(cfg.forgejoUrl, secrets.forgejo.adminToken)
  const team = await mm.getTeamByName(cfg.team)
  return { mm, fj, team, secrets }
}

function parseCommaList(v: string | boolean | undefined): string[] {
  if (typeof v !== 'string' || !v.trim()) return []
  return v.split(',').map(s => s.trim()).filter(Boolean)
}

async function cmdProjectNew(pos: string[], flags: Record<string, string | boolean>) {
  const name = slug(pos[0] ?? '')
  const valid = validateProjectName(name)
  if (!valid.ok) throw new Error(valid.reason)
  if (await loadProject(root, name)) throw new Error(`project ${name} already exists`)
  const description = str(flags.desc) ?? ''
  if (!description.trim()) throw new Error('usage: office project new <name> --desc "..." [--members a,b]')
  const members = parseCommaList(flags.members)
  const { mm, fj, team, secrets } = await projectAdminClients()

  // Create repo with the same labels as office/tasks and branch protection on main.
  const repo = await fj.createOrgRepo(cfg.forgejoOrg, name, { autoInit: true })
  await fj.ensureLabels(cfg.forgejoOrg, name, [
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
  await fj.createBranchProtection(cfg.forgejoOrg, name, 'main')

  // Create public project channel and add owner + members.
  const channelName = `proj-${name}`
  let channel: { id: string; name: string }
  try {
    channel = await mm.getChannelByName(team.id, channelName)
  } catch {
    channel = await mm.createChannel({ teamId: team.id, name: channelName, displayName: channelName, purpose: `Project ${name}: ${description}`, type: 'O' })
  }
  for (const username of [cfg.human.username, ...members]) {
    try {
      const u = await mm.getUserByUsername(username)
      await mm.addToChannel(channel.id, u.id)
    } catch (e) {
      console.log(`warning: could not add @${username} to #${channelName}: ${(e as Error).message}`)
    }
  }
  // Ensure the office admin bot can post dispatcher announcements in the project channel.
  if (secrets.officeBot?.userId) {
    try { await mm.addToChannel(channel.id, secrets.officeBot.userId) } catch { /* already in channel */ }
  }

  // Seed project knowledge in the brain repo.
  ensureBrain(root)
  const pdir = projectBrainDir(root, name)
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, 'README.md'), `# Project ${name}\n\n${description}\n\n- Repo: ${cfg.forgejoOrg}/${name}\n- Channel: #${channelName}\n- Members: ${[cfg.human.username, ...members].join(', ')}\n\n## Conventions\n\n(Add team conventions here as the project grows.)\n`)
  commitBrain(root, `Create project ${name}`)

  const createdBy = str(flags['created-by'])
  const record = {
    name, description, repo: `${cfg.forgejoOrg}/${name}`, channel: channelName,
    members: [...members], createdAt: new Date().toISOString(),
    ...(createdBy ? { createdBy } : {}),
  }
  await saveProject(root, record)
  console.log(`project ${name} created: ${repo.html_url}  #${channelName}`)
}

async function cmdProjectList() {
  const projects = await listProjects(root)
  if (!projects.length) { console.log('no projects'); return }
  console.log(projects.map(p => `${p.archived ? '[archived] ' : ''}${p.name}: ${p.description}  repo=${p.repo}  channel=#${p.channel}  members=${p.members.join(', ') || '(none)'}`).join('\n'))
}

async function cmdProjectStaff(pos: string[], flags: Record<string, string | boolean>) {
  const name = slug(pos[0] ?? '')
  const p = await loadProject(root, name)
  if (!p) throw new Error(`project ${name} not found`)
  if (p.archived) throw new Error(`project ${name} is archived`)
  const { mm, team } = await projectAdminClients()
  const channel = await mm.getChannelByName(team.id, p.channel)

  const add = parseCommaList(flags.add)
  const remove = parseCommaList(flags.remove)
  if (!add.length && !remove.length) {
    console.log(`members of ${name}: ${[cfg.human.username, ...p.members].join(', ')}`)
    return
  }

  for (const username of add) {
    if (p.members.includes(username)) continue
    try {
      const u = await mm.getUserByUsername(username)
      await mm.addToChannel(channel.id, u.id)
      p.members.push(username)
    } catch (e) {
      console.log(`warning: could not add @${username}: ${(e as Error).message}`)
    }
  }
  for (const username of remove) {
    if (!p.members.includes(username)) continue
    try {
      const u = await mm.getUserByUsername(username)
      await mm.removeFromChannel(channel.id, u.id)
    } catch { /* ignore */ }
    p.members = p.members.filter(m => m !== username)
  }
  await saveProject(root, p)
  console.log(`updated members of ${name}: ${[cfg.human.username, ...p.members].join(', ')}`)
}

async function cmdProjectArchive(pos: string[]) {
  const name = slug(pos[0] ?? '')
  const p = await loadProject(root, name)
  if (!p) throw new Error(`project ${name} not found`)
  const { fj } = await projectAdminClients()
  await fj.archiveRepo(cfg.forgejoOrg, name)
  p.archived = true
  await saveProject(root, p)
  console.log(`project ${name} archived (repo ${p.repo})`)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parseArgs(rest)
  const targets = async () => (flags.all === true || !pos.length ? (await allAgents()).filter(a => a.status === 'hired') : await Promise.all(pos.map(n => agent(slug(n)))))
  switch (cmd) {
    case 'init': await bootstrap(); ensureBrain(root); console.log('office initialised'); break
    case 'up': await ensureInfra(); break
    case 'setup': await runSetup(root, flags); break
    case 'vault': await cmdVault(root, cfg.resourceGroups, pos); break
    case 'group': {
      const deps: GroupDeps = {
        root, cfg,
        saveConfig,
        agents: allAgents,
        saveAgent,
        stopAgent,
        startAgent: async (rec) => startAgent(await agent(rec.name)),
        claudeAuthStatus: (dir) => {
          const info = readClaudeAccountInfo(dir)
          return info ? { loggedIn: info.loggedIn } : undefined
        },
        runClaudeLogin: (dir) => spawnSync('claude', ['auth', 'login'], { stdio: 'inherit', env: { ...process.env, ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}) } }).status ?? 1,
        isTTY: !!process.stdin.isTTY,
        log: console.log,
      }
      await cmdGroup(pos, flags, deps)
      break
    }
    case 'export': await cmdExport(pos); break
    case 'import': await cmdImport(pos, flags); break
    case 'shutdown': await shutdownOffice(); break
    case 'hire': await cmdHire(pos, flags); break
    case 'start': await ensureInfra(); await ensureAdminDaemon(); for (const a of await targets()) await startAgent(a); break
    case 'stop': for (const a of await targets()) await stopAgent(a); break
    case 'restart': for (const a of await targets()) { await stopAgent(a); await startAgent(await agent(a.name)) } break
    case 'status': await cmdStatus(flags); break
    case 'inspect':
    case 'peek': await cmdInspect(pos); break
    case 'activity': await cmdActivity(pos, flags); break
    case 'finance': await cmdFinance(pos); break
    case 'admin': await runAdminDaemon(); break
    case 'admin-stop': await stopAdminDaemon(); break
    case 'attach': execFileSync('tmux', ['attach', '-t', pos[0] ? windowTarget(cfg.tmuxSession, pos[0]) : cfg.tmuxSession], { stdio: 'inherit' }); break
    case 'fork': await cmdFork(pos, flags); break
    case 'merge': await cmdMerge(pos, flags); break
    case 'shift': await cmdShift(pos, flags); break
    case 'model': {
      const a = await agent(slug(pos[0] ?? ''))
      const model = pos[1]
      if (!model) throw new Error('usage: office model <agent> <model>')
      if (a.harness === 'opencode' && !model.includes('/')) throw new Error('opencode models look like provider/model, e.g. opencode-go/deepseek-v4-pro')
      if (a.harness === 'claude' && model.includes('/')) throw new Error('claude models are aliases like sonnet, opus, haiku (or a full claude-* id)')
      const old = a.model
      a.model = model
      if (a.group && checkGroupForAgent(a, a.group, cfg.resourceGroups)) {
        const oldGroup = a.group
        a.group = undefined
        console.log(`@${a.name}: group ${oldGroup} no longer fits ${model} — now using ${groupIdForAgent(a, cfg.resourceGroups) ?? 'no group'}`)
      }
      await saveAgent(a)
      console.log(`@${a.name}: model ${old} → ${model}; restarting (same session)`)
      await stopAgent(a); await startAgent(await agent(a.name))
      break
    }
    case 'retire': { const a = await agent(slug(pos[0] ?? '')); await stopAgent(a); await retireAgentIdentity(a.name); a.status = 'retired'; await saveAgent(a); console.log(`@${a.name} retired`); break }
    case 'freeze': fs.writeFileSync(path.join(stateDir(), 'freeze'), new Date().toISOString()); console.log('office frozen: only human messages are delivered, agent posts refused'); break
    case 'unfreeze': fs.rmSync(path.join(stateDir(), 'freeze'), { force: true }); console.log('office unfrozen'); break
    case 'say': await cmdSay(pos, flags); break
    case 'logs': execFileSync('tail', ['-n', str(flags.n) ?? '50', path.join(agentStateDir(slug(pos[0] ?? '')), 'mcp.log')], { stdio: 'inherit' }); break
    case 'prompt': await queueSystemPrompt(root, slug(pos[0] ?? ''), 'manual', pos.slice(1).join(' ')); console.log('queued'); break
    case 'project': {
      const sub = pos[0]
      const rest = pos.slice(1)
      switch (sub) {
        case 'new': await cmdProjectNew(rest, flags); break
        case 'list': await cmdProjectList(); break
        case 'staff': await cmdProjectStaff(rest, flags); break
        case 'archive': await cmdProjectArchive(rest); break
        default: throw new Error('usage: office project new|list|staff|archive ...')
      }
      break
    }
    default:
      console.log(`office <command>
  setup [--import dir] [--force]  guided first run / reconfigure: owner, access address, API keys, Claude login
  init                         bring up Mattermost + Forgejo, create owner, team, channels, brain
  up                           docker compose up -d
  hire <name> [--harness claude|opencode] [--model M] [--focus "..."] [--display N] [--chrome] [--group <id|auto>] [--no-start]
  start|stop|restart [names…]  manage agent sessions (tmux session "${cfg.tmuxSession}")
  admin                        run the #office-admin chat-ops daemon in the foreground
  admin-stop                   stop the admin daemon window
  status [--md] [--all]        agents, windows, idle/busy, pending prompts, context, alerts
  inspect|peek <agent>         deep report on one agent (pane, log, pending, posts, work)
  activity [--minutes N] [N]   timeline of agent + owner posts and ticket/PR events
  finance [today|week|limits|<agent>|<group>]  resource-group usage/cost + rolling-window limits report
  attach [name]                open the tmux session (watch / talk to agents directly)
  fork <agent> [--name N] [--task "..."]    clone an agent's live session into a new colleague
  merge <src> [--into dst] [--keep]         replay src's experience into dst's session + merge memory
  shift <agent>                memory write-back, then fresh session
  model <agent> <model>        switch the agent's model (e.g. sonnet, opus, opencode-go/deepseek-v4-pro) and restart it in the same session
  retire <agent>               stop and deactivate
  freeze | unfreeze            stop agent chatter (only the owner's messages get through)
  say <text> [--channel c] [--thread id]    post as the owner (testing)
  prompt <agent> <text>        queue a raw prompt for an agent
  project new <name> --desc "..." [--members a,b]
                               create a new project repo, channel and brain folder
  project list                 list projects
  project staff <name> [--add a,b] [--remove c]
                               update project members and channel membership
  project archive <name>       archive the project repo
  logs <agent> [--n 50]        office-mcp log
  vault [status|set <id>|rm <id>|check|import-opencode]
                               encrypted provider API keys, injected into agents as env vars
  group [list|add <kind> --id X [--label L]|rm <id>|login <id>|move <agent> <group>]
                               resource groups (Claude subscriptions, OpenCode Go / OpenRouter keys)
  export [dir]                 stop the office and bundle it (chat, tickets, state, brain, workspaces) to move machines
  import <dir> [--force]       restore a bundle here; agents continue in fresh sessions
  shutdown                     stop all agent sessions and the admin daemon (the stack keeps running)`)
  }
}

main().then(() => process.exit(0), e => { console.error(`error: ${(e as Error).message}`); process.exit(1) })
