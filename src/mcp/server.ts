// office-mcp: one instance per agent, spawned by the agent's harness over stdio.
// Tools: chat_* (Mattermost), ticket_* (Forgejo), office_*.
// Background: listens to Mattermost (WebSocket) + Forgejo notifications, applies the
// delivery policy and wakes the agent's live session through its wake adapter.
// Env: OFFICE_ROOT, OFFICE_AGENT, optional OFFICE_WAKE=channel (Claude channels, if the org allows them).
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { AgentRecord, ChatPost, InboundEvent, OfficeRequest, RequestType, WakeAdapter, WatchMode } from '../lib/types.js'
import { agentStateDir, listAgents, loadAgent, loadConfig, repoRoot, stateDir } from '../lib/config.js'
import { MattermostClient } from '../lib/mattermost.js'
import { ForgejoClient } from '../lib/forgejo.js'
import { isProjectMember, listProjects, loadProject, saveProject } from '../lib/projects.js'
import {
  checkAttachmentSize,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  resolveInWorkspace,
  sanitizeAttachmentFilename,
  workspaceDir,
} from '../lib/workspace.js'
import { DeliveryQueue, PostGuard, channelTypeOf, classifyPost, renderDigest, renderEvents, type AgentContext } from './policy.js'
import { ClaudeTmuxWakeAdapter } from '../lib/harness/claude.js'
import { OpencodeWakeAdapter } from '../lib/harness/opencode.js'
import { ensureInboxKey, queueSystemPrompt, verifyPrompt } from '../lib/inbox.js'
import { buildRequest, listRequests, loadRequest, setRequestStatus, writeRequest } from '../lib/requests.js'
import { formatProjectCreatedNotice, validateProjectRequest } from '../lib/project-requests.js'

const agentName = process.env.OFFICE_AGENT
if (!agentName) throw new Error('OFFICE_AGENT is not set')
const cfg = await loadConfig()
const root = repoRoot()
const must = (r: AgentRecord | undefined) => { if (!r) throw new Error(`no such agent: ${agentName}`); return r }
let rec: AgentRecord = must(await loadAgent(agentName))
const dir = agentStateDir(agentName)
const logFile = path.join(dir, 'mcp.log')
const log = (m: string) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`) } catch { /* ignore */ } }

const mm = new MattermostClient(cfg.mattermostUrl, rec.mattermost.token)
const fj = new ForgejoClient(cfg.forgejoUrl, rec.forgejo.token)
const defaultRepo = `${cfg.forgejoOrg}/${cfg.ticketsRepo}`

// ------------------------------------------------------------------ persisted per-agent state
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T } catch { return d } }
const writeJson = (f: string, v: unknown) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${f}.tmp`, f) }
const watchFile = path.join(dir, 'watch.json')
const threadsFile = path.join(dir, 'threads.json')
const watch: Record<string, WatchMode> = readJson(watchFile, {})
const threads = new Set<string>(readJson<string[]>(threadsFile, []))
const rememberThread = (id: string) => {
  if (threads.has(id)) return
  threads.add(id)
  writeJson(threadsFile, [...threads].slice(-2000))
}
// Undelivered events survive MCP restarts (session restart, shift change).
const pendingFile = path.join(dir, 'pending.json')
const pending = new Map<string, InboundEvent>(readJson<InboundEvent[]>(pendingFile, []).map(e => [e.id, e]))
const savePending = () => writeJson(pendingFile, [...pending.values()])
// Newest post time seen, so a restarted MCP can catch up on what it missed.
const seenFile = path.join(dir, 'last-seen.json')
let lastSeen = readJson<{ at: number }>(seenFile, { at: 0 }).at
const markSeen = (at: number) => { if (at > lastSeen) { lastSeen = at; writeJson(seenFile, { at }) } }
const freezeFile = path.join(stateDir(), 'freeze')
const isFrozen = () => fs.existsSync(freezeFile)

// ------------------------------------------------------------------ platform context
const me = await mm.me()
const team = await mm.getTeamByName(cfg.team)
const humans = [cfg.human.username]
const systemUsernames = cfg.systemUsernames ?? []
const ctx = (): AgentContext => ({
  username: me.username, userId: me.id, humanUsernames: humans, systemUsernames,
  agentChannelPrefix: cfg.agentChannelPrefix,
  watch, defaultWatch: 'digest', participatedThreads: threads,
})
const queue = new DeliveryQueue({ digestMinutes: cfg.defaults.digestMinutes })
async function enqueue(ev: InboundEvent) {
  if (pending.has(ev.id)) return
  pending.set(ev.id, ev) // reserve the slot before the (possibly slow) download
  savePending()
  await resolveEventAttachments(ev)
  queue.push(ev)
  savePending()
}
function delivered(evs: InboundEvent[]) { for (const e of evs) pending.delete(e.id); savePending() }

