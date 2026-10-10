import { describe, expect, it, beforeEach, afterEach, vi, type Mock } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cmdGroup, resolveHireGroup, type GroupDeps } from '../src/cli/group-cmd.js'
import { setSecret } from '../src/lib/vault.js'
import { workspaceDir } from '../src/lib/workspace.js'
import { claudeProjectSlug } from '../src/lib/transcript.js'
import type { AgentRecord, OfficeConfig, ResourceGroup } from '../src/lib/types.js'

let root: string
let claudeHome: string
let prevClaudeDir: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-cmd-test-'))
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'group-cmd-claude-'))
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = claudeHome
})
afterEach(() => {
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(claudeHome, { recursive: true, force: true })
})

function groups(): ResourceGroup[] {
  return [
    { id: 'claude-sub', kind: 'claude-subscription', label: 'Main Claude' },
    { id: 'claude-b', kind: 'claude-subscription', label: 'Claude B', configDir: 'state/claude/claude-b' },
    { id: 'claude-c', kind: 'claude-subscription', label: 'Claude C', configDir: 'state/claude/claude-c' },
    { id: 'opencode-go', kind: 'opencode-go', label: 'Go main' },
    { id: 'go-2', kind: 'opencode-go', label: 'Go 2' },
    { id: 'openrouter', kind: 'openrouter', label: 'OR main' },
  ]
}

function agent(name: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name,
    displayName: name,
    harness: 'claude',
    model: 'sonnet',
    status: 'hired',
    pastSessions: [],
    chrome: false,
    mattermost: { userId: `u-${name}`, token: 't' },
    forgejo: { token: 't' },
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  }
}

function roster(): AgentRecord[] {
  return [
    agent('alice', { sessionId: 'sess-1' }),
    agent('bob', { group: 'claude-b', sessionId: 'sess-2' }),
    agent('carol', { harness: 'opencode', model: 'opencode-go/kimi-k2', group: 'go-2', sessionId: 'ses_carol', opencodePort: 4100 }),
    agent('dave', { status: 'retired', group: 'claude-b' }),
    // group of the wrong kind -> falls back to the default openrouter group
    agent('erin', { harness: 'opencode', model: 'openrouter/qwen', group: 'claude-b', sessionId: 'ses_erin' }),
  ]
}

interface Fake extends GroupDeps {
  lines: string[]
  saveConfig: Mock<GroupDeps['saveConfig']>
  saveAgent: Mock<GroupDeps['saveAgent']>
  stopAgent: Mock<GroupDeps['stopAgent']>
  startAgent: Mock<GroupDeps['startAgent']>
  claudeAuthStatus: Mock<GroupDeps['claudeAuthStatus']>
  runClaudeLogin: Mock<GroupDeps['runClaudeLogin']>
}

function makeDeps(opts: { groups?: ResourceGroup[]; agents?: AgentRecord[]; isTTY?: boolean } = {}): Fake {
  const lines: string[] = []
  const recs = opts.agents ?? roster()
  const cfg = { resourceGroups: opts.groups ?? groups() } as unknown as OfficeConfig
  return {
    root,
    cfg,
    lines,
    saveConfig: vi.fn(async (_c: OfficeConfig) => {}),
    agents: async () => recs,
    saveAgent: vi.fn(async (_r: AgentRecord) => {}),
    stopAgent: vi.fn(async (_r: AgentRecord) => {}),
    startAgent: vi.fn(async (_r: AgentRecord) => {}),
    claudeAuthStatus: vi.fn((_d?: string) => ({ loggedIn: true })),
    runClaudeLogin: vi.fn((_d?: string) => 0),
    isTTY: opts.isTTY ?? true,
    log: (line: string) => { lines.push(...line.split('\n')) },
  } as Fake
}

const out = (d: Fake) => d.lines.join('\n')
const lineWith = (d: Fake, label: string) => {
  const l = d.lines.find((x) => x.includes(label))
  expect(l, `no line for ${label}`).toBeDefined()
  return l as string
}
const absDir = (id: string) => path.resolve(root, 'state', 'claude', id)
const savedGroups = (d: Fake) => (d.saveConfig.mock.calls[0][0] as OfficeConfig).resourceGroups

