import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  OpencodeClient,
  OpencodeWakeAdapter,
  opencodeTranscript,
  buildOpencodeConfig,
  opencodeLaunchCommand,
  forkOpencodeSession,
} from '../src/lib/harness/opencode.js'
import type { OpencodeMessage, OpencodeSession } from '../src/lib/harness/opencode.js'

// Real messages JSON captured against opencode 1.18.32 (trimmed): a user text
// turn, an assistant text turn, a tool turn, and a reasoning+text turn.
const fixture: OpencodeMessage[] = [
  {
    info: {
      id: 'msg_0d9bef58e0011AB7AGe0uCEdN3',
      sessionID: 'ses_f26415066ffes8487O9RmBMB2J',
      role: 'user',
      time: { created: 1790359565711 },
      agent: 'build',
      model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
    },
    parts: [
      {
        id: 'prt_0d9bef596001XC4kF7A7Gt8XBa',
        sessionID: 'ses_f26415066ffes8487O9RmBMB2J',
        messageID: 'msg_0d9bef58e0011AB7AGe0uCEdN3',
        type: 'text',
        text: 'Reply with exactly the word: pong',
      },
    ],
  },
  {
    info: {
      id: 'msg_0d9bef5a8001CtofpW1k5WkXaB',
      sessionID: 'ses_f26415066ffes8487O9RmBMB2J',
      role: 'assistant',
      time: { created: 1790359565736, completed: 1790359569068 },
      parentID: 'msg_0d9bef58e0011AB7AGe0uCEdN3',
      agent: 'build',
      finish: 'stop',
    },
    parts: [
      { id: 'prt_x1', sessionID: 'ses_f26415066ffes8487O9RmBMB2J', messageID: 'msg_0d9bef5a8001CtofpW1k5WkXaB', type: 'step-start' },
      { id: 'prt_x2', sessionID: 'ses_f26415066ffes8487O9RmBMB2J', messageID: 'msg_0d9bef5a8001CtofpW1k5WkXaB', type: 'text', text: 'pong', time: { start: 1790359569055, end: 1790359569058 } },
      { id: 'prt_x3', sessionID: 'ses_f26415066ffes8487O9RmBMB2J', messageID: 'msg_0d9bef5a8001CtofpW1k5WkXaB', type: 'step-finish', reason: 'stop' },
    ],
  },
  {
    info: {
      id: 'msg_0d9bfa09a001Z539eZHZLyk6qq',
      sessionID: 'ses_f26415066ffes8487O9RmBMB2J',
      role: 'assistant',
      time: { created: 1790359569800, completed: 1790359570400 },
      parentID: 'msg_0d9bfa091001UHC9h1cKGp1k38',
      agent: 'build',
    },
    parts: [
      { id: 'prt_y1', sessionID: 'ses_f26415066ffes8487O9RmBMB2J', messageID: 'msg_0d9bfa09a001Z539eZHZLyk6qq', type: 'step-start' },
      {
        id: 'prt_y2',
        sessionID: 'ses_f26415066ffes8487O9RmBMB2J',
        messageID: 'msg_0d9bfa09a001Z539eZHZLyk6qq',
        type: 'tool',
        callID: 'call_1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/proj/answer.txt' },
          output: '<content>\n1: the secret number is 42\n</content>',
        },
      },
      { id: 'prt_y3', sessionID: 'ses_f26415066ffes8487O9RmBMB2J', messageID: 'msg_0d9bfa09a001Z539eZHZLyk6qq', type: 'step-finish', reason: 'stop' },
    ],
  },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SESSION: OpencodeSession = {
  id: 'ses_f26415066ffes8487O9RmBMB2J',
  title: 'oc-spike-test',
  projectID: 'global',
  directory: '/proj',
  model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
  time: { created: 1, updated: 2 },
}

describe('opencodeTranscript', () => {
  it('converts text and tool parts into TranscriptEntry', () => {
    const entries = opencodeTranscript(fixture)
    expect(entries).toHaveLength(3)

    expect(entries[0]).toMatchObject({
      role: 'user',
      text: 'Reply with exactly the word: pong',
      tools: [],
    })
    expect(entries[0].at).toBe(new Date(1790359565711).toISOString())

    expect(entries[1].role).toBe('assistant')
    expect(entries[1].text).toBe('pong')
    expect(entries[1].tools).toEqual([])

    // tool turn: no text, one tool with input + result
    expect(entries[2].role).toBe('assistant')
    expect(entries[2].text).toBe('')
    expect(entries[2].tools).toHaveLength(1)
    expect(entries[2].tools[0].name).toBe('read')
    expect(entries[2].tools[0].input).toBe(JSON.stringify({ filePath: '/proj/answer.txt' }))
    expect(entries[2].tools[0].result).toContain('the secret number is 42')
    expect(entries[2].tools[0].isError).toBe(false)
  })

  it('marks tool errors', () => {
    const msgs: OpencodeMessage[] = [
      {
        info: { id: 'msg_1', role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'bash',
            state: { status: 'error', input: { command: 'rm x' }, output: 'no' },
          },
        ],
      },
    ]
    const [entry] = opencodeTranscript(msgs)
    expect(entry.tools[0].isError).toBe(true)
    expect(entry.tools[0].result).toBe('no')
  })
})

