import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COPIED_ONBOARDING_KEYS, ensureClaudeOnboarded } from '../src/lib/harness/claude.js'

let tmp: string
let prevClaudeDir: string | undefined
let prevHome: string | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-onboarding-test-'))
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR
  prevHome = process.env.HOME
})
afterEach(() => {
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
const writeJson = (file: string, obj: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj))
}

const fullSource = {
  theme: 'dark',
  lastOnboardingVersion: '2.1.0',
  lastReleaseNotesSeen: '2.1.3',
  hasSeenAutoModeOutsideReadPrompt: true,
  hasCompletedClaudeInChromeOnboarding: true,
  hasCompletedOnboarding: true,
  oauthAccount: { emailAddress: 'owner@example.com', accountUuid: 'acc-1' },
  userID: 'user-123',
  projects: { '/some/path': { allowedTools: [] } },
  primaryApiKey: 'sk-ant-secret',
  numStartups: 42,
}

describe('COPIED_ONBOARDING_KEYS', () => {
  it('lists exactly the UI/onboarding keys and nothing account-related', () => {
    expect([...COPIED_ONBOARDING_KEYS].sort()).toEqual([
      'hasCompletedClaudeInChromeOnboarding',
      'hasSeenAutoModeOutsideReadPrompt',
      'lastOnboardingVersion',
      'lastReleaseNotesSeen',
      'theme',
    ])
  })
})

