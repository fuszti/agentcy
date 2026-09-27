// opencode harness adapter: drive a long-lived opencode TUI (running with
// `--port N`) over its built-in HTTP server, and translate its transcript.
//
// Everything here is derived from live experiments against opencode 1.18.32
// (see docs/research/opencode-runtime.md). The server exposes a REST API plus
// an SSE event stream; sessions are `ses_...` ids, messages are `msg_...`,
// parts `prt_...`, events `evt_...`.
import type { TranscriptEntry, WakeAdapter } from '../types.js'

// ------------------------------------------------------------------ shapes

/** Minimal view of a session as returned by POST/GET /session. */
export interface OpencodeSession {
  id: string
  title?: string
  slug?: string
  directory?: string
  projectID?: string
  parentID?: string
  model?: { id: string; providerID: string; variant?: string }
  time?: { created: number; updated: number }
  [key: string]: unknown
}

/** `info` object attached to every message. */
export interface OpencodeMessageInfo {
  id: string
  role: string // "user" | "assistant" | ...
  time?: { created?: number; completed?: number }
  agent?: string
  parentID?: string
  model?: { providerID?: string; modelID?: string }
  [key: string]: unknown
}

export interface OpencodeTextPart {
  id?: string
  type: 'text'
  text: string
  [key: string]: unknown
}

export interface OpencodeToolPart {
  id?: string
  type: 'tool'
  /** opencode calls the field `tool` in the durable message, `name` in older shapes. */
  tool?: string
  name?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type OpencodePart =
  | OpencodeTextPart
  | OpencodeToolPart
  | ({ type: string } & Record<string, unknown>)

/** One message as returned by GET /session/{id}/message. */
export interface OpencodeMessage {
  info: OpencodeMessageInfo
  parts: OpencodePart[]
}

/** A single SSE event (the normalised `payload` of a `data:` frame). */
export interface OpencodeEvent {
  id?: string
  type: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
  [key: string]: unknown
}

// ------------------------------------------------------------------ client

export interface OpencodeClientOptions {
  /** Basic-auth password (opencode's OPENCODE_SERVER_PASSWORD). */
  password?: string
  /** Basic-auth username; opencode defaults to "opencode". */
  username?: string
}

const DEFAULT_WAIT_TIMEOUT = 300_000

/**
 * Thin client for the opencode HTTP API. All methods talk to the server that a
 * long-lived `opencode --port N` (TUI or `opencode serve`) exposes on localhost.
 */
export class OpencodeClient {
  readonly baseUrl: string
  private readonly username: string
  private readonly password?: string