// ---- room requests: the owner asked everyone. Agents get them staggered (fair, per-post order);
// before delivery we check whether a colleague already claimed it (reaction) or answered.
const ROOM_STAGGER_MS = 20_000
const HUMAN_BURST_MS = 8_000
const roomWait = new Map<string, { ev: InboundEvent; dueAt: number }>()
let lastHumanPostAt = 0
let colleagues: string[] = [rec.name]
async function refreshColleagues() {
  try {
    const recs = (await Promise.all((await listAgents()).map(n => loadAgent(n)))).filter(Boolean) as AgentRecord[]
    colleagues = recs.filter(r => r.status === 'hired').map(r => r.name)
    if (!colleagues.includes(rec.name)) colleagues.push(rec.name)
  } catch { /* keep previous */ }
}
function staggerFor(postId: string): number {
  const rank = [...colleagues]
    .sort((a, b) => createHash('sha256').update(postId + a).digest('hex').localeCompare(createHash('sha256').update(postId + b).digest('hex')))
    .indexOf(rec.name)
  return Math.max(0, rank) * ROOM_STAGGER_MS
}
function holdRoom(ev: InboundEvent) {
  if (pending.has(ev.id) || roomWait.has(ev.id)) return
  pending.set(ev.id, ev); savePending()
  roomWait.set(ev.id, { ev, dueAt: Date.parse(ev.at) + HUMAN_BURST_MS + staggerFor(ev.postId ?? ev.id) })
}
/** Who (other than the owner and me) already took this post: an agent reaction or reply. */
async function claimedBy(postId: string): Promise<string | undefined> {
  const reactions = await mm.getReactions(postId).catch(() => [])
  for (const r of reactions) {
    if (r.user_id === me.id) continue
    const u = await mm.getUser(r.user_id).catch(() => undefined)
    if (u && !humans.includes(u.username)) return u.username
  }
  const thread = await mm.getPostThread(postId).catch(() => [] as ChatPost[])
  const reply = thread.find(p => p.id !== postId && p.userId !== me.id && !humans.includes(p.username))
  return reply?.username
}
async function releaseRooms() {
  const now = Date.now()
  for (const [id, { ev, dueAt }] of roomWait) {
    if (dueAt > now) continue
    roomWait.delete(id)
    const taker = await claimedBy(ev.postId ?? '')
    if (taker) {
      ev.kind = 'digest-item'
      ev.note = `already taken by @${taker}`
    } else {
      ev.note = 'Owner asked the room (nobody addressed). If you are a good fit, FIRST chat_react with "eyes" on this post_id to claim it, then do the work and chat_reply in the thread. If you are not a good fit, do nothing: a colleague will take it.'
    }
    await resolveEventAttachments(ev)
    queue.push(ev)
    log(`room ${id} released as ${ev.kind}${taker ? ` (taken by ${taker})` : ''}`)
  }
}
const guard = new PostGuard(cfg.limits)
const maxAttachmentBytes = cfg.attachments?.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES

/** Download one inbound attachment into workspaces/<agent>/attachments/<post_id>/<safe-name>, or mark it skipped. */
async function downloadAttachment(
  postId: string,
  file: { id: string; name: string; size: number },
): Promise<{ path?: string; skipped?: string }> {
  const skipped = checkAttachmentSize(file.size, maxAttachmentBytes)
  if (skipped) return { skipped }
  try {
    const destDir = path.join(workspaceDir(root, rec.name), 'attachments', postId)
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, sanitizeAttachmentFilename(file.name))
    const data = await mm.downloadFile(file.id)
    fs.writeFileSync(dest, data)
    return { path: dest }
  } catch (e) {
    return { skipped: `download failed: ${(e as Error).message}` }
  }
}

/** Resolve attachments in place (download unless the event only feeds the digest). */
async function resolveEventAttachments(ev: InboundEvent): Promise<void> {
  if (!ev.attachments?.length || ev.kind === 'digest-item') return
  await Promise.all(
    ev.attachments.map(async (a) => {
      Object.assign(a, await downloadAttachment(ev.postId ?? ev.id, a))
    }),
  )
}

