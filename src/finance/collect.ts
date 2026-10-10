// Finance snapshot collector: gathers read-only data from Claude, OpenCode Go and
// OpenRouter and shapes it into the GroupRow/AgentRow view the console command and
// daily report render. Every external call is wrapped so missing data degrades to
// "-" plus a note, rather than failing the whole snapshot.

import path from 'node:path'
import type { AgentRecord, OfficeConfig, ResourceGroup } from '../lib/types.js'
import { listAgents, loadAgent, agentStateDir } from '../lib/config.js'
import { capturePane, paneAlive, windowTarget } from '../lib/tmux.js'
import { tailMcpLog } from '../admin/monitor.js'
import { claudeConfigDir, groupIdForAgent, isDefaultGroup } from './groups.js'
import {
  parseClaudeWeeklyUsageFromPane,
  readAgentClaudeTokenUsage,
  readClaudeAccountInfo,
  sumTokenUsage,
  type ClaudeTokenUsage,
} from './claude.js'
import { detectOpencodeHealth, parseAgentOpencodeUsage, readOpencodeStats, type OpencodeStats } from './opencode.js'
import { fetchOpenrouterCredits, fetchOpenrouterKeyUsage, readOpenrouterKey } from './openrouter.js'
import { getSecret } from '../lib/vault.js'
import { OpencodeClient } from '../lib/harness/opencode.js'
import type { GroupRow, AgentRow, LimitRow } from './render.js'
import { claudeUsageCacheFile, getClaudeUsageLimits } from './claude-usage-probe.js'
import { fetchOpencodeGoUsage, readOpencodeGoKey } from './opencode-go-usage.js'
import { buildOpencodeGoGroupLimits, resolveOpencodeDbPath } from './opencode-limits.js'
import { buildClaudeLimitRows, buildOpencodeGoLimitRowsEstimate, buildOpencodeGoLimitRowsExact, buildOpenrouterLimitRows } from './limits.js'
import { headroomFromSnapshot, writeHeadroom } from './headroom.js'

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
  // Vault first (home-server installs), then opencode's own auth.json (laptop installs) — the
  // auth.json fallback only applies to the DEFAULT group of a kind, since it holds one key.
  const vaulted = (id: string) => { try { return getSecret(root, id) } catch { return undefined } }
  const openrouterKeyFor = (g: ResourceGroup) => vaulted(g.id) ?? (isDefaultGroup(g, groups) ? readOpenrouterKey() : undefined)
  const opencodeGoKeyFor = (g: ResourceGroup) => vaulted(g.id) ?? (isDefaultGroup(g, groups) ? readOpencodeGoKey() : undefined)

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

  // Best-effort: a headroom-file write issue should never fail the finance snapshot itself.
  try {
    writeHeadroom(root, headroomFromSnapshot(limits, groupsWeek))
  } catch { /* ignore */ }

  return { groupsToday, groupsWeek, agentsToday, agentsWeek, agentsMerged: mergeAgentRows(agentsToday, agentsWeek), limits }

  /** Every Claude group's config dir, for cross-group session-transcript lookups. */
  function claudeGroupDirs(): (string | undefined)[] {
    return groups.filter((g) => g.kind === 'claude-subscription').map((g) => claudeConfigDir(root, g))
  }

  async function collectLimits(): Promise<LimitRow[]> {
    const rows: LimitRow[] = []
    for (const g of groups) {
      if (g.kind === 'claude-subscription') {
        const isDefault = isDefaultGroup(g, groups)
        const dir = claudeConfigDir(root, g)
        const cacheFile = claudeUsageCacheFile(root, isDefault ? undefined : g.id)
        const usage = await getClaudeUsageLimits(root, cacheFile, dir).catch(() => undefined)
        rows.push(...buildClaudeLimitRows(g.label, usage).map((r) => ({ ...r, groupId: g.id })))
      } else if (g.kind === 'opencode-go') {
        const isDefault = isDefaultGroup(g, groups)
        const exact = await fetchOpencodeGoUsage(opencodeGoKeyFor(g)).catch(() => undefined)
        if (exact) {
          rows.push(...buildOpencodeGoLimitRowsExact(g.label, exact).map((r) => ({ ...r, groupId: g.id })))
        } else if (isDefault) {
          // Local-DB $-estimate fallback: only meaningful for the default group, since the
          // local opencode SQLite store isn't broken down by resource group.
          const configuredModels = new Set<string>(
            all.filter((a) => a.harness === 'opencode' && groupIdForAgent(a, groups) === g.id).map((a) => a.model.replace(/^opencode-go\//, '')),
          )
          if (cfg.defaults.opencodeModel.startsWith('opencode-go/')) configuredModels.add(cfg.defaults.opencodeModel.slice('opencode-go/'.length))
          const groupLimits = buildOpencodeGoGroupLimits(resolveOpencodeDbPath(), cfg.finance.opencodeGoMonthlyDollarCap, configuredModels)
          rows.push(...buildOpencodeGoLimitRowsEstimate(g.label, groupLimits).map((r) => ({ ...r, groupId: g.id })))
        } else {
          rows.push({
            group: g.label, groupId: g.id, window: 'usage', usedText: '–', limitText: '–', remainingText: '–', resets: '–',
            note: 'exact usage unavailable (no key set for this group), and the local-DB estimate only covers the default OpenCode Go group',
          })
        }
      } else if (g.kind === 'openrouter') {
        const key = openrouterKeyFor(g)
        const [credits, keyUse] = await Promise.all([fetchOpenrouterCredits(key).catch(() => undefined), fetchOpenrouterKeyUsage(key).catch(() => undefined)])
        rows.push(...buildOpenrouterLimitRows(g.label, credits, keyUse).map((r) => ({ ...r, groupId: g.id })))
      }
    }
    return rows
  }

  async function collectClaudeGroup(g: ResourceGroup, members: AgentRecord[]) {
    const label = g.label
    const dir = claudeConfigDir(root, g)
    const account = readClaudeAccountInfo(dir)
    let usagePercent: number | undefined
    for (const a of members) {
      const target = windowTarget(cfg.tmuxSession, a.name)
      if (!(await paneAlive(target).catch(() => false))) continue
      const pane = await capturePane(target, 40).catch(() => '')
      const pct = parseClaudeWeeklyUsageFromPane(pane)
      if (pct !== undefined) usagePercent = usagePercent === undefined ? pct : Math.max(usagePercent, pct)
    }

    // Search this group's own dir first, then every other Claude group's dir — a session
    // copied by `office group move` shouldn't be missed, or double-counted, across groups.
    const configDirs = [dir, ...claudeGroupDirs().filter((d) => d !== dir)]
    const perAgentUsage = new Map<string, ClaudeTokenUsage[]>()
    for (const a of members) {
      const ids = [a.sessionId, ...a.pastSessions].filter((x): x is string => !!x)
      perAgentUsage.set(a.name, readAgentClaudeTokenUsage(a.name, ids, configDirs))
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

  async function collectOpencodeGoGroup(g: ResourceGroup, members: AgentRecord[]) {
    const label = g.label
    const isDefault = isDefaultGroup(g, groups)

    let health: 'ok' | 'exhausted' | 'throttled' = 'ok'
    for (const a of members) {
      const target = windowTarget(cfg.tmuxSession, a.name)
      const pane = (await paneAlive(target).catch(() => false)) ? await capturePane(target, 60).catch(() => '') : ''
      const log = tailMcpLog(path.join(agentStateDir(a.name), 'mcp.log'), 40).join('\n')
      const h = detectOpencodeHealth(`${pane}\n${log}`)
      if (h === 'exhausted') health = 'exhausted'
      else if (h === 'throttled' && health === 'ok') health = 'throttled'
    }

    const perAgentToday: AgentRow[] = []
    const perAgentWeek: AgentRow[] = []
    const day = todayLocal()
    const week7 = last7DaysSet()
    let anyAgentUsage = false
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
        anyAgentUsage = true
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

    let tokensDay: number | undefined
    let costDay: number | undefined
    let tokensWeek: number | undefined
    let costWeek: number | undefined
    let note: string | undefined

    if (isDefault) {
      // `opencode stats` is office-wide (all opencode sessions, not just office agents), so
      // group totals are shown as estimates of this group's actual spend. Only meaningful for
      // the default group — other groups have no way to isolate their share of it.
      const statsDay: OpencodeStats | undefined = readOpencodeStats(1, true)
      const statsWeek: OpencodeStats | undefined = readOpencodeStats(7, true)
      costDay = statsDay?.overview.totalCost
      tokensDay = statsDay ? (statsDay.overview.inputTokens ?? 0) + (statsDay.overview.outputTokens ?? 0) : undefined
      costWeek = statsWeek?.overview.totalCost
      tokensWeek = statsWeek ? (statsWeek.overview.inputTokens ?? 0) + (statsWeek.overview.outputTokens ?? 0) : undefined
      note = !statsDay ? '`opencode stats` unavailable' : undefined
    } else {
      // Non-default groups: `opencode stats` can't be scoped to one group, so totals are the
      // sum of this group's own agents' per-agent rows, still marked as estimates.
      tokensDay = anyAgentUsage ? perAgentToday.reduce((s, r) => s + (r.tokensToday ?? 0), 0) : undefined
      costDay = anyAgentUsage ? perAgentToday.reduce((s, r) => s + (r.estCost ?? 0), 0) : undefined
      tokensWeek = anyAgentUsage ? perAgentWeek.reduce((s, r) => s + (r.tokens7d ?? 0), 0) : undefined
      costWeek = anyAgentUsage ? perAgentWeek.reduce((s, r) => s + (r.estCost ?? 0), 0) : undefined
      note = anyAgentUsage ? undefined : 'no agent usage data available (opencode server unreachable for every member)'
    }

    const today: GroupRow = {
      id: g.id, label, status: health, agents: members.map((m) => m.name),
      tokensToday: tokensDay, tokensTodayIsEstimate: true,
      costToday: costDay, costTodayIsEstimate: true,
      tokens7d: tokensWeek, tokens7dIsEstimate: true,
      cost7d: costWeek, cost7dIsEstimate: true,
      note,
    }
    const week: GroupRow = { ...today }
    return { today, week, perAgentToday, perAgentWeek }
  }

  async function collectOpenrouterGroup(g: ResourceGroup, members: AgentRecord[]) {
    const label = g.label
    const key = openrouterKeyFor(g)
    const credits = await fetchOpenrouterCredits(key)
    const keyUse = await fetchOpenrouterKeyUsage(key)
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
