import { describe, expect, it, vi, afterEach } from 'vitest'
import { ForgejoClient, ensureForgejoPrivacy, forgejoPrivacyReady, type PrivacyClient } from '../src/lib/forgejo.js'

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

  it('commentInfo resolves login, id and time from the comment URL', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/comments/99')) {
        return Promise.resolve(jsonResponse({ user: { login: 'kim', id: 9 }, created_at: '2026-10-11T10:00:00Z' }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    }))
    const fj = new ForgejoClient('http://fj', 'tok')
    expect(await fj.commentInfo('http://fj/api/v1/repos/o/r/issues/comments/99')).toEqual({ login: 'kim', id: 9, createdAt: '2026-10-11T10:00:00Z' })
  })

  it('commentInfo returns undefined on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))))
    const fj = new ForgejoClient('http://fj', 'tok')
    expect(await fj.commentInfo('http://fj/api/v1/repos/o/r/issues/comments/99')).toBeUndefined()
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

function capture(replies: (req: { method: string; url: string }) => Response) {
  const requests: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const req = { method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }
    requests.push(req)
    return replies(req)
  }))
  return requests
}

describe('ForgejoClient privacy and collaborators', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('creates orgs private and repos private', async () => {
    const reqs = capture((r) => r.method === 'GET' ? jsonResponse([]) : jsonResponse({ id: 1, name: 'x', html_url: 'http://fj/office/x' }, 201))
    const fj = new ForgejoClient('http://fj', 'tok')
    await fj.createOrg('office')
    await fj.createOrgRepo('office', 'web', { autoInit: true })
    expect(reqs.find(r => r.url.endsWith('/orgs') && r.method === 'POST')?.body).toMatchObject({ username: 'office', visibility: 'private' })
    expect(reqs.find(r => r.url.endsWith('/orgs/office/repos') && r.method === 'POST')?.body).toMatchObject({ name: 'web', private: true })
  })

  it('getOrg returns the visibility', async () => {
    capture(() => jsonResponse({ id: 3, name: 'office', visibility: 'public' }))
    expect(await new ForgejoClient('http://fj', 'tok').getOrg('office')).toMatchObject({ visibility: 'public' })
  })

  it('listOrgRepos keeps reading after a short page and stops only on an empty one', async () => {
    const reqs = capture((r) => jsonResponse(r.url.includes('page=1') ? [{ name: 'a', private: true }] : r.url.includes('page=2') ? [{ name: 'b', private: true }] : []))
    const repos = await new ForgejoClient('http://fj', 'tok').listOrgRepos('office')
    expect(repos.map(r => r.name)).toEqual(['a', 'b'])
    expect(reqs).toHaveLength(3)
  })

  it('listOrgRepos reads every page', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ name: `r${String(i)}`, private: false, extra: true }))
    const reqs = capture((r) => jsonResponse(r.url.includes('page=1') ? page1 : r.url.includes('page=2') ? [{ name: 'last', private: true }] : []))
    const repos = await new ForgejoClient('http://fj', 'tok').listOrgRepos('office')
    expect(reqs.map(r => r.url.match(/page=(\d+)/)?.[1])).toEqual(['1', '2', '3'])
    expect(repos).toHaveLength(51)
    expect(repos[0]).toEqual({ name: 'r0', private: false })
    expect(repos[50]).toEqual({ name: 'last', private: true })
    expect(reqs[0].url).toBe('http://fj/api/v1/orgs/office/repos?limit=50&page=1')
  })

  it('switches org visibility and repo privacy', async () => {
    const reqs = capture(() => jsonResponse({}))
    const fj = new ForgejoClient('http://fj', 'tok')
    await fj.setOrgVisibility('office', 'private')
    await fj.setRepoPrivate('office', 'web')
    expect(reqs[0]).toEqual({ method: 'PATCH', url: 'http://fj/api/v1/orgs/office', body: { visibility: 'private' } })
    expect(reqs[1]).toEqual({ method: 'PATCH', url: 'http://fj/api/v1/repos/office/web', body: { private: true } })
  })

  it('adds a write collaborator by default and removes one', async () => {
    const reqs = capture(() => jsonResponse(null, 204))
    const fj = new ForgejoClient('http://fj', 'tok')
    await fj.addCollaborator('office', 'web', 'alice')
    await fj.addCollaborator('office', 'web', 'bob', 'read')
    await fj.removeCollaborator('office', 'web', 'alice')
    expect(reqs[0]).toEqual({ method: 'PUT', url: 'http://fj/api/v1/repos/office/web/collaborators/alice', body: { permission: 'write' } })
    expect(reqs[1].body).toEqual({ permission: 'read' })
    expect(reqs[2]).toMatchObject({ method: 'DELETE', url: 'http://fj/api/v1/repos/office/web/collaborators/alice' })
  })

  it('removeCollaborator treats a missing repo or user as done, but not other errors', async () => {
    capture(() => jsonResponse({ message: 'not found' }, 404))
    await expect(new ForgejoClient('http://fj', 'tok').removeCollaborator('office', 'gone', 'alice')).resolves.toBeUndefined()
    capture(() => jsonResponse({ message: 'boom' }, 500))
    await expect(new ForgejoClient('http://fj', 'tok').removeCollaborator('office', 'web', 'alice')).rejects.toThrow(/500/)
  })

  it('blocks a login and resets a password with a forced change', async () => {
    const reqs = capture(() => jsonResponse({}))
    const fj = new ForgejoClient('http://fj', 'tok')
    await fj.setProhibitLogin('alice', true)
    await fj.adminResetPassword('alice', 'pw', true)
    await fj.adminResetPassword('ada', 'pw2')
    expect(reqs[0]).toEqual({ method: 'PATCH', url: 'http://fj/api/v1/admin/users/alice', body: { prohibit_login: true, login_name: 'alice', source_id: 0 } })
    expect(reqs[1].body).toEqual({ password: 'pw', must_change_password: true, login_name: 'alice', source_id: 0 })
    expect(reqs[2].body).toEqual({ password: 'pw2', must_change_password: false, login_name: 'ada', source_id: 0 })
  })

  it('adminGetUser reads an account, or undefined when it is missing', async () => {
    const reqs = capture(() => jsonResponse({ login: 'alice', email: 'a@office.local', is_admin: false, prohibit_login: false }))
    expect(await new ForgejoClient('http://fj', 'tok').adminGetUser('alice')).toMatchObject({ login: 'alice', is_admin: false })
    expect(reqs[0]).toMatchObject({ method: 'GET', url: 'http://fj/api/v1/users/alice' })
    capture(() => jsonResponse({ message: 'nope' }, 404))
    expect(await new ForgejoClient('http://fj', 'tok').adminGetUser('ghost')).toBeUndefined()
    capture(() => jsonResponse({ message: 'boom' }, 500))
    await expect(new ForgejoClient('http://fj', 'tok').adminGetUser('x')).rejects.toThrow(/500/)
  })

  it('isTeamMember is true on 204, false on 404 or a missing team, and rethrows other errors', async () => {
    const reply = (member: number) => (r: { url: string }) =>
      r.url.endsWith('/orgs/office/teams') ? jsonResponse([{ id: 7, name: 'Agents' }]) : jsonResponse({ message: 'x' }, member)
    const reqs = capture(reply(204))
    expect(await new ForgejoClient('http://fj', 'tok').isTeamMember('office', 'agents', 'alice')).toBe(true)
    expect(reqs[1]).toMatchObject({ method: 'GET', url: 'http://fj/api/v1/teams/7/members/alice' })
    capture(reply(404))
    expect(await new ForgejoClient('http://fj', 'tok').isTeamMember('office', 'agents', 'alice')).toBe(false)
    capture(reply(500))
    await expect(new ForgejoClient('http://fj', 'tok').isTeamMember('office', 'agents', 'alice')).rejects.toThrow(/500/)
    capture(() => jsonResponse([]))
    expect(await new ForgejoClient('http://fj', 'tok').isTeamMember('office', 'agents', 'alice')).toBe(false)
  })

  it('getUserById resolves the current login by id, or undefined when the id is unknown', async () => {
    const reqs = capture(() => jsonResponse({ ok: true, data: [{ id: 41, login: 'alice-renamed' }] }))
    expect(await new ForgejoClient('http://fj', 'tok').getUserById(41)).toEqual({ id: 41, login: 'alice-renamed' })
    expect(reqs[0].url).toBe('http://fj/api/v1/users/search?uid=41')
    capture(() => jsonResponse({ ok: true, data: [] }))
    expect(await new ForgejoClient('http://fj', 'tok').getUserById(42)).toBeUndefined()
    capture(() => jsonResponse({ ok: true, data: [{ id: 7, login: 'other' }] }))
    expect(await new ForgejoClient('http://fj', 'tok').getUserById(42)).toBeUndefined()
  })

  it('getUserIdByName returns the id, undefined for a missing user, and throws on other errors', async () => {
    capture(() => jsonResponse({ id: 5, login: 'owner' }))
    expect(await new ForgejoClient('http://fj', 'tok').getUserIdByName('owner')).toBe(5)
    capture(() => jsonResponse({ message: 'nope' }, 404))
    expect(await new ForgejoClient('http://fj', 'tok').getUserIdByName('ghost')).toBeUndefined()
    capture(() => jsonResponse({ message: 'boom' }, 500))
    await expect(new ForgejoClient('http://fj', 'tok').getUserIdByName('x')).rejects.toThrow(/500/)
  })

  it('issueInfo returns the poster and creation time, or undefined when the issue cannot be read or lacks them', async () => {
    capture(() => jsonResponse({ number: 7, user: { login: 'alice', id: 41 }, created_at: '2026-10-11T09:00:00Z', updated_at: '2026-10-11T09:05:00Z' }))
    expect(await new ForgejoClient('http://fj', 'tok').issueInfo('office', 'web', 7)).toEqual({ login: 'alice', id: 41, createdAt: '2026-10-11T09:00:00Z', updatedAt: '2026-10-11T09:05:00Z' })
    capture(() => jsonResponse({ number: 7, user: { login: 'alice', id: 41 }, created_at: '2026-10-11T09:00:00Z' }))
    expect(await new ForgejoClient('http://fj', 'tok').issueInfo('office', 'web', 7)).toBeUndefined()
    capture(() => jsonResponse({ number: 7, user: { login: 'alice' } }))
    expect(await new ForgejoClient('http://fj', 'tok').issueInfo('office', 'web', 7)).toBeUndefined()
    capture(() => jsonResponse({ message: 'nope' }, 404))
    expect(await new ForgejoClient('http://fj', 'tok').issueInfo('office', 'web', 8)).toBeUndefined()
  })
})

