// Monitoring + debugging helpers for the agent office.
// Pure pane parsers plus admin-side I/O wrappers used by `office status`,
// `office inspect` and the admin daemon watchdog.

import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord, AgentStatus, ChatPost, InboundEvent } from '../lib/types.js'
import type { Comment, Issue } from '../lib/forgejo.js'

/** Normalised result of reading a tmux pane. */
export interface PaneSnapshot {
  text: string
  lines: string[]
  tail: string
}

/** Condition detected from the pane text. */
export type PaneCondition = 'working' | 'dialog' | 'idle-prompt' | 'error/limit' | 'unknown'

/** Parsed context/usage numbers shown by the harness TUI. */
export interface PaneMetrics {
  /** e.g. "4% (41.5K)" or "–". */
  context: string
  /** Claude weekly usage 0-100, or undefined. */
  weeklyPercent?: number
  /** Lines that look like errors or rate/quota limits. */
  errorLines: string[]
  /** Overall pane condition. */
  condition: PaneCondition
}

/** One rendered status row. */
export interface RichStatusRow {
  name: string
  harness: string
  modelShort: string
  stateIcon: string
  stateLabel: string
  stateAge: string
  doing: string
  lastPostAge: string
  lastPostChannel: string
  context: string
  alerts: string[]
}

// ------------------------------------------------------------------ pane parsers

const ERROR_REGEXES = [
  /usage limit/i,
  /weekly limit/i,
  /rate limit/i,
  /\b429\b/,
  /quota/i,
  /overloaded/i,
  /Error:/i,
  /ECONNREFUSED/i,
]

const SPINNER_PATTERNS = [
  /esc to interrupt/i,
  /…\s*\((\d+m\s*)?\d+s\s*·/,
  /sautéed for/i,
  /thinking/i,
  /ruminating/i,
]

const DIALOG_MARKERS = [
  'Do you want to',
  '❯ 1. Yes',
  'Yes, I trust this folder',
  'Enter to confirm',
  'Esc to cancel',
  'Allow for this conversation?',
  'permanently?',
]

const IDLE_PROMPT_MARKERS = [
  />\s*$/, // Claude prompt caret at end of line
  /❯\s*$/, // opencode prompt caret
  /Called office \d+ times/, // opencode idle summary line
  /# Todos/, // opencode todo list visible
]

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
const BOX_RE = /[┃┣┗┏┓┛┃│╔╗╚╝║═┈┉┊┋]/g

/** Strip ANSI escapes and box-drawing characters from pane text. */
export function cleanPane(text: string): string {
  return text.replace(ANSI_RE, '').replace(BOX_RE, ' ')
}

/** Collapse blank runs and trim each line. */
export function tidyPaneLines(text: string): string[] {
  const lines = cleanPane(text).split('\n').map(l => l.trimEnd())
  const out: string[] = []
  let blanks = 0
  for (const l of lines) {
    if (l === '') { blanks++; continue }
    if (blanks > 0 && out.length > 0) out.push('')
    blanks = 0
    out.push(l)
  }
  return out
}

/** Truncate a line to max chars, adding an ellipsis. */
export function truncateLine(line: string, max = 200): string {
  if (line.length <= max) return line
  return line.slice(0, max - 1) + '…'
}

/** Format milliseconds as a compact age: 34m, 2h, 1d. */
export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60 * 10) / 10
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24 * 10) / 10
  return `${d}d`
}

/** Parse an opencode TUI footer like "41,485 tokens  4% used". */
export function parseOpencodeFooter(text: string): { usedPercent?: number; tokens?: number } {
  const m = text.match(/([\d,]+)\s*tokens.*?([\d.]+)%\s*used/s)
  if (m) {
    return {
      tokens: Number(m[1].replace(/,/g, '')),
      usedPercent: Number(m[2]),
    }
  }
  // Some variants show "Context  202.0K (77%)".
  const m2 = text.match(/Context\s+([\d.]+[KM]?)\s*\(([\d.]+)%\)/)
  if (m2) return { usedPercent: Number(m2[2]) }
  return {}
}

/** Parse Claude "Context left" / "% context" strings. */
export function parseClaudeContext(text: string): { usedPercent?: number; tokensLeft?: number } {
  // "Context left 12,345 / 12%"
  const m1 = text.match(/Context left\s+([\d,]+)\s*\/\s*([\d.]+)%/i)
  if (m1) return { tokensLeft: Number(m1[1].replace(/,/g, '')), usedPercent: Number(m1[2]) }
  // "15% context used"
  const m2 = text.match(/([\d.]+)%\s*context/i)
  if (m2) return { usedPercent: Number(m2[1]) }
  // "Context  202.0K (77%)" (opencode-style may also appear in Claude)
  const m3 = text.match(/Context\s+([\d.]+[KM]?)\s*\(([\d.]+)%\)/)
  if (m3) return { usedPercent: Number(m3[2]) }
  return {}
}

