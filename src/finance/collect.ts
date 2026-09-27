// Finance snapshot collector: gathers read-only data from Claude, OpenCode Go and
// OpenRouter and shapes it into the GroupRow/AgentRow view the console command and
// daily report render. Every external call is wrapped so missing data degrades to
// "-" plus a note, rather than failing the whole snapshot.

import path from 'node:path'
import type { AgentRecord, OfficeConfig } from '../lib/types.js'
import { listAgents, loadAgent, agentStateDir } from '../lib/config.js'
import { capturePane, paneAlive, windowTarget } from '../lib/tmux.js'
import { tailMcpLog } from '../admin/monitor.js'
import { groupIdForAgent } from './groups.js'
import {
  parseClaudeWeeklyUsageFromPane,
  readAgentClaudeTokenUsage,
  readClaudeAccountInfo,
  sumTokenUsage,
  type ClaudeTokenUsage,
} from './claude.js'
import { detectOpencodeHealth, parseAgentOpencodeUsage, readOpencodeStats, type OpencodeStats } from './opencode.js'
import { fetchOpenrouterCredits, fetchOpenrouterKeyUsage } from './openrouter.js'
import { OpencodeClient } from '../lib/harness/opencode.js'
import type { GroupRow, AgentRow, LimitRow } from './render.js'
import { getClaudeUsageLimits } from './claude-usage-probe.js'
import { fetchOpencodeGoUsage } from './opencode-go-usage.js'
import { buildOpencodeGoGroupLimits, resolveOpencodeDbPath } from './opencode-limits.js'
import { buildClaudeLimitRows, buildOpencodeGoLimitRowsEstimate, buildOpencodeGoLimitRowsExact, buildOpenrouterLimitRows } from './limits.js'

export interface FinanceSnapshot {
  groupsToday: GroupRow[]
  groupsWeek: GroupRow[]
  agentsToday: AgentRow[]
  agentsWeek: AgentRow[]
  /** Per-agent rows with both today and 7d columns filled in, for the combined report view. */
  agentsMerged: AgentRow[]
  /** Rolling-window plan-limit rows (Claude session/week, OpenCode Go rolling/weekly/monthly, OpenRouter balance). */
  limits: LimitRow[]
}

/** Combine the today-scoped and week-scoped agent rows (same agent) into one row each. */
export function mergeAgentRows(today: AgentRow[], week: AgentRow[]): AgentRow[] {
  const byName = new Map<string, AgentRow>()
  for (const r of week) byName.set(r.name, { ...r })
  for (const r of today) byName.set(r.name, { ...(byName.get(r.name) ?? r), ...r })
  return [...byName.values()]
}

function todayLocal(): string {
  return new Date().toISOString().slice(0, 10)
}

function last7DaysSet(): Set<string> {
  const out = new Set<string>()
  const now = Date.now()
  for (let i = 0; i < 7; i++) out.add(new Date(now - i * 86_400_000).toISOString().slice(0, 10))
  return out
}

