import { describe, expect, it, vi, afterEach } from 'vitest'
import { ForgejoClient } from '../src/lib/forgejo.js'

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(status === 204 || status === 205 ? null : JSON.stringify(body), {
    status,
    headers: { ...(headers ?? {}), ...(status !== 204 && status !== 205 ? { 'Content-Type': 'application/json' } : {}) },
  })
}

describe('ForgejoClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('listNotifications preserves updated_at, html_url and latest_comment_url', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse([
      {
        id: '42',
        unread: true,
        updated_at: '2026-09-25T20:48:48+02:00',
        subject: {
          title: 'Fix thing',
          url: 'http://fj/api/v1/repos/o/r/issues/7',
          html_url: 'http://fj/o/r/issues/7',
          latest_comment_url: 'http://fj/api/v1/repos/o/r/issues/comments/99',
          latest_comment_html_url: 'http://fj/o/r/issues/7#issuecomment-99',
          type: 'Issue',
          state: 'open',
        },
        repository: { full_name: 'o/r' },
      }
    ]))))
    const fj = new ForgejoClient('http://fj', 'tok')
    const notes = await fj.listNotifications({ unreadOnly: true })
    expect(notes).toHaveLength(1)
    expect(notes[0].updated_at).toBe('2026-09-25T20:48:48+02:00')
    expect(notes[0].subject.html_url).toBe('http://fj/o/r/issues/7')
    expect(notes[0].subject.latest_comment_url).toBe('http://fj/api/v1/repos/o/r/issues/comments/99')
  })

  it('latestCommentAuthor resolves the login from the comment URL', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/comments/99')) {
        return Promise.resolve(jsonResponse({ user: { login: 'kim' } }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    }))
    const fj = new ForgejoClient('http://fj', 'tok')
    expect(await fj.latestCommentAuthor('http://fj/api/v1/repos/o/r/issues/comments/99')).toBe('kim')
  })

  it('latestCommentAuthor returns undefined on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))))
    const fj = new ForgejoClient('http://fj', 'tok')
    expect(await fj.latestCommentAuthor('http://fj/api/v1/repos/o/r/issues/comments/99')).toBeUndefined()
  })

  it('treats 205 Reset Content as empty success (L12)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(null, 205))))
    const fj = new ForgejoClient('http://fj', 'tok')
    await expect(fj.markNotificationRead('42')).resolves.toBeUndefined()
  })

  it('treats empty-bodied 200 as empty success', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 200, headers: { 'content-length': '0' } }))))
    const fj = new ForgejoClient('http://fj', 'tok')
    const result = await (fj as any).request('GET', '/empty')
    expect(result).toBeUndefined()
  })

  it('maps pull request fields including created_at', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({
      number: 5,
      title: 'Add thing',
      body: 'closes #1',
      state: 'open',
      user: { login: 'kim' },
      head: { label: 'office/kim/1', ref: 'kim/1', sha: 'abc' },
      base: { label: 'office/main', ref: 'main', sha: 'def' },
      html_url: 'http://fj/office/hello/pulls/5',
      url: 'http://fj/api/v1/repos/office/hello/pulls/5',
      mergeable: true,
      created_at: '2026-09-26T10:00:00Z',
    }))))
    const fj = new ForgejoClient('http://fj', 'tok')
    const pr = await fj.getPullRequest('office', 'hello', 5)
    expect(pr.number).toBe(5)
    expect(pr.user.login).toBe('kim')
    expect(pr.created_at).toBe('2026-09-26T10:00:00Z')
  })

  it('requests reviewers with the correct body', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      return Promise.resolve(jsonResponse({}))
    }))
    const fj = new ForgejoClient('http://fj', 'tok')
    await fj.requestReviewers('office', 'hello', 5, ['rex'])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/pulls/5/requested_reviewers')
    expect(calls[0].body).toEqual({ reviewers: ['rex'] })
  })

  it('merges with squash and delete_branch_after_merge', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      return Promise.resolve(jsonResponse({}))
    }))
    const fj = new ForgejoClient('http://fj', 'tok')
    await fj.mergePullRequest('office', 'hello', 5, 'squash')
    expect(calls[0].url).toContain('/pulls/5/merge')
    expect(calls[0].body).toEqual({ Do: 'squash', delete_branch_after_merge: true })
  })

  it('maps APPROVE review event to Forgejo APPROVED', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      return Promise.resolve(jsonResponse({ id: 1, user: { login: 'rex' }, state: 'APPROVED', body: 'lgtm' }))
    }))
    const fj = new ForgejoClient('http://fj', 'tok')
    await fj.submitReview('office', 'hello', 5, 'APPROVE', 'lgtm')
    expect(calls[0].url).toContain('/pulls/5/reviews')
    expect(calls[0].body).toEqual({ event: 'APPROVED', body: 'lgtm' })
  })
})