async function channelByName(name: string) {
  const clean = name.replace(/^[#~]/, '')
  return mm.getChannelByName(team.id, clean)
}
const kindOf = (ch: { name: string; type: string }) => channelTypeOf(ch.name, ch.type, cfg.agentChannelPrefix)

async function threadAuthors(rootId: string) {
  const posts = await mm.getPostThread(rootId)
  return posts.map(p => ({ username: p.username, isHuman: humans.includes(p.username) }))
}

function fmtPost(p: ChatPost): string {
  const t = new Date(p.createAt).toISOString().slice(0, 16).replace('T', ' ')
  const files = p.files?.length ? ` files: ${p.files.map((f) => `${f.name} (${f.id})`).join(', ')}` : ''
  return `[${t}] @${p.username} (post_id=${p.id}${p.rootId ? ` thread_id=${p.rootId}` : ''}): ${p.message}${files}`
}

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${msg}` }], isError: true })
const guarded = <A>(fn: (a: A) => Promise<ReturnType<typeof ok>>) => async (a: A) => {
  try { return await fn(a) } catch (e) { log(`tool error: ${(e as Error).message}`); return fail((e as Error).message) }
}

async function postGuarded(p: { channelId: string; channelType: 'mixed' | 'agent-only' | 'dm'; text: string; rootId?: string; fileIds?: string[] }) {
  const verdict = guard.check({
    text: p.text, channelType: p.channelType, frozen: isFrozen(), hasAttachment: (p.fileIds?.length ?? 0) > 0,
    threadAuthors: p.rootId ? await threadAuthors(p.rootId) : undefined,
  })
  if (!verdict.ok) return fail(verdict.reason)
  const post = await mm.createPost({ channelId: p.channelId, message: p.text, rootId: p.rootId, fileIds: p.fileIds })
  guard.record(p.text)
  rememberThread(p.rootId || post.id)
  return ok({ post_id: post.id, thread_id: p.rootId || post.id, ...(p.fileIds?.length ? { file_id: p.fileIds[0] } : {}) })
}

function parseRepo(repo?: string): [string, string] {
  const [owner, name] = (repo || defaultRepo).split('/')
  if (!owner || !name) throw new Error(`repo must look like "owner/name", got "${repo}"`)
  return [owner, name]
}

// ------------------------------------------------------------------ MCP server + tools
const useChannel = process.env.OFFICE_WAKE === 'channel'
const server = new McpServer({ name: 'office', version: '0.1.0' }, {
  capabilities: useChannel ? { experimental: { 'claude/channel': {} } } : {},
  instructions:
    `Office tools for @${me.username}. Events reach you as <office-events>/<office-digest> blocks in your session. ` +
    'Answer in threads with chat_reply(thread_id). Tickets live in Forgejo (ticket_*). Guards reject ack-only, duplicate, too-frequent or runaway-thread posts: read the error and adapt.',
})

server.registerTool('chat_post', {
  description: 'Post a NEW message (starts a thread) in a channel. Use chat_reply to answer inside an existing thread.',
  inputSchema: { channel: z.string().describe('channel name, e.g. "office" or "ag-lobby"'), text: z.string() },
}, guarded(async ({ channel, text }) => {
  const ch = await channelByName(channel)
  return postGuarded({ channelId: ch.id, channelType: kindOf(ch), text })
}))

server.registerTool('chat_reply', {
  description: 'Reply inside a thread (thread_id or any post_id in it).',
  inputSchema: { thread_id: z.string(), text: z.string() },
}, guarded(async ({ thread_id, text }) => {
  const post = await mm.getPost(thread_id)
  const rootId = post.rootId || post.id
  const ch = await mm.getChannel(post.channelId)
  return postGuarded({ channelId: ch.id, channelType: kindOf(ch), text, rootId })
}))

server.registerTool('chat_dm', {
  description: 'Send a direct message to a user or agent (username without @).',
  inputSchema: { user: z.string(), text: z.string() },
}, guarded(async ({ user, text }) => {
  const other = await mm.getUserByUsername(user.replace(/^@/, ''))
  const ch = await mm.createDirectChannel(me.id, other.id)
  return postGuarded({ channelId: ch.id, channelType: 'dm', text })
}))

server.registerTool('chat_read', {
  description: 'Read recent messages of a channel (oldest first).',
  inputSchema: { channel: z.string(), limit: z.number().int().min(1).max(200).optional(), since_minutes: z.number().optional() },
}, guarded(async ({ channel, limit, since_minutes }) => {
  const ch = await channelByName(channel)
  const since = since_minutes ? Date.now() - since_minutes * 60_000 : undefined
  const posts = await mm.getChannelPosts(ch.id, { since, perPage: limit ?? 30 })
  return ok(posts.slice(-(limit ?? 30)).map(fmtPost).join('\n') || '(no messages)')
}))

server.registerTool('chat_thread', {
  description: 'Read a whole thread (thread_id or any post_id in it).',
  inputSchema: { thread_id: z.string() },
}, guarded(async ({ thread_id }) => ok((await mm.getPostThread(thread_id)).map(fmtPost).join('\n'))))

server.registerTool('chat_search', {
  description: 'Search messages across the office (Mattermost search syntax, e.g. "from:ada in:office deploy").',
  inputSchema: { terms: z.string() },
}, guarded(async ({ terms }) => ok((await mm.searchPosts(team.id, terms)).slice(0, 40).map(fmtPost).join('\n') || '(no results)')))

server.registerTool('chat_channels', {
  description: 'List channels: which you are in, their kind (mixed / agent-only) and your watch mode.',
  inputSchema: {},
}, guarded(async () => {
  const mine = await mm.getChannelsForUser(team.id)
  const pub = await mm.getPublicChannels(team.id)
  const joined = new Set(mine.map(c => c.id))
  const rows = [...mine.filter(c => c.type === 'O' || c.type === 'P'), ...pub.filter(c => !joined.has(c.id))].map(c => ({
    name: c.name, kind: kindOf(c), joined: joined.has(c.id), watch: joined.has(c.id) ? (watch[c.name] ?? 'digest') : undefined, purpose: c.purpose,
  }))
  return ok(rows)
}))

server.registerTool('chat_create_channel', {
  description: `Create a public channel and join it. kind "agent-only" gets the "${cfg.agentChannelPrefix}" prefix (the owner reads but does not post); "mixed" is for humans + agents.`,
  inputSchema: { name: z.string(), purpose: z.string(), kind: z.enum(['agent-only', 'mixed']) },
}, guarded(async ({ name, purpose, kind }) => {
  let slug = name.toLowerCase().replace(/^[#~]/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const pre = cfg.agentChannelPrefix
  if (kind === 'agent-only' && !slug.startsWith(pre)) slug = pre + slug
  if (kind === 'mixed' && slug.startsWith(pre)) slug = slug.slice(pre.length)
  const ch = await mm.createChannel({ teamId: team.id, name: slug, displayName: slug, purpose: `${kind === 'agent-only' ? 'Agent-only' : 'Mixed'}: ${purpose}`, type: 'O' })
  await mm.addToChannel(ch.id, me.id).catch(() => {})
  return ok({ channel: ch.name, kind })
}))

server.registerTool('chat_join', {
  description: 'Join a channel and choose how you follow it: all (wake on every message), digest (default, periodic summary), mentions (only @you).',
  inputSchema: { channel: z.string(), watch: z.enum(['all', 'digest', 'mentions']).optional() },
}, guarded(async ({ channel, watch: mode }) => {
  const ch = await channelByName(channel)
  await mm.addToChannel(ch.id, me.id)
  watch[ch.name] = mode ?? 'digest'
  writeJson(watchFile, watch)
  return ok({ joined: ch.name, watch: watch[ch.name] })
}))

server.registerTool('chat_leave', {
  description: 'Leave a channel.',
  inputSchema: { channel: z.string() },
}, guarded(async ({ channel }) => {
  const ch = await channelByName(channel)
  await mm.removeFromChannel(ch.id, me.id)
  delete watch[ch.name]; writeJson(watchFile, watch)
  return ok({ left: ch.name })
}))

server.registerTool('chat_watch', {
  description: 'Change how you follow a joined channel: all | digest | mentions.',
  inputSchema: { channel: z.string(), mode: z.enum(['all', 'digest', 'mentions']) },
}, guarded(async ({ channel, mode }) => {
  const ch = await channelByName(channel)
  watch[ch.name] = mode; writeJson(watchFile, watch)
  return ok({ channel: ch.name, watch: mode })
}))

server.registerTool('chat_react', {
  description: 'React to a post with an emoji name (e.g. "+1", "white_check_mark", "eyes"). Use instead of ack-only messages.',
  inputSchema: { post_id: z.string(), emoji: z.string() },
}, guarded(async ({ post_id, emoji }) => { await mm.addReaction(post_id, emoji.replace(/:/g, '')); return ok('reacted') }))

server.registerTool('chat_upload', {
  description:
    'Upload a file from YOUR OWN workspace and post it as an attachment, either as a new message in a channel or as a thread reply. ' +
    'text may be omitted when a file is attached. The path must resolve inside your workspace (no other agent\'s files, no state/ or brain/).',
  inputSchema: {
    path: z.string().describe('file path, absolute or relative to your workspace'),
    channel: z.string().optional().describe('post as a new message in this channel (mutually exclusive with thread_id)'),
    thread_id: z.string().optional().describe('reply in this thread instead of posting a new message'),
    text: z.string().optional(),
  },
}, guarded(async ({ path: filePath, channel, thread_id, text }) => {
  if (!channel && !thread_id) return fail('provide channel or thread_id')
  const real = resolveInWorkspace(root, rec.name, filePath)
  if (!real) return fail(`file not found or outside your workspace: ${filePath}`)
  let stat: fs.Stats
  try { stat = fs.statSync(real) } catch { return fail(`file not found: ${filePath}`) }
  if (!stat.isFile()) return fail('not a regular file')
  const tooLarge = checkAttachmentSize(stat.size, maxAttachmentBytes)
  if (tooLarge) return fail(`file too large: ${tooLarge}`)

  let channelId: string
  let channelType: 'mixed' | 'agent-only' | 'dm'
  let rootId: string | undefined
  if (thread_id) {
    const post = await mm.getPost(thread_id)
    rootId = post.rootId || post.id
    const ch = await mm.getChannel(post.channelId)
    channelId = ch.id; channelType = kindOf(ch)
  } else {
    const ch = await channelByName(channel!)
    channelId = ch.id; channelType = kindOf(ch)
  }

  const fileId = await mm.uploadFile(channelId, path.basename(real), fs.readFileSync(real))
  return postGuarded({ channelId, channelType, text: text ?? '', rootId, fileIds: [fileId] })
}))

server.registerTool('chat_download', {
  description: 'Download a file by file_id (see the "files:" list on chat_thread/chat_read output) into your workspace. Returns the local path.',
  inputSchema: { file_id: z.string() },
}, guarded(async ({ file_id }) => {
  const info = await mm.getFileInfo(file_id)
  const tooLarge = checkAttachmentSize(info.size, maxAttachmentBytes)
  if (tooLarge) return fail(`file too large: ${tooLarge}`)
  const destDir = path.join(workspaceDir(root, rec.name), 'attachments', 'downloads')
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, sanitizeAttachmentFilename(info.name))
  fs.writeFileSync(dest, await mm.downloadFile(file_id))
  return ok({ path: dest, name: info.name, mime_type: info.mimeType, size: info.size })
}))

server.registerTool('office_directory', {
  description: 'Who works here: the human owner and all agents (harness, model, status, focus, projects).',
  inputSchema: {},
}, guarded(async () => {
  const recs = (await Promise.all((await listAgents()).map(n => loadAgent(n)))).filter(Boolean) as AgentRecord[]
  const projects = await listProjects(root)
  const memberProjects = (username: string) => projects.filter(p => !p.archived && p.members.includes(username)).map(p => p.name)
  const agents = recs.map(a => {
    let focus = ''
    try { focus = /Initial focus:\s*(.*)/.exec(fs.readFileSync(path.join(repoRoot(), 'brain/agents', a.name, 'persona.md'), 'utf8'))?.[1] ?? '' } catch { /* none */ }
    return { name: a.name, displayName: a.displayName, harness: a.harness, model: a.model, status: a.status, forkedFrom: a.forkedFrom?.parent, focus, projects: memberProjects(a.name) }
  })
  return ok({ human: cfg.human, agents })
}))

server.registerTool('office_shift_ready', {
  description: 'Call after a shift-change notice once memory.md / journal.md are updated and the brain is committed.',
  inputSchema: {},
}, guarded(async () => { fs.writeFileSync(path.join(dir, 'shift-ready'), new Date().toISOString()); return ok('shift ready — your session will be restarted fresh') }))

// ---- tickets
const repoArg = z.string().optional().describe(`"owner/name", default ${defaultRepo}`)
const projectArg = z.string().optional().describe('project name; resolves to its repo')

server.registerTool('ticket_create', {
  description: 'Create a ticket (Forgejo issue). Labels e.g. status/todo, kind/feature, kind/bug, kind/research. Use project or repo.',
  inputSchema: { title: z.string(), body: z.string(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional(), repo: repoArg, project: projectArg },
}, guarded(async ({ title, body, labels, assignees, repo, project }) => {
  const [o, r] = resolveRepo(repo, project)
  const issue = await fj.createIssue(o, r, { title, body, labels: labels ?? ['status/todo'], assignees })
  return ok(issue)
}))

server.registerTool('ticket_list', {
  description: 'List tickets. state: open|closed|all; filter by assignee username, labels, or text query. Use project or repo.',
  inputSchema: { state: z.enum(['open', 'closed', 'all']).optional(), assignee: z.string().optional(), labels: z.array(z.string()).optional(), query: z.string().optional(), repo: repoArg, project: projectArg },
}, guarded(async ({ state, assignee, labels, query, repo, project }) => {
  const [o, r] = resolveRepo(repo, project)
  return ok(await fj.listIssues(o, r, { state: state ?? 'open', assignee, labels, q: query }))
}))

server.registerTool('ticket_get', {
  description: 'Get a ticket with its comments. Use project or repo.',
  inputSchema: { number: z.number().int(), repo: repoArg, project: projectArg },
}, guarded(async ({ number, repo, project }) => {
  const [o, r] = resolveRepo(repo, project)
  return ok({ issue: await fj.getIssue(o, r, number), comments: await fj.listComments(o, r, number) })
}))

server.registerTool('ticket_comment', {
  description: 'Comment on a ticket (progress, evidence, questions). Mention people with @username. Use project or repo.',
  inputSchema: { number: z.number().int(), body: z.string(), repo: repoArg, project: projectArg },
}, guarded(async ({ number, body, repo, project }) => {
  const [o, r] = resolveRepo(repo, project)
  return ok(await fj.createComment(o, r, number, body))
}))

server.registerTool('ticket_update', {
  description: 'Update a ticket: state (open|closed), labels (replaces all), assignees (replaces all), title. Use project or repo.',
  inputSchema: { number: z.number().int(), state: z.enum(['open', 'closed']).optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional(), title: z.string().optional(), repo: repoArg, project: projectArg },
}, guarded(async ({ number, state, labels, assignees, title, repo, project }) => {
  const [o, r] = resolveRepo(repo, project)
  if (labels) await fj.setLabels(o, r, number, labels)
  return ok(await fj.editIssue(o, r, number, { state, assignees, title }))
}))

server.registerTool('ticket_claim', {
  description: 'Claim a ticket: assigns it to you and sets status/in-progress. Fails if someone else holds it. Use project or repo.',
  inputSchema: { number: z.number().int(), repo: repoArg, project: projectArg },
}, guarded(async ({ number, repo, project }) => {
  const [o, r] = resolveRepo(repo, project)
  const issue = await fj.getIssue(o, r, number) as { assignees?: { login: string }[] | null; labels?: { name: string }[] }
  const holders = (issue.assignees ?? []).map(a => a.login).filter(l => l !== me.username)
  if (holders.length) return fail(`already claimed by ${holders.join(', ')} — coordinate with them in the ticket or chat`)
  await fj.editIssue(o, r, number, { assignees: [me.username] })
  const labels = (issue.labels ?? []).map(l => l.name).filter(n => !n.startsWith('status/'))
  await fj.setLabels(o, r, number, [...labels, 'status/in-progress'])
  return ok({ claimed: number, by: me.username })
}))

// ------------------------------------------------------------------ self-management requests
async function hiredAgentsCount(): Promise<number> {
  const recs = (await Promise.all((await listAgents()).map(n => loadAgent(n)))).filter(Boolean) as AgentRecord[]
  return recs.filter(a => a.status === 'hired').length
}

async function liveForksCount(parent: string): Promise<number> {
  const recs = (await Promise.all((await listAgents()).map(n => loadAgent(n)))).filter(Boolean) as AgentRecord[]
  return recs.filter(a => a.status === 'hired' && a.forkedFrom?.parent === parent).length
}

async function writeAgentRequest(type: RequestType, args: Record<string, unknown>, status?: 'pending' | 'approved'): Promise<OfficeRequest> {
  const req = buildRequest(type, rec.name, args)
  if (status) req.status = status
  await writeRequest(root, req)
  return req
}

async function agentRequestNotice(req: OfficeRequest, outcome: string) {
  const text = `<office-system kind="request-update">Your ${req.type} request (${req.id}) is ${outcome}.` +
    (req.status === 'done' && req.result ? ` Result: ${req.result}` : '') +
    '</office-system>'
  await queueSystemPrompt(root, rec.name, `req-${req.id}`, text)
}

server.registerTool('office_fork_self', {
  description: 'Request to fork yourself into a new agent to do parallel work. Provide a concrete task.',
  inputSchema: { task: z.string(), name: z.string().optional() },
}, guarded(async ({ task, name }) => {
  const sm = cfg.selfManagement
  if (rec.forkedFrom) return fail('you are already a fork; forks cannot fork')
  if (await liveForksCount(rec.name) >= sm.maxForksPerAgent) return fail(`you already have ${sm.maxForksPerAgent} live forks`)
  if (await hiredAgentsCount() >= sm.maxAgents) return fail(`office is at the ${sm.maxAgents} agent limit`)
  const auto = sm.autoApproveFork[rec.harness]
  const req = await writeAgentRequest('fork', { task, name }, auto ? 'approved' : 'pending')
  return ok(`fork requested (${req.id}), ${auto ? 'auto-approved' : 'awaiting owner approval'}; you will get a system notice`)
}))

server.registerTool('office_fork_done', {
  description: 'Only for forks: request to merge back into your parent. Call this as your last action, then finish your turn.',
  inputSchema: { summary: z.string() },
}, guarded(async ({ summary }) => {
  if (!rec.forkedFrom) return fail('only forks can call office_fork_done')
  const auto = cfg.selfManagement.autoMergeOnDone
  const req = await writeAgentRequest('merge', { source: rec.name, target: rec.forkedFrom.parent, summary }, auto ? 'approved' : 'pending')
  return ok(`merge requested (${req.id}), ${auto ? 'auto-approved' : 'awaiting owner approval'}. Finish your turn and wait; you will get a system notice`)
}))

server.registerTool('office_request_shift', {
  description: 'Request a shift change (fresh session) when your context is heavy.',
  inputSchema: {},
}, guarded(async () => {
  if (!cfg.selfManagement.allowSelfShift) return fail('self shift is disabled')
  const req = await writeAgentRequest('shift', {}, 'approved')
  return ok(`shift requested (${req.id}), auto-approved; you will get a system notice`)
}))

server.registerTool('office_request_hire', {
  description: 'Request to hire a new colleague. Always needs owner approval.',
  inputSchema: {
    name: z.string(),
    harness: z.enum(['claude', 'opencode']),
    model: z.string().optional(),
    focus: z.string(),
    reason: z.string(),
  },
}, guarded(async ({ name, harness, model, focus, reason }) => {
  if (await hiredAgentsCount() >= cfg.selfManagement.maxAgents) return fail(`office is at the ${cfg.selfManagement.maxAgents} agent limit`)
  const req = await writeAgentRequest('hire', { name, harness, model, focus, reason }, 'pending')
  return ok(`hire requested (${req.id}), awaiting owner approval; you will get a system notice`)
}))

server.registerTool('office_create_project', {
  description: 'Create a new office project (repo + channel + registry). Provide a one-line reason.',
  inputSchema: {
    name: z.string(),
    description: z.string(),
    members: z.array(z.string()).optional(),
    reason: z.string(),
  },
}, guarded(async ({ name, description, members, reason }) => {
  const validation = await validateProjectRequest(
    { name, description, members, reason },
    cfg,
    () => listProjects(root),
    () => listRequests(root),
    rec.name,
  )
  if (!validation.ok) return fail(validation.reason)

  const memberSet = new Set(validation.args.members)
  memberSet.add(rec.name)
  const finalMembers = [...memberSet]
  const req = await writeAgentRequest('project', {
    name: validation.args.name,
    description: validation.args.description,
    members: finalMembers,
    reason: validation.args.reason,
  }, validation.status)

  if (validation.status === 'approved') {
    return ok(`project creation requested (${req.id}); you'll get a system notice with the repo URL in a few seconds`)
  }
  return ok(`project creation requested (${req.id}), awaiting owner approval; you will get a system notice`)
}))

