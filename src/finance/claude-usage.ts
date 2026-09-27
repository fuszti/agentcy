// Pure parser for Claude Code's `/usage` TUI output, captured from a tmux pane.
//
// Real capture (Pro account) renders each window as its own block, e.g.:
//   Current session
//   ████████████▌   25% used
//   Resets 1:09pm (Europe/Budapest)
//
//   Current week (all models)
//   ███████▌   15% used
//   Resets Sep 29, 8:59pm (Europe/Budapest)
//
// and further down, extra (pay-as-you-go) usage:
//   Usage credits
//   Usage credits are off · /usage-credits to turn them on
//
// An older/alternate single-line format is also accepted for robustness:
//   "Current session: 4% used · resets Sep 26, 5:50am (Europe/Budapest)"
//   "Current week (all models): 84% used · resets Sep 27, 10am"

export interface ClaudeUsageWindow {
  percent: number
  /** Free-text reset description exactly as printed, e.g. "Sep 26, 5:50am (Europe/Budapest)". */
  resets: string
}

/** "Usage credits" (extra pay-as-you-go usage beyond the subscription limits). */
export interface ClaudeExtraUsage {
  enabled: boolean
  /** Amount spent so far this period, if shown (only when enabled). */
  amount?: number
  /** Spending limit, if shown (only when enabled and a limit is set). */
  limit?: number
}

export interface ClaudeUsageLimits {
  session?: ClaudeUsageWindow
  week?: ClaudeUsageWindow
  weekOpus?: ClaudeUsageWindow
  weekSonnet?: ClaudeUsageWindow
  extraUsage?: ClaudeExtraUsage
}

const HEADER_RE = /^Current (session|week)(?:\s*\(([^)]+)\))?\s*$/i
const INLINE_RE = /^Current (session|week)(?:\s*\(([^)]+)\))?\s*:\s*(\d+)%\s*used\s*(?:[·\-]\s*)?resets\s+(.+?)\s*$/i
const PERCENT_RE = /(\d+)%\s*used/i
const RESETS_RE = /^Resets\s+(.+?)\s*$/i
const CREDITS_STATUS_RE = /Usage credits are (on|off)/i
const DOLLAR_RE = /\$\s?([\d.]+)/g

function assignWindow(limits: ClaudeUsageLimits, kind: string, label: string | undefined, percent: number, resets: string): void {
  const win: ClaudeUsageWindow = { percent, resets }
  if (kind.toLowerCase() === 'session') {
    limits.session = win
    return
  }
  const l = (label ?? '').toLowerCase()
  if (!l || l === 'all models') limits.week = win
  else if (l.includes('opus')) limits.weekOpus = win
  else if (l.includes('sonnet')) limits.weekSonnet = win
}

/** Parse a captured `/usage` pane into rolling-window limits + extra-usage (pay-as-you-go) status. */
export function parseClaudeUsageOutput(paneText: string): ClaudeUsageLimits {
  const limits: ClaudeUsageLimits = {}
  const lines = paneText.split('\n').map((l) => l.trim())
  let current: { kind: string; label?: string } | undefined
  let pendingPercent: number | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    const inline = line.match(INLINE_RE)
    if (inline) {
      assignWindow(limits, inline[1], inline[2], Number(inline[3]), inline[4].trim())
      current = undefined
      pendingPercent = undefined
      continue
    }

    const header = line.match(HEADER_RE)
    if (header) {
      current = { kind: header[1], label: header[2] }
      pendingPercent = undefined
      continue
    }

    if (current) {
      const pct = line.match(PERCENT_RE)
      if (pct) {
        pendingPercent = Number(pct[1])
        continue
      }
      const resets = line.match(RESETS_RE)
      if (resets && pendingPercent !== undefined) {
        assignWindow(limits, current.kind, current.label, pendingPercent, resets[1].trim())
        current = undefined
        pendingPercent = undefined
        continue
      }
    }

    const credits = line.match(CREDITS_STATUS_RE)
    if (credits) {
      const enabled = credits[1].toLowerCase() === 'on'
      const extra: ClaudeExtraUsage = { enabled }
      // Look at this line and the next couple for dollar figures ("$X spent of $Y limit").
      const scan = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ')
      const amounts = [...scan.matchAll(DOLLAR_RE)].map((m) => Number(m[1]))
      if (enabled && amounts.length) {
        extra.amount = amounts[0]
        if (amounts.length > 1) extra.limit = amounts[1]
      }
      limits.extraUsage = extra
    }
  }
  return limits
}

/** True when the parse found nothing at all (probe likely failed or /usage didn't render yet). */
export function isEmptyClaudeUsage(limits: ClaudeUsageLimits): boolean {
  return !limits.session && !limits.week && !limits.weekOpus && !limits.weekSonnet
}
