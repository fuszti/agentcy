// Admin-channel daemon: the owner types office commands in #office-admin
// and the office bot runs them, posting threaded replies with the output.

import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadSecrets, repoRoot, stateDir } from '../lib/config.js'
import { MattermostClient } from '../lib/mattermost.js'
import { ForgejoClient } from '../lib/forgejo.js'
import type { ChatPost, OfficeRequest, RequestStatus } from '../lib/types.js'
import { listAgents, loadAgent } from '../lib/config.js'
import { helpText, parseCommandLine, parseRequestId, vaultSetLeak } from './commands.js'
import { listRequests, loadRequest, setRequestStatus, updateRequest } from '../lib/requests.js'
import { formatProjectCreatedFyi, formatProjectCreatedNotice } from '../lib/project-requests.js'
import { queueSystemPrompt } from '../lib/inbox.js'
import {
  buildHelperPromptFromState,
  extractJsonBlock,
  isGenerateTrigger,
  renderProposalMessage,
  runHelper,
  stripGenerateTrigger,
  validateProposal,
  type HelperProposal,
} from './helper.js'
import { buildDispatcherDeps, dispatchRound } from './dispatcher.js'
import { loadWatchdogState, runWatchdog, saveWatchdogState } from './watchdog.js'
import { collectFinanceSnapshot } from '../finance/collect.js'
import { detectGroupAlerts, detectLimitAlerts, loadFinanceAlertState, saveFinanceAlertState } from '../finance/alerts.js'
import { renderFinanceReport } from '../finance/render.js'
import { suggestMoveText } from '../finance/groups.js'
import { headroomFromSnapshot } from '../finance/headroom.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
const HOURGLASS = 'hourglass_flowing_sand'
const CHECK = 'white_check_mark'
const CROSS = 'x'
const OUTPUT_LIMIT = 14_000

function adminLog(line: string) {
  const ts = new Date().toISOString()
  appendFile(path.join(stateDir(), 'admin.log'), `${ts} ${line}\n`).catch(() => {})
}

function truncateTail(s: string, max: number): string {
  if (s.length <= max) return s
  return '…[truncated]\n' + s.slice(s.length - max + 12)
}

interface PendingJob {
  post: ChatPost
  command?: { command: string; args: string[] }
  generated?: { commands: string[][] }
}

