// Admin daemon watchdog: alert in #office-admin when agents look stuck, down,
// near limits, or have stale work. One alert per incident; cleared when resolved.

import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord, OfficeConfig } from '../lib/types.js'
import { agentStateDir, listAgents, loadAgent, repoRoot } from '../lib/config.js'
import { capturePane, paneAlive, windowTarget } from '../lib/tmux.js'
import { readStatus } from '../lib/harness/claude.js'
import { ForgejoClient } from '../lib/forgejo.js'
import { MattermostClient } from '../lib/mattermost.js'
import { listProjects } from '../lib/projects.js'
import {
  alertKey,
  detectStaleWork,
  formatDuration,
  lastDeliveredFromLog,
  parsePaneMetrics,
  parseWeeklyPercent,
  readPending,
  shouldAlertThreshold,
  tailMcpLog,
} from './monitor.js'

export interface WatchdogDeps {
  root: string
  cfg: OfficeConfig
  mm: MattermostClient
  fj: ForgejoClient
  botUserId: string
  teamId: string
  channelId: string
  now?: () => number
}

export interface WatchdogState {
  /** Keys already alerted this scan cycle. */
  alerted: Set<string>
  /** Last time a stale-work alert was sent per ticket key. */
  staleSentAt: Map<string, number>
  /** Last threshold bucket fired for weekly/context alerts. */
  thresholdBucket: Map<string, number>
}

export function createWatchdogState(): WatchdogState {
  return { alerted: new Set(), staleSentAt: new Map(), thresholdBucket: new Map() }
}

/** Post a short alert in #office-admin and log it. */
async function postAlert(deps: WatchdogDeps, text: string, state: WatchdogState, key: string) {
  if (state.alerted.has(key)) return
  try {
    await deps.mm.createPost({ channelId: deps.channelId, message: text })
  } catch (e) {
    // ignore: we are inside a poll, do not crash the daemon
  }
  state.alerted.add(key)
}

/** Clear an alert key when the condition is resolved. */
export function clearAlert(state: WatchdogState, key: string): void {
  state.alerted.delete(key)
}

/** Read status.json for an agent. */
function statusJson(name: string): ReturnType<typeof readStatus> {
  return readStatus(path.join(agentStateDir(name), 'status.json'))
}

/** Run one watchdog scan and post any new alerts. */
export async function runWatchdog(deps: WatchdogDeps, state: WatchdogState): Promise<void> {
  const { cfg, mm, fj, teamId, channelId } = deps
  const now = (deps.now ?? Date.now)()
  const root = deps.root

  const projects = (await listProjects(root)).filter(p => !p.archived)
  const repos = [cfg.ticketsRepo, ...projects.map(p => p.name)]

  for (const name of await listAgents()) {
    const rec = await loadAgent(name)
    if (!rec || rec.status === 'retired') {
      // Clear stale keys for retired agents.
      for (const key of state.alerted) if (key.startsWith(`${name}:`)) state.alerted.delete(key)
      continue
    }

    const target = windowTarget(cfg.tmuxSession, name)
    const alive = await paneAlive(target)
    const st = statusJson(name)
    const pane = alive ? await capturePane(target, 35).catch(() => '') : ''
    const metrics = parsePaneMetrics(pane, rec.harness)

    // Window down.
    if (!alive && st?.state !== 'stopped') {
      await postAlert(deps, `🔴 @${name} is down. Try \`start ${name}\``, state, alertKey(name, 'down'))
      continue
    }
    clearAlert(state, alertKey(name, 'down'))

    // Blocked dialog > 2 min.
    if (metrics.condition === 'dialog' || st?.state === 'blocked') {
      const blockedMs = st?.at ? now - Date.parse(st.at) : 0
      if (blockedMs > 2 * 60_000) {
        await postAlert(deps, `🟠 @${name} has been blocked for ${formatDuration(blockedMs)}. \`inspect ${name}\``, state, alertKey(name, 'blocked', st?.at ?? ''))
      }
    } else {
      clearAlert(state, alertKey(name, 'blocked'))
    }

    // Busy > 30 min.
    if (st?.state === 'busy' && st.at) {
      const busyMs = now - Date.parse(st.at)
      if (busyMs > 30 * 60_000) {
        await postAlert(deps, `🔵 @${name} has been busy ${formatDuration(busyMs)}. \`inspect ${name}\``, state, alertKey(name, 'busy', st.at))
      }
    } else {
      clearAlert(state, alertKey(name, 'busy'))
    }

    // Pane error/limit text.
    if (metrics.errorLines.length) {
      const line = metrics.errorLines[0]!
      await postAlert(deps, `⚠️ @${name}: ${line}  \`inspect ${name}\``, state, alertKey(name, 'error', line))
    }

    // Claude weekly usage thresholds.
    if (metrics.weeklyPercent !== undefined) {
      const threshold = shouldAlertThreshold(metrics.weeklyPercent, [90, 95])
      if (threshold !== undefined) {
        const key = alertKey(name, 'weekly', String(threshold))
        const lastBucket = state.thresholdBucket.get(key)
        if (lastBucket !== threshold) {
          await postAlert(deps, `📊 @${name} Claude weekly usage is ${metrics.weeklyPercent}% (threshold ${threshold}%). Consider \`shift ${name}\``, state, key)
          state.thresholdBucket.set(key, threshold)
        }
      }
    }

    // Context threshold.
    const ctxPercent = parseContextPercent(metrics.context)
    if (ctxPercent !== undefined && ctxPercent >= 85) {
      const key = alertKey(name, 'context', String(ctxPercent))
      const lastBucket = state.thresholdBucket.get(key)
      if (lastBucket !== ctxPercent) {
        await postAlert(deps, `🧠 @${name} context ${ctxPercent}%. Consider \`shift ${name}\``, state, key)
        state.thresholdBucket.set(key, ctxPercent)
      }
    }

    // Stale work.
    await checkStaleWork(deps, state, rec, repos, now)

    // Claude answered in terminal, not in chat.
    await checkTerminalAnswer(deps, state, rec, mm, teamId, now)
  }
}

