import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import type { MattermostClient } from '../src/lib/mattermost.js'

const wsInstances: MockWebSocket[] = []

class MockWebSocket {
  public handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  public sent: unknown[] = []
  public close = vi.fn()
  public terminate = vi.fn()

  constructor() {
    wsInstances.push(this)
  }

  on(ev: string, fn: (...args: unknown[]) => void) {
    this.handlers[ev] = this.handlers[ev] ?? []
    this.handlers[ev].push(fn)
  }

  send(data: unknown) {
    this.sent.push(data)
  }
}

vi.mock('ws', () => ({ default: MockWebSocket }))

async function makeClient(): Promise<MattermostClient> {
  const mod = await import('../src/lib/mattermost.js')
  return new mod.MattermostClient('http://mm', 'tok')
}

describe('MattermostClient WebSocket', () => {
  beforeEach(() => { wsInstances.length = 0 })

  it('does not throw when posted event contains invalid JSON (M10)', async () => {
    const client = await makeClient()
    const posts: unknown[] = []
    client.connectWebSocket((post, meta) => { posts.push({ post, meta }) })
    const ws = wsInstances[0]
    ws.handlers.open?.forEach((fn) => fn())
    expect(() => {
      ws.handlers.message?.forEach((fn) => fn(Buffer.from(JSON.stringify({ event: 'posted', data: { post: 'not-json' } }))))
      ws.handlers.message?.forEach((fn) => fn(Buffer.from(JSON.stringify({ event: 'posted', data: { post: JSON.stringify({ id: 'p1', channel_id: 'c1', user_id: 'u1', message: 'hi', root_id: '', create_at: 1 }), mentions: 'not-json' } }))))
    }).not.toThrow()
    expect(posts).toHaveLength(0)
  })

  it('calls onReconnect on reconnect, not on first open (H2)', async () => {
    const client = await makeClient()
    const reconnects: number[] = []
    client.connectWebSocket(() => {}, undefined, () => reconnects.push(Date.now()))
    const first = wsInstances[0]
    first.handlers.open?.forEach((fn) => fn())
    expect(reconnects).toHaveLength(0)
    first.handlers.close?.forEach((fn) => fn())
    await new Promise((r) => setTimeout(r, 1_500))
    expect(wsInstances).toHaveLength(2)
    const second = wsInstances[1]
    second.handlers.open?.forEach((fn) => fn())
    expect(reconnects).toHaveLength(1)
  })
})

function captureFetch(reply: unknown = {}, status = 200) {
  const requests: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } })
  }))
  return requests
}

describe('MattermostClient role and account admin calls', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads a role by name', async () => {
    const reqs = captureFetch({ id: 'r1', name: 'team_user', permissions: ['view_team'], extra: 1 })
    const role = await (await makeClient()).getRoleByName('team_user')
    expect(role).toMatchObject({ id: 'r1', name: 'team_user', permissions: ['view_team'] })
    expect(reqs[0]).toMatchObject({ method: 'GET', url: 'http://mm/api/v4/roles/name/team_user' })
  })

  it('patches the permissions of a role', async () => {
    const reqs = captureFetch({ id: 'r1' })
    await (await makeClient()).patchRolePermissions('r1', ['view_team'])
    expect(reqs[0]).toEqual({ method: 'PUT', url: 'http://mm/api/v4/roles/r1/patch', body: { permissions: ['view_team'] } })
  })

  it('reads and promotes a team member', async () => {
    const reqs = captureFetch({ scheme_admin: true, user_id: 'u1' })
    const mm = await makeClient()
    expect((await mm.getTeamMember('t1', 'u1')).scheme_admin).toBe(true)
    await mm.setTeamAdmin('t1', 'u1')
    expect(reqs[0]).toMatchObject({ method: 'GET', url: 'http://mm/api/v4/teams/t1/members/u1' })
    expect(reqs[1]).toEqual({ method: 'PUT', url: 'http://mm/api/v4/teams/t1/members/u1/schemeRoles', body: { scheme_admin: true, scheme_user: true } })
  })

  it('sets a password and deactivates a user', async () => {
    const reqs = captureFetch({ status: 'OK' })
    const mm = await makeClient()
    await mm.setUserPassword('u1', 'new-secret')
    await mm.deactivateUser('u1')
    expect(reqs[0]).toEqual({ method: 'PUT', url: 'http://mm/api/v4/users/u1/password', body: { new_password: 'new-secret' } })
    expect(reqs[1]).toMatchObject({ method: 'DELETE', url: 'http://mm/api/v4/users/u1' })
  })
})