  constructor(baseUrl: string, opts: OpencodeClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.username = opts.username ?? 'opencode'
    this.password = opts.password
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.password !== undefined) {
      const token = Buffer.from(`${this.username}:${this.password}`).toString('base64')
      h['Authorization'] = `Basic ${token}`
    }
    return h
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(30_000),
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`opencode ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 500)}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  /** Poll the health endpoint until the server answers (or timeoutMs elapses). */
  async waitForServer(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const res = await fetch(`${this.baseUrl}/global/health`, { headers: this.headers(), signal: AbortSignal.timeout(2_000) })
        if (res.ok) return
      } catch {
        // not up yet
      }
      if (Date.now() >= deadline) {
        throw new Error(`opencode server ${this.baseUrl} did not come up within ${timeoutMs}ms`)
      }
      await sleep(250)
    }
  }

  /** Create a session (POST /session). Returns the created session (has `id`). */
  async createSession(title: string, opts: { model?: { providerID: string; modelID: string }; agent?: string } = {}): Promise<OpencodeSession> {
    const body: Record<string, unknown> = { title }
    if (opts.model) body.model = { id: opts.model.modelID, providerID: opts.model.providerID }
    if (opts.agent) body.agent = opts.agent
    return this.request<OpencodeSession>('/session', { method: 'POST', body: JSON.stringify(body) })
  }

  /** List sessions, most recently updated first. */
  async listSessions(): Promise<OpencodeSession[]> {
    return this.request<OpencodeSession[]>('/session')
  }

  /**
   * Inject a prompt into a session (POST /session/{id}/prompt_async). Returns
   * immediately (204). When `wait` is true, polls until a new assistant
   * message appears (or DEFAULT_WAIT_TIMEOUT elapses).
   */
  async prompt(
    sessionId: string,
    text: string,
    opts: {
      wait?: boolean
      model?: { providerID: string; modelID: string }
      agent?: string
      timeoutMs?: number
    } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] }
    if (opts.model) body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID }
    if (opts.agent) body.agent = opts.agent

    const before = opts.wait ? new Set((await this.messages(sessionId)).map((m) => m.info.id)) : null

    await this.request<void>(`/session/${sessionId}/prompt_async`, { method: 'POST', body: JSON.stringify(body) })

    if (opts.wait && before) {
      const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT)
      for (;;) {
        const msgs = await this.messages(sessionId)
        if (msgs.some((m) => m.info.role === 'assistant' && !before.has(m.info.id))) return
        if (Date.now() >= deadline) throw new Error(`timed out waiting for opencode response on ${sessionId}`)
        await sleep(500)
      }
    }
  }

  /** All messages of a session (GET /session/{id}/message): `[{info, parts}]`. */
  async messages(sessionId: string): Promise<OpencodeMessage[]> {
    return this.request<OpencodeMessage[]>(`/session/${sessionId}/message`)
  }

  /** Fork a session (POST /session/{id}/fork) at an optional message id. */
  async fork(sessionId: string, messageId?: string): Promise<OpencodeSession> {
    return this.request<OpencodeSession>(`/session/${sessionId}/fork`, {
      method: 'POST',
      body: JSON.stringify(messageId ? { messageID: messageId } : {}),
    })
  }

  /** Abort a running session (POST /session/{id}/abort). */
  async abort(sessionId: string): Promise<void> {
    await this.request<void>(`/session/${sessionId}/abort`, { method: 'POST' })
  }

  /**
   * Whether the session is idle. Uses GET /session/status, which reports a map
   * of currently-tracked sessions; a session is idle when absent or `type === "idle"`
   * (any other type — busy, retry — means it is still working).
   */
  async isIdle(sessionId: string): Promise<boolean> {
    const statuses = await this.request<Record<string, { type?: string }>>('/session/status')
    const status = statuses[sessionId]
    return !status || status.type === 'idle'
  }

  /**
   * Subscribe to the global SSE event stream (GET /global/event). `onEvent` is
   * called with each normalised event payload. Reconnects with exponential
   * backoff (1s -> 30s) until close() is called. Returns `{close()}` to stop.
   */
  subscribe(onEvent: (event: OpencodeEvent) => void): { close(): void } {
    const controller = new AbortController()
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let backoffMs = 1000
    const maxBackoff = 30000

    const run = async () => {
      while (!closed) {
        try {
          const res = await fetch(`${this.baseUrl}/global/event`, {
            headers: { ...this.headers(), Accept: 'text/event-stream' },
            signal: controller.signal,
          })
          if (!res.ok || !res.body) throw new Error(`subscribe failed: ${res.status}`)
          backoffMs = 1000
          await consumeSse(res.body, (event) => {
            const payload = event as OpencodeEvent
            if (payload && typeof payload.type === 'string' && payload.type !== 'sync') onEvent(payload)
          })
        } catch {
          // Stream closed or failed to connect; backoff and retry.
        }
        if (closed) break
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeout(() => {
            backoffMs = Math.min(backoffMs * 2, maxBackoff)
            resolve()
          }, backoffMs)
        })
      }
    }

    void run()
    return {
      close: () => {
        closed = true
        if (reconnectTimer) clearTimeout(reconnectTimer)
        controller.abort()
      },
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Incremental SSE parser over a web stream. Calls `onEvent` with the parsed
 * JSON of each `data:` frame. opencode sends `data: {json}\n\n` with an initial
 * burst of NUL keep-alive bytes, which we ignore.
 */
async function consumeSse(body: ReadableStream<Uint8Array>, onEvent: (event: unknown) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\x00/g, '')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim())
      } else if (line === '' && dataLines.length > 0) {
        const text = dataLines.join('\n')
        dataLines = []
        if (!text) continue
        try {
          onEvent(JSON.parse(text))
        } catch {
          // ignore malformed frame
        }
      }
    }
  }
}

// ------------------------------------------------------------------ adapter

/**
 * Wake adapter backed by an opencode server. Tracks idle state from the SSE
 * stream and falls back to the /session/status endpoint when the stream is stale.
 */
export class OpencodeWakeAdapter implements WakeAdapter {
  private readonly client: OpencodeClient
  private readonly sessionId: () => string | undefined
  private readonly idleBySession = new Map<string, boolean>()
  private readonly lastEventAt = new Map<string, number>()
  private readonly staleMs = 30_000

  constructor(opts: { baseUrl: string; sessionId: () => string | undefined }) {
    this.client = new OpencodeClient(opts.baseUrl)
    this.sessionId = opts.sessionId
    this.client.subscribe((event) => {
      const id = event.properties?.sessionID ?? event.data?.sessionID
      if (typeof id !== 'string') return
      const now = Date.now()
      this.lastEventAt.set(id, now)
      if (event.type === 'session.status') {
        const status = (event.properties?.status as { type?: string })?.type
        this.idleBySession.set(id, status === 'idle')
      } else if (event.type === 'session.idle') {
        this.idleBySession.set(id, true)
      }
    })
  }

  async isIdle(): Promise<boolean> {
    const id = this.sessionId()
    if (!id) return true
    const tracked = this.idleBySession.get(id)
    const last = this.lastEventAt.get(id)
    const fresh = last !== undefined && Date.now() - last < this.staleMs
    if (tracked !== undefined && fresh) return tracked
    const current = await this.client.isIdle(id)
    this.idleBySession.set(id, current)
    return current
  }

  /** Inject a prompt via the HTTP API; it appears live in the opencode TUI. */
  async deliver(text: string): Promise<void> {
    const id = this.sessionId()
    if (!id) throw new Error('no opencode desk session id available')
    await this.client.prompt(id, text)
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.client.waitForServer(1500)
      return true
    } catch {
      return false
    }
  }
}

// ------------------------------------------------------------------ transcript

/** Convert opencode messages into harness-neutral transcript entries. */
export function opencodeTranscript(messages: OpencodeMessage[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const msg of messages) {
    const role = msg.info.role === 'user' ? 'user' : 'assistant'
    const texts: string[] = []
    const tools: TranscriptEntry['tools'] = []
    for (const part of msg.parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        texts.push(part.text)
      } else if (part.type === 'tool') {
        const toolPart = part as OpencodeToolPart
        const tool = toolPart.tool ?? toolPart.name
        const state: { status?: string; input?: unknown; output?: string } = toolPart.state ?? {}
        tools.push({
          name: tool ?? '',
          input: typeof state.input === 'string' ? state.input : JSON.stringify(state.input ?? {}),
          result: typeof state.output === 'string' ? state.output : undefined,
          isError: state.status === 'error',
        })
      }
    }
    out.push({
      role,
      text: texts.join('\n\n'),
      tools,
      at: msg.info.time?.created ? new Date(msg.info.time.created).toISOString() : undefined,
    })
  }
  return out
}

// ------------------------------------------------------------------ config

/** A local MCP server that launches Playwright (for agents with Chrome access). */
export const opencodePlaywrightMcp = {
  type: 'local',
  command: ['npx', '-y', '@playwright/mcp@latest', '--headless', '--isolated'],
} as const

export interface BuildOpencodeConfigOptions {
  root: string
  agent: string
  model: string
  instructions: string[]
  extraMcp?: Record<string, unknown>
}

/**
 * Build an opencode.json object for one agent. The `office` MCP server is the
 * per-agent `src/mcp/server.ts`, run with tsx and told its root + agent via env.
 */
export function buildOpencodeConfig(opts: BuildOpencodeConfigOptions): Record<string, unknown> {
  const tsx = `${opts.root}/node_modules/.bin/tsx`
  const server = `${opts.root}/src/mcp/server.ts`
  const mcp: Record<string, unknown> = {
    office: {
      type: 'local',
      command: [tsx, server],
      environment: { OFFICE_ROOT: opts.root, OFFICE_AGENT: opts.agent },
    },
  }
  for (const [name, cfg] of Object.entries(opts.extraMcp ?? {})) mcp[name] = cfg

  return {
    $schema: 'https://opencode.ai/config.json',
    model: opts.model,
    instructions: opts.instructions,
    mcp,
    permission: {
      edit: 'allow',
      read: {
        '*': 'allow',
        [`*${opts.root}/state*`]: 'deny',
        '*../state*': 'deny',
      },
      bash: {
        '*': 'allow',
        'rm -rf /*': 'deny',
        'sudo *': 'deny',
        'git push --force*': 'deny',
        'docker rm*': 'deny',
        'docker compose down*': 'deny',
        [`*${opts.root}/state*`]: 'deny',
        '*../state*': 'deny',
        // The office CLI carries owner powers (hire/retire/merge): agents use their MCP tools instead.
        '*bin/office*': 'deny',
        '*src/cli/office*': 'deny',
        '*src/cli/bootstrap*': 'deny',
      },
      webfetch: 'ask',
    },
  }
}

// ------------------------------------------------------------------ launch

export interface OpencodeLaunchOptions {
  root: string
  agent: string
  workspace: string
  configPath: string
  port: number
  model: string
  sessionId?: string
  /** Start a headless server (`opencode serve`) instead of the TUI. */
  headless?: boolean
  /** Env-var assignments to prefix to the shell command (git identity, etc.). */
  envPrefix?: string
}

/** Single-quote a string for a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The exact command to run inside the tmux window (or, with `headless: true`,
 * as a background process). Derived from the verified Q4 startup sequence:
 * `opencode <workspace> --port N -m <model> -s <session>`, with the agent config
 * supplied via OPENCODE_CONFIG (a file path). `opencode serve` does not accept a
 * project path or `-m`, so the headless form `cd`s into the workspace and relies
 * on the config's `model` field.
 */
export function opencodeLaunchCommand(opts: OpencodeLaunchOptions): string {
  let prefix = opts.envPrefix ?? ''
  if (opts.configPath) prefix += `OPENCODE_CONFIG=${shellQuote(opts.configPath)} `
  if (opts.headless) {
    // Env must be applied to opencode itself, not to `cd`.
    return `cd ${shellQuote(opts.workspace)} && exec env ${prefix}opencode serve --port ${opts.port}`
  }
  const parts = [`opencode ${shellQuote(opts.workspace)}`, `--port ${opts.port}`, `-m ${opts.model}`, `--auto`]
  if (opts.sessionId) parts.push(`-s ${opts.sessionId}`)
  return `${prefix}${parts.join(' ')}`
}

// ------------------------------------------------------------------ fork

/**
 * Fork an opencode session into a new one and return the new session id
 * (verified Q5): the new session copies all messages strictly before the fork
 * point and gets a fresh id; title becomes "<title> (fork #N)".
 */
export async function forkOpencodeSession(opts: {
  baseUrl: string
  sessionId: string
  messageId?: string
}): Promise<string> {
  const client = new OpencodeClient(opts.baseUrl)
  const forked = await client.fork(opts.sessionId, opts.messageId)
  return forked.id
}
