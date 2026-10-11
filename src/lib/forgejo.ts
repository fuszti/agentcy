// Typed Forgejo REST client (Gitea-compatible API).

export interface CreateForgejoUserInput {
  username: string
  email: string
  password: string
  mustChangePassword?: boolean
}

export interface CreateOrgRepoInput {
  autoInit?: boolean
}

export interface CreateBranchProtectionInput {
  branch_name: string
  enable_push: boolean
  enable_push_whitelist: boolean
  push_whitelist_usernames: string[]
  push_whitelist_teams: string[]
  push_whitelist_deploy_keys: boolean
  required_approvals: number
  block_on_rejected_reviews: boolean
  dismiss_stale_approvals: boolean
}

export interface CreatePullRequestInput {
  title: string
  body?: string
  head: string
  base?: string
}

export interface PullRequest {
  number: number
  title: string
  body: string
  state: string
  user: { login: string }
  head: { label: string; ref: string; sha: string }
  base: { label: string; ref: string; sha: string }
  html_url: string
  url: string
  mergeable: boolean
  created_at: string
  requested_reviewers?: { login: string }[]
}

export interface PullRequestReview {
  id: number
  user: { login: string }
  state: string
  body: string
}

export interface PullRequestFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch?: string
}

export interface CreateIssueInput {
  title: string
  body?: string
  assignees?: string[]
  labels?: string[]
}

export interface EditIssueInput {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  assignees?: string[]
}

export interface ListIssuesQuery {
  state?: 'open' | 'closed' | 'all'
  assignee?: string
  labels?: string[]
  q?: string
}

export interface Issue {
  number: number
  title: string
  body: string
  state: string
  url: string
  html_url: string
  created_at: string
  updated_at: string
  user: { login: string }
  assignees: { login: string }[]
  labels: { name: string; color: string }[]
}

export interface Comment {
  id: number
  body: string
  user: { login: string }
  created_at: string
  html_url: string
}

export interface Notification {
  id: string
  unread: boolean
  updated_at: string
  subject: {
    title: string
    url: string
    html_url: string
    latest_comment_url?: string
    latest_comment_html_url?: string
    type: string
    state?: string
  }
  repository: { full_name: string }
}

/** Forgejo REST client. */
/** The Forgejo account behind a comment or an issue, and when it was created. */
export interface TicketActor { login: string; id: number; createdAt: string }
interface RawActor { user?: { login?: string; id?: number }; created_at?: string }
function toActor(raw: RawActor): TicketActor | undefined {
  const { user, created_at } = raw
  return user?.login && typeof user.id === 'number' && created_at ? { login: user.login, id: user.id, createdAt: created_at } : undefined
}

