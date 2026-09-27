import { describe, expect, it } from 'vitest'
import { renderAgentDetail, renderAgentTable, renderFinanceReport, renderGroupDetail, renderGroupTable } from '../src/finance/render.js'
import type { AgentRow, GroupRow } from '../src/finance/render.js'

const claudeGroup: GroupRow = {
  id: 'claude-sub', label: 'Claude subscription', status: 'ok', usagePercent: 42,
  tokensToday: 120_000, tokens7d: 900_000, agents: ['ada', 'kai', 'lead'],
}
const opencodeGroup: GroupRow = {
  id: 'opencode-go', label: 'OpenCode Go', status: 'throttled', usagePercent: undefined,
  tokensToday: 6_300_000, tokensTodayIsEstimate: true, costToday: 27.41, costTodayIsEstimate: true,
  agents: ['rex', 'webre'], note: 'group total is office-wide, not per-agent',
}
const agentRow: AgentRow = { name: 'ada', group: 'Claude subscription', model: 'sonnet', tokensToday: 12_000, tokens7d: 80_000 }

describe('renderGroupTable', () => {
  it('renders a markdown table with status icons and dashes for missing data', () => {
    const md = renderGroupTable([claudeGroup, opencodeGroup])
    expect(md).toContain('| Group | Status |')
    expect(md).toContain('**Claude subscription**')
    expect(md).toContain('🟢 ok')
    expect(md).toContain('42%')
    expect(md).toContain('🟠 throttled')
    expect(md).toContain('–') // opencode group has no usagePercent
    expect(md).toContain('~6.3M') // estimate marker
    expect(md).toContain('_OpenCode Go: group total is office-wide, not per-agent_')
  })
})

describe('renderAgentTable', () => {
  it('renders agent rows with an always-estimated cost column', () => {
    const md = renderAgentTable([agentRow])
    expect(md).toContain('@ada')
    expect(md).toContain('12.0K')
    expect(md).toContain('80.0K')
    expect(md).toContain('| – |') // no cost given -> dash
  })
})

describe('renderFinanceReport', () => {
  it('includes both sections and an estimate legend', () => {
    const md = renderFinanceReport('today', [claudeGroup, opencodeGroup], [agentRow])
    expect(md).toContain('## Finance — today')
    expect(md).toContain('### Resource groups')
    expect(md).toContain('### Agents')
    expect(md).toContain('estimate')
  })

  it('labels the week scope', () => {
    const md = renderFinanceReport('week', [claudeGroup], [agentRow])
    expect(md).toContain('## Finance — last 7 days')
  })
})

describe('renderGroupDetail / renderAgentDetail', () => {
  it('renders a single group with its agents', () => {
    const md = renderGroupDetail(claudeGroup, [agentRow])
    expect(md).toContain('## Finance — Claude subscription')
    expect(md).toContain('@ada')
  })

  it('renders a single agent', () => {
    const md = renderAgentDetail(agentRow)
    expect(md).toContain('## Finance — @ada')
  })
})
