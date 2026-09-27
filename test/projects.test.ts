import { describe, expect, it } from 'vitest'
import { listProjects, loadProject, saveProject, validateProjectName } from '../src/lib/projects.js'
import type { ProjectRecord } from '../src/lib/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

describe('validateProjectName', () => {
  it('accepts lowercase letters, digits and hyphens up to 40 chars', () => {
    expect(validateProjectName('hello-agents')).toEqual({ ok: true })
    expect(validateProjectName('a1-b2-c3')).toEqual({ ok: true })
    expect(validateProjectName('x'.repeat(40))).toEqual({ ok: true })
  })

  it('rejects empty, too long or invalid names', () => {
    expect(validateProjectName('')).toEqual({ ok: false, reason: 'project name is required' })
    expect(validateProjectName('x'.repeat(41))).toEqual({ ok: false, reason: 'project name must be ≤ 40 chars' })
    expect(validateProjectName('Hello')).toEqual({ ok: false, reason: 'project name must be lowercase letters, digits and hyphens only' })
    expect(validateProjectName('hello_world')).toEqual({ ok: false, reason: 'project name must be lowercase letters, digits and hyphens only' })
    expect(validateProjectName('hello agents')).toEqual({ ok: false, reason: 'project name must be lowercase letters, digits and hyphens only' })
  })
})

describe('project registry', () => {
  let root: string

  function freshRoot() {
    const dir = mkdtempSync(path.join(tmpdir(), 'office-projects-'))
    root = dir
    return dir
  }

  it('saves, loads and lists projects atomically', async () => {
    const dir = freshRoot()
    try {
      const p: ProjectRecord = {
        name: 'demo',
        description: 'demo project',
        repo: 'office/demo',
        channel: 'proj-demo',
        members: ['kim'],
        createdAt: new Date().toISOString(),
      }
      await saveProject(dir, p)
      expect(await loadProject(dir, 'demo')).toEqual(p)
      expect(await listProjects(dir)).toEqual([p])
      await saveProject(dir, { ...p, name: 'alpha', channel: 'proj-alpha' })
      expect((await listProjects(dir)).map(x => x.name)).toEqual(['alpha', 'demo'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