export class ForgejoClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers(),
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
      throw new Error(`Forgejo ${method} ${path} failed: ${res.status} ${serverMsg}`)
    }
    if (res.status === 204 || res.status === 205) return undefined as T
    if (res.headers.get('content-length') === '0') return undefined as T
    return (await res.json()) as T
  }

  async me(): Promise<{ id: number; login: string; email: string; is_admin: boolean }> {
    return this.request('GET', '/user')
  }

  // ---------------------------------------------------------------- admin / user lifecycle

  async createUser(input: CreateForgejoUserInput): Promise<{ id: number; login: string; email: string }> {
    return this.request('POST', '/admin/users', {
      ...input,
      must_change_password: input.mustChangePassword ?? false,
    })
  }

  async adminResetPassword(username: string, password: string, mustChange = false): Promise<void> {
    await this.request('PATCH', `/admin/users/${encodeURIComponent(username)}`, {
      password,
      must_change_password: mustChange,
      login_name: username,
      source_id: 0,
    })
  }


  /** Block or unblock an account. A blocked account cannot log in or use its tokens. */
  async setProhibitLogin(username: string, prohibit: boolean): Promise<void> {
    await this.request('PATCH', `/admin/users/${encodeURIComponent(username)}`, {
      prohibit_login: prohibit,
      login_name: username,
      source_id: 0,
    })
  }


  /** Read one account as an admin; undefined when it does not exist. */
  async adminGetUser(username: string): Promise<{ id: number; login: string; email: string; is_admin: boolean; prohibit_login: boolean } | undefined> {
    try {
      return await this.request('GET', `/users/${encodeURIComponent(username)}`)
    } catch (err) {
      if ((err as Error).message.includes('failed: 404')) return undefined
      throw err
    }
  }

  /**
   * Current login of the account with this id (a user can rename themselves), or undefined when it
   * no longer exists. `/users/search?uid=` answers 200 with an empty list for an unknown id.
   */
  async getUserById(id: number): Promise<{ id: number; login: string } | undefined> {
    const res = await this.request<{ data?: { id: number; login: string }[] }>('GET', `/users/search?uid=${String(id)}`)
    const hit = res.data?.find(u => u.id === id)
    return hit ? { id: hit.id, login: hit.login } : undefined
  }

  /** Forgejo id of a login, or undefined when there is no such user. */
  async getUserIdByName(login: string): Promise<number | undefined> {
    try {
      return (await this.request<{ id: number }>('GET', `/users/${encodeURIComponent(login)}`)).id
    } catch (err) {
      if ((err as Error).message.includes('failed: 404')) return undefined
      throw err
    }
  }

  async listTokensForUser(
    username: string,
    password: string,
  ): Promise<{ id?: number; name: string; sha1: string; token?: string }[]> {
    const res = await fetch(this.url(`/users/${encodeURIComponent(username)}/tokens`), {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      let serverMsg = ''
      try {
        const parsed = JSON.parse(await res.text())
        serverMsg = parsed.message ?? parsed.error
      } catch {
        serverMsg = `${res.status} ${res.statusText}`
      }
      throw new Error(`Forgejo listTokensForUser failed: ${res.status} ${serverMsg}`)
    }
    return (await res.json()) as { id?: number; name: string; sha1: string; token?: string }[]
  }

  async deleteTokenForUser(username: string, password: string, tokenId: number): Promise<void> {
    const res = await fetch(this.url(`/users/${encodeURIComponent(username)}/tokens/${tokenId}`), {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok && res.status !== 404) {
      let serverMsg = ''
      try {
        const parsed = JSON.parse(await res.text())
        serverMsg = parsed.message ?? parsed.error
      } catch {
        serverMsg = `${res.status} ${res.statusText}`
      }
      throw new Error(`Forgejo deleteTokenForUser failed: ${res.status} ${serverMsg}`)
    }
  }

  async createTokenForUser(
    username: string,
    password: string,
    name: string,
    scopes: string[],
  ): Promise<{ sha1: string; token?: string }> {
    // If a token with this name already exists, delete it so the call is idempotent.
    try {
      const tokens = await this.listTokensForUser(username, password)
      const existing = tokens.find((t) => t.name === name)
      if (existing?.id) await this.deleteTokenForUser(username, password, existing.id)
    } catch {
      // ignore list/delete failures and let the create call surface the real error
    }

    const res = await fetch(this.url(`/users/${encodeURIComponent(username)}/tokens`), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ name, scopes }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      let serverMsg = ''
      try {
        const parsed = JSON.parse(await res.text())
        serverMsg = parsed.message ?? parsed.error
      } catch {
        serverMsg = `${res.status} ${res.statusText}`
      }
      throw new Error(`Forgejo createTokenForUser failed: ${res.status} ${serverMsg}`)
    }
    return (await res.json()) as { sha1: string; token?: string }
  }

  // ---------------------------------------------------------------- org + team + repos

  async createOrg(username: string, fullName?: string): Promise<{ id: number; name: string }> {
    return this.request('POST', '/orgs', {
      username,
      full_name: fullName ?? username,
      visibility: 'private',
    })
  }

  async getOrg(name: string): Promise<{ id: number; name: string; visibility: string } | undefined> {
    try {
      return await this.request('GET', `/orgs/${encodeURIComponent(name)}`)
    } catch (err) {
      if ((err as Error).message.includes('404')) return undefined
      throw err
    }
  }

  async setOrgVisibility(org: string, visibility: 'public' | 'limited' | 'private'): Promise<void> {
    await this.request('PATCH', `/orgs/${encodeURIComponent(org)}`, { visibility })
  }

  /** Every repo of an org. Forgejo caps a page at 50, so this reads all pages. */
  async listOrgRepos(org: string): Promise<{ name: string; private: boolean }[]> {
    const out: { name: string; private: boolean }[] = []
    for (let page = 1; ; page++) {
      const batch = await this.request<{ name: string; private: boolean }[]>('GET', `/orgs/${encodeURIComponent(org)}/repos?limit=50&page=${String(page)}`)
      // Stop only on an empty page: a server may cap `limit` below 50 and return short pages.
      if (!batch.length) return out
      out.push(...batch.map(r => ({ name: r.name, private: r.private })))
    }
  }

  async ensureOrgTeam(
    org: string,
    teamName: string,
    permission: 'read' | 'write' | 'admin' = 'write',
    units?: string[],
  ): Promise<{ id: number; name: string }> {
    const teams = await this.request<{ id: number; name: string }[]>('GET', `/orgs/${encodeURIComponent(org)}/teams`)
    const existing = teams.find((t) => t.name.toLowerCase() === teamName.toLowerCase())
    // Agents must be able to write to every office repo, including repos created later.
    if (existing) {
      await this.request('PATCH', `/teams/${existing.id}`, { name: existing.name, includes_all_repositories: true, permission })
      return existing
    }
    return this.request('POST', `/orgs/${encodeURIComponent(org)}/teams`, {
      name: teamName,
      permission,
      includes_all_repositories: true,
      units: units ?? ['repo.code', 'repo.issues', 'repo.pulls', 'repo.releases', 'repo.wiki', 'repo.ext_wiki', 'repo.projects'],
      can_create_org_repo: true,
    })
  }

  /**
   * Stop watching every repo of an org as the token's user. Unwatched users are only
   * notified about issues they are assigned to, mentioned in or took part in.
   */
  async unwatchOrgRepos(org: string): Promise<number> {
    const repos = await this.request<{ name: string }[]>('GET', `/orgs/${encodeURIComponent(org)}/repos?limit=100`)
    let n = 0
    for (const r of repos) {
      try { await this.request('DELETE', `/repos/${encodeURIComponent(org)}/${encodeURIComponent(r.name)}/subscription`); n++ } catch { /* not watching */ }
    }
    return n
  }

  async addTeamMember(org: string, teamName: string, username: string): Promise<void> {
    const teams = await this.request<{ id: number; name: string }[]>('GET', `/orgs/${encodeURIComponent(org)}/teams`)
    const team = teams.find((t) => t.name.toLowerCase() === teamName.toLowerCase())
    if (!team) throw new Error(`team ${teamName} not found in org ${org}`)
    await this.request('PUT', `/teams/${team.id}/members/${encodeURIComponent(username)}`)
  }

  /** True when the user is in the named org team; a missing team or user counts as no. */
  async isTeamMember(org: string, teamName: string, username: string): Promise<boolean> {
    const teams = await this.request<{ id: number; name: string }[]>('GET', `/orgs/${encodeURIComponent(org)}/teams`)
    const team = teams.find((t) => t.name.toLowerCase() === teamName.toLowerCase())
    if (!team) return false
    try {
      await this.request('GET', `/teams/${team.id}/members/${encodeURIComponent(username)}`)
      return true
    } catch (err) {
      if ((err as Error).message.includes('failed: 404')) return false
      throw err
    }
  }

  async createOrgRepo(org: string, name: string, input: CreateOrgRepoInput = {}): Promise<{ id: number; name: string; html_url: string }> {
    const repos = await this.request<{ id: number; name: string; html_url: string }[]>('GET', `/orgs/${encodeURIComponent(org)}/repos?limit=100`)
    const existing = repos.find((r) => r.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing
    return this.request('POST', `/orgs/${encodeURIComponent(org)}/repos`, {
      name,
      auto_init: input.autoInit ?? false,
      private: true,
      default_branch: 'main',
    })
  }

  async getRepo(owner: string, repo: string): Promise<{ id: number; name: string; html_url: string; archived: boolean; default_branch: string } | undefined> {
    try {
      return await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
    } catch (err) {
      if ((err as Error).message.includes('404')) return undefined
      throw err
    }
  }

  async archiveRepo(owner: string, repo: string): Promise<void> {
    await this.request('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { archived: true })
  }

  async setRepoPrivate(owner: string, repo: string): Promise<void> {
    await this.request('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { private: true })
  }

  /** Give one user access to one repo, without org or team membership. */
  async addCollaborator(owner: string, repo: string, username: string, permission: 'read' | 'write' = 'write'): Promise<void> {
    await this.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`, { permission })
  }

  /** A repo or user that is already gone counts as removed. */
  async removeCollaborator(owner: string, repo: string, username: string): Promise<void> {
    try {
      await this.request('DELETE', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`)
    } catch (err) {
      if (!(err as Error).message.includes('failed: 404')) throw err
    }
  }

  /** Who opened an issue or pull request and when (the issues endpoint serves both). */
  async issueInfo(owner: string, repo: string, number: number): Promise<TicketActor | undefined> {
    try {
      return toActor(await this.request<RawActor>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${String(number)}`))
    } catch {
      return undefined
    }
  }

  async createBranchProtection(owner: string, repo: string, branch: string, input: Partial<CreateBranchProtectionInput> = {}): Promise<void> {
    await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branch_protections`, {
      branch_name: branch,
      enable_push: false,
      enable_push_whitelist: false,
      push_whitelist_usernames: [],
      push_whitelist_teams: [],
      push_whitelist_deploy_keys: false,
      required_approvals: 1,
      block_on_rejected_reviews: true,
      dismiss_stale_approvals: true,
      ...input,
    })
  }

  // ---------------------------------------------------------------- pull requests

  async createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    return this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      title: input.title,
      body: input.body ?? '',
      head: input.head,
      base: input.base ?? 'main',
    })
  }

  async listPullRequests(owner: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<PullRequest[]> {
    const params = new URLSearchParams()
    if (state) params.set('state', state)
    params.set('limit', '100')
    const q = params.toString() ? `?${params.toString()}` : ''
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${q}`)
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`)
  }

  async getPullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}.diff`, {
      method: 'GET',
      headers: { Authorization: `token ${this.token}`, Accept: 'text/plain' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`Forgejo GET /pulls/${number}.diff failed: ${res.status}`)
    return res.text()
  }

  async requestReviewers(owner: string, repo: string, number: number, reviewers: string[]): Promise<void> {
    await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/requested_reviewers`, {
      reviewers,
    })
  }

  async listRequestedReviewers(owner: string, repo: string, number: number): Promise<{ users: { login: string }[] }> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/requested_reviewers`)
  }

  async submitReview(owner: string, repo: string, number: number, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body?: string): Promise<PullRequestReview> {
    // Forgejo expects APPROVED, REQUEST_CHANGES or COMMENT.
    const forgejoEvent = event === 'APPROVE' ? 'APPROVED' : event
    return this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`, {
      event: forgejoEvent,
      body: body ?? '',
    })
  }

  async listReviews(owner: string, repo: string, number: number): Promise<PullRequestReview[]> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`)
  }

  async listPullRequestFiles(owner: string, repo: string, number: number): Promise<PullRequestFile[]> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`)
  }

  async mergePullRequest(owner: string, repo: string, number: number, method: 'squash' | 'merge' | 'rebase' = 'squash'): Promise<void> {
    await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`, {
      Do: method,
      delete_branch_after_merge: true,
    })
  }

  // ---------------------------------------------------------------- labels

  async ensureLabels(
    owner: string,
    repo: string,
    labels: { name: string; color: string; description?: string }[],
  ): Promise<Record<string, number>> {
    const existing: { id: number; name: string; color: string }[] = await this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels?limit=100`,
    )
    const existingByName = new Map(existing.map((l) => [l.name, l]))
    const out: Record<string, number> = {}
    for (const label of labels) {
      const e = existingByName.get(label.name)
      if (e) {
        out[label.name] = e.id
      } else {
        const created = await this.request<{ id: number }>(
          'POST',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`,
          {
            name: label.name,
            color: label.color.replace(/^#/, ''),
            description: label.description ?? '',
          },
        )
        out[label.name] = created.id
      }
    }
    return out
  }

  // ---------------------------------------------------------------- issues

  private async resolveLabelIds(owner: string, repo: string, names: string[]): Promise<number[]> {
    if (!names.length) return []
    const labels = await this.ensureLabels(
      owner,
      repo,
      names.map((n) => ({ name: n, color: '000000' })),
    )
    return names.map((n) => {
      const id = labels[n]
      if (id === undefined) throw new Error(`label ${n} not found in ${owner}/${repo}`)
      return id
    })
  }

  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<Issue> {
    const labelIds = await this.resolveLabelIds(owner, repo, input.labels ?? [])
    return this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
      title: input.title,
      body: input.body ?? '',
      assignees: input.assignees ?? [],
      labels: labelIds,
    })
  }

  async getIssue(owner: string, repo: string, number: number): Promise<Issue> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`)
  }

  async listIssues(owner: string, repo: string, query: ListIssuesQuery = {}): Promise<Issue[]> {
    const params = new URLSearchParams()
    if (query.state) params.set('state', query.state)
    if (query.assignee) params.set('assignee', query.assignee)
    if (query.labels?.length) params.set('labels', query.labels.join(','))
    if (query.q) params.set('q', query.q)
    params.set('limit', '100')
    const q = params.toString() ? `?${params.toString()}` : ''
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${q}`)
  }

  async listComments(owner: string, repo: string, issueNumber: number): Promise<Comment[]> {
    return this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    )
  }

  async createComment(owner: string, repo: string, issueNumber: number, body: string): Promise<Comment> {
    return this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`, {
      body,
    })
  }

  async editIssue(owner: string, repo: string, number: number, input: EditIssueInput): Promise<Issue> {
    const body: Record<string, unknown> = {}
    if (input.title !== undefined) body.title = input.title
    if (input.body !== undefined) body.body = input.body
    if (input.state !== undefined) body.state = input.state
    if (input.assignees !== undefined) body.assignees = input.assignees
    return this.request('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, body)
  }

  async setLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    const labelIds = await this.resolveLabelIds(owner, repo, labels)
    await this.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`, { labels: labelIds })
  }

  // ---------------------------------------------------------------- notifications

  async listNotifications({ unreadOnly }: { unreadOnly?: boolean } = {}): Promise<Notification[]> {
    const params = new URLSearchParams()
    if (unreadOnly) params.set('status-types', 'unread')
    params.set('limit', '100')
    const q = params.toString() ? `?${params.toString()}` : ''
    const raw = await this.request<
      {
        id: string
        unread: boolean
        updated_at: string
        subject: {
          title: string
          url: string
          html_url: string
          latest_comment_url?: string
          latest_comment_html_url?: string
          type: string
          state?: string
        }
        repository: { full_name: string }
      }[]
    >('GET', `/notifications${q}`)
    return raw.map((n) => ({
      id: n.id,
      unread: n.unread,
      updated_at: n.updated_at,
      subject: {
        title: n.subject.title,
        url: n.subject.url,
        html_url: n.subject.html_url,
        latest_comment_url: n.subject.latest_comment_url,
        latest_comment_html_url: n.subject.latest_comment_html_url,
        type: n.subject.type,
        state: n.subject.state,
      },
      repository: { full_name: n.repository.full_name },
    }))
  }

  /** Who wrote the comment behind a latest-comment URL, and when; undefined if unreachable. */
  async commentInfo(commentUrl: string): Promise<TicketActor | undefined> {
    try {
      const res = await fetch(commentUrl, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(30_000) })
      if (!res.ok) return undefined
      return toActor((await res.json()) as RawActor)
    } catch {
      return undefined
    }
  }

  async markNotificationRead(id: string): Promise<void> {
    await this.request('PATCH', `/notifications/threads/${id}`)
  }
}

export interface PrivacyClient {
  getOrg(name: string): Promise<{ visibility: string } | undefined>
  setOrgVisibility(org: string, visibility: 'private'): Promise<void>
  listOrgRepos(org: string): Promise<{ name: string; private: boolean }[]>
  setRepoPrivate(owner: string, repo: string): Promise<void>
}

/** True only when the org exists, is private and every repo in it is private. Any error counts as not ready. */
export async function forgejoPrivacyReady(fj: Pick<PrivacyClient, 'getOrg' | 'listOrgRepos'>, org: string): Promise<boolean> {
  try {
    if ((await fj.getOrg(org))?.visibility !== 'private') return false
    return (await fj.listOrgRepos(org)).every(r => r.private)
  } catch {
    return false
  }
}

/**
 * Make the office org and all its repos private, so an invited member (a per-repo collaborator)
 * sees only the repos they were given. Agents keep access through the `agents` team. Idempotent;
 * returns what it changed.
 */
export async function ensureForgejoPrivacy(fj: PrivacyClient, org: string): Promise<{ org: boolean; repos: string[] }> {
  const current = await fj.getOrg(org)
  if (!current) return { org: false, repos: [] }
  const repos: string[] = []
  for (const r of await fj.listOrgRepos(org)) {
    if (r.private) continue
    await fj.setRepoPrivate(org, r.name)
    repos.push(r.name)
  }
  const switchOrg = current.visibility !== 'private'
  if (switchOrg) await fj.setOrgVisibility(org, 'private')
  return { org: switchOrg, repos }
}
