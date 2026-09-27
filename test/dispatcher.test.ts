import { describe, expect, it } from 'vitest'
import { dispatchRound, type DispatcherClients, type DispatcherDeps } from '../src/admin/dispatcher.js'
import type { OfficeConfig, ProjectRecord } from '../src/lib/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

function makeClients(): { clients: DispatcherClients; posts: { channelId: string; message: string }[] } {
  const posts: { channelId: string; message: string }[] = []
  const usersByChannel: Record<string, string[]> = { 'chan-hello': [] }
  const clients: DispatcherClients = {
    botUserId: 'u-office',
    teamId: 'team-1',
    mm: {
      getChannelByName: async (_teamId: string, name: string) => {
        if (name === 'proj-hello') return { id: 'chan-hello', name, displayName: name, purpose: '', type: 'O' }
        throw new Error('not found')
      },
      addToChannel: async (channelId: string, userId: string) => {
        usersByChannel[channelId] ??= []
        if (!usersByChannel[channelId].includes(userId)) usersByChannel[channelId].push(userId)
      },
      createPost: async (input: { channelId: string; message: string }) => { posts.push(input) },
    } as unknown as DispatcherClients['mm'],
    fj: {
      listIssues: async () => [
        { number: 1, title: 'first issue', html_url: 'http://fj/o/r/issues/1', created_at: '2026-09-26T10:00:00Z', user: { login: 'owner' }, assignees: [], labels: [], body: '', state: 'open', url: '' },
        { number: 2, title: 'second issue', html_url: 'http://fj/o/r/issues/2', created_at: '2026-09-26T12:00:00Z', user: { login: 'owner' }, assignees: [], labels: [], body: '', state: 'open', url: '' },
      ],
      listPullRequests: async () => [
        { number: 3, title: 'first pr', html_url: 'http://fj/o/r/pulls/3', created_at: '2026-09-26T12:05:00Z', user: { login: 'kim' }, head: { label: 'o:kim/1', ref: 'kim/1', sha: 'a' }, base: { label: 'o:main', ref: 'main', sha: 'b' }, body: '', state: 'open', url: '', mergeable: true, requested_reviewers: [] },
      ],
    } as unknown as DispatcherClients['fj'],
  }
  return { clients, posts }
}

function makeDeps(root: string, clients: DispatcherClients): DispatcherDeps {
  return {
    root,
    cfg: { forgejoOrg: 'office', mattermostUrl: 'http://mm', forgejoUrl: 'http://fj' } as OfficeConfig,
    clients,
    stateFile: path.join(root, 'dispatcher.json'),
    now: () => new Date('2026-09-26T12:00:00Z'),
  }
}

async function seedProject(root: string): Promise<void> {
  const dir = path.join(root, 'state', 'projects')
  const record: ProjectRecord = {
    name: 'hello',
    description: 'hello project',
    repo: 'office/hello',
    channel: 'proj-hello',
    members: ['kim'],
    createdAt: '2026-09-26T09:00:00Z',
  }
  const fs = await import('node:fs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'hello.json'), JSON.stringify(record))
}

describe('dispatchRound', () => {
  it('announces issues and PRs created after first seen, and only once', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'office-dispatch-'))
    try {
      await seedProject(tmp)
      const { clients, posts } = makeClients()
      const deps = makeDeps(tmp, clients)

      // First round: records firstSeenAt and does nothing.
      await dispatchRound(deps)
      expect(posts).toHaveLength(0)

      // Second round: only issues/PRs created at or after firstSeenAt are announced.
      // Since now is 12:00Z, issue #2 and PR #3 were created at/after firstSeenAt; issue #1 is before.
      await dispatchRound(deps)
      expect(posts).toHaveLength(2)
      expect(posts[0].message).toContain('New ticket office/hello#2')
      expect(posts[0].message).toContain('ticket_claim')
      expect(posts[1].message).toContain('PR office/hello#3')
      expect(posts[1].message).toContain('needs a reviewer')

      // Third round: nothing new.
      const before = posts.length
      await dispatchRound(deps)
      expect(posts.length).toBe(before)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not announce PRs that already have requested reviewers', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'office-dispatch-'))
    try {
      await seedProject(tmp)
      const { clients, posts } = makeClients()
      const deps = makeDeps(tmp, clients)
      // Stub PR to already have a requested reviewer.
      clients.fj.listPullRequests = async () => [
        { number: 3, title: 'first pr', html_url: 'http://fj/o/r/pulls/3', created_at: '2026-09-26T12:05:00Z', user: { login: 'kim' }, head: { label: 'o:kim/1', ref: 'kim/1', sha: 'a' }, base: { label: 'o:main', ref: 'main', sha: 'b' }, body: '', state: 'open', url: '', mergeable: true, requested_reviewers: [{ login: 'rex' }] },
      ]

      await dispatchRound(deps)
      await dispatchRound(deps)
      expect(posts).toHaveLength(1)
      expect(posts[0].message).toContain('New ticket office/hello#2')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
