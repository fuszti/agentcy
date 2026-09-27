import { describe, expect, it } from 'vitest'
import {
  buildActivityTimeline,
  buildRichStatusMarkdown,
  buildRichStatusPlain,
  buildRichStatusRow,
  detectPaneCondition,
  detectStaleWork,
  findErrorLines,
  formatChannelLabel,
  formatDuration,
  isDmChannelName,
  otherDmParticipant,
  parseClaudeContext,
  parseOpencodeFooter,
  parsePaneMetrics,
  parseWeeklyPercent,
  alertKey,
  shouldAlertThreshold,
} from '../src/admin/monitor.js'
import type { AgentRecord } from '../src/lib/types.js'
import type { Comment, Issue } from '../src/lib/forgejo.js'

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'ada',
    harness: 'claude',
    model: 'claude-sonnet-4-20250514',
    status: 'hired',
    createdAt: new Date().toISOString(),
    ...over,
  } as AgentRecord
}

describe('pane parsers', () => {
  it('parses opencode footer percent and tokens', () => {
    expect(parseOpencodeFooter('41,485 tokens  4% used')).toEqual({ tokens: 41485, usedPercent: 4 })
    expect(parseOpencodeFooter('Context  202.0K (77%)')).toEqual({ usedPercent: 77 })
    expect(parseOpencodeFooter('nothing here')).toEqual({})
  })

  it('parses claude context strings', () => {
    expect(parseClaudeContext('Context left 12,345 / 12%')).toEqual({ tokensLeft: 12345, usedPercent: 12 })
    expect(parseClaudeContext('15% context used')).toEqual({ usedPercent: 15 })
    expect(parseClaudeContext('nothing')).toEqual({})
  })

  it('parses weekly limit percent', () => {
    expect(parseWeeklyPercent("You've used 92% of your weekly limit")).toBe(92)
    expect(parseWeeklyPercent('weekly limit 95%')).toBe(95)
    expect(parseWeeklyPercent('nothing')).toBeUndefined()
  })

  it('finds error/limit lines without duplicates', () => {
    const text = 'line one\nError: something broke\nError: something broke\nrate limit hit\nok'
    expect(findErrorLines(text)).toEqual(['Error: something broke', 'rate limit hit'])
  })

  it('detects pane condition: dialog, working, error, idle', () => {
    expect(detectPaneCondition('Do you want to proceed?\nEnter to confirm')).toBe('dialog')
    expect(detectPaneCondition('thinking… (12s · esc to interrupt)')).toBe('working')
    expect(detectPaneCondition('ECONNREFUSED at line 3')).toBe('error/limit')
    expect(detectPaneCondition('some output\n> ')).toBe('idle-prompt')
  })

  it('parsePaneMetrics combines condition + context + weekly + errors', () => {
    const m = parsePaneMetrics("You've used 91% of your weekly limit\nContext left 1,000 / 20%", 'claude')
    expect(m.weeklyPercent).toBe(91)
    expect(m.context).toBe('20% (1.0K left)')
    expect(m.condition).toBe('error/limit')
  })

  it('formatDuration renders compact ages', () => {
    expect(formatDuration(30_000)).toBe('1m')
    expect(formatDuration(34 * 60_000)).toBe('34m')
    expect(formatDuration(2 * 60 * 60_000)).toBe('2h')
    expect(formatDuration(50 * 60 * 60_000)).toBe('2.1d')
  })
})

describe('status row rendering', () => {
  it('flags a busy > 30m agent as an alert', () => {
    const now = Date.now()
    const row = buildRichStatusRow(rec(), {
      alive: true,
      status: { state: 'busy', at: new Date(now - 34 * 60_000).toISOString() },
      paneMetrics: { context: '10%', errorLines: [], condition: 'working' },
      pending: [],
      logFile: '/nonexistent',
      nowMs: now,
    })
    expect(row.alerts.some(a => a.includes('busy'))).toBe(true)
  })

  it('flags high context and weekly usage', () => {
    const now = Date.now()
    const row = buildRichStatusRow(rec(), {
      alive: true,
      status: { state: 'idle', at: new Date(now).toISOString() },
      paneMetrics: { context: '88%', errorLines: [], condition: 'unknown', weeklyPercent: 95 },
      pending: [],
      logFile: '/nonexistent',
      nowMs: now,
    })
    expect(row.alerts).toEqual(expect.arrayContaining([expect.stringContaining('weekly'), expect.stringContaining('context')]))
  })

  it('renders a markdown table with a header row', () => {
    const now = Date.now()
    const row = buildRichStatusRow(rec(), {
      alive: true,
      status: { state: 'idle', at: new Date(now).toISOString() },
      paneMetrics: { context: '–', errorLines: [], condition: 'unknown' },
      pending: [],
      logFile: '/nonexistent',
      nowMs: now,
    })
    const md = buildRichStatusMarkdown([row], { footer: 'footer text' })
    expect(md).toContain('| Agent |')
    expect(md).toContain('@ada')
    expect(md).toContain('footer text')
  })
})

