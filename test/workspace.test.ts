import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkAttachmentSize,
  resolveInWorkspace,
  sanitizeAttachmentFilename,
  workspaceDir,
} from '../src/lib/workspace.js'

const roots: string[] = []
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-ws-test-'))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })

describe('sanitizeAttachmentFilename', () => {
  it('keeps a normal filename as-is', () => {
    expect(sanitizeAttachmentFilename('screenshot.png')).toBe('screenshot.png')
  })

  it('strips directory components (path traversal)', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeAttachmentFilename('a/b/../../c.txt')).toBe('c.txt')
    expect(sanitizeAttachmentFilename('..\\..\\windows\\file.txt')).toBe('file.txt')
  })

  it('replaces unsafe characters and never returns empty or a dotfile', () => {
    expect(sanitizeAttachmentFilename('weird name*?.txt')).toBe('weird_name_.txt')
    expect(sanitizeAttachmentFilename('')).toBe('file')
    expect(sanitizeAttachmentFilename('..')).toBe('_')
    expect(sanitizeAttachmentFilename('.hidden')).toBe('_hidden')
  })
})

describe('checkAttachmentSize', () => {
  it('allows files at or under the limit', () => {
    expect(checkAttachmentSize(100, 100)).toBeUndefined()
    expect(checkAttachmentSize(99, 100)).toBeUndefined()
  })

  it('reports a "too large (N.N MB)" reason over the limit', () => {
    const reason = checkAttachmentSize(21 * 1024 * 1024, 20 * 1024 * 1024)
    expect(reason).toMatch(/^too large \(\d+\.\d MB\)$/)
    expect(reason).toContain('21.0 MB')
  })
})

describe('resolveInWorkspace', () => {
  it('resolves a relative path inside the workspace', () => {
    const root = tmpRoot()
    const ws = workspaceDir(root, 'zz')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'note.txt'), 'hi')
    const real = resolveInWorkspace(root, 'zz', 'note.txt')
    expect(real).toBe(fs.realpathSync(path.join(ws, 'note.txt')))
  })

  it('resolves an absolute path inside the workspace', () => {
    const root = tmpRoot()
    const ws = workspaceDir(root, 'zz')
    fs.mkdirSync(ws, { recursive: true })
    const file = path.join(ws, 'note.txt')
    fs.writeFileSync(file, 'hi')
    expect(resolveInWorkspace(root, 'zz', file)).toBe(fs.realpathSync(file))
  })

  it('rejects a relative path that escapes the workspace via ..', () => {
    const root = tmpRoot()
    fs.mkdirSync(workspaceDir(root, 'zz'), { recursive: true })
    fs.writeFileSync(path.join(root, 'secret.txt'), 'nope')
    expect(resolveInWorkspace(root, 'zz', '../secret.txt')).toBeUndefined()
  })

  it('rejects an absolute path outside the workspace (e.g. another agent\'s files)', () => {
    const root = tmpRoot()
    fs.mkdirSync(workspaceDir(root, 'zz'), { recursive: true })
    const otherWs = workspaceDir(root, 'other')
    fs.mkdirSync(otherWs, { recursive: true })
    const otherFile = path.join(otherWs, 'file.txt')
    fs.writeFileSync(otherFile, 'nope')
    expect(resolveInWorkspace(root, 'zz', otherFile)).toBeUndefined()
  })

  it('rejects a symlink inside the workspace that points outside it', () => {
    const root = tmpRoot()
    const ws = workspaceDir(root, 'zz')
    fs.mkdirSync(ws, { recursive: true })
    const outsideFile = path.join(root, 'outside-secret.txt')
    fs.writeFileSync(outsideFile, 'nope')
    const link = path.join(ws, 'escape-link')
    fs.symlinkSync(outsideFile, link)
    expect(resolveInWorkspace(root, 'zz', 'escape-link')).toBeUndefined()
  })

  it('accepts a symlink that points inside the workspace', () => {
    const root = tmpRoot()
    const ws = workspaceDir(root, 'zz')
    fs.mkdirSync(ws, { recursive: true })
    const target = path.join(ws, 'real.txt')
    fs.writeFileSync(target, 'hi')
    const link = path.join(ws, 'alias.txt')
    fs.symlinkSync(target, link)
    expect(resolveInWorkspace(root, 'zz', 'alias.txt')).toBe(fs.realpathSync(target))
  })

  it('returns undefined for a missing file', () => {
    const root = tmpRoot()
    fs.mkdirSync(workspaceDir(root, 'zz'), { recursive: true })
    expect(resolveInWorkspace(root, 'zz', 'nope.txt')).toBeUndefined()
  })
})
