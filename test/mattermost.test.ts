import { describe, expect, it, vi, beforeEach } from 'vitest'
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