server.registerTool('office_requests', {
  description: 'List your self-management requests and their status.',
  inputSchema: {},
}, guarded(async () => {
  const mine = (await listRequests(root)).filter(r => r.agent === rec.name)
  return ok(mine.map(r => ({ id: r.id, type: r.type, status: r.status, createdAt: r.createdAt, result: r.result })))
}))

// ------------------------------------------------------------------ projects + code workflow
function resolveRepo(repo?: string, project?: string): [string, string] {
  if (project) return [cfg.forgejoOrg, project]
  return parseRepo(repo)
}

server.registerTool('project_list', {
  description: 'List office projects with name, description, members, repo, channel, clone URL and whether you are a member.',
  inputSchema: {},
}, guarded(async () => {
  const projects = await listProjects(root)
  const cloneUrl = (name: string) => `${cfg.forgejoUrl.replace(/\/$/, '')}/${cfg.forgejoOrg}/${name}.git`
  return ok(projects.map(p => ({
    name: p.name,
    description: p.description,
    repo: p.repo,
    channel: p.channel,
    members: [cfg.human.username, ...p.members],
    clone_url: cloneUrl(p.name),
    is_member: !p.archived && p.members.includes(me.username),
    archived: p.archived ?? false,
  })))
}))

server.registerTool('project_join', {
  description: 'Join a project: add yourself to the registry and its channel.',
  inputSchema: { project: z.string() },
}, guarded(async ({ project }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  if (p.archived) return fail(`project ${project} is archived`)
  if (p.members.includes(me.username)) return fail(`you are already a member of ${project}`)
  const ch = await channelByName(p.channel)
  await mm.addToChannel(ch.id, me.id)
  p.members.push(me.username)
  await saveProject(root, p)
  return ok({ joined: project, channel: p.channel })
}))