describe('group list', () => {
  it('lists every group with id, kind, label, default marker and resolved hired agents', async () => {
    const d = makeDeps()
    await cmdGroup([], {}, d)
    const main = lineWith(d, 'Main Claude')
    expect(main).toContain('claude-sub')
    expect(main).toContain('claude-subscription')
    expect(main).toMatch(/\bdefault\b/)
    expect(main).toContain('alice')
    expect(main).not.toContain('bob')

    const b = lineWith(d, 'Claude B')
    expect(b).toContain('claude-b')
    expect(b).not.toMatch(/\bdefault\b/)
    expect(b).toContain('bob')
    expect(b).not.toContain('dave') // retired
    expect(b).not.toContain('erin') // wrong kind -> resolves elsewhere

    const goMain = lineWith(d, 'Go main')
    expect(goMain).toContain('opencode-go')
    expect(goMain).toMatch(/\bdefault\b/)
    expect(goMain).not.toContain('carol')

    const go2 = lineWith(d, 'Go 2')
    expect(go2).toContain('go-2')
    expect(go2).not.toMatch(/\bdefault\b/)
    expect(go2).toContain('carol')

    const or = lineWith(d, 'OR main')
    expect(or).toContain('openrouter')
    expect(or).toMatch(/\bdefault\b/)
    expect(or).toContain('erin')
  })

  it('"list" is the same as no sub-command', async () => {
    const a = makeDeps()
    const b = makeDeps()
    await cmdGroup([], {}, a)
    await cmdGroup(['list'], {}, b)
    expect(out(b)).toBe(out(a))
  })

  it('shows key status for API groups and token status for Claude groups', async () => {
    const g = groups()
    setSecret(root, 'go-2', 'sk-go-2', g)
    setSecret(root, 'claude-b', 'sk-ant-oat-b', g)
    const d = makeDeps({ groups: g })
    await cmdGroup(['list'], {}, d)
    expect(lineWith(d, 'Go 2')).toContain('key: set')
    expect(lineWith(d, 'Go main')).toContain('key: not set')
    expect(lineWith(d, 'OR main')).toContain('key: not set')
    expect(lineWith(d, 'Claude B')).toContain('token: set')
    expect(lineWith(d, 'Main Claude')).toContain('token: not set')
    expect(lineWith(d, 'Claude C')).toContain('token: not set')
    expect(out(d)).not.toContain('sk-go-2')
  })

  it('shows Claude login status from claudeAuthStatus with the resolved config dir', async () => {
    const d = makeDeps()
    d.claudeAuthStatus.mockImplementation((dir?: string) => {
      if (dir === undefined) return { loggedIn: true }
      if (dir === absDir('claude-b')) return { loggedIn: false }
      return undefined
    })
    await cmdGroup(['list'], {}, d)
    expect(lineWith(d, 'Main Claude')).toContain('login: ok')
    expect(lineWith(d, 'Claude B')).toContain('login: not logged in')
    expect(lineWith(d, 'Claude C')).toContain('login: unknown')
    expect(lineWith(d, 'Go 2')).not.toContain('login:')
    expect(lineWith(d, 'OR main')).not.toContain('login:')
    const dirs = d.claudeAuthStatus.mock.calls.map((c) => c[0])
    expect(dirs).toContain(undefined)
    expect(dirs).toContain(absDir('claude-b'))
    expect(dirs).toContain(absDir('claude-c'))
  })
})

