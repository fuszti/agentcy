// Admin dispatcher: announce new unassigned project tickets and PRs needing reviewers
// in their project channels. Runs inside the admin daemon.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OfficeConfig, OfficeSecrets, ProjectRecord } from '../lib/types.js'
import { ForgejoClient } from '../lib/forgejo.js'
import { MattermostClient } from '../lib/mattermost.js'
import { listProjects } from '../lib/projects.js'

interface DispatcherState {
  /** ISO timestamp when the dispatcher first saw each project. */
  firstSeenAt: Record<string, string>
  /** Issue numbers already announced per project repo. */
  announcedIssues: Record<string, number[]>
  /** PR numbers already announced per project repo. */
  announcedPRs: Record<string, number[]>
}

export interface DispatcherClients {
  mm: MattermostClient
  fj: ForgejoClient
  botUserId: string
  teamId: string
}

export interface DispatcherDeps {
  root: string
  cfg: OfficeConfig
  clients: DispatcherClients
  stateFile: string
  now?: () => Date
}

function statePath(root: string): string {
  return path.join(root, 'state', 'admin', 'dispatcher.json')
}

async function loadState(stateFile: string): Promise<DispatcherState> {
  try {
    const raw = await readFile(stateFile, 'utf8')
    return JSON.parse(raw) as DispatcherState
  } catch {
    return { firstSeenAt: {}, announcedIssues: {}, announcedPRs: {} }
  }
}

async function saveState(stateFile: string, state: DispatcherState): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n')
}

function keyFor(project: ProjectRecord): string {
  return project.repo
}

/** Return true if the issue/PR was created after the dispatcher first saw the repo. */
function isAfterFirstSeen(createdAt: string, firstSeenAt?: string): boolean {
  if (!firstSeenAt) return false
  return new Date(createdAt).getTime() >= new Date(firstSeenAt).getTime()
}

async function ensureBotInChannel(mm: MattermostClient, teamId: string, channelName: string, botUserId: string): Promise<string | undefined> {
  try {
    const ch = await mm.getChannelByName(teamId, channelName)
    await mm.addToChannel(ch.id, botUserId).catch(() => {})
    return ch.id
  } catch (e) {
    return undefined
  }
}

/** Poll every project once and post announcements for new unassigned issues / PRs without reviewers. */
export async function dispatchRound(deps: DispatcherDeps): Promise<void> {
  const { root, cfg, clients, stateFile, now } = deps
  const { mm, fj, botUserId, teamId } = clients
  const state = await loadState(stateFile)
  const projects = (await listProjects(root)).filter(p => !p.archived)
  const nowIso = (now ?? (() => new Date()))().toISOString()

  for (const project of projects) {
    const key = keyFor(project)
    if (!state.firstSeenAt[key]) {
      state.firstSeenAt[key] = nowIso
      await saveState(stateFile, state)
      continue
    }

    const channelId = await ensureBotInChannel(mm, teamId, project.channel, botUserId)
    if (!channelId) continue

    const [owner, repo] = project.repo.split('/')
    if (!owner || !repo) continue

    // New unassigned issues.
    try {
      const issues = await fj.listIssues(owner, repo, { state: 'open', assignee: '0' })
      const announced = new Set(state.announcedIssues[key] ?? [])
      for (const issue of issues) {
        if (!isAfterFirstSeen(issue.created_at ?? issue.user?.login ?? '', state.firstSeenAt[key])) continue
        if (announced.has(issue.number)) continue
        const text = `🎫 New ticket ${project.repo}#${issue.number}: ${issue.title} — ${issue.html_url}. Room request: claim with 👀, then ticket_claim.`
        await mm.createPost({ channelId, message: text })
        announced.add(issue.number)
      }
      state.announcedIssues[key] = [...announced]
    } catch (e) {
      // ignore per-project errors
    }

    // New PRs with no requested reviewers.
    try {
      const prs = await fj.listPullRequests(owner, repo, 'open')
      const announced = new Set(state.announcedPRs[key] ?? [])
      for (const pr of prs) {
        if (!isAfterFirstSeen(pr.created_at ?? '', state.firstSeenAt[key])) continue
        if (announced.has(pr.number)) continue
        const requested = pr.requested_reviewers ?? []
        if (requested.length > 0) continue
        const text = `🔍 PR ${project.repo}#${pr.number} by @${pr.user.login} needs a reviewer (not the author): ${pr.title} — ${pr.html_url}. Claim with 👀.`
        await mm.createPost({ channelId, message: text })
        announced.add(pr.number)
      }
      state.announcedPRs[key] = [...announced]
    } catch (e) {
      // ignore per-project errors
    }
  }

  await saveState(stateFile, state)
}

/** Build dispatcher dependencies from config/secrets. */
export function buildDispatcherDeps(
  root: string,
  cfg: OfficeConfig,
  secrets: OfficeSecrets,
): DispatcherDeps | undefined {
  if (!secrets.officeBot) return undefined
  const mm = new MattermostClient(cfg.mattermostUrl, secrets.officeBot.token)
  const fj = new ForgejoClient(cfg.forgejoUrl, secrets.forgejo.adminToken)
  const clients: DispatcherClients = {
    mm,
    fj,
    botUserId: secrets.officeBot.userId,
    teamId: secrets.mattermost.teamId,
  }
  return { root, cfg, clients, stateFile: statePath(root) }
}