describe('OpencodeClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  const calls: { url: string; init?: RequestInit }[] = []
  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(handler(url, init))
    }))
  }

  it('createSession posts a title and returns the session id', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/session') && init?.method === 'POST') return jsonResponse(SESSION)
      throw new Error(`unexpected ${url}`)
    })
    const client = new OpencodeClient('http://127.0.0.1:4199/')
    const session = await client.createSession('oc-spike-test')
    expect(session.id).toBe('ses_f26415066ffes8487O9RmBMB2J')
    expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({ title: 'oc-spike-test' })
  })

  it('prompt sends a text part and waits for a new assistant message when wait=true', async () => {
    let poll = 0
    stubFetch((url, init) => {
      if (url.includes('/prompt_async')) return new Response(null, { status: 204 })
      if (url.includes('/message')) {
        poll++
        // first poll: only the old user message; second: a new assistant message
        return poll === 1
          ? jsonResponse([fixture[0]])
          : jsonResponse([fixture[0], fixture[1]])
      }
      throw new Error(`unexpected ${url}`)
    })
    const client = new OpencodeClient('http://127.0.0.1:4199')
    await client.prompt('ses_f26415066ffes8487O9RmBMB2J', 'hello', { wait: true })
    const body = JSON.parse(calls.find((c) => c.url.includes('/prompt_async'))!.init!.body as string)
    expect(body.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(poll).toBe(2)
  })

  it('isIdle is true when status map is empty and false when busy', async () => {
    let busy = false
    stubFetch((url) => {
      if (url.includes('/session/status')) return jsonResponse(busy ? { ses_x: { type: 'busy' } } : {})
      throw new Error(`unexpected ${url}`)
    })
    const client = new OpencodeClient('http://127.0.0.1:4199')
    expect(await client.isIdle('ses_x')).toBe(true)
    busy = true
    expect(await client.isIdle('ses_x')).toBe(false)
  })

  it('fork posts an optional messageID and returns the new session id', async () => {
    stubFetch((url, init) => {
      if (url.includes('/fork')) {
        expect(JSON.parse(init!.body as string)).toEqual({ messageID: 'msg_123' })
        return jsonResponse({ ...SESSION, id: 'ses_new', title: 'oc-spike-test (fork #1)' })
      }
      throw new Error(`unexpected ${url}`)
    })
    const id = await forkOpencodeSession({ baseUrl: 'http://127.0.0.1:4199', sessionId: 'ses_f26415066ffes8487O9RmBMB2J', messageId: 'msg_123' })
    expect(id).toBe('ses_new')
  })

  it('sends basic auth when a password is configured', async () => {
    stubFetch((url, init) => {
      if (url.includes('/session') && init?.method === 'POST') return jsonResponse(SESSION)
      throw new Error(`unexpected ${url}`)
    })
    const client = new OpencodeClient('http://127.0.0.1:4199', { password: 'sekret' })
    await client.createSession('x')
    const auth = calls[0].init!.headers as Record<string, string>
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('opencode:sekret').toString('base64')}`)
  })
})

describe('OpencodeWakeAdapter', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('delivers via prompt and reports isIdle from the status endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/session/status')) return Promise.resolve(jsonResponse({}))
      if (url.includes('/prompt_async')) return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(new Response(null, { status: 404 }))
    }))
    let sessionId: string | undefined = 'ses_abc'
    const adapter = new OpencodeWakeAdapter({ baseUrl: 'http://127.0.0.1:4199', sessionId: () => sessionId })
    expect(await adapter.isIdle()).toBe(true)
    await adapter.deliver('hello')
    sessionId = undefined
    expect(await adapter.isIdle()).toBe(true)
    await expect(adapter.deliver('x')).rejects.toThrow(/no opencode desk session/)
  })

  it('isAlive reflects server reachability', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))))
    const adapter = new OpencodeWakeAdapter({ baseUrl: 'http://127.0.0.1:4199', sessionId: () => 'ses_abc' })
    expect(await adapter.isAlive()).toBe(false)
  })

  it('isIdle falls back to /session/status when the cached SSE state is stale', async () => {
    vi.useFakeTimers()
    let statusCalls = 0
    const idleEvent = 'data: {"type":"session.idle","properties":{"sessionID":"ses_abc"}}\n\n'
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/global/event')) {
        return Promise.resolve(new Response(new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(idleEvent))
            c.close()
          }
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      }
      if (url.includes('/session/status')) {
        statusCalls++
        return Promise.resolve(jsonResponse({ ses_abc: { type: 'busy' } }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    }))
    const adapter = new OpencodeWakeAdapter({ baseUrl: 'http://127.0.0.1:4199', sessionId: () => 'ses_abc' })
    // Let the SSE event land.
    await vi.advanceTimersByTimeAsync(10)
    // Cached idle is fresh.
    expect(await adapter.isIdle()).toBe(true)
    expect(statusCalls).toBe(0)
    // Advance past the 30s stale threshold.
    vi.advanceTimersByTime(31_000)
    expect(await adapter.isIdle()).toBe(false)
    expect(statusCalls).toBeGreaterThanOrEqual(1)
    vi.useRealTimers()
  })
})

describe('OpencodeClient.subscribe', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('reconnects with backoff after the stream ends', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/global/event')) {
        calls++
        return Promise.resolve(new Response(new ReadableStream({ pull: (c) => c.close() }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    }))
    const client = new OpencodeClient('http://127.0.0.1:4199')
    const sub = client.subscribe(() => {})
    expect(calls).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(calls).toBeGreaterThanOrEqual(2)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(calls).toBeGreaterThanOrEqual(3)
    const beforeClose = calls
    sub.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(beforeClose)
    vi.useRealTimers()
  })
})

describe('buildOpencodeConfig', () => {
  it('declares the office MCP, instructions, and deny rules', () => {
    const cfg = buildOpencodeConfig({
      root: '/app',
      agent: 'ada',
      model: 'opencode-go/deepseek-v4.1-flash',
      instructions: ['AGENTS.md', 'persona.md'],
      extraMcp: { browser: { type: 'local', command: ['npx', 'x'] } },
    }) as Record<string, any>

    expect(cfg.$schema).toBe('https://opencode.ai/config.json')
    expect(cfg.model).toBe('opencode-go/deepseek-v4.1-flash')
    expect(cfg.instructions).toEqual(['AGENTS.md', 'persona.md'])

    const office = cfg.mcp.office
    expect(office.type).toBe('local')
    expect(office.command).toEqual(['/app/node_modules/.bin/tsx', '/app/src/mcp/server.ts'])
    expect(office.environment).toEqual({ OFFICE_ROOT: '/app', OFFICE_AGENT: 'ada' })
    expect(cfg.mcp.browser).toEqual({ type: 'local', command: ['npx', 'x'] })

    const bash = cfg.permission.bash
    expect(cfg.permission.edit).toBe('allow')
    expect(bash['*']).toBe('allow')
    expect(bash['rm -rf /*']).toBe('deny')
    expect(bash['sudo *']).toBe('deny')
    expect(bash['git push --force*']).toBe('deny')
    expect(bash['docker rm*']).toBe('deny')
    expect(bash['docker compose down*']).toBe('deny')
  })
})

describe('opencodeLaunchCommand', () => {
  it('builds the verified startup sequence with OPENCODE_CONFIG and -s', () => {
    const cmd = opencodeLaunchCommand({
      root: '/app',
      agent: 'ada',
      workspace: '/ws/ada',
      configPath: '/ws/ada/opencode.json',
      port: 4100,
      model: 'opencode-go/deepseek-v4.1-flash',
      sessionId: 'ses_123',
    })
    expect(cmd).toBe(
      "OPENCODE_CONFIG='/ws/ada/opencode.json' opencode '/ws/ada' --port 4100 -m opencode-go/deepseek-v4.1-flash --auto -s ses_123",
    )
  })

  it('omits -s when no session id is given', () => {
    const cmd = opencodeLaunchCommand({
      root: '/app',
      agent: 'ada',
      workspace: '/ws/ada',
      configPath: '/ws/ada/opencode.json',
      port: 4100,
      model: 'm',
    })
    expect(cmd).not.toContain('-s')
    expect(cmd).toContain('--port 4100')
  })

  it('headless uses opencode serve and cds into the workspace', () => {
    const cmd = opencodeLaunchCommand({
      root: '/app',
      agent: 'ada',
      workspace: '/ws/ada',
      configPath: '/ws/ada/opencode.json',
      port: 4100,
      model: 'm',
      headless: true,
    })
    expect(cmd).toBe("cd '/ws/ada' && exec env OPENCODE_CONFIG='/ws/ada/opencode.json' opencode serve --port 4100")
  })
})

// Live test: run only when OPENCODE_LIVE=1 with a running opencode server.
//   OPENCODE_LIVE=1 npx vitest run test/opencode.test.ts
const LIVE = process.env.OPENCODE_LIVE === '1'
const BASE = process.env.OPENCODE_LIVE_URL ?? 'http://127.0.0.1:4199'
const LIVE_MODEL = { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }

describe.skipIf(!LIVE)('live opencode', () => {
  it('create → prompt → messages → fork → abort against a real server', async () => {
    const client = new OpencodeClient(BASE)
    await client.waitForServer(30_000)

    const session = await client.createSession('oc-live-test')
    await client.prompt(session.id, 'Reply with exactly: live-ok', { wait: true, model: LIVE_MODEL })

    const msgs = await client.messages(session.id)
    const last = msgs[msgs.length - 1]
    expect(last.info.role).toBe('assistant')

    const forked = await client.fork(session.id)
    expect(forked.id).not.toBe(session.id)
    expect(forked.id).toMatch(/^ses/)

    await client.abort(session.id)
  })
})