server.registerTool('project_leave', {
  description: 'Leave a project: remove yourself from the registry and its channel.',
  inputSchema: { project: z.string() },
}, guarded(async ({ project }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  if (!p.members.includes(me.username)) return fail(`you are not a member of ${project}`)
  const ch = await channelByName(p.channel)
  await mm.removeFromChannel(ch.id, me.id)
  p.members = p.members.filter(m => m !== me.username)
  await saveProject(root, p)
  return ok({ left: project, channel: p.channel })
}))

server.registerTool('repo_clone', {
  description: 'Clone a project repo into your workspace (or fetch if already present). Returns the local path.',
  inputSchema: { project: z.string() },
}, guarded(async ({ project }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  const ws = workspaceDir(root, rec.name)
  const local = path.join(ws, project)
  const remote = `${cfg.forgejoUrl.replace(/\/$/, '')}/${cfg.forgejoOrg}/${project}.git`
  fs.mkdirSync(ws, { recursive: true })
  if (fs.existsSync(path.join(local, '.git'))) {
    execFileSync('git', ['fetch', '--all', '--prune'], { cwd: local, stdio: 'ignore' })
  } else {
    execFileSync('git', ['clone', '--quiet', remote, local], { cwd: ws, stdio: 'ignore' })
  }
  return ok({ project, local_path: local, remote })
}))

