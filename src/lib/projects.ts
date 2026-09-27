// Project registry helpers: state/projects/<name>.json.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectRecord } from './types.js'

const MAX_NAME_LEN = 40
const NAME_RE = /^[a-z0-9-]+$/

export function projectsDir(root: string): string {
  return path.join(root, 'state', 'projects')
}

export function projectPath(root: string, name: string): string {
  return path.join(projectsDir(root), `${name}.json`)
}

/** Validate a project name: lowercase letters, digits and hyphens, max 40 chars. */
export function validateProjectName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: 'project name is required' }
  if (name.length > MAX_NAME_LEN) return { ok: false, reason: `project name must be ≤ ${MAX_NAME_LEN} chars` }
  if (!NAME_RE.test(name)) return { ok: false, reason: 'project name must be lowercase letters, digits and hyphens only' }
  return { ok: true }
}

/** Load a project record if it exists. */
export async function loadProject(root: string, name: string): Promise<ProjectRecord | undefined> {
  try {
    const raw = await readFile(projectPath(root, name), 'utf-8')
    return JSON.parse(raw) as ProjectRecord
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** Save a project record atomically. */
export async function saveProject(root: string, record: ProjectRecord): Promise<void> {
  const dir = projectsDir(root)
  await mkdir(dir, { recursive: true })
  const file = projectPath(root, record.name)
  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf-8')
  await rename(tmp, file)
}

/** List all project records. */
export async function listProjects(root: string): Promise<ProjectRecord[]> {
  const dir = projectsDir(root)
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const records: ProjectRecord[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    const name = e.name.slice(0, -5)
    const p = await loadProject(root, name)
    if (p) records.push(p)
  }
  return records.sort((a, b) => a.name.localeCompare(b.name))
}

/** True if username is a member of the project (and the project is not archived). */
export function isProjectMember(project: ProjectRecord, username: string): boolean {
  if (project.archived) return false
  return project.members.includes(username)
}