describe('ensureClaudeOnboarded', () => {
  it('creates the config dir and a .claude.json with hasCompletedOnboarding and copied keys', () => {
    const src = path.join(tmp, 'src', '.claude.json')
    writeJson(src, fullSource)
    const dir = path.join(tmp, 'new', 'nested', 'group')
    expect(ensureClaudeOnboarded(dir, src)).toBe(true)
    const target = path.join(dir, '.claude.json')
    const got = readJson(target)
    expect(got).toEqual({
      hasCompletedOnboarding: true,
      theme: 'dark',
      lastOnboardingVersion: '2.1.0',
      lastReleaseNotesSeen: '2.1.3',
      hasSeenAutoModeOutsideReadPrompt: true,
      hasCompletedClaudeInChromeOnboarding: true,
    })
  })

  it('never copies account, identity, project or key data', () => {
    const src = path.join(tmp, 'src.json')
    writeJson(src, fullSource)
    const dir = path.join(tmp, 'g')
    ensureClaudeOnboarded(dir, src)
    const got = readJson(path.join(dir, '.claude.json'))
    for (const k of ['oauthAccount', 'userID', 'projects', 'primaryApiKey', 'numStartups']) {
      expect(got, k).not.toHaveProperty(k)
    }
    expect(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).not.toContain('sk-ant-secret')
  })

  it('writes the file with mode 0600', () => {
    const dir = path.join(tmp, 'g')
    ensureClaudeOnboarded(dir, path.join(tmp, 'missing.json'))
    expect(fs.statSync(path.join(dir, '.claude.json')).mode & 0o777).toBe(0o600)
  })

  it('preserves existing target keys and does not overwrite them from the source', () => {
    const src = path.join(tmp, 'src.json')
    writeJson(src, fullSource)
    const dir = path.join(tmp, 'g')
    const target = path.join(dir, '.claude.json')
    writeJson(target, {
      theme: 'light',
      oauthAccount: { emailAddress: 'group@example.com' },
      userID: 'group-user',
      hasCompletedOnboarding: false,
    })
    expect(ensureClaudeOnboarded(dir, src)).toBe(true)
    const got = readJson(target)
    expect(got.theme).toBe('light')
    expect(got.oauthAccount).toEqual({ emailAddress: 'group@example.com' })
    expect(got.userID).toBe('group-user')
    expect(got.hasCompletedOnboarding).toBe(true)
    // absent keys are still filled in
    expect(got.lastOnboardingVersion).toBe('2.1.0')
    expect(got.lastReleaseNotesSeen).toBe('2.1.3')
  })

  it('returns false and leaves the file untouched when nothing changes', () => {
    const src = path.join(tmp, 'src.json')
    writeJson(src, { theme: 'dark' })
    const dir = path.join(tmp, 'g')
    expect(ensureClaudeOnboarded(dir, src)).toBe(true)
    const target = path.join(dir, '.claude.json')
    const before = fs.readFileSync(target, 'utf8')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(target, past, past)
    const mtimeBefore = fs.statSync(target).mtimeMs

    expect(ensureClaudeOnboarded(dir, src)).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe(before)
    expect(fs.statSync(target).mtimeMs).toBe(mtimeBefore)
  })

  it('returns false for an already-onboarded target with all copyable keys present', () => {
    const src = path.join(tmp, 'src.json')
    writeJson(src, fullSource)
    const dir = path.join(tmp, 'g')
    const target = path.join(dir, '.claude.json')
    const existing = {
      hasCompletedOnboarding: true,
      theme: 'light',
      lastOnboardingVersion: '1.0.0',
      lastReleaseNotesSeen: '1.0.0',
      hasSeenAutoModeOutsideReadPrompt: false,
      hasCompletedClaudeInChromeOnboarding: false,
      custom: 1,
    }
    writeJson(target, existing)
    expect(ensureClaudeOnboarded(dir, src)).toBe(false)
    expect(readJson(target)).toEqual(existing)
  })

  it('leaves a corrupt target untouched and returns false', () => {
    const dir = path.join(tmp, 'g')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, '.claude.json')
    fs.writeFileSync(target, '{not json')
    expect(ensureClaudeOnboarded(dir, path.join(tmp, 'missing.json'))).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('{not json')
  })

  it('a missing source just sets the flag', () => {
    const dir = path.join(tmp, 'g')
    expect(ensureClaudeOnboarded(dir, path.join(tmp, 'nope.json'))).toBe(true)
    expect(readJson(path.join(dir, '.claude.json'))).toEqual({ hasCompletedOnboarding: true })
  })

  it('a corrupt source just sets the flag', () => {
    const src = path.join(tmp, 'src.json')
    fs.writeFileSync(src, 'garbage{')
    const dir = path.join(tmp, 'g')
    expect(ensureClaudeOnboarded(dir, src)).toBe(true)
    expect(readJson(path.join(dir, '.claude.json'))).toEqual({ hasCompletedOnboarding: true })
  })

  it('only copies keys actually present in the source', () => {
    const src = path.join(tmp, 'src.json')
    writeJson(src, { theme: 'dark-daltonized', oauthAccount: { a: 1 } })
    const dir = path.join(tmp, 'g')
    ensureClaudeOnboarded(dir, src)
    expect(readJson(path.join(dir, '.claude.json'))).toEqual({ hasCompletedOnboarding: true, theme: 'dark-daltonized' })
  })

  it('defaults the source to $CLAUDE_CONFIG_DIR/.claude.json when that env var is set', () => {
    const envDir = path.join(tmp, 'envdir')
    writeJson(path.join(envDir, '.claude.json'), { theme: 'from-env', userID: 'x' })
    const home = path.join(tmp, 'home')
    writeJson(path.join(home, '.claude.json'), { theme: 'from-home' })
    process.env.CLAUDE_CONFIG_DIR = envDir
    process.env.HOME = home
    const dir = path.join(tmp, 'g')
    expect(ensureClaudeOnboarded(dir)).toBe(true)
    const got = readJson(path.join(dir, '.claude.json'))
    expect(got.theme).toBe('from-env')
    expect(got).not.toHaveProperty('userID')
  })

  it('defaults the source to ~/.claude.json when CLAUDE_CONFIG_DIR is unset', () => {
    const home = path.join(tmp, 'home')
    writeJson(path.join(home, '.claude.json'), { theme: 'from-home', oauthAccount: { a: 1 } })
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home // os.homedir() honours $HOME on POSIX
    const dir = path.join(tmp, 'g')
    expect(ensureClaudeOnboarded(dir)).toBe(true)
    const got = readJson(path.join(dir, '.claude.json'))
    expect(got.theme).toBe('from-home')
    expect(got).not.toHaveProperty('oauthAccount')
  })
})