/** Collect the full finance snapshot for the office. Read-only, never mutates agent state. */
export async function collectFinanceSnapshot(root: string, cfg: OfficeConfig): Promise<FinanceSnapshot> {
  const names = await listAgents()
  const all = (await Promise.all(names.map((n) => loadAgent(n)))).filter((a): a is AgentRecord => !!a && a.status === 'hired')
  const groups = cfg.resourceGroups

  const groupsToday: GroupRow[] = []
  const groupsWeek: GroupRow[] = []
  const agentsToday: AgentRow[] = []
  const agentsWeek: AgentRow[] = []

  for (const g of groups) {
    const members = all.filter((a) => groupIdForAgent(a, groups) === g.id)
    if (g.kind === 'claude-subscription') {
      const { today, week, perAgentToday, perAgentWeek } = await collectClaudeGroup(g, members)
      groupsToday.push(today)
      groupsWeek.push(week)
      agentsToday.push(...perAgentToday)
      agentsWeek.push(...perAgentWeek)
    } else if (g.kind === 'opencode-go') {
      const { today, week, perAgentToday, perAgentWeek } = await collectOpencodeGoGroup(g, members)
      groupsToday.push(today)
      groupsWeek.push(week)
      agentsToday.push(...perAgentToday)
      agentsWeek.push(...perAgentWeek)
    } else if (g.kind === 'openrouter') {
      const { today, week, perAgentToday, perAgentWeek } = await collectOpenrouterGroup(g, members)
      groupsToday.push(today)
      groupsWeek.push(week)
      agentsToday.push(...perAgentToday)
      agentsWeek.push(...perAgentWeek)
    }
  }

  const limits = await collectLimits()

  return { groupsToday, groupsWeek, agentsToday, agentsWeek, agentsMerged: mergeAgentRows(agentsToday, agentsWeek), limits }

  async function collectLimits(): Promise<LimitRow[]> {
    const rows: LimitRow[] = []
    const claudeGroup = groups.find((g) => g.kind === 'claude-subscription')
    const opencodeGroup = groups.find((g) => g.kind === 'opencode-go')
    const openrouterGroup = groups.find((g) => g.kind === 'openrouter')

    if (claudeGroup) {
      const usage = await getClaudeUsageLimits(root).catch(() => undefined)
      rows.push(...buildClaudeLimitRows(claudeGroup.label, usage))
    }
    if (opencodeGroup) {
      const exact = await fetchOpencodeGoUsage().catch(() => undefined)
      if (exact) {
        rows.push(...buildOpencodeGoLimitRowsExact(opencodeGroup.label, exact))
      } else {
        const configuredModels = new Set<string>(
          all.filter((a) => a.harness === 'opencode').map((a) => a.model.replace(/^opencode-go\//, '')),
        )
        if (cfg.defaults.opencodeModel.startsWith('opencode-go/')) configuredModels.add(cfg.defaults.opencodeModel.slice('opencode-go/'.length))
        const groupLimits = buildOpencodeGoGroupLimits(resolveOpencodeDbPath(), cfg.finance.opencodeGoMonthlyDollarCap, configuredModels)
        rows.push(...buildOpencodeGoLimitRowsEstimate(opencodeGroup.label, groupLimits))
      }
    }
    if (openrouterGroup) {
      const [credits, keyUse] = await Promise.all([fetchOpenrouterCredits().catch(() => undefined), fetchOpenrouterKeyUsage().catch(() => undefined)])
      rows.push(...buildOpenrouterLimitRows(openrouterGroup.label, credits, keyUse))
    }
    return rows
  }

  async function collectClaudeGroup(g: OfficeConfig['resourceGroups'][number], members: AgentRecord[]) {
    const label = g.label
    const account = readClaudeAccountInfo()
    let usagePercent: number | undefined
    for (const a of members) {
      const target = windowTarget(cfg.tmuxSession, a.name)
      if (!(await paneAlive(target).catch(() => false))) continue
      const pane = await capturePane(target, 40).catch(() => '')
      const pct = parseClaudeWeeklyUsageFromPane(pane)
      if (pct !== undefined) usagePercent = usagePercent === undefined ? pct : Math.max(usagePercent, pct)
    }

    const perAgentUsage = new Map<string, ClaudeTokenUsage[]>()
    for (const a of members) {
      const ids = [a.sessionId, ...a.pastSessions].filter((x): x is string => !!x)
      perAgentUsage.set(a.name, readAgentClaudeTokenUsage(a.name, ids))
    }

    const day = todayLocal()
    const week7 = last7DaysSet()
    const allEntries = [...perAgentUsage.values()].flat()
    const totalsToday = sumTokenUsage(allEntries.filter((e) => e.day === day))
    const totalsWeek = sumTokenUsage(allEntries.filter((e) => week7.has(e.day)))
    const tokensToday = totalsToday.inputTokens + totalsToday.outputTokens
    const tokensWeek = totalsWeek.inputTokens + totalsWeek.outputTokens

    const note = !account
      ? '`claude auth status` unavailable'
      : usagePercent === undefined
        ? 'weekly % not visible in any agent pane right now'
        : undefined

    const today: GroupRow = {
      id: g.id, label, status: 'ok', usagePercent, agents: members.map((m) => m.name),
      tokensToday: allEntries.length ? tokensToday : undefined,
      tokens7d: allEntries.length ? tokensWeek : undefined,
      note,
    }
    const week: GroupRow = { ...today }

    const perAgentToday: AgentRow[] = []
    const perAgentWeek: AgentRow[] = []
    for (const a of members) {
      const entries = perAgentUsage.get(a.name) ?? []
      const models = [...new Set(entries.map((e) => e.model))]
      const modelLabel = models.length ? models.join(', ') : a.model
      const tToday = sumTokenUsage(entries.filter((e) => e.day === day))
      const tWeek = sumTokenUsage(entries.filter((e) => week7.has(e.day)))
      perAgentToday.push({ name: a.name, group: label, model: modelLabel, tokensToday: entries.length ? tToday.inputTokens + tToday.outputTokens : undefined })
      perAgentWeek.push({ name: a.name, group: label, model: modelLabel, tokens7d: entries.length ? tWeek.inputTokens + tWeek.outputTokens : undefined })
    }
    return { today, week, perAgentToday, perAgentWeek }
  }

  async function collectOpencodeGoGroup(g: OfficeConfig['resourceGroups'][number], members: AgentRecord[]) {
    const label = g.label
    const statsDay: OpencodeStats | undefined = readOpencodeStats(1, true)
    const statsWeek: OpencodeStats | undefined = readOpencodeStats(7, true)

    let health: 'ok' | 'exhausted' | 'throttled' = 'ok'
    for (const a of members) {
      const target = windowTarget(cfg.tmuxSession, a.name)
      const pane = (await paneAlive(target).catch(() => false)) ? await capturePane(target, 60).catch(() => '') : ''
      const log = tailMcpLog(path.join(agentStateDir(a.name), 'mcp.log'), 40).join('\n')
      const h = detectOpencodeHealth(`${pane}\n${log}`)
      if (h === 'exhausted') health = 'exhausted'
      else if (h === 'throttled' && health === 'ok') health = 'throttled'
    }

    const costDay = statsDay?.overview.totalCost
    const tokensDay = statsDay ? (statsDay.overview.inputTokens ?? 0) + (statsDay.overview.outputTokens ?? 0) : undefined
    const costWeek = statsWeek?.overview.totalCost
    const tokensWeek = statsWeek ? (statsWeek.overview.inputTokens ?? 0) + (statsWeek.overview.outputTokens ?? 0) : undefined

    const note = !statsDay ? '`opencode stats` unavailable' : undefined
    // `opencode stats` is office-wide (all opencode sessions, not just office agents), so
    // group totals are shown as estimates of this group's actual spend.
    const today: GroupRow = {
      id: g.id, label, status: health, agents: members.map((m) => m.name),
      tokensToday: tokensDay, tokensTodayIsEstimate: true,
      costToday: costDay, costTodayIsEstimate: true,
      tokens7d: tokensWeek, tokens7dIsEstimate: true,
      cost7d: costWeek, cost7dIsEstimate: true,
      note,
    }
    const week: GroupRow = { ...today }

    const perAgentToday: AgentRow[] = []
    const perAgentWeek: AgentRow[] = []
    const day = todayLocal()
    const week7 = last7DaysSet()
    for (const a of members) {
      if (!a.opencodePort || !a.sessionId) {
        perAgentToday.push({ name: a.name, group: label, model: a.model })
        perAgentWeek.push({ name: a.name, group: label, model: a.model })
        continue
      }
      try {
        const client = new OpencodeClient(`http://127.0.0.1:${a.opencodePort}`)
        const messages = await client.messages(a.sessionId)
        const usage = parseAgentOpencodeUsage(messages)
        const uToday = usage.filter((u) => u.day === day)
        const uWeek = usage.filter((u) => week7.has(u.day))
        const modelLabel = [...new Set(usage.map((u) => u.model))].join(', ') || a.model
        perAgentToday.push({
          name: a.name, group: label, model: modelLabel,
          tokensToday: uToday.reduce((s, u) => s + u.tokens, 0),
          estCost: uToday.reduce((s, u) => s + u.cost, 0),
        })
        perAgentWeek.push({
          name: a.name, group: label, model: modelLabel,
          tokens7d: uWeek.reduce((s, u) => s + u.tokens, 0),
          estCost: uWeek.reduce((s, u) => s + u.cost, 0),
        })
      } catch {
        perAgentToday.push({ name: a.name, group: label, model: a.model })
        perAgentWeek.push({ name: a.name, group: label, model: a.model })
      }
    }
    return { today, week, perAgentToday, perAgentWeek }
  }

  async function collectOpenrouterGroup(g: OfficeConfig['resourceGroups'][number], members: AgentRecord[]) {
    const label = g.label
    const credits = await fetchOpenrouterCredits()
    const keyUse = await fetchOpenrouterKeyUsage()
    // Usage % = this key's month against its cap. The account's lifetime counter (/credits) covers every
    // key the owner has ever used, so it only tells us the balance left, not what the office spent.
    const usagePercent = keyUse?.limit ? (keyUse.usageMonthly / keyUse.limit) * 100 : undefined
    const balance = credits ? credits.remaining : undefined
    const lowBalance = balance !== undefined && balance < 1
    const parts = [
      balance !== undefined ? `account balance $${balance.toFixed(2)} left` : 'account balance unknown',
      keyUse ? `this key: $${keyUse.usageMonthly.toFixed(2)} this month${keyUse.limit ? ` of $${keyUse.limit} cap` : ''}` : 'key usage unavailable',
    ]
    const row: GroupRow = {
      id: g.id, label, status: lowBalance ? 'exhausted' : 'ok', usagePercent,
      costToday: keyUse?.usageDaily, cost7d: keyUse?.usageWeekly,
      agents: members.map((m) => m.name), note: parts.join('; '),
    }
    const perAgentToday = members.map((a) => ({ name: a.name, group: label, model: a.model }))
    const perAgentWeek = members.map((a) => ({ name: a.name, group: label, model: a.model }))
    return { today: row, week: { ...row }, perAgentToday, perAgentWeek }
  }
}