describe('group add', () => {
  const base = (): ResourceGroup[] => [
    { id: 'claude-sub', kind: 'claude-subscription', label: 'Main Claude' },
    { id: 'opencode-go', kind: 'opencode-go', label: 'Go main' },
  ]

  it('adds a Claude group with its own 0700 config dir and points to group login', async () => {
    const d = makeDeps({ groups: base() })
    await cmdGroup(['add', 'claude'], { id: 'claude-b' }, d)
    expect(d.saveConfig).toHaveBeenCalledTimes(1)
    const saved = savedGroups(d)
    expect(saved).toHaveLength(3)
    expect(saved[2]).toMatchObject({ id: 'claude-b', kind: 'claude-subscription', configDir: 'state/claude/claude-b' })
    const dir = absDir('claude-b')
    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(out(d)).toContain('office group login claude-b')
  })

  it('seeds the new Claude config dir as onboarded, copying only UI keys from the main config', async () => {
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'owner@example.com' },
      userID: 'owner-id',
    }))
    const d = makeDeps({ groups: base() })
    await cmdGroup(['add', 'claude'], { id: 'claude-b' }, d)
    const file = path.join(absDir('claude-b'), '.claude.json')
    expect(fs.existsSync(file)).toBe(true)
    const got = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(got.hasCompletedOnboarding).toBe(true)
    expect(got.theme).toBe('dark')
    expect(got).not.toHaveProperty('oauthAccount')
    expect(got).not.toHaveProperty('userID')
  })

  it('seeds the new Claude config dir as onboarded even without a main config', async () => {
    const d = makeDeps({ groups: base() })
    await cmdGroup(['add', 'claude'], { id: 'claude-b' }, d)
    const got = JSON.parse(fs.readFileSync(path.join(absDir('claude-b'), '.claude.json'), 'utf8'))
    expect(got.hasCompletedOnboarding).toBe(true)
  })

  it('accepts the full kind name claude-subscription', async () => {
    const d = makeDeps({ groups: base() })
    await cmdGroup(['add', 'claude-subscription'], { id: 'claude-x' }, d)
    expect(savedGroups(d).at(-1)).toMatchObject({ id: 'claude-x', kind: 'claude-subscription' })
  })

  it('adds an OpenCode Go group with a label and points to vault set', async () => {
    const d = makeDeps({ groups: base() })
    await cmdGroup(['add', 'opencode-go'], { id: 'go-2', label: 'Go 2' }, d)
    const saved = savedGroups(d)
    expect(saved.at(-1)).toMatchObject({ id: 'go-2', kind: 'opencode-go', label: 'Go 2' })
    expect(saved.at(-1)?.configDir).toBeUndefined()
    expect(out(d)).toContain('office vault set go-2')
    expect(out(d)).not.toContain('office group login')
  })

  it('adds an OpenRouter group', async () => {
    const d = makeDeps({ groups: base() })
    await cmdGroup(['add', 'openrouter'], { id: 'or-2' }, d)
    expect(savedGroups(d).at(-1)).toMatchObject({ id: 'or-2', kind: 'openrouter' })
    expect(out(d)).toContain('office vault set or-2')
  })

  it('rejects an unknown kind', async () => {
    const d = makeDeps({ groups: base() })
    await expect(cmdGroup(['add', 'gemini'], { id: 'gem-1' }, d)).rejects.toThrow()
    expect(d.saveConfig).not.toHaveBeenCalled()
  })

  it('rejects a duplicate id', async () => {
    const d = makeDeps({ groups: base() })
    await expect(cmdGroup(['add', 'opencode-go'], { id: 'claude-sub' }, d)).rejects.toThrow()
    expect(d.saveConfig).not.toHaveBeenCalled()
  })

  it('rejects a reserved id', async () => {
    const d = makeDeps({ groups: base() })
    await expect(cmdGroup(['add', 'openrouter'], { id: 'anthropic' }, d)).rejects.toThrow()
    await expect(cmdGroup(['add', 'claude'], { id: 'claude-oauth' }, d)).rejects.toThrow()
    expect(d.saveConfig).not.toHaveBeenCalled()
    expect(fs.existsSync(absDir('claude-oauth'))).toBe(false)
  })

  it('rejects a missing --id', async () => {
    const d = makeDeps({ groups: base() })
    await expect(cmdGroup(['add', 'openrouter'], {}, d)).rejects.toThrow()
    expect(d.saveConfig).not.toHaveBeenCalled()
  })
})