function parseContextPercent(s: string): number | undefined {
  const m = s.match(/^(\d+)%/)
  return m ? Number(m[1]) : undefined
}

async function checkStaleWork(
  deps: WatchdogDeps,
  state: WatchdogState,
  rec: AgentRecord,
  repos: string[],
  now: number,
): Promise<void> {
  const staleMs = (deps.cfg.watchdog?.staleWorkMinutes ?? 45) * 60_000
  const staleIssues = []
  for (const repo of repos) {
    try {
      const issues = await deps.fj.listIssues(deps.cfg.forgejoOrg, repo, { state: 'open', assignee: rec.name })
      const commentsByIssue = new Map<number, import('../lib/forgejo.js').Comment[]>()
      for (const issue of issues) {
        const comments = await deps.fj.listComments(deps.cfg.forgejoOrg, repo, issue.number).catch(() => [])
        commentsByIssue.set(issue.number, comments)
      }
      staleIssues.push(...detectStaleWork(issues, commentsByIssue, {
        username: rec.name,
        staleMs,
        nowMs: now,
      }))
    } catch { /* ignore per-repo errors */ }
  }

  for (const issue of staleIssues) {
    const key = alertKey(rec.name, 'stale', `${issue.repo}#${issue.number}`)
    const lastAlert = state.staleSentAt.get(key) ?? 0
    if (now - lastAlert < 2 * 60 * 60 * 1000) continue // at most once per 2 h per ticket

    // Post in project channel if known, otherwise #office.
    const project = deps.cfg.forgejoOrg + '/' + issue.repo.split('/')[1]
    const projectRec = (await listProjects(deps.root)).find(p => p.repo === project)
    const channelName = projectRec?.channel ?? 'office'
    const channel = await deps.mm.getChannelByName(deps.teamId, channelName).catch(() => undefined)
    const ageMin = Math.round((now - issue.lastActivityAt.getTime()) / 60000)
    const text = `⏰ @${rec.name} ${issue.repo}#${issue.number} has had no activity for ${ageMin} min. Please continue it now or say what blocks you.`
    if (channel) {
      try { await deps.mm.createPost({ channelId: channel.id, message: text }) } catch { /* ignore */ }
    }
    await postAlert(deps, `⏰ @${rec.name} stale work: ${issue.repo}#${issue.number} (${issue.title}) — ${ageMin} min idle`, state, key)
    state.staleSentAt.set(key, now)
  }
}

async function checkTerminalAnswer(
  deps: WatchdogDeps,
  state: WatchdogState,
  rec: AgentRecord,
  mm: MattermostClient,
  teamId: string,
  now: number,
): Promise<void> {
  if (rec.harness !== 'claude') return
  const logFile = path.join(agentStateDir(rec.name), 'mcp.log')
  const delivered = lastDeliveredFromLog(logFile)
  if (!delivered || !delivered.line.includes('human=true')) return
  const deliveryAt = Date.parse(delivered.at)
  if (Number.isNaN(deliveryAt)) return
  if (now - deliveryAt < 2 * 60_000) return // wait grace period

  // Has the agent posted anything since the delivery?
  try {
    const posts = await mm.searchPosts(teamId, `from:${rec.name}`)
    const postedSince = posts.some(p => p.createAt > deliveryAt)
    if (postedSince) {
      clearAlert(state, alertKey(rec.name, 'terminal-answer', delivered.at))
      return
    }
    const st = statusJson(rec.name)
    if (st?.state === 'idle') {
      await postAlert(deps, `💬 @${rec.name} answered in its terminal, not in chat. \`inspect ${rec.name}\``, state, alertKey(rec.name, 'terminal-answer', delivered.at))
    }
  } catch { /* ignore */ }
}

/** Persist watchdog state so alert de-duplication survives daemon restarts. */
export function loadWatchdogState(root: string): WatchdogState {
  const file = path.join(root, 'state', 'admin', 'watchdog.json')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as { alerted?: string[]; staleSentAt?: [string, number][]; thresholdBucket?: [string, number][] }
    return {
      alerted: new Set(parsed.alerted ?? []),
      staleSentAt: new Map(parsed.staleSentAt ?? []),
      thresholdBucket: new Map(parsed.thresholdBucket ?? []),
    }
  } catch {
    return createWatchdogState()
  }
}

export function saveWatchdogState(root: string, state: WatchdogState): void {
  const file = path.join(root, 'state', 'admin', 'watchdog.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    alerted: [...state.alerted],
    staleSentAt: [...state.staleSentAt],
    thresholdBucket: [...state.thresholdBucket],
  }, null, 2) + '\n')
}