describe('ensureForgejoPrivacy', () => {
  function fakeFj(org: { visibility: string } | undefined, repos: { name: string; private: boolean }[]) {
    const calls: string[] = []
    const fj: PrivacyClient = {
      getOrg: async () => org,
      setOrgVisibility: async (o, v) => { calls.push(`org ${o} ${v}`) },
      listOrgRepos: async () => repos,
      setRepoPrivate: async (o, r) => { calls.push(`repo ${o}/${r}`) },
    }
    return { fj, calls }
  }

  it('makes public repos and a public org private', async () => {
    const f = fakeFj({ visibility: 'public' }, [{ name: 'tasks', private: false }, { name: 'web', private: true }, { name: 'api', private: false }])
    expect(await ensureForgejoPrivacy(f.fj, 'office')).toEqual({ org: true, repos: ['tasks', 'api'] })
    expect(f.calls).toEqual(['repo office/tasks', 'repo office/api', 'org office private'])
  })

  it('changes nothing when everything is private already', async () => {
    const f = fakeFj({ visibility: 'private' }, [{ name: 'tasks', private: true }])
    expect(await ensureForgejoPrivacy(f.fj, 'office')).toEqual({ org: false, repos: [] })
    expect(f.calls).toEqual([])
  })

  it('does nothing when the org does not exist yet', async () => {
    const f = fakeFj(undefined, [])
    expect(await ensureForgejoPrivacy(f.fj, 'office')).toEqual({ org: false, repos: [] })
    expect(f.calls).toEqual([])
  })
})

describe('forgejoPrivacyReady', () => {
  const fj = (visibility: string, repos: boolean[]) => ({
    getOrg: async () => ({ visibility }),
    listOrgRepos: async () => repos.map((p, i) => ({ name: `r${i}`, private: p })),
  })
  it('is true for a private org with private repos', async () => { expect(await forgejoPrivacyReady(fj('private', [true, true]), 'o')).toBe(true) })
  it('is false for a public org', async () => { expect(await forgejoPrivacyReady(fj('public', [true]), 'o')).toBe(false) })
  it('is false when one repo is public', async () => { expect(await forgejoPrivacyReady(fj('private', [true, false]), 'o')).toBe(false) })
  it('is false on error or a missing org', async () => {
    expect(await forgejoPrivacyReady({ getOrg: async () => { throw new Error('x') }, listOrgRepos: async () => [] }, 'o')).toBe(false)
    expect(await forgejoPrivacyReady({ getOrg: async () => undefined, listOrgRepos: async () => [] }, 'o')).toBe(false)
  })
})