describe('stale work detection', () => {
  function issue(over: Partial<Issue> = {}): Issue {
    return {
      number: 2,
      title: 'compose-guard',
      body: '',
      state: 'open',
      url: '',
      html_url: 'http://x/office/compose-guard/issues/2',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user: { login: 'kim' },
      assignees: [{ login: 'kim' }],
      labels: [],
      ...over,
    }
  }

  function comment(body: string, ageMs: number): Comment {
    return { id: 1, body, user: { login: 'kim' }, created_at: new Date(Date.now() - ageMs).toISOString(), html_url: '' }
  }

  it('flags an assigned ticket with a stale promise comment', () => {
    const oldComment = comment("I'll start compose-guard#2", 90 * 60_000)
    const iss = issue({ updated_at: oldComment.created_at })
    const out = detectStaleWork([iss], new Map([[2, [oldComment]]]), { username: 'kim', staleMs: 45 * 60_000, nowMs: Date.now() })
    expect(out).toHaveLength(1)
    expect(out[0]!.number).toBe(2)
  })

  it('does not flag recent promises', () => {
    const recentComment = comment("on it", 5 * 60_000)
    const iss = issue({ updated_at: recentComment.created_at })
    const out = detectStaleWork([iss], new Map([[2, [recentComment]]]), { username: 'kim', staleMs: 45 * 60_000, nowMs: Date.now() })
    expect(out).toHaveLength(0)
  })

  it('does not flag an assigned ticket with no promise or in-progress label', () => {
    const iss = issue({ updated_at: new Date(Date.now() - 90 * 60_000).toISOString() })
    const out = detectStaleWork([iss], new Map(), { username: 'kim', staleMs: 45 * 60_000, nowMs: Date.now() })
    expect(out).toHaveLength(0)
  })

  it('flags a labelled in-progress ticket with no recent activity', () => {
    const iss = issue({ updated_at: new Date(Date.now() - 90 * 60_000).toISOString(), labels: [{ name: 'status/in-progress', color: '' }] })
    const out = detectStaleWork([iss], new Map(), { username: 'kim', staleMs: 45 * 60_000, nowMs: Date.now() })
    expect(out).toHaveLength(1)
  })
})

describe('alert de-duplication', () => {
  it('builds stable keys', () => {
    expect(alertKey('kim', 'down')).toBe('kim:down:')
    expect(alertKey('kim', 'stale', 'office/tasks#2')).toBe('kim:stale:office/tasks#2')
  })

  it('fires once per threshold crossing', () => {
    expect(shouldAlertThreshold(92, [90, 95])).toBe(90)
    expect(shouldAlertThreshold(97, [90, 95])).toBe(95)
    expect(shouldAlertThreshold(50, [90, 95])).toBeUndefined()
  })
})

describe('activity timeline', () => {
  it('merges chat posts and ticket events in time order', () => {
    const t0 = Date.now() - 10_000
    const t1 = Date.now() - 5_000
    const timeline = buildActivityTimeline(
      [{ id: '1', channelId: 'c', channel: 'office', username: 'ada', message: 'hello', createAt: t1 } as any],
      [{ at: new Date(t0).toISOString(), repo: 'office/tasks', number: 2, title: 'fix bug', action: 'commented' }],
    )
    expect(timeline).toHaveLength(2)
    expect(timeline[0]!.who).toBe('forgejo')
    expect(timeline[1]!.who).toBe('@ada')
  })
})

describe('DM channel display', () => {
  const selfId = 'aaaaaaaaaaaaaaaaaaaaaaaaaa' // 26 chars
  const otherId = 'bbbbbbbbbbbbbbbbbbbbbbbbbb' // 26 chars
  const dmName = `${selfId}__${otherId}`

  it('recognises a DM channel name and rejects normal channel names', () => {
    expect(isDmChannelName(dmName)).toBe(true)
    expect(isDmChannelName('office')).toBe(false)
    expect(isDmChannelName('proj-hello-agents')).toBe(false)
  })

  it('resolves the other participant id from either side of the DM name', () => {
    expect(otherDmParticipant(dmName, selfId)).toBe(otherId)
    expect(otherDmParticipant(dmName, otherId)).toBe(selfId)
    expect(otherDmParticipant(dmName, 'someone-else')).toBeUndefined()
  })

  it('renders a DM channel as "DM @user" and a normal channel with "#"', () => {
    expect(formatChannelLabel('office', undefined)).toBe('#office')
    expect(formatChannelLabel(dmName, 'owner')).toBe('DM @owner')
  })

  it('buildRichStatusRow resolves the DM label end-to-end via lastPostDmOtherUsername', () => {
    const row = buildRichStatusRow(rec({ name: 'ada' }), {
      alive: true,
      status: { state: 'idle', at: new Date().toISOString() },
      paneMetrics: { context: '–', errorLines: [], condition: 'idle-prompt' },
      lastPost: { id: 'p1', channelId: 'c1', channel: dmName, userId: selfId, username: 'ada', message: 'hi', createAt: Date.now() },
      lastPostDmOtherUsername: 'owner',
      pending: [],
      logFile: '/nonexistent',
      nowMs: Date.now(),
    })
    expect(row.lastPostChannel).toBe('DM @owner')
    expect(buildRichStatusPlain([row])).toContain('DM @owner')
    expect(buildRichStatusPlain([row])).not.toContain('#DM')
  })
})