/** Parse "You've used N% of your weekly limit" and variants. */
export function parseWeeklyPercent(text: string): number | undefined {
  const m = text.match(/used\s+([\d.]+)%\s+of\s+your\s+weekly\s+limit/i)
  if (m) return Number(m[1])
  const m2 = text.match(/weekly\s+limit\s+([\d.]+)%/i)
  if (m2) return Number(m2[1])
  return undefined
}

/** Find lines that look like errors or quota/limit text. */
export function findErrorLines(text: string): string[] {
  const lines = cleanPane(text).split('\n')
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (ERROR_REGEXES.some(re => re.test(line)) && !seen.has(line)) {
      seen.add(line)
      out.push(truncateLine(line))
    }
  }
  return out
}

/** Detect whether the pane shows working spinner, dialog, idle prompt, etc. */
export function detectPaneCondition(text: string): PaneCondition {
  const tail = text.split('\n').slice(-25).join('\n')
  if (DIALOG_MARKERS.some(m => tail.includes(m))) return 'dialog'
  if (SPINNER_PATTERNS.some(re => re.test(tail))) return 'working'
  if (ERROR_REGEXES.some(re => re.test(tail))) return 'error/limit'
  const lastFew = tail.split('\n').slice(-5)
  if (lastFew.some(l => IDLE_PROMPT_MARKERS.some(re => re.test(l)))) return 'idle-prompt'
  return 'unknown'
}

/** Parse all metrics from a captured pane. */
export function parsePaneMetrics(text: string, harness: 'claude' | 'opencode'): PaneMetrics {
  const weeklyPercent = parseWeeklyPercent(text)
  const errorLines = findErrorLines(text)
  let condition = detectPaneCondition(text)
  if (errorLines.length && condition !== 'dialog') condition = 'error/limit'

  let context = '–'
  if (harness === 'opencode') {
    const o = parseOpencodeFooter(text)
    if (o.usedPercent !== undefined) {
      const size = o.tokens !== undefined ? formatTokenCount(o.tokens) : ''
      context = `${Math.round(o.usedPercent)}%${size ? ` (${size})` : ''}`
    } else {
      const c = parseClaudeContext(text)
      if (c.usedPercent !== undefined) context = `${Math.round(c.usedPercent)}%`
    }
  } else {
    const c = parseClaudeContext(text)
    if (c.usedPercent !== undefined) {
      const size = c.tokensLeft !== undefined ? formatTokenCount(c.tokensLeft) + ' left' : ''
      context = `${Math.round(c.usedPercent)}%${size ? ` (${size})` : ''}`
    }
  }

  return { context, weeklyPercent, errorLines, condition }
}

/** DM channel names are the two participants' 26-char user ids joined by "__". */
const DM_CHANNEL_RE = /^[a-z0-9]{26}__[a-z0-9]{26}$/

/** True when a channel name looks like a Mattermost direct-message channel. */
export function isDmChannelName(name: string): boolean {
  return DM_CHANNEL_RE.test(name)
}

/** Given a DM channel name and one participant's id, return the other participant's id. */
export function otherDmParticipant(channelName: string, selfUserId: string): string | undefined {
  const [a, b] = channelName.split('__')
  if (a === undefined || b === undefined) return undefined
  if (a === selfUserId) return b
  if (b === selfUserId) return a
  return undefined
}

/** Render a channel name for display: "#name" normally, "DM @other" for a direct message. */
export function formatChannelLabel(channelName: string, dmOtherUsername?: string): string {
  if (dmOtherUsername) return `DM @${dmOtherUsername}`
  return `#${channelName}`
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ------------------------------------------------------------------ log / state readers

/** Read the last `n` delivered/queued lines from an mcp.log file. */
export function tailMcpLog(logFile: string, n = 12): string[] {
  if (!fs.existsSync(logFile)) return []
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  return lines.slice(-n)
}

/** Describe the most recent delivered event from an mcp.log. */
export function lastDeliveredFromLog(logFile: string): { kind: string; channel?: string; ticket?: string; at: string; line: string } | undefined {
  const lines = tailMcpLog(logFile, 60)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const delivered = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+delivered\s+(\d+)\s+events?/)
    if (delivered) {
      return { kind: 'events', at: delivered[1]!, line }
    }
    const digest = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+delivered digest of (\d+)/)
    if (digest) {
      return { kind: 'digest', at: digest[1]!, line }
    }
    const system = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+delivered system prompt\s+(.+)/)
    if (system) {
      return { kind: 'system', at: system[1]!, line: system[2]! }
    }
  }
  return undefined
}

