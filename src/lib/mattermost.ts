// Typed Mattermost REST v4 + WebSocket client for the agent office.

import WebSocket from 'ws'
import type { ChatPost, ChatChannel, ChatFile } from './types.js'

export interface CreateChannelInput {
  teamId: string
  name: string
  displayName: string
  purpose?: string
  type: 'O' | 'P' | 'D'
}

export interface CreatePostInput {
  channelId: string
  message: string
  rootId?: string
  /** Ids of files (from uploadFile) to attach. */
  fileIds?: string[]
}

export interface PostQuery {
  since?: number
  page?: number
  perPage?: number
}

export interface CreateUserInput {
  username: string
  email: string
  password: string
}

export interface CreateBotInput {
  username: string
  displayName: string
  description?: string
}

export interface StatusEvent {
  user_id: string
  status: string
}

/** Resolve username + channel name for a raw post, with simple in-memory caches. */
class MattermostResolver {
  private users = new Map<string, string>()
  private channels = new Map<string, ChatChannel>()

  constructor(private client: MattermostClient) {}

  async userName(id: string): Promise<string> {
    let name = this.users.get(id)
    if (!name) {
      const u = await this.client.getUser(id)
      name = u.username
      this.users.set(id, name)
    }
    return name
  }

  async channel(id: string): Promise<ChatChannel> {
    let ch = this.channels.get(id)
    if (!ch) {
      ch = await this.client.getChannel(id)
      this.channels.set(id, ch)
    }
    return ch
  }

  cacheUser(id: string, username: string): void {
    this.users.set(id, username)
  }

  cacheChannel(id: string, channel: ChatChannel): void {
    this.channels.set(id, channel)
  }
}

/** Mattermost Team Edition REST client. */
export class MattermostClient {
  private resolver: MattermostResolver
  private wsBaseUrl: string