describe('group rm', () => {
  it('removes an unused group and saves', async () => {
    const d = makeDeps({ agents: roster().filter((a) => a.name !== 'carol') })
    await cmdGroup(['rm', 'go-2'], {}, d)
    expect(d.saveConfig).toHaveBeenCalledTimes(1)
    expect(savedGroups(d).map((g) => g.id)).not.toContain('go-2')
    expect(savedGroups(d)).toHaveLength(5)
  })

  it('refuses when a hired agent resolves to the group', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['rm', 'claude-b'], {}, d)).rejects.toThrow(/bob/)
    expect(d.saveConfig).not.toHaveBeenCalled()
  })

  it('throws on an unknown group', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['rm', 'nope'], {}, d)).rejects.toThrow()
    expect(d.saveConfig).not.toHaveBeenCalled()
  })

  it('removing a Claude group keeps its config dir and says where', async () => {
    fs.mkdirSync(absDir('claude-c'), { recursive: true })
    // a retired agent on the group does not block removal
    const d = makeDeps({ agents: [...roster(), agent('fred', { status: 'retired', group: 'claude-c' })] })
    await cmdGroup(['rm', 'claude-c'], {}, d)
    expect(savedGroups(d).map((g) => g.id)).not.toContain('claude-c')
    expect(out(d)).toContain(path.join('state', 'claude', 'claude-c'))
    expect(fs.existsSync(absDir('claude-c'))).toBe(true)
  })
})

describe('group login', () => {
  it('runs claude auth login with the group dir and reports the status', async () => {
    const d = makeDeps()
    await cmdGroup(['login', 'claude-b'], {}, d)
    expect(d.runClaudeLogin).toHaveBeenCalledTimes(1)
    expect(d.runClaudeLogin).toHaveBeenCalledWith(absDir('claude-b'))
    expect(d.claudeAuthStatus).toHaveBeenCalledWith(absDir('claude-b'))
    expect(d.runClaudeLogin.mock.invocationCallOrder[0]).toBeLessThan(d.claudeAuthStatus.mock.invocationCallOrder[0])
  })

  it('leaves the group config dir onboarded after a successful login, keeping keys login wrote', async () => {
    const d = makeDeps()
    d.runClaudeLogin.mockImplementation((dir?: string) => {
      fs.mkdirSync(dir!, { recursive: true })
      fs.writeFileSync(path.join(dir!, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'b@example.com' },
        userID: 'user-b',
      }))
      return 0
    })
    await cmdGroup(['login', 'claude-b'], {}, d)
    const got = JSON.parse(fs.readFileSync(path.join(absDir('claude-b'), '.claude.json'), 'utf8'))
    expect(got.hasCompletedOnboarding).toBe(true)
    expect(got.oauthAccount).toEqual({ emailAddress: 'b@example.com' })
    expect(got.userID).toBe('user-b')
  })

  it('leaves the group config dir onboarded after a login that wrote no config file', async () => {
    const d = makeDeps()
    await cmdGroup(['login', 'claude-b'], {}, d)
    const got = JSON.parse(fs.readFileSync(path.join(absDir('claude-b'), '.claude.json'), 'utf8'))
    expect(got.hasCompletedOnboarding).toBe(true)
  })

  it('uses the harness default dir for the default Claude group', async () => {
    const d = makeDeps()
    await cmdGroup(['login', 'claude-sub'], {}, d)
    expect(d.runClaudeLogin).toHaveBeenCalledTimes(1)
    expect(d.runClaudeLogin.mock.calls[0][0]).toBeUndefined()
  })

  it('throws when claude auth login exits non-zero', async () => {
    const d = makeDeps()
    d.runClaudeLogin.mockReturnValue(1)
    await expect(cmdGroup(['login', 'claude-b'], {}, d)).rejects.toThrow()
  })

  it('refuses without a TTY and points to the server shell', async () => {
    const d = makeDeps({ isTTY: false })
    await expect(cmdGroup(['login', 'claude-b'], {}, d)).rejects.toThrow(/shell/)
    expect(d.runClaudeLogin).not.toHaveBeenCalled()
  })

  it('refuses for non-Claude groups and points to vault set', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['login', 'go-2'], {}, d)).rejects.toThrow(/office vault set go-2/)
    expect(d.runClaudeLogin).not.toHaveBeenCalled()
  })

  it('throws on an unknown group', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['login', 'nope'], {}, d)).rejects.toThrow()
    expect(d.runClaudeLogin).not.toHaveBeenCalled()
  })
})