async function run() {
  const root = repoRoot()
  const config = await loadConfig()
  const secrets = await loadSecrets()
  if (!secrets?.officeBot) {
    console.error('office bot not configured; run `bin/office init` first')
    process.exit(1)
  }
  if (!secrets.mattermost.humanUserId) {
    console.error('human user id not configured; run `bin/office init` first')
    process.exit(1)
  }

  const mm = new MattermostClient(config.mattermostUrl, secrets.officeBot.token)
  const botUserId = (await mm.me()).id
  const channel = await mm.getChannelByName(secrets.mattermost.teamId, config.adminChannel)
  const financeChannel = await mm.getChannelByName(secrets.mattermost.teamId, config.financeChannel)

  const queue: PendingJob[] = []
  let busy = false

  const binOffice = path.join(root, 'bin', 'office')

  async function runOfficeArgv(argv: string[]): Promise<{ exitCode: number; output: string }> {
    return new Promise<{ exitCode: number; output: string }>((resolve) => {
      const child = spawn(binOffice, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (d) => (stdout += d.toString()))
      child.stderr!.on('data', (d) => (stderr += d.toString()))

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
      }, 15 * 60 * 1000)

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ exitCode: 1, output: `${err.message}` })
      })

      child.on('close', (code, signal) => {
        clearTimeout(timer)
        let output = stripAnsi(stdout + stderr).replace(/\r\n/g, '\n')
        if (signal) output += `\n[command terminated by ${signal}]`
        if (code === null && signal === 'SIGTERM') output += '\n[command timed out after 15 minutes]'
        resolve({ exitCode: code ?? 1, output })
      })
    })
  }

  async function postCommandResult(post: ChatPost, command: string, result: { exitCode: number; output: string }) {
    const ok = result.exitCode === 0
    const tail = truncateTail(result.output, OUTPUT_LIMIT)
    const message = command === 'status'
      ? `${tail}\n\n${ok ? '✅' : '❌'} exit ${result.exitCode}`
      : `\`\`\`\n${tail}\n\`\`\`\n\n${ok ? '✅' : '❌'} exit ${result.exitCode}`
    try {
      await mm.createPost({ channelId: channel.id, message, rootId: post.rootId || post.id })
    } catch (e) {
      adminLog(`reply failed post=${post.id}: ${(e as Error).message}`)
    }
  }

  async function execute(job: PendingJob) {
    const { post } = job

    if (job.generated) {
      adminLog(`generated exec post=${post.id} commands=${JSON.stringify(job.generated.commands)}`)
      let overallOk = true
      for (const argv of job.generated.commands) {
        const commandName = argv[0] ?? ''
        const result = await runOfficeArgv(argv)
        await postCommandResult(post, commandName, result)
        if (result.exitCode !== 0) {
          overallOk = false
          break
        }
      }
      try { await mm.removeReaction(post.id, HOURGLASS) } catch { /* ignore */ }
      try { await mm.addReaction(post.id, overallOk ? CHECK : CROSS) } catch { /* ignore */ }
      return
    }

    const command = job.command!
    adminLog(`exec pid=${process.pid} cmd=${command.command} args=${JSON.stringify(command.args)} post=${post.id}`)

    if (command.command === 'help') {
      await mm.createPost({ channelId: channel.id, message: helpText, rootId: post.rootId || post.id }).catch(() => {})
      await mm.removeReaction(post.id, HOURGLASS).catch(() => {})
      await mm.addReaction(post.id, CHECK).catch(() => {})
      return
    }

    const argv = [command.command]
    if (command.command === 'status') argv.push('--md')
    argv.push(...command.args)

    const result = await runOfficeArgv(argv)
    await postCommandResult(post, command.command === 'peek' ? 'inspect' : command.command, result)

    try { await mm.removeReaction(post.id, HOURGLASS) } catch { /* ignore */ }
    try { await mm.addReaction(post.id, result.exitCode === 0 ? CHECK : CROSS) } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ self-management requests
  const pendingApprovalPosts = new Map<string, string>() // request id -> post id

  // ------------------------------------------------------------------ generate proposals
  interface StoredProposal {
    rootPostId: string
    ownerPostId: string
    proposalPostId: string
    createdAt: string
    commands: string[][]
    status: 'pending' | 'approved' | 'discarded'
  }

  const proposalsDir = path.join(stateDir(), 'admin', 'proposals')
  const proposalsByPost = new Map<string, StoredProposal>() // proposal post id -> proposal

  async function loadProposals() {
    try {
      await mkdir(proposalsDir, { recursive: true })
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(proposalsDir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        try {
          const raw = await readFile(path.join(proposalsDir, f), 'utf8')
          const p = JSON.parse(raw) as StoredProposal
          if (p.proposalPostId) proposalsByPost.set(p.proposalPostId, p)
        } catch { /* ignore corrupt file */ }
      }
    } catch (e) {
      adminLog(`load proposals error: ${(e as Error).message}`)
    }
  }

  async function saveProposal(p: StoredProposal) {
    await mkdir(proposalsDir, { recursive: true })
    const file = path.join(proposalsDir, `${p.rootPostId}.json`)
    await writeFile(file, JSON.stringify(p, null, 2) + '\n')
    proposalsByPost.set(p.proposalPostId, p)
  }

  async function updateProposalStatus(proposalPostId: string, status: StoredProposal['status']) {
    const p = proposalsByPost.get(proposalPostId)
    if (!p) return
    p.status = status
    await saveProposal(p)
  }

  function isKnownProposalRoot(rootId: string | undefined): boolean {
    if (!rootId) return false
    for (const p of proposalsByPost.values()) {
      if (p.rootPostId === rootId) return true
    }
    return false
  }

  async function handleGenerate(post: ChatPost, text: string) {
    const rootPostId = post.rootId || post.id
    const isRefinement = !!post.rootId && isKnownProposalRoot(post.rootId)

    adminLog(`generate post=${post.id} root=${rootPostId} refinement=${isRefinement}`)

    const conversation: { role: 'owner' | 'helper'; text: string }[] = []
    if (isRefinement && post.rootId) {
      // Rebuild the whole exchange from the real thread: the owner's original request,
      // every helper proposal (with its explanation and questions) and earlier feedback.
      const thread = await mm.getPostThread(post.rootId).catch(() => [] as ChatPost[])
      for (const p of thread) {
        if (p.id === post.id) continue
        if (p.userId === secrets!.mattermost.humanUserId) {
          conversation.push({ role: 'owner', text: p.message.replace(/^(generate|gen|\?)\s+/i, '').trim() })
        } else if (p.userId === botUserId) {
          conversation.push({ role: 'helper', text: p.message })
        }
      }
    }
    conversation.push({ role: 'owner', text })

    let prompt: string
    try {
      prompt = await buildHelperPromptFromState(root, config, conversation)
    } catch (e) {
      adminLog(`build helper prompt failed: ${(e as Error).message}`)
      await mm.createPost({ channelId: channel.id, message: `❌ helper prompt failed: ${(e as Error).message}`, rootId: rootPostId }).catch(() => {})
      return
    }

    let lastError: string | undefined
    let validated: { ok: true; proposal: HelperProposal } | { ok: false; error: string } | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const fullPrompt = lastError ? `${prompt}\n\n[VALIDATION ERROR ON PREVIOUS ATTEMPT — FIX IT]: ${lastError}` : prompt
      const result = runHelper({ root, helperModel: config.defaults.helperModel, prompt: fullPrompt, timeoutMs: 120_000, groups: config.resourceGroups })
      if (result.exitCode !== 0) {
        adminLog(`helper run failed exit=${result.exitCode} output=${result.output.slice(0, 200)}`)
        lastError = `helper process exited ${result.exitCode}`
        continue
      }
      const parsed = extractJsonBlock(result.output)
      validated = validateProposal(parsed)
      if (validated.ok) break
      lastError = validated.error
    }

    if (!validated || !validated.ok) {
      const err = validated ? validated.error : 'helper produced no valid JSON'
      await mm.createPost({ channelId: channel.id, message: `❌ ${err}`, rootId: rootPostId }).catch(() => {})
      return
    }

    const proposal = validated.proposal
    const message = renderProposalMessage(proposal)
    try {
      const proposalPost = await mm.createPost({ channelId: channel.id, message, rootId: rootPostId })
      const stored: StoredProposal = {
        rootPostId,
        ownerPostId: post.id,
        proposalPostId: proposalPost.id,
        createdAt: new Date().toISOString(),
        commands: proposal.commands,
        status: 'pending',
      }
      await saveProposal(stored)
    } catch (e) {
      adminLog(`proposal post failed: ${(e as Error).message}`)
    }
  }

  async function checkProposals() {
    const humanUserId = secrets!.mattermost.humanUserId
    for (const [postId, proposal] of proposalsByPost) {
      if (proposal.status !== 'pending') continue
      const reactions = await mm.getReactions(postId).catch(() => [])
      const approved = reactions.some(r => r.user_id === humanUserId && (r.emoji_name === 'white_check_mark' || r.emoji_name === 'heavy_check_mark'))
      const denied = reactions.some(r => r.user_id === humanUserId && r.emoji_name === 'x')
      if (!approved && !denied) continue

      if (denied) {
        await updateProposalStatus(postId, 'discarded')
        await mm.createPost({ channelId: channel.id, message: '❌ discarded', rootId: proposal.rootPostId }).catch(() => {})
        continue
      }

      await updateProposalStatus(postId, 'approved')
      if (proposal.commands.length === 0) {
        await mm.createPost({ channelId: channel.id, message: '✅ nothing to run (no commands proposed)', rootId: proposal.rootPostId }).catch(() => {})
        continue
      }

      const post = await mm.getPost(proposal.ownerPostId).catch(() => undefined)
      if (!post) continue

      // Build a synthetic post anchored at the proposal thread root so results thread correctly.
      const syntheticPost: ChatPost = {
        ...post,
        id: proposal.proposalPostId,
        rootId: proposal.rootPostId,
      }
      mm.addReaction(proposal.proposalPostId, HOURGLASS).catch(() => {})
      queue.push({ post: syntheticPost, generated: { commands: proposal.commands } })
      processQueue()
    }
  }

  function argvForRequest(req: OfficeRequest): string[] | undefined {
    switch (req.type) {
      case 'fork': {
        const task = req.args.task
        const argv = ['fork', req.agent]
        if (req.args.name) argv.push('--name', String(req.args.name))
        if (task) argv.push('--task', String(task))
        return argv
      }
      case 'merge':
        return ['merge', String(req.args.source), '--into', String(req.args.target)]
      case 'shift':
        return ['shift', req.agent]
      case 'hire': {
        const { name, harness, model, focus } = req.args as Record<string, string>
        const argv = ['hire', name, '--harness', harness, '--focus', focus]
        if (model) argv.push('--model', model)
        return argv
      }
      case 'project': {
        const { name, description, members } = req.args as Record<string, unknown>
        const argv = ['project', 'new', String(name), '--desc', String(description)]
        if (Array.isArray(members) && members.length) argv.push('--members', members.join(','))
        argv.push('--created-by', req.agent)
        return argv
      }
      default:
        return undefined
    }
  }

  async function notifyRequester(req: OfficeRequest, status: RequestStatus, result?: string) {
    const text = `<office-system kind="request-update">Your ${req.type} request (${req.id}) is ${status}.${result ? ` Result: ${result}` : ''}</office-system>`
    await queueSystemPrompt(root, req.agent, `req-${req.id}`, text).catch(e => adminLog(`notify requester failed: ${(e as Error).message}`))
  }

  async function executeRequest(req: OfficeRequest) {
    adminLog(`request ${req.id} ${req.type} executing`)
    const argv = argvForRequest(req)
    if (!argv) {
      await setRequestStatus(root, req.id, 'failed', 'unknown request type')
      return
    }

    const result = await new Promise<{ exitCode: number; output: string }>((resolve) => {
      const child = spawn(binOffice, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (d) => (stdout += d.toString()))
      child.stderr!.on('data', (d) => (stderr += d.toString()))
      const timer = setTimeout(() => { child.kill('SIGTERM') }, 15 * 60 * 1000)
      child.on('error', (err) => { clearTimeout(timer); resolve({ exitCode: 1, output: err.message }) })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        let output = stripAnsi(stdout + stderr).replace(/\r\n/g, '\n')
        if (signal) output += `\n[terminated by ${signal}]`
        if (code === null && signal === 'SIGTERM') output += '\n[timed out after 15 minutes]'
        resolve({ exitCode: code ?? 1, output })
      })
    })

    const ok = result.exitCode === 0
    const updated = await setRequestStatus(root, req.id, ok ? 'done' : 'failed', truncateTail(result.output, 2000))

    if (ok && req.type === 'project') {
      const members = Array.isArray(req.args.members) ? (req.args.members as string[]) : [req.agent]
      const fyi = formatProjectCreatedFyi(req, members)
      await mm.createPost({ channelId: channel.id, message: fyi }).catch(() => {})
      const channelName = `proj-${String(req.args.name)}`
      const notice = formatProjectCreatedNotice(config, String(req.args.name), channelName)
      await queueSystemPrompt(root, req.agent, `req-${req.id}`, notice).catch(e => adminLog(`notify requester failed: ${(e as Error).message}`))
      return
    }

    const note = ok
      ? `✅ ${req.type} request ${req.id} completed for @${req.agent}`
      : `❌ ${req.type} request ${req.id} failed for @${req.agent}`
    await mm.createPost({ channelId: channel.id, message: `${note}\n\n\`\`\`\n${truncateTail(result.output, 1200)}\n\`\`\`` }).catch(() => {})
    await notifyRequester(updated ?? req, ok ? 'done' : 'failed', ok ? undefined : truncateTail(result.output, 800))
  }

  async function postApprovalPrompt(req: OfficeRequest) {
    if (req.approvalPostId) return
    let text = `🙋 @${req.agent} requests a ${req.type}`
    if (req.type === 'fork') text += `: ${req.args.task ?? '(no task)'}`
    if (req.type === 'hire') text += `: ${req.args.name} (${req.args.harness}) — ${req.args.reason}`
    if (req.type === 'project') text += `: ${req.args.name} — ${req.args.reason}`
    text += ` (${req.id}). React ✅ to approve or ❌ to deny, or type \`approve ${req.id}\` / \`deny ${req.id}\`.`
    try {
      const post = await mm.createPost({ channelId: channel.id, message: text })
      await updateRequest(root, req.id, { approvalPostId: post.id })
      pendingApprovalPosts.set(req.id, post.id)
    } catch (e) {
      adminLog(`approval prompt failed for ${req.id}: ${(e as Error).message}`)
    }
  }

  async function checkApprovals() {
    const humanUserId = secrets!.mattermost.humanUserId
    for (const [reqId, postId] of pendingApprovalPosts) {
      const reactions = await mm.getReactions(postId).catch(() => [])
      const approved = reactions.some(r => r.user_id === humanUserId && (r.emoji_name === 'white_check_mark' || r.emoji_name === 'heavy_check_mark'))
      const denied = reactions.some(r => r.user_id === humanUserId && r.emoji_name === 'x')
      if (!approved && !denied) continue
      pendingApprovalPosts.delete(reqId)
      const status: RequestStatus = approved ? 'approved' : 'denied'
      const updated = await setRequestStatus(root, reqId, status)
      if (updated) await notifyRequester(updated, status, approved ? 'approved by owner' : 'denied by owner')
    }
  }

  let requestQueueBusy = false
  async function processRequestQueue() {
    if (requestQueueBusy) return
    requestQueueBusy = true
    try {
      const reqs = await listRequests(root)
      for (const req of reqs) {
        if (req.status === 'pending' && !req.approvalPostId) await postApprovalPrompt(req)
      }
      const ready = reqs.find(r => r.status === 'approved')
      if (ready) {
        await executeRequest(ready)
      }
    } catch (e) {
      adminLog(`request queue error: ${(e as Error).message}`)
    } finally {
      requestQueueBusy = false
    }
  }

  async function handleConsoleApproveDeny(post: ChatPost, command: string, args: string[]) {
    const parsed = parseRequestId(args)
    if ('error' in parsed) {
      await mm.createPost({ channelId: channel.id, message: `❌ ${parsed.error}`, rootId: post.rootId || post.id }).catch(() => {})
      return
    }
    const req = await loadRequest(root, parsed.id)
    if (!req) {
      await mm.createPost({ channelId: channel.id, message: `❌ request ${parsed.id} not found`, rootId: post.rootId || post.id }).catch(() => {})
      return
    }
    if (req.status !== 'pending') {
      await mm.createPost({ channelId: channel.id, message: `❌ request ${parsed.id} is ${req.status}`, rootId: post.rootId || post.id }).catch(() => {})
      return
    }
    pendingApprovalPosts.delete(req.id)
    const status: RequestStatus = command === 'approve' ? 'approved' : 'denied'
    const updated = await setRequestStatus(root, req.id, status)
    if (updated) await notifyRequester(updated, status, status === 'approved' ? 'approved by owner' : 'denied by owner')
    await mm.createPost({ channelId: channel.id, message: `${status === 'approved' ? '✅' : '❌'} ${req.id} ${status}`, rootId: post.rootId || post.id }).catch(() => {})
  }

  async function handleRequestsList(post: ChatPost) {
    const reqs = (await listRequests(root)).slice(-20)
    const pending = reqs.filter(r => r.status === 'pending')
    const recent = reqs.filter(r => r.status !== 'pending')
    const lines = ['**Pending**', pending.length ? pending.map(r => `- ${r.id} @${r.agent} ${r.type}: ${r.type === 'fork' ? r.args.task : r.type === 'hire' ? `${r.args.name} (${r.args.harness})` : r.type === 'project' ? `${r.args.name}` : ''}`).join('\n') : '(none)']
    lines.push('', '**Recent**', recent.length ? recent.map(r => `- ${r.id} @${r.agent} ${r.type} → ${r.status}`).join('\n') : '(none)')
    await mm.createPost({ channelId: channel.id, message: lines.join('\n'), rootId: post.rootId || post.id }).catch(() => {})
  }

  async function processQueue() {
    if (busy) return
    busy = true
    while (queue.length > 0) {
      const job = queue.shift()!
      try {
        await execute(job)
      } catch (e) {
        adminLog(`execute error post=${job.post.id}: ${(e as Error).message}`)
      }
    }
    busy = false
  }

  // #office-finance only understands `finance` and `help`; everything else is ignored
  // (no generate/self-management there, keep the channel focused on the finance report).
  async function handleFinanceChannelPost(post: ChatPost): Promise<void> {
    const parsed = parseCommandLine(post.message, {})
    if (parsed.kind !== 'command' || (parsed.command !== 'finance' && parsed.command !== 'help')) return
    await mm.addReaction(post.id, HOURGLASS).catch(() => {})
    try {
      if (parsed.command === 'help') {
        await mm.createPost({ channelId: financeChannel.id, message: '`finance [today|week|<agent>|<group>]` — resource-group usage/cost report.', rootId: post.rootId || post.id }).catch(() => {})
      } else {
        const result = await runOfficeArgv(['finance', ...parsed.args])
        const ok = result.exitCode === 0
        const message = ok ? truncateTail(result.output, OUTPUT_LIMIT) : `\`\`\`\n${truncateTail(result.output, OUTPUT_LIMIT)}\n\`\`\`\n\n❌ exit ${result.exitCode}`
        await mm.createPost({ channelId: financeChannel.id, message, rootId: post.rootId || post.id }).catch(() => {})
      }
    } finally {
      await mm.removeReaction(post.id, HOURGLASS).catch(() => {})
      await mm.addReaction(post.id, CHECK).catch(() => {})
    }
  }

  /**
   * A key was pasted into chat (`vault set <id> <value>`): purge the post right away, before
   * any parsing or queueing, so it neither waits behind running jobs nor reaches the helper model.
   * Needs the owner's token: bots can't delete other users' posts.
   */
  async function purgeLeakedKey(post: ChatPost, entryId: string, replyChannelId: string): Promise<void> {
    const purged = await new MattermostClient(config.mattermostUrl, secrets!.mattermost.adminToken).deletePost(post.id, true).then(() => true, () => false)
    adminLog(`vault set with a value in chat post=${post.id} purged=${purged}`)
    await mm.createPost({
      channelId: replyChannelId,
      message: `⚠️ That looked like an API key, so I ${purged ? 'permanently deleted your message' : 'tried to delete your message (failed: delete it yourself)'}. ` +
        `Treat the key as leaked and rotate it at the provider. Keys are only set on the server shell: \`office vault set ${entryId}\` (input hidden).`,
    }).catch(() => {})
  }

  function handlePost(post: ChatPost) {
    if (post.userId === botUserId) return // ignore own posts
    if ((post.channelId === channel.id || post.channelId === financeChannel.id) && post.userId === secrets!.mattermost.humanUserId) {
      const leaked = vaultSetLeak(post.message)
      if (leaked) {
        purgeLeakedKey(post, leaked, post.channelId).catch((e) => adminLog(`purge failed post=${post.id}: ${(e as Error).message}`))
        return
      }
    }
    if (post.channelId === financeChannel.id) {
      if (post.userId !== secrets!.mattermost.humanUserId) return
      handleFinanceChannelPost(post).catch((e) => adminLog(`finance channel error post=${post.id}: ${(e as Error).message}`))
      return
    }
    if (post.channelId !== channel.id) return
    if (post.userId !== secrets!.mattermost.humanUserId) return

    const parsed = parseCommandLine(post.message, { threadParentIsProposal: isKnownProposalRoot(post.rootId) })
    if (parsed.kind === 'generate') {
      mm.addReaction(post.id, HOURGLASS).catch(() => {})
      handleGenerate(post, parsed.text).finally(() => {
        mm.removeReaction(post.id, HOURGLASS).catch(() => {})
      })
      return
    }
    if (parsed.kind === 'error') {
      mm.createPost({
        channelId: channel.id,
        message: `❌ ${parsed.error}\n\n${helpText}`,
        rootId: post.rootId || post.id,
      }).catch(() => {})
      return
    }

    if (parsed.command === 'requests') {
      mm.addReaction(post.id, HOURGLASS).catch(() => {})
      handleRequestsList(post).finally(() => {
        mm.removeReaction(post.id, HOURGLASS).catch(() => {})
        mm.addReaction(post.id, CHECK).catch(() => {})
      })
      return
    }
    if (parsed.command === 'approve' || parsed.command === 'deny') {
      mm.addReaction(post.id, HOURGLASS).catch(() => {})
      handleConsoleApproveDeny(post, parsed.command, parsed.args).finally(() => {
        mm.removeReaction(post.id, HOURGLASS).catch(() => {})
      })
      return
    }

    mm.addReaction(post.id, HOURGLASS).catch(() => {})
    queue.push({ post, command: parsed })
    processQueue()
  }

  const ws = mm.connectWebSocket((post) => handlePost(post))

  // Startup greeting.
  try {
    await mm.createPost({
      channelId: channel.id,
      message: 'Office console online. Type `help`.',
    })
  } catch (e) {
    adminLog(`startup greeting failed: ${(e as Error).message}`)
  }

  // Watchdog: richer alerts for down windows, stuck agents, limits, stale work.
  const watchdogState = loadWatchdogState(root)
  const watchdogDeps = {
    root, cfg: config, mm, fj: new ForgejoClient(config.forgejoUrl, secrets!.forgejo.adminToken),
    botUserId, teamId: secrets!.mattermost.teamId, channelId: channel.id,
  }
  async function checkWatchdog() {
    try {
      await runWatchdog(watchdogDeps, watchdogState)
      saveWatchdogState(root, watchdogState)
    } catch (e) {
      adminLog(`watchdog error: ${(e as Error).message}`)
    }
  }
  const watchdogIntervalMs = (config.watchdog?.alertIntervalSeconds ?? 60) * 1000
  const watcher = setInterval(checkWatchdog, watchdogIntervalMs)
  await checkWatchdog()

  // Finance: daily report + usage/health/spike alerts in #office-finance.
  const financeState = loadFinanceAlertState(root)
  async function checkFinance() {
    try {
      const snapshot = await collectFinanceSnapshot(root, config)
      const now = Date.now()
      // Point an alert at a same-kind group with more headroom (`office group move`).
      const usedPercent = headroomFromSnapshot(snapshot.limits, snapshot.groupsWeek)
      const agentsByGroup = new Map(snapshot.groupsWeek.map((g) => [g.id, g.agents]))
      const suggest = (id: string) => suggestMoveText(id, config.resourceGroups, usedPercent, agentsByGroup.get(id) ?? [])
      const thresholds = config.finance?.usageAlertThresholds ?? [75, 90, 100]
      const alerts = detectGroupAlerts(snapshot.groupsToday, thresholds, financeState, suggest)
      const limitThresholds = config.finance?.limitAlertThresholds ?? [80, 95]
      alerts.push(...detectLimitAlerts(snapshot.limits, limitThresholds, financeState, suggest))
      for (const a of alerts) {
        await mm.createPost({ channelId: financeChannel.id, message: a.message }).catch(() => {})
      }
      saveFinanceAlertState(root, financeState)

      const reportHour = config.finance?.dailyReportHour ?? 9
      const today = new Date().toISOString().slice(0, 10)
      if (new Date().getHours() === reportHour && financeState.lastDailyReportDate !== today) {
        const report = renderFinanceReport('today', snapshot.groupsToday, snapshot.agentsMerged, { limits: snapshot.limits })
        await mm.createPost({ channelId: financeChannel.id, message: report }).catch(() => {})
        financeState.lastDailyReportDate = today
        saveFinanceAlertState(root, financeState)
      }
    } catch (e) {
      adminLog(`finance error: ${(e as Error).message}`)
    }
  }
  const financeIntervalMs = 5 * 60_000
  const financeWatcher = setInterval(checkFinance, financeIntervalMs)
  await checkFinance()

  // Self-management request polling.
  await loadProposals()
  const requestPoll = setInterval(processRequestQueue, 3_000)
  const reactionPoll = setInterval(checkApprovals, 5_000)
  const proposalPoll = setInterval(checkProposals, 5_000)
  await processRequestQueue()
  await checkProposals()

  // Project dispatcher: announce new unassigned tickets and PRs needing reviewers.
  const dispatcherDeps = buildDispatcherDeps(root, config, secrets!)
  let dispatcherPoll: ReturnType<typeof setInterval> | undefined
  if (dispatcherDeps) {
    const run = () => dispatchRound(dispatcherDeps).catch(e => adminLog(`dispatcher error: ${(e as Error).message}`))
    dispatcherPoll = setInterval(run, 30_000)
    run()
  }

  // Keep the process alive until interrupted.
  const shutdown = () => {
    clearInterval(watcher)
    clearInterval(requestPoll)
    clearInterval(reactionPoll)
    clearInterval(proposalPoll)
    if (dispatcherPoll) clearInterval(dispatcherPoll)
    clearInterval(financeWatcher)
    saveWatchdogState(root, watchdogState)
    saveFinanceAlertState(root, financeState)
    ws.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {})
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}

export { run }