  constructor(
    private baseUrl: string,
    private token: string,
  ) {
    this.resolver = new MattermostResolver(this)
    this.wsBaseUrl = baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/api/v4${path}`
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(this.url(path), init)
    if (!res.ok) {
      let serverMsg = ''
      try {
        const txt = await res.text()
        const parsed = JSON.parse(txt)
        serverMsg = parsed.message ?? parsed.error ?? txt
      } catch {
        serverMsg = `${res.status} ${res.statusText}`
      }
      throw new Error(`Mattermost ${method} ${path} failed: ${res.status} ${serverMsg}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  async me(): Promise<{ id: string; username: string; email: string; roles: string }> {
    return this.request('GET', '/users/me')
  }

  async getUser(id: string): Promise<{ id: string; username: string; email: string; roles: string }> {
    return this.request('GET', `/users/${id}`)
  }

  async getUserByUsername(username: string): Promise<{ id: string; username: string; email: string; roles: string }> {
    return this.request('GET', `/users/username/${encodeURIComponent(username)}`)
  }

  async getUsersByIds(ids: string[]): Promise<{ id: string; username: string }[]> {
    return this.request('POST', '/users/ids', ids)
  }

  async getTeamByName(name: string): Promise<{ id: string; name: string; display_name: string }> {
    return this.request('GET', `/teams/name/${encodeURIComponent(name)}`)
  }

  async addUserToTeam(teamId: string, userId: string): Promise<void> {
    await this.request('POST', `/teams/${teamId}/members`, { team_id: teamId, user_id: userId })
  }

  async getChannelByName(teamId: string, name: string): Promise<ChatChannel> {
    const raw = await this.request<{
      id: string
      name: string
      display_name: string
      purpose: string
      type: 'O' | 'P' | 'D' | 'G'
    }>('GET', `/teams/${teamId}/channels/name/${encodeURIComponent(name)}`)
    const ch = this.mapChannel(raw)
    this.resolver.cacheChannel(raw.id, ch)
    return ch
  }

  async getChannel(id: string): Promise<ChatChannel> {
    const raw = await this.request<{
      id: string
      name: string
      display_name: string
      purpose: string
      type: 'O' | 'P' | 'D' | 'G'
    }>('GET', `/channels/${id}`)
    const ch = this.mapChannel(raw)
    this.resolver.cacheChannel(raw.id, ch)
    return ch
  }

  async createChannel(input: CreateChannelInput): Promise<ChatChannel> {
    const raw = await this.request<{
      id: string
      name: string
      display_name: string
      purpose: string
      type: 'O' | 'P' | 'D' | 'G'
    }>('POST', '/channels', {
      team_id: input.teamId,
      name: input.name,
      display_name: input.displayName,
      purpose: input.purpose ?? '',
      type: input.type,
    })
    const ch = this.mapChannel(raw)
    this.resolver.cacheChannel(raw.id, ch)
    return ch
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}`)
  }

  async addToChannel(channelId: string, userId: string): Promise<void> {
    await this.request('POST', `/channels/${channelId}/members`, { user_id: userId })
  }

  async removeFromChannel(channelId: string, userId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}/members/${userId}`)
  }

  async getChannelMembers(channelId: string): Promise<{ user_id: string }[]> {
    return this.request('GET', `/channels/${channelId}/members`)
  }

  async getChannelsForUser(teamId: string, userId?: string): Promise<ChatChannel[]> {
    const uid = userId ?? 'me'
    const raw = await this.request<
      { id: string; name: string; display_name: string; purpose: string; type: 'O' | 'P' | 'D' | 'G' }[]
    >('GET', `/users/${uid}/teams/${teamId}/channels`)
    return raw.map((r) => this.mapChannel(r))
  }

  async getPublicChannels(teamId: string): Promise<ChatChannel[]> {
    const raw = await this.request<
      { id: string; name: string; display_name: string; purpose: string; type: 'O' | 'P' | 'D' | 'G' }[]
    >('GET', `/teams/${teamId}/channels`)
    return raw.map((r) => this.mapChannel(r))
  }

  async createDirectChannel(a: string, b: string): Promise<ChatChannel> {
    const raw = await this.request<{
      id: string
      name: string
      display_name: string
      purpose: string
      type: 'O' | 'P' | 'D' | 'G'
    }>('POST', '/channels/direct', [a, b])
    const ch = this.mapChannel(raw)
    this.resolver.cacheChannel(raw.id, ch)
    return ch
  }

  async createPost(input: CreatePostInput): Promise<ChatPost> {
    const raw = await this.request<RawPost>('POST', '/posts', {
      channel_id: input.channelId,
      message: input.message,
      root_id: input.rootId ?? '',
      file_ids: input.fileIds ?? [],
    })
    return this.mapPost(raw)
  }

  /** FileInfo for one uploaded file (name/size/mime), e.g. to size-check before download. */
  async getFileInfo(id: string): Promise<ChatFile> {
    const raw = await this.request<{ id: string; name: string; mime_type: string; size: number }>(
      'GET',
      `/files/${id}/info`,
    )
    return { id: raw.id, name: raw.name, mimeType: raw.mime_type, size: raw.size }
  }

  /** Raw bytes of an uploaded file. */
  async downloadFile(id: string): Promise<Buffer> {
    const res = await fetch(this.url(`/files/${id}`), {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`Mattermost GET /files/${id} failed: ${res.status} ${res.statusText}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** Upload a file (multipart) to a channel ahead of attaching it to a post; returns the file id. */
  async uploadFile(channelId: string, filename: string, data: Buffer): Promise<string> {
    const form = new FormData()
    form.append('channel_id', channelId)
    form.append('files', new Blob([new Uint8Array(data)]), filename)
    const res = await fetch(this.url('/files'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      let serverMsg = `${res.status} ${res.statusText}`
      try {
        const parsed = JSON.parse(await res.text())
        serverMsg = parsed.message ?? parsed.error ?? serverMsg
      } catch {
        // keep default
      }
      throw new Error(`Mattermost POST /files failed: ${serverMsg}`)
    }
    const parsed = (await res.json()) as { file_infos: { id: string }[] }
    const id = parsed.file_infos?.[0]?.id
    if (!id) throw new Error('Mattermost POST /files returned no file id')
    return id
  }

  async getPost(id: string): Promise<ChatPost> {
    const raw = await this.request<RawPost>('GET', `/posts/${id}`)
    return this.mapPost(raw)
  }

  /** Thread replies ordered oldest -> newest. */
  async getPostThread(postId: string): Promise<ChatPost[]> {
    const raw = await this.request<{ order: string[]; posts: Record<string, RawPost> }>('GET', `/posts/${postId}/thread`)
    return await Promise.all(raw.order.map((id) => this.mapPost(raw.posts[id])))
  }

  async getChannelPosts(channelId: string, query: PostQuery = {}): Promise<ChatPost[]> {
    const params = new URLSearchParams()
    if (query.since !== undefined) params.set('since', String(query.since))
    if (query.page !== undefined) params.set('page', String(query.page))
    if (query.perPage !== undefined) params.set('per_page', String(query.perPage))
    const q = params.toString() ? `?${params.toString()}` : ''
    const raw = await this.request<{ order: string[]; posts: Record<string, RawPost> }>(
      'GET',
      `/channels/${channelId}/posts${q}`,
    )
    const posts = await Promise.all(raw.order.map((id) => this.mapPost(raw.posts[id])))
    return posts.sort((a, b) => a.createAt - b.createAt) // oldest → newest

  }

  async searchPosts(teamId: string, terms: string): Promise<ChatPost[]> {
    const raw = await this.request<{ order: string[]; posts: Record<string, RawPost> }>('POST', `/teams/${teamId}/posts/search`, {
      terms,
      is_or_search: false,
    })
    return await Promise.all(raw.order.map((id) => this.mapPost(raw.posts[id])))
  }

  async getReactions(postId: string): Promise<{ user_id: string; emoji_name: string }[]> {
    return (await this.request<{ user_id: string; emoji_name: string }[] | null>('GET', `/posts/${postId}/reactions`)) ?? []
  }

  async addReaction(postId: string, emoji: string): Promise<void> {
    await this.request('POST', '/reactions', {
      user_id: (await this.me()).id,
      post_id: postId,
      emoji_name: emoji.replace(/:/g, ''),
    })
  }

  /** Delete a post; `permanent` also purges it from the database (needs ENABLEAPIPOSTDELETION + a system admin token). */
  async deletePost(postId: string, permanent = false): Promise<void> {
    await this.request('DELETE', `/posts/${encodeURIComponent(postId)}${permanent ? '?permanent=true' : ''}`)
  }

  async removeReaction(postId: string, emoji: string): Promise<void> {
    await this.request('DELETE', '/reactions', {
      user_id: (await this.me()).id,
      post_id: postId,
      emoji_name: emoji.replace(/:/g, ''),
    })
  }

  // ---------------------------------------------------------------- admin ops

  async createUser(input: CreateUserInput): Promise<{ id: string; username: string }> {
    return this.request('POST', '/users', input)
  }

  async createBot(input: CreateBotInput): Promise<{ id: string; username: string }> {
    const raw = await this.request<{ user_id: string; username: string }>('POST', '/bots', {
      username: input.username,
      display_name: input.displayName,
      description: input.description ?? '',
    })
    return { id: raw.user_id, username: raw.username }
  }

  async createUserAccessToken(userId: string, description: string): Promise<string> {
    const res = await this.request<{ token: string; description: string }>('POST', `/users/${userId}/tokens`, {
      description,
    })
    return res.token
  }

  async disableBot(userId: string): Promise<void> {
    await this.request('POST', `/bots/${userId}/disable`)
  }

  async enableBot(userId: string): Promise<void> {
    await this.request('POST', `/bots/${userId}/enable`)
  }

  async updateUserRoles(userId: string, roles: string): Promise<void> {
    await this.request('PUT', `/users/${userId}/roles`, { roles })
  }

  async listUserTokens(userId: string): Promise<{ id: string; description: string; token: string }[]> {
    return this.request('GET', `/users/${userId}/tokens`)
  }

  async createTeam(name: string, displayName: string): Promise<{ id: string; name: string }> {
    return this.request('POST', '/teams', {
      name,
      display_name: displayName,
      type: 'O',
      allow_open_invite: false,
    })
  }

  // ---------------------------------------------------------------- websocket

  connectWebSocket(
    onPost: (post: ChatPost, meta: { mentions: string[]; channelType: string; channelName: string; senderName: string }) => void,
    onStatus?: (ev: StatusEvent) => void,
    onReconnect?: () => void,
  ): { close: () => void } {
    let ws: WebSocket | undefined
    let closed = false
    let backoffMs = 1000
    const maxBackoff = 30000
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let everOpened = false

    const connect = () => {
      if (closed) return
      ws = new WebSocket(`${this.wsBaseUrl}/api/v4/websocket`, {
        headers: { Authorization: `Bearer ${this.token}` },
      })

      ws.on('open', () => {
        if (everOpened && onReconnect) {
          try { onReconnect() } catch { /* ignore */ }
        }
        everOpened = true
        backoffMs = 1000
        ws!.send(
          JSON.stringify({
            seq: 1,
            action: 'authentication_challenge',
            data: { token: this.token },
          }),
        )
      })

      ws.on('message', (data: Buffer) => {
        let ev: unknown
        try {
          ev = JSON.parse(data.toString())
        } catch {
          return
        }
        if (!ev || typeof ev !== 'object') return
        const event = ev as { event?: string; data?: Record<string, string>; broadcast?: Record<string, string> }
        if (event.event === 'posted' && event.data) {
          let rawPost: RawPost
          let mentionIds: string[]
          try {
            rawPost = JSON.parse(event.data.post)
            mentionIds = event.data.mentions ? JSON.parse(event.data.mentions) : []
          } catch {
            return
          }
          Promise.all([
            this.mapPost(rawPost),
            Promise.all(mentionIds.map((id) => this.resolver.userName(id).catch(() => id))),
          ])
            .then(([post, mentions]) => {
              onPost(post, {
                mentions,
                channelType: event.data!.channel_type,
                channelName: post.channel,
                senderName: post.username,
              })
            })
            .catch(() => {
              // drop mapping failures
            })
        } else if (event.event === 'status_change' && onStatus && event.data) {
          onStatus({ user_id: event.data.user_id, status: event.data.status })
        }
      })

      ws.on('close', () => {
        if (closed) return
        reconnectTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, maxBackoff)
          connect()
        }, backoffMs)
      })

      ws.on('error', () => {
        ws?.terminate()
      })
    }

    connect()

    return {
      close: () => {
        closed = true
        if (reconnectTimer) clearTimeout(reconnectTimer)
        ws?.close()
      },
    }
  }

  // ---------------------------------------------------------------- mapping

  private mapChannel(raw: { id: string; name: string; display_name: string; purpose: string; type: 'O' | 'P' | 'D' | 'G' }): ChatChannel {
    return {
      id: raw.id,
      name: raw.name,
      displayName: raw.display_name,
      purpose: raw.purpose ?? '',
      type: raw.type,
    }
  }

  private async mapPost(raw: RawPost): Promise<ChatPost> {
    const [username, channel, files] = await Promise.all([
      this.resolver.userName(raw.user_id),
      this.resolver.channel(raw.channel_id),
      this.mapFiles(raw),
    ])
    this.resolver.cacheUser(raw.user_id, username)
    return {
      id: raw.id,
      channelId: raw.channel_id,
      channel: channel.name,
      userId: raw.user_id,
      username,
      message: raw.message,
      rootId: raw.root_id || undefined,
      createAt: raw.create_at,
      files,
    }
  }

  /** Prefer post.metadata.files (already full FileInfo, no extra request); fall back to file_ids. */
  private async mapFiles(raw: RawPost): Promise<ChatFile[] | undefined> {
    if (raw.metadata?.files?.length) {
      return raw.metadata.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mime_type, size: f.size }))
    }
    if (raw.file_ids?.length) {
      const infos = await Promise.all(raw.file_ids.map((id) => this.getFileInfo(id).catch(() => undefined)))
      const ok = infos.filter((f): f is ChatFile => f !== undefined)
      return ok.length ? ok : undefined
    }
    return undefined
  }
}

interface RawFileInfo {
  id: string
  name: string
  mime_type: string
  size: number
}

interface RawPost {
  id: string
  channel_id: string
  user_id: string
  message: string
  root_id: string
  create_at: number
  file_ids?: string[]
  metadata?: { files?: RawFileInfo[] }
}