describe('group move', () => {
  const writeTranscript = (configDir: string, name: string, sessionId: string) => {
    const dir = path.join(configDir, 'projects', claudeProjectSlug(workspaceDir(root, name)))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${sessionId}.jsonl`)
    fs.writeFileSync(file, '{"type":"user"}\n')
    return file
  }
  const transcriptIn = (configDir: string, name: string, sessionId: string) =>
    path.join(configDir, 'projects', claudeProjectSlug(workspaceDir(root, name)), `${sessionId}.jsonl`)

  const expectNothingDone = (d: Fake) => {
    expect(d.stopAgent).not.toHaveBeenCalled()
    expect(d.saveAgent).not.toHaveBeenCalled()
    expect(d.startAgent).not.toHaveBeenCalled()
  }

  it('throws for an unknown agent', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['move', 'zed', 'claude-b'], {}, d)).rejects.toThrow()
    expectNothingDone(d)
  })

  it('throws for a retired agent', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['move', 'dave', 'claude-sub'], {}, d)).rejects.toThrow()
    expectNothingDone(d)
  })

  it('throws on a kind mismatch', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['move', 'alice', 'go-2'], {}, d)).rejects.toThrow()
    expectNothingDone(d)
  })

  it('throws on an unknown group', async () => {
    const d = makeDeps()
    await expect(cmdGroup(['move', 'alice', 'nope'], {}, d)).rejects.toThrow()
    expectNothingDone(d)
  })

  it('does nothing when the agent already resolves to the group', async () => {
    const d = makeDeps()
    await cmdGroup(['move', 'alice', 'claude-sub'], {}, d)
    await cmdGroup(['move', 'bob', 'claude-b'], {}, d)
    expect(out(d)).toMatch(/already/i)
    expectNothingDone(d)
  })

  it('Claude: stops, copies the transcript into the new dir, keeps the session and restarts', async () => {
    writeTranscript(claudeHome, 'alice', 'sess-1')
    const dest = transcriptIn(absDir('claude-b'), 'alice', 'sess-1')
    const d = makeDeps()
    let copiedBeforeStop: boolean | undefined
    d.stopAgent.mockImplementation(async () => { copiedBeforeStop = fs.existsSync(dest) })
    await cmdGroup(['move', 'alice', 'claude-b'], {}, d)

    expect(copiedBeforeStop).toBe(false)
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('{"type":"user"}\n')

    expect(d.stopAgent).toHaveBeenCalledTimes(1)
    expect(d.saveAgent).toHaveBeenCalledTimes(1)
    expect(d.startAgent).toHaveBeenCalledTimes(1)
    const saved = d.saveAgent.mock.calls[0][0] as AgentRecord
    expect(saved.name).toBe('alice')
    expect(saved.group).toBe('claude-b')
    expect(saved.sessionId).toBe('sess-1')
    expect(saved.pastSessions).not.toContain('sess-1')
    expect((d.startAgent.mock.calls[0][0] as AgentRecord).group).toBe('claude-b')

    const [stop] = d.stopAgent.mock.invocationCallOrder
    const [save] = d.saveAgent.mock.invocationCallOrder
    const [start] = d.startAgent.mock.invocationCallOrder
    expect(stop).toBeLessThan(save)
    expect(save).toBeLessThan(start)
  })

  it('Claude: moving back to the default group copies into the default config dir', async () => {
    writeTranscript(absDir('claude-b'), 'bob', 'sess-2')
    const d = makeDeps()
    await cmdGroup(['move', 'bob', 'claude-sub'], {}, d)
    expect(fs.existsSync(transcriptIn(claudeHome, 'bob', 'sess-2'))).toBe(true)
    const saved = d.saveAgent.mock.calls[0][0] as AgentRecord
    expect(saved.group).toBe('claude-sub')
    expect(saved.sessionId).toBe('sess-2')
  })

  it('Claude: without a transcript the session is retired and a fresh one starts', async () => {
    const d = makeDeps()
    await cmdGroup(['move', 'alice', 'claude-b'], {}, d)
    expect(d.stopAgent).toHaveBeenCalledTimes(1)
    const saved = d.saveAgent.mock.calls[0][0] as AgentRecord
    expect(saved.group).toBe('claude-b')
    expect(saved.sessionId).toBeUndefined()
    expect(saved.pastSessions).toContain('sess-1')
    expect(out(d)).toMatch(/fresh/i)
    expect(d.startAgent).toHaveBeenCalledTimes(1)
    expect(d.stopAgent.mock.invocationCallOrder[0]).toBeLessThan(d.saveAgent.mock.invocationCallOrder[0])
    expect(d.saveAgent.mock.invocationCallOrder[0]).toBeLessThan(d.startAgent.mock.invocationCallOrder[0])
  })

  it('opencode: stops, switches group, saves and restarts the same session', async () => {
    const d = makeDeps()
    await cmdGroup(['move', 'carol', 'opencode-go'], {}, d)
    expect(d.stopAgent).toHaveBeenCalledTimes(1)
    const saved = d.saveAgent.mock.calls[0][0] as AgentRecord
    expect(saved.name).toBe('carol')
    expect(saved.group).toBe('opencode-go')
    expect(saved.sessionId).toBe('ses_carol')
    expect(saved.pastSessions).toEqual([])
    expect(d.startAgent).toHaveBeenCalledTimes(1)
    expect(d.stopAgent.mock.invocationCallOrder[0]).toBeLessThan(d.saveAgent.mock.invocationCallOrder[0])
    expect(d.saveAgent.mock.invocationCallOrder[0]).toBeLessThan(d.startAgent.mock.invocationCallOrder[0])
  })
})

describe('resolveHireGroup', () => {
  const claudeRec = { harness: 'claude', model: 'sonnet' } as const
  const goRec = { harness: 'opencode', model: 'opencode-go/kimi-k2' } as const
  const noKindRec = { harness: 'opencode', model: 'some-provider/model' } as const

  it('returns undefined for no flag or an empty flag', () => {
    expect(resolveHireGroup(undefined, claudeRec, groups(), {})).toBeUndefined()
    expect(resolveHireGroup('', claudeRec, groups(), {})).toBeUndefined()
  })

  it('auto picks the same-kind group with the lowest used %', () => {
    expect(resolveHireGroup('auto', claudeRec, groups(), { 'claude-sub': 80, 'claude-b': 20, 'claude-c': 50 })).toBe('claude-b')
    expect(resolveHireGroup('auto', goRec, groups(), { 'opencode-go': 10, 'go-2': 60 })).toBe('opencode-go')
  })

  it('auto falls back to config order when nothing is known', () => {
    expect(resolveHireGroup('auto', claudeRec, groups(), {})).toBe('claude-sub')
    expect(resolveHireGroup('auto', goRec, groups(), {})).toBe('opencode-go')
  })

  it('auto returns undefined when the model has no group kind', () => {
    expect(resolveHireGroup('auto', noKindRec, groups(), { 'claude-sub': 1 })).toBeUndefined()
  })

  it('auto returns undefined when no group of the kind exists', () => {
    const onlyClaude = groups().filter((g) => g.kind === 'claude-subscription')
    expect(resolveHireGroup('auto', goRec, onlyClaude, {})).toBeUndefined()
  })

  it('returns a valid explicit id', () => {
    expect(resolveHireGroup('claude-c', claudeRec, groups(), {})).toBe('claude-c')
    expect(resolveHireGroup('go-2', goRec, groups(), {})).toBe('go-2')
  })

  it('throws the checkGroupForAgent message for an unknown id', () => {
    expect(() => resolveHireGroup('nope', claudeRec, groups(), {})).toThrow(/unknown group nope/)
  })

  it('throws the checkGroupForAgent message on a kind mismatch', () => {
    expect(() => resolveHireGroup('go-2', claudeRec, groups(), {})).toThrow(/go-2 is an OpenCode Go group.*needs a Claude/)
  })
})