/** Read pending events from pending.json. */
export function readPending(pendingFile: string): InboundEvent[] {
  if (!fs.existsSync(pendingFile)) return []
  try {
    return JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as InboundEvent[]
  } catch {
    return []
  }
}

/** Group pending events by kind, newest last. */
export function pendingByKind(events: InboundEvent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
  return counts
}

// ------------------------------------------------------------------ state rendering

const STATE_ICONS: Record<string, string> = {
  idle: '🟢',
  busy: '🔵',
  blocked: '🟠',
  down: '🔴',
  problem: '⚠️',
  starting: '🟡',
  stopped: '⚫',
}

/** Compute state icon + label + age from status, pane condition and liveness. */
export function resolveState(
  st: AgentStatus | undefined,
  condition: PaneCondition,
  alive: boolean,
  nowMs: number,
): { icon: string; label: string; age: string; alerts: string[] } {
  const alerts: string[] = []
  if (!alive) {
    const age = st?.at ? formatDuration(nowMs - Date.parse(st.at)) : ''
    return { icon: STATE_ICONS.down, label: 'down', age, alerts: ['window down'] }
  }

  const state = st?.state ?? 'unknown'
  const age = st?.at ? formatDuration(nowMs - Date.parse(st.at)) : ''

  if (condition === 'dialog' || state === 'blocked') {
    return { icon: STATE_ICONS.blocked, label: 'blocked (dialog)', age, alerts: age && nowMs - Date.parse(st!.at) > 2 * 60_000 ? ['blocked >2m'] : [] }
  }
  if (condition === 'error/limit') {
    alerts.push('pane error/limit')
    return { icon: STATE_ICONS.problem, label: 'problem', age, alerts }
  }
  if (state === 'busy') {
    const alertsOut = age && nowMs - Date.parse(st!.at) > 30 * 60_000 ? ['busy >30m'] : []
    return { icon: STATE_ICONS.busy, label: `busy ${age}`, age, alerts: alertsOut }
  }
  if (state === 'starting') return { icon: STATE_ICONS.starting, label: 'starting', age, alerts }
  if (state === 'stopped') return { icon: STATE_ICONS.stopped, label: 'stopped', age, alerts }
  return { icon: STATE_ICONS.idle, label: 'idle', age, alerts }
}

/** Build the "Doing" text for a status row. */
export function describeDoing(
  logFile: string,
  st: AgentStatus | undefined,
  pending: InboundEvent[],
  nowMs: number,
): string {
  const delivered = lastDeliveredFromLog(logFile)
  if (st?.state === 'busy' && st?.at) {
    const busyMin = Math.round((nowMs - Date.parse(st.at)) / 60000)
    if (delivered) return `turn running ${busyMin}m`
    return `busy ${busyMin}m`
  }
  if (delivered) {
    if (delivered.kind === 'digest') return 'digest delivered'
    if (delivered.kind === 'system') return `system: ${path.basename(delivered.line).replace(/\.md$/, '')}`
  }
  const lastPending = pending.slice(-1)[0]
  if (lastPending) {
    const t = lastPending.ticket ? `${lastPending.ticket.repo}#${lastPending.ticket.number}` : lastPending.channel ?? ''
    return `${lastPending.kind} ${t}`.trim()
  }
  if (delivered) return `last: ${delivered.kind}`
  return '–'
}

