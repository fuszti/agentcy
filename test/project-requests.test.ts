import { describe, expect, it } from 'vitest'
import type { OfficeConfig, OfficeRequest, ProjectRecord } from '../src/lib/types.js'
import {
  countActiveProjects,
  countProjectsCreatedTodayByAgent,
  formatProjectCreatedFyi,
  formatProjectCreatedNotice,
  validateProjectRequest,
  validateProjectRequestArgs,
} from '../src/lib/project-requests.js'

function config(over: Partial<OfficeConfig['selfManagement']> = {}): OfficeConfig {
  return {
    forgejoUrl: 'http://127.0.0.1:3033',
    forgejoOrg: 'office',
    selfManagement: {
      autoApproveProject: true,
      maxActiveProjects: 2,
      maxNewProjectsPerAgentPerDay: 2,
      ...over,
    },
  } as OfficeConfig
}

function project(name: string, archived = false): ProjectRecord {
  return { name, description: 'd', repo: `office/${name}`, channel: `proj-${name}`, members: ['kim'], createdAt: '2026-09-26T10:00:00Z', archived }
}

function request(agent: string, name: string, createdAt = new Date().toISOString()): OfficeRequest {
  return { id: 'req_x', type: 'project', agent, args: { name, description: 'd', reason: 'r' }, status: 'approved', createdAt }
}

describe('validateProjectRequestArgs', () => {
  it('accepts valid args', () => {
    const r = validateProjectRequestArgs({ name: 'hello-world', description: 'A project', reason: 'testing' })
    expect(r).toEqual({ ok: true, args: { name: 'hello-world', description: 'A project', members: [], reason: 'testing' } })
  })

  it('rejects invalid name, missing description or reason', () => {
    expect(validateProjectRequestArgs({ name: '', description: 'd', reason: 'r' })).toHaveProperty('reason')
    expect(validateProjectRequestArgs({ name: 'Hello', description: 'd', reason: 'r' })).toHaveProperty('reason')
    expect(validateProjectRequestArgs({ name: 'hello', description: '', reason: 'r' })).toEqual({ ok: false, reason: 'description is required' })
    expect(validateProjectRequestArgs({ name: 'hello', description: 'd', reason: '' })).toEqual({ ok: false, reason: 'reason is required' })
  })

  it('normalises members to lowercase usernames', () => {
    const r = validateProjectRequestArgs({ name: 'hello', description: 'd', reason: 'r', members: ['Kim', 'ada'] })
    expect(r).toEqual({ ok: true, args: { name: 'hello', description: 'd', members: ['kim', 'ada'], reason: 'r' } })
  })

  it('rejects malformed member usernames', () => {
    const r = validateProjectRequestArgs({ name: 'hello', description: 'd', reason: 'r', members: ['bad name'] })
    expect(r).toEqual({ ok: false, reason: 'members must be lowercase usernames' })
  })
})

describe('validateProjectRequest limits', () => {
  it('rejects existing project', async () => {
    const r = await validateProjectRequest(
      { name: 'hello', description: 'd', reason: 'r' },
      config(),
      () => [project('hello')],
      () => [],
      'kim',
    )
    expect(r).toEqual({ ok: false, reason: 'project hello already exists' })
  })

  it('rejects when active project cap is reached', async () => {
    const r = await validateProjectRequest(
      { name: 'new', description: 'd', reason: 'r' },
      config(),
      () => [project('a'), project('b')],
      () => [],
      'kim',
    )
    expect(r).toEqual({ ok: false, reason: 'active project limit reached (2)' })
  })

  it('rejects when per-agent daily cap is reached', async () => {
    const r = await validateProjectRequest(
      { name: 'new', description: 'd', reason: 'r' },
      config({ maxNewProjectsPerAgentPerDay: 1 }),
      () => [project('a')],
      () => [request('kim', 'a'), request('kim', 'b')],
      'kim',
    )
    expect(r).toEqual({ ok: false, reason: 'you already created 1 projects today' })
  })

  it('approves when autoApproveProject is true', async () => {
    const r = await validateProjectRequest(
      { name: 'new', description: 'd', reason: 'r' },
      config(),
      () => [project('a')],
      () => [],
      'kim',
    )
    expect(r).toEqual({ ok: true, args: expect.objectContaining({ name: 'new' }), status: 'approved' })
  })

  it('leaves pending when autoApproveProject is false', async () => {
    const r = await validateProjectRequest(
      { name: 'new', description: 'd', reason: 'r' },
      config({ autoApproveProject: false }),
      () => [project('a')],
      () => [],
      'kim',
    )
    expect(r).toEqual({ ok: true, args: expect.objectContaining({ name: 'new' }), status: 'pending' })
  })
})

describe('countActiveProjects', () => {
  it('counts only non-archived projects', () => {
    expect(countActiveProjects([project('a'), project('b', true), project('c')])).toBe(2)
  })
})

describe('countProjectsCreatedTodayByAgent', () => {
  it('counts only todays project requests for the agent', () => {
    const today = new Date().toISOString()
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString()
    const reqs: OfficeRequest[] = [
      request('kim', 'a', today),
      request('kim', 'b', today),
      request('kim', 'c', yesterday),
      request('ada', 'd', today),
    ]
    expect(countProjectsCreatedTodayByAgent(reqs, 'kim')).toBe(2)
  })
})

describe('formatProjectCreatedFyi', () => {
  it('renders the admin FYI with members and reason', () => {
    const req: OfficeRequest = {
      id: 'req_x', type: 'project', agent: 'lead', status: 'done',
      args: { name: 'review-nudge', description: 'Nudge reviewers', reason: 'reduce review latency' },
      createdAt: '2026-09-26T10:00:00Z',
    }
    expect(formatProjectCreatedFyi(req, ['lead', 'kim'])).toBe(
      '📁 @lead created project `review-nudge`: Nudge reviewers — members lead, kim — reason reduce review latency',
    )
  })
})

describe('formatProjectCreatedNotice', () => {
  it('includes repo URL, clone URL and channel', () => {
    const notice = formatProjectCreatedNotice(config(), 'review-nudge', 'proj-review-nudge')
    expect(notice).toContain('http://127.0.0.1:3033/office/review-nudge')
    expect(notice).toContain('http://127.0.0.1:3033/office/review-nudge.git')
    expect(notice).toContain('#proj-review-nudge')
    expect(notice).toContain('repo_clone({ project: "review-nudge" })')
  })
})
