// Pure markdown rendering for the `finance` console command and daily report.
// Numbers that are estimates (derived rather than directly reported) are marked with "~".

export interface GroupRow {
  id: string
  label: string
  status: 'ok' | 'exhausted' | 'throttled' | 'unknown'
  usagePercent?: number // 0-100, undefined when unknown
  usageIsEstimate?: boolean
  tokensToday?: number
  tokensTodayIsEstimate?: boolean
  costToday?: number
  costTodayIsEstimate?: boolean
  tokens7d?: number
  tokens7dIsEstimate?: boolean
  cost7d?: number
  cost7dIsEstimate?: boolean
  agents: string[]
  note?: string // reason for missing data, shown when fields are "-"
}

export interface AgentRow {
  name: string
  group: string // group label
  model: string
  tokensToday?: number
  tokensTodayIsEstimate?: boolean
  tokens7d?: number
  tokens7dIsEstimate?: boolean
  estCost?: number
}

const DASH = '–'

function fmtNum(n: number | undefined, estimate?: boolean): string {
  if (n === undefined) return DASH
  const prefix = estimate ? '~' : ''
  if (n >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${prefix}${(n / 1_000).toFixed(1)}K`
  return `${prefix}${Math.round(n)}`
}

function fmtCost(n: number | undefined, estimate?: boolean): string {
  if (n === undefined) return DASH
  return `${estimate ? '~' : ''}$${n.toFixed(2)}`
}

function fmtPercent(n: number | undefined, estimate?: boolean): string {
  if (n === undefined) return DASH
  return `${estimate ? '~' : ''}${Math.round(n)}%`
}

const STATUS_ICON: Record<GroupRow['status'], string> = {
  ok: '🟢',
  exhausted: '🔴',
  throttled: '🟠',
  unknown: '⚪',
}

/** Render the per-group finance table. */
export function renderGroupTable(rows: GroupRow[]): string {
  const headers = ['Group', 'Status', 'Usage', 'Tokens today', 'Cost today', 'Tokens 7d', 'Cost 7d', 'Agents']
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => {
      const status = `${STATUS_ICON[r.status]} ${r.status}`
      const usage = fmtPercent(r.usagePercent, r.usageIsEstimate)
      return `| **${r.label}** | ${status} | ${usage} | ${fmtNum(r.tokensToday, r.tokensTodayIsEstimate)} | ${fmtCost(r.costToday, r.costTodayIsEstimate)} | ${fmtNum(r.tokens7d, r.tokens7dIsEstimate)} | ${fmtCost(r.cost7d, r.cost7dIsEstimate)} | ${r.agents.map((a) => `@${a}`).join(', ') || DASH} |`
    }),
  ]
  const notes = rows.filter((r) => r.note).map((r) => `_${r.label}: ${r.note}_`)
  if (notes.length) lines.push('', ...notes)
  return lines.join('\n')
}

/** Render the per-agent finance table. */
export function renderAgentTable(rows: AgentRow[]): string {
  const headers = ['Agent', 'Group', 'Model', 'Tokens today', 'Tokens 7d', 'Est. cost']
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(
      (r) =>
        `| @${r.name} | ${r.group} | ${r.model} | ${fmtNum(r.tokensToday, r.tokensTodayIsEstimate)} | ${fmtNum(r.tokens7d, r.tokens7dIsEstimate)} | ${fmtCost(r.estCost, true)} |`,
    ),
  ]
  return lines.join('\n')
}

/** Render the combined `finance` (today) or `finance week` report. */
export function renderFinanceReport(
  scope: 'today' | 'week',
  groups: GroupRow[],
  agents: AgentRow[],
  opts: { footer?: string; limits?: LimitRow[] } = {},
): string {
  const title = scope === 'today' ? '## Finance — today' : '## Finance — last 7 days'
  const lines = [title, '', '### Resource groups', '', renderGroupTable(groups), '', '### Agents', '', renderAgentTable(agents)]
  if (opts.limits?.length) lines.push('', '### Limits', '', renderLimitsTable(opts.limits))
  if (opts.footer) lines.push('', opts.footer)
  lines.push('', '_~ marks an estimate (derived from another source, not directly reported)._')
  return lines.join('\n')
}

/** Render a single group's detail view for `finance <group>`. */
export function renderGroupDetail(row: GroupRow, agents: AgentRow[]): string {
  const lines = [`## Finance — ${row.label}`, '', renderGroupTable([row])]
  if (agents.length) lines.push('', '### Agents in this group', '', renderAgentTable(agents))
  return lines.join('\n')
}

/** Render a single agent's detail view for `finance <agent>`. */
export function renderAgentDetail(row: AgentRow): string {
  return [`## Finance — @${row.name}`, '', renderAgentTable([row])].join('\n')
}

// ---------------------------------------------------------------- rolling-window limits

/** One row of the Limits section: a resource group's usage against a rolling-window cap. */
export interface LimitRow {
  group: string // e.g. "Claude subscription", "OpenCode Go", "OpenRouter"
  window: string // e.g. "5-hour session", "week (all models)", "Rolling (5h)", "Weekly", "balance"
  usedText: string // "-" when only a % is known (Claude), else a dollar figure
  limitText: string // "-" when only a % is known, else a dollar figure
  percent?: number // 0-100+, undefined when unknown
  remainingText: string // "-", a "%", or a dollar figure, matching used/limit's unit
  resets: string // reset description, "rolling", "monthly", or "-"
  status?: 'ok' | 'rate-limited' | 'exhausted'
  isEstimate?: boolean
  note?: string
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)))
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled)
}

function fmtLimitPercent(percent: number | undefined, estimate?: boolean): string {
  if (percent === undefined) return DASH
  return `${bar(percent)} ${estimate ? '~' : ''}${Math.round(percent)}%`
}

const LIMIT_STATUS_ICON: Record<string, string> = { ok: '🟢', 'rate-limited': '🟠', exhausted: '🔴' }

/** Render the "Limits" table: one row per resource group x rolling window. */
export function renderLimitsTable(rows: LimitRow[]): string {
  const headers = ['Resource group', 'Window', 'Used', 'Limit', '% used', 'Remaining', 'Resets']
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => {
      const status = r.status ? `${LIMIT_STATUS_ICON[r.status] ?? ''} ` : ''
      return `| **${r.group}** | ${status}${r.window} | ${r.usedText} | ${r.limitText} | ${fmtLimitPercent(r.percent, r.isEstimate)} | ${r.remainingText} | ${r.resets} |`
    }),
  ]
  const notes = rows.filter((r) => r.note).map((r) => `_${r.group} · ${r.window}: ${r.note}_`)
  if (notes.length) lines.push('', ...notes)
  return lines.join('\n')
}

/** Standalone `finance limits` view. */
export function renderLimitsSection(rows: LimitRow[]): string {
  return ['## Finance — limits', '', renderLimitsTable(rows), '', '_~ marks an estimate; % used shown with a text bar._'].join('\n')
}