/** Build a rich status row from raw facts. */
export function buildRichStatusRow(
  rec: AgentRecord,
  opts: {
    alive: boolean
    status: AgentStatus | undefined
    paneMetrics: PaneMetrics
    lastPost?: ChatPost
    /** Resolved username of the other DM participant, when lastPost is in a DM channel. */
    lastPostDmOtherUsername?: string
    pending: InboundEvent[]
    logFile: string
    nowMs: number
  },
): RichStatusRow {
  const state = resolveState(opts.status, opts.paneMetrics.condition, opts.alive, opts.nowMs)
  const alerts = [...state.alerts]
  if (opts.paneMetrics.weeklyPercent !== undefined && opts.paneMetrics.weeklyPercent >= 90) {
    alerts.push(`weekly ${opts.paneMetrics.weeklyPercent}%`)
  }
  const ctxPercent = parseContextPercentString(opts.paneMetrics.context)
  if (ctxPercent !== undefined && ctxPercent >= 85) alerts.push(`context ${ctxPercent}%`)

  const doing = describeDoing(opts.logFile, opts.status, opts.pending, opts.nowMs)

  let lastPostAge = '–'
  let lastPostChannel = '–'
  if (opts.lastPost) {
    lastPostAge = formatDuration(opts.nowMs - opts.lastPost.createAt)
    lastPostChannel = formatChannelLabel(opts.lastPost.channel, opts.lastPostDmOtherUsername)
  }

  return {
    name: rec.name,
    harness: rec.harness,
    modelShort: shortenModel(rec.harness, rec.model),
    stateIcon: state.icon,
    stateLabel: state.label,
    stateAge: state.age,
    doing,
    lastPostAge,
    lastPostChannel,
    context: opts.paneMetrics.context,
    alerts,
  }
}

function shortenModel(harness: string, model: string): string {
  if (harness === 'claude') {
    return model.replace(/^claude-/, '').replace(/-20\d{6}$/, '')
  }
  const parts = model.split('/')
  return parts[parts.length - 1] ?? model
}

function parseContextPercentString(s: string): number | undefined {
  const m = s.match(/^(\d+)%/)
  if (m) return Number(m[1])
  return undefined
}

// ------------------------------------------------------------------ markdown rendering

/** Render rich status rows as a compact Mattermost markdown table. */
export function buildRichStatusMarkdown(rows: RichStatusRow[], opts: { footer?: string } = {}): string {
  if (rows.length === 0) return '_(no agents)_'
  const headers = ['Agent', 'State', 'Doing', 'Last post', 'Context', 'Alerts']
  const lines: string[] = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(r => {
      const agent = `**@${r.name}** ${r.modelShort}`
      const state = `${r.stateIcon} ${r.stateLabel}`
      const alerts = r.alerts.length ? r.alerts.join(', ') : '–'
      return `| ${agent} | ${state} | ${r.doing} | ${r.lastPostAge} ${r.lastPostChannel} | ${r.context} | ${alerts} |`
      // r.lastPostChannel already carries its own "#" or "DM @user" prefix (see formatChannelLabel).
    }),
  ]
  if (opts.footer) lines.push('', opts.footer)
  return lines.join('\n')
}

/** Render rich status rows as plain console text. */
export function buildRichStatusPlain(rows: RichStatusRow[], opts: { footer?: string } = {}): string {
  if (rows.length === 0) return '(no agents)'
  const lines = rows.map(r => {
    const alerts = r.alerts.length ? ` [${r.alerts.join(', ')}]` : ''
    return `@${r.name} (${r.harness}/${r.modelShort}): ${r.stateIcon} ${r.stateLabel}  doing: ${r.doing}  last: ${r.lastPostAge} ${r.lastPostChannel}  ctx: ${r.context}${alerts}`
  })
  if (opts.footer) lines.push('', opts.footer)
  return lines.join('\n')
}

// ------------------------------------------------------------------ inspect report

export interface InspectReport {
  identity: string
  state: string
  condition: string
  context: string
  terminal: string[]
  log: string[]
  pending: Record<string, number>
  lastPosts: { time: string; channel: string; text: string }[]
  workItems: { repo: string; number: number; title: string; age: string; url?: string }[]
  weeklyLine?: string
}

/** Format an inspect markdown report. */
export function formatInspectReport(name: string, report: InspectReport): string {
  const lines: string[] = [`## @${name}`]
  lines.push('', report.identity)
  lines.push('', `**State:** ${report.state}  `)
  lines.push(`**Pane condition:** ${report.condition}  `)
  lines.push(`**Context:** ${report.context}`)
  if (report.weeklyLine) lines.push('', `> ${report.weeklyLine}`)

  lines.push('', '### Terminal (last 25 lines)')
  lines.push('```')
  lines.push(...(report.terminal.length ? report.terminal : ['(empty)']))
  lines.push('```')

  lines.push('', '### Office helper log (last 12)')
  lines.push('```')
  lines.push(...(report.log.length ? report.log : ['(empty)']))
  lines.push('```')

  lines.push('', '### Pending events')
  const pendingEntries = Object.entries(report.pending)
  lines.push(pendingEntries.length ? pendingEntries.map(([k, n]) => `- ${k}: ${n}`).join('\n') : '_(none)_')

  lines.push('', '### Last chat posts')
  lines.push(...report.lastPosts.map(p => `- **${p.time} #${p.channel}:** ${p.text}`))

  lines.push('', '### Open work assigned / authored')
  lines.push(...report.workItems.map(w => `- **${w.age}** [${w.repo}#${w.number}](${w.url ?? ''}): ${w.title}`))

  return lines.join('\n')
}