server.registerTool('pr_create', {
  description: 'Open a pull request in a project repo. Request reviewers by username. Body should include "Closes #<ticket>".',
  inputSchema: {
    project: z.string(),
    head: z.string(),
    base: z.string().optional(),
    title: z.string(),
    body: z.string(),
    reviewers: z.array(z.string()).optional(),
  },
}, guarded(async ({ project, head, base, title, body, reviewers }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  const [o, r] = p.repo.split('/')
  const pr = await fj.createPullRequest(o, r, { title, body, head, base })
  if (reviewers?.length) await fj.requestReviewers(o, r, pr.number, reviewers)
  return ok({ number: pr.number, title: pr.title, url: pr.html_url, head: pr.head.ref, base: pr.base.ref })
}))

server.registerTool('pr_list', {
  description: 'List pull requests in a project repo.',
  inputSchema: { project: z.string(), state: z.enum(['open', 'closed', 'all']).optional() },
}, guarded(async ({ project, state }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  const [o, r] = p.repo.split('/')
  const prs = await fj.listPullRequests(o, r, state)
  return ok(prs.map(pr => ({ number: pr.number, title: pr.title, state: pr.state, author: pr.user.login, head: pr.head.ref, base: pr.base.ref, url: pr.html_url })))
}))

server.registerTool('pr_get', {
  description: 'Get a pull request with reviews, requested reviewers and changed files.',
  inputSchema: { project: z.string(), number: z.number().int() },
}, guarded(async ({ project, number }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  const [o, r] = p.repo.split('/')
  const pr = await fj.getPullRequest(o, r, number)
  const [reviews, files] = await Promise.all([
    fj.listReviews(o, r, number),
    fj.listPullRequestFiles(o, r, number),
  ])
  const requested = pr.requested_reviewers ?? []
  const linkedIssues = Array.from(new Set((pr.body.match(/(^|\s)(?:closes|fixes|resolves|refs?)\s*#(\d+)/gi) ?? [])))
  return ok({
    number: pr.number, title: pr.title, body: pr.body, author: pr.user.login, state: pr.state,
    mergeable: pr.mergeable, head: pr.head, base: pr.base, url: pr.html_url,
    reviews: reviews.map(rv => ({ reviewer: rv.user.login, state: rv.state, body: rv.body })),
    requested_reviewers: requested.map(u => u.login),
    linked_issue_refs: linkedIssues,
    changed_files: files.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })),
  })
}))

server.registerTool('pr_diff', {
  description: 'Get the unified diff of a pull request, truncated to ~60k chars.',
  inputSchema: { project: z.string(), number: z.number().int() },
}, guarded(async ({ project, number }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  const [o, r] = p.repo.split('/')
  let diff = await fj.getPullRequestDiff(o, r, number)
  if (diff.length > 60_000) diff = diff.slice(0, 60_000) + '\n\n...[truncated: diff exceeds 60k chars]'
  return ok(diff)
}))

server.registerTool('pr_review', {
  description: 'Submit a PR review: APPROVE, REQUEST_CHANGES or COMMENT. You cannot APPROVE your own PR.',
  inputSchema: {
    project: z.string(),
    number: z.number().int(),
    event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    body: z.string(),
  },
}, guarded(async ({ project, number, event, body }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  const [o, r] = p.repo.split('/')
  const pr = await fj.getPullRequest(o, r, number)
  if (event === 'APPROVE' && pr.user.login === me.username) return fail('you cannot approve your own PR')
  const review = await fj.submitReview(o, r, number, event, body)
  return ok({ review_id: review.id, event, reviewer: review.user.login })
}))

server.registerTool('pr_merge', {
  description: 'Merge a PR (squash by default). Branch is deleted after merge. Surface Forgejo refusal if protection blocks it.',
  inputSchema: {
    project: z.string(),
    number: z.number().int(),
    method: z.enum(['squash', 'merge', 'rebase']).optional(),
  },
}, guarded(async ({ project, number, method }) => {
  const p = await loadProject(root, project)
  if (!p) return fail(`project ${project} not found`)
  const [o, r] = p.repo.split('/')
  try {
    await fj.mergePullRequest(o, r, number, method ?? 'squash')
    return ok({ merged: number, method: method ?? 'squash' })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('405') || msg.includes('required') || msg.includes('protection') || msg.includes('approv')) {
      return fail(`merge blocked: ${msg}`)
    }
    return fail(msg)
  }
}))