/** Build terminal block from raw pane text. */
export function buildTerminalBlock(text: string, maxLines = 25, maxChars = 200): string[] {
  const lines = tidyPaneLines(text)
  return lines.slice(-maxLines).map(l => truncateLine(l, maxChars))
}

// ------------------------------------------------------------------ stale work detection

export interface StaleWorkCandidate {
  repo: string
  number: number
  title: string
  assigned: boolean
  promiseComment?: string
  lastActivityAt: Date
  url?: string
}

const PROMISE_RE = /\b(I'll start|starting|on it|will do|working on|looking at|picked up)\b/i

/** Detect stale tickets/PRs assigned to or authored by an agent. */
export function detectStaleWork(
  issues: Issue[],
  commentsByIssue: Map<number, Comment[]>,
  opts: { username: string; staleMs: number; nowMs: number; commitsByIssue?: Map<number, Date> },
): StaleWorkCandidate[] {
  const out: StaleWorkCandidate[] = []
  for (const issue of issues) {
    if (issue.state !== 'open') continue
    const assigned = issue.assignees.some(a => a.login === opts.username)
    const authored = issue.user.login === opts.username
    if (!assigned && !authored) continue

    const comments = commentsByIssue.get(issue.number) ?? []
    const agentComments = comments.filter(c => c.user.login === opts.username)
    const lastAgentComment = agentComments[agentComments.length - 1]
    const hasPromise = lastAgentComment && PROMISE_RE.test(lastAgentComment.body)
    const hasProgressLabel = issue.labels.some(l => l.name === 'status/in-progress')

    if (!assigned && !(hasPromise || hasProgressLabel)) continue
    if (assigned && !hasPromise && !hasProgressLabel) continue

    const commentDates = comments.map(c => new Date(c.created_at))
    const commitDate = opts.commitsByIssue?.get(issue.number)
    const dates = [new Date(issue.updated_at), ...commentDates, ...(commitDate ? [commitDate] : [])]
    const lastActivityAt = new Date(Math.max(...dates.map(d => d.getTime())))
    if (opts.nowMs - lastActivityAt.getTime() < opts.staleMs) continue

    out.push({
      repo: issue.html_url ? issue.html_url.replace(/.*\/([^/]+\/[^/]+)\/(issues|pulls)\/\d+.*/, '$1') : 'unknown',
      number: issue.number,
      title: issue.title,
      assigned,
      promiseComment: lastAgentComment?.body.slice(0, 200),
      lastActivityAt,
      url: issue.html_url,
    })
  }
  return out
}

// ------------------------------------------------------------------ activity timeline

export interface TimelineEvent {
  at: number
  time: string
  who: string
  channel: string
  text: string
  url?: string
}

/** Build a merged timeline of chat posts and ticket/PR events. */
export function buildActivityTimeline(
  posts: ChatPost[],
  ticketEvents: { at: string; repo: string; number: number; title: string; action: string; url?: string }[],
): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (const p of posts) {
    events.push({
      at: p.createAt,
      time: formatTime(p.createAt),
      who: `@${p.username}`,
      channel: `#${p.channel}`,
      text: p.message.slice(0, 120).replace(/\n/g, ' ') + (p.message.length > 120 ? '…' : ''),
    })
  }
  for (const t of ticketEvents) {
    events.push({
      at: new Date(t.at).getTime(),
      time: formatTime(new Date(t.at).getTime()),
      who: 'forgejo',
      channel: `${t.repo}#${t.number}`,
      text: `${t.action}: ${t.title.slice(0, 100)}`,
      url: t.url,
    })
  }
  events.sort((a, b) => a.at - b.at)
  return events
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ------------------------------------------------------------------ alert de-duplication helpers

/** Build a stable key for a watchdog alert. */
export function alertKey(agent: string, category: string, detail = ''): string {
  return `${agent}:${category}:${detail}`
}

/** Decide whether a numeric threshold crossing should fire (one alert per 90/95 bucket). */
export function shouldAlertThreshold(value: number, thresholds: number[]): number | undefined {
  let best: number | undefined
  for (const t of thresholds) if (value >= t && (best === undefined || t > best)) best = t
  return best
}