// ------------------------------------------------------------------ inbound → queue
function onPost(post: ChatPost, meta: { mentions: string[]; channelType: string; channelName: string; senderName: string }) {
  markSeen(post.createAt)
  if (post.userId === me.id) { rememberThread(post.rootId || post.id); return }
  const isHuman = humans.includes(post.username)
  if (isHuman && post.message.trim() === '!freeze') { fs.writeFileSync(freezeFile, new Date().toISOString()); log('frozen by human') }
  if (isHuman && post.message.trim() === '!unfreeze') { fs.rmSync(freezeFile, { force: true }); log('unfrozen by human') }
  const kind = channelTypeOf(meta.channelName, meta.channelType, cfg.agentChannelPrefix)
  const ev = classifyPost(ctx(), post, { ...meta, channelType: kind })
  // Agent replies in a shared thread only wake you when they @mention you; otherwise they go to the digest.
  if (ev && ev.kind === 'thread' && !ev.fromHuman) ev.kind = 'digest-item'
  if (isHuman) lastHumanPostAt = Date.now()
  if (ev && ev.kind === 'room') { holdRoom(ev); log(`holding room request ${ev.id} from ${ev.from}`); return }
  if (ev) { void enqueue(ev); log(`queued ${ev.kind} ${ev.id} from ${ev.from}`) }
}

async function pollTickets() {
  try {
    const notes = await fj.listNotifications({ unreadOnly: true })
    for (const n of notes) {
      const url: string = n.subject.html_url || n.subject.url || ''
      const num = Number(/\/(?:issues|pulls)\/(\d+)/.exec(url)?.[1] ?? 0)
      const from = n.subject.latest_comment_url
        ? await fj.latestCommentAuthor(n.subject.latest_comment_url).catch(() => undefined)
        : undefined
      const repo = n.repository.full_name ?? defaultRepo
      const isPull = n.subject.type === 'Pull'
      const text = isPull
        ? `PR ${repo}#${num}: "${n.subject.title ?? ''}" needs your attention (review requested / commented / approved / changes requested). Open it with pr_get.`
        : `${n.subject.type ?? 'Issue'} "${n.subject.title ?? ''}" (${n.subject.state ?? ''}) needs your attention. Open it with ticket_get.`
      const ev: InboundEvent = {
        kind: 'ticket', id: `fj:${n.id}:${n.updated_at}`, at: n.updated_at ?? new Date().toISOString(),
        from: from ?? 'forgejo', fromHuman: false,
        text,
        ticket: { repo, number: num, title: n.subject.title ?? '', url, reason: n.subject.type ?? 'notification' },
      }
      await enqueue(ev)
      log(`queued ticket ${ev.ticket?.repo}#${ev.ticket?.number} (${ev.id})`)
      await fj.markNotificationRead(n.id).catch((e) => log(`mark read failed: ${(e as Error).message}`))
    }
  } catch (e) { log(`ticket poll failed: ${(e as Error).message}`) }
}

// System prompts dropped by the office CLI (merge, shift, fork intro): verified by HMAC, then delivered in order.
const inboxDir = path.join(dir, 'inbox')
fs.mkdirSync(inboxDir, { recursive: true })
let inboxKey: Buffer | undefined
ensureInboxKey(repoRoot()).then(k => { inboxKey = k }).catch(e => log(`inbox key load failed: ${(e as Error).message}`))
function nextSystemPrompt(): { file: string; text: string } | undefined {
  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md')).sort()
  if (!files.length) return undefined
  const file = path.join(inboxDir, files[0])
  const raw = fs.readFileSync(file, 'utf8')
  if (!inboxKey) {
    log(`inbox key not ready; holding ${path.basename(file)}`)
    return undefined
  }
  const text = verifyPrompt(raw, inboxKey)
  if (text === undefined) {
    const rejected = `${file}.rejected`
    fs.renameSync(file, rejected)
    log(`rejected unsigned/invalid inbox file ${path.basename(file)} -> ${path.basename(rejected)}`)
    return undefined
  }
  return { file, text }
}

// ------------------------------------------------------------------ wake
function makeWake(): WakeAdapter {
  if (useChannel) {
    return {
      isIdle: async () => true, // Claude Code queues channel events itself
      isAlive: async () => true,
      deliver: async (text: string) => { await server.server.notification({ method: 'notifications/claude/channel', params: { content: text, meta: { source_kind: 'office' } } }) },
    }
  }
  if (rec.harness === 'claude') {
    return new ClaudeTmuxWakeAdapter({ tmuxSession: cfg.tmuxSession, agent: rec.name, statusFile: path.join(dir, 'status.json') })
  }
  // The desk session id changes on shift change: keep a fresh copy of the record.
  setInterval(() => { loadAgent(agentName!).then(r => { if (r) rec = r }).catch(() => {}) }, 5000)
  return new OpencodeWakeAdapter({ baseUrl: `http://127.0.0.1:${rec.opencodePort}`, sessionId: () => rec.sessionId })
}
const wake = makeWake()

let delivering = false
async function deliveryTick() {
  if (delivering) return
  delivering = true
  try {
    queue.setFrozen(isFrozen())
    await releaseRooms()
    const sys = nextSystemPrompt()
    if (!sys && !queue.hasImmediate() && !queue.digestDue()) return
    // Let a burst of owner messages ("question" … "@kim?") land together.
    if (!sys && Date.now() - lastHumanPostAt < HUMAN_BURST_MS) return
    if (!(await wake.isIdle())) return
    if (sys) {
      await wake.deliver(sys.text)
      fs.renameSync(sys.file, `${sys.file}.delivered`)
      log(`delivered system prompt ${path.basename(sys.file)}`)
    } else if (queue.hasImmediate()) {
      const evs = queue.takeImmediate()
      // Waking anyway: bring the pending digest along as context.
      const context = queue.takeDigest()
      await wake.deliver(renderEvents(me.username, evs) + (context.length ? `\n\nRecent channel context:\n${renderDigest(me.username, context)}` : ''))
      delivered([...evs, ...context])
      const hasHuman = [...evs, ...context].some(e => e.fromHuman)
      log(`delivered ${evs.length} events${hasHuman ? ' human=true' : ''}`)
    } else {
      const items = queue.takeDigest()
      await wake.deliver(renderDigest(me.username, items))
      delivered(items)
      const digestHuman = items.some(e => e.fromHuman)
      log(`delivered digest of ${items.length}${digestHuman ? ' human=true' : ''}`)
    }
  } catch (e) {
    log(`delivery failed: ${(e as Error).message}`)
  } finally { delivering = false }
}

// ------------------------------------------------------------------ start
await server.connect(new StdioServerTransport())
log(`office-mcp up for @${me.username} (wake=${useChannel ? 'channel' : rec.harness})`)
/** Replay posts made while this MCP was not running (first start: nothing to replay). */
async function catchUp() {
  if (!lastSeen) { markSeen(Date.now()); return }
  const cutoff = lastSeen // fixed: markSeen() advances lastSeen while we replay
  const since = Math.max(cutoff, Date.now() - 24 * 3600_000)
  let n = 0
  for (const ch of await mm.getChannelsForUser(team.id)) {
    const posts = await mm.getChannelPosts(ch.id, { since, perPage: 200 }).catch(() => [])
    for (const p of posts) {
      if (p.createAt <= cutoff) continue
      onPost(p, { mentions: [], channelType: ch.type, channelName: ch.name, senderName: p.username }); n++
    }
  }
  log(`catch-up replayed ${n} posts since ${new Date(since).toISOString()}`)
}
const ws = mm.connectWebSocket(onPost, undefined, () => void catchUp().catch(e => log(`catch-up failed: ${(e as Error).message}`)))
void catchUp().catch(e => log(`catch-up failed: ${(e as Error).message}`))
// Undelivered events from before a restart: room requests go back through the claim check.
for (const e of pending.values()) {
  if (e.kind === 'room') roomWait.set(e.id, { ev: e, dueAt: Date.now() })
  else queue.push(e)
}
void refreshColleagues()
const timers = [
  setInterval(deliveryTick, 2000),
  setInterval(refreshColleagues, 60_000),
  setInterval(pollTickets, 20_000),
]
// Watching org repos would notify every agent about every ticket: keep agents unsubscribed.
const unwatch = () => fj.unwatchOrgRepos(cfg.forgejoOrg).then(n => log(`unwatched ${n} repos`), e => log(`unwatch failed: ${(e as Error).message}`))
void unwatch().then(pollTickets)
timers.push(setInterval(unwatch, 10 * 60_000))
const shutdown = () => { timers.forEach(clearInterval); ws.close(); process.exit(0) }
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${String(reason)}`))
process.on('uncaughtException', (err) => log(`uncaught exception: ${err.message}\n${err.stack ?? ''}`))
