import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  STATIC_ENTRIES, ensureVaultKey, getSecret, importableFromAuthJson, listSecrets, markValidated,
  migrateLegacyVault, opencodeProviderOverrides, removeSecret, renderEnvFile, renderVaultStatus, setSecret,
  validateSecret, vaultEnvDefaults, vaultEnvForAgent, vaultSpec, vaultSpecs, withEnvFile, writeAgentEnvFile,
} from '../src/lib/vault.js'
import type { VaultEntrySpec } from '../src/lib/vault.js'
import type { ResourceGroup } from '../src/lib/types.js'

const GROUPS: ResourceGroup[] = [
  { id: 'claude-sub', kind: 'claude-subscription', label: 'Claude' },
  { id: 'claude-b', kind: 'claude-subscription', label: 'Claude B', configDir: 'state/claude/claude-b' },
  { id: 'opencode-go', kind: 'opencode-go', label: 'Go' },
  { id: 'go-2', kind: 'opencode-go', label: 'Go 2' },
  { id: 'openrouter', kind: 'openrouter', label: 'OR' },
]

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-')) })
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Write a milestone-1 style 'claude-oauth' entry straight into state/vault.json. */
function writeLegacyEntry(dir: string, value: string): void {
  const key = ensureVaultKey(dir)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('claude-oauth'))
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const f = path.join(dir, 'state', 'vault.json')
  let store: Record<string, unknown> = {}
  try { store = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { /* new store */ }
  store['claude-oauth'] = {
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'), setAt: new Date().toISOString(),
  }
  fs.writeFileSync(f, JSON.stringify(store, null, 2), { mode: 0o600 })
}

const readStore = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'vault.json'), 'utf8'))

describe('vault crypto', () => {
  it('creates a 32-byte chmod-600 key once', () => {
    const k = ensureVaultKey(root)
    expect(k).toHaveLength(32)
    expect(fs.statSync(path.join(root, 'state', 'vault.key')).mode & 0o777).toBe(0o600)
    expect(ensureVaultKey(root)).toEqual(k)
  })

  it('round-trips a secret and never stores it in clear text', () => {
    setSecret(root, 'openrouter', '  sk-or-secret-123  ', GROUPS)
    expect(getSecret(root, 'openrouter')).toBe('sk-or-secret-123')
    const raw = fs.readFileSync(path.join(root, 'state', 'vault.json'), 'utf8')
    expect(raw).not.toContain('sk-or-secret-123')
    expect(fs.statSync(path.join(root, 'state', 'vault.json')).mode & 0o777).toBe(0o600)
  })

  it('rejects empty and multi-line values', () => {
    expect(() => setSecret(root, 'openrouter', '   ', GROUPS)).toThrow(/empty/)
    expect(() => setSecret(root, 'openrouter', 'a\nb', GROUPS)).toThrow(/single line/)
  })

  it('fails to decrypt with a different key (tamper / wrong key)', () => {
    setSecret(root, 'openrouter', 'sk-1', GROUPS)
    fs.writeFileSync(path.join(root, 'state', 'vault.key'), Buffer.alloc(32, 1))
    expect(() => getSecret(root, 'openrouter')).toThrow()
  })

  it('binds ciphertext to its entry id', () => {
    setSecret(root, 'openrouter', 'sk-1', GROUPS)
    const f = path.join(root, 'state', 'vault.json')
    const store = JSON.parse(fs.readFileSync(f, 'utf8'))
    store['go-2'] = store.openrouter
    fs.writeFileSync(f, JSON.stringify(store))
    expect(() => getSecret(root, 'go-2')).toThrow()
  })

  it('lists metadata only and removes entries', () => {
    setSecret(root, 'go-2', 'go-key', GROUPS)
    markValidated(root, 'go-2', true)
    const info = listSecrets(root, GROUPS).find(e => e.id === 'go-2')!
    expect(info).toMatchObject({ label: 'Go 2', set: true, valid: true })
    expect(JSON.stringify(listSecrets(root, GROUPS))).not.toContain('go-key')
    expect(renderVaultStatus(listSecrets(root, GROUPS))).toMatch(/go-2 .*validated/)
    expect(removeSecret(root, 'go-2')).toBe(true)
    expect(removeSecret(root, 'go-2')).toBe(false)
  })
})

describe('vaultSpecs', () => {
  it('has the static entries', () => {
    expect(STATIC_ENTRIES.map(s => s.id)).toEqual(['opencode-zen', 'anthropic'])
    expect(STATIC_ENTRIES[0]).toMatchObject({ env: 'OPENCODE_API_KEY', harness: 'opencode', opencodeProviders: ['opencode'], authJsonId: 'opencode' })
    expect(STATIC_ENTRIES[1]).toMatchObject({ env: 'ANTHROPIC_API_KEY', harness: 'opencode', opencodeProviders: ['anthropic'], authJsonId: 'anthropic' })
    for (const s of STATIC_ENTRIES) expect(s.groupId).toBeUndefined()
  })

  it('makes one spec per group in config order, then the static entries', () => {
    const specs = vaultSpecs(GROUPS)
    expect(specs.map(s => s.id)).toEqual(['claude-sub', 'claude-b', 'opencode-go', 'go-2', 'openrouter', 'opencode-zen', 'anthropic'])
    for (const g of GROUPS) {
      const s = specs.find(x => x.id === g.id)!
      expect(s.label).toBe(g.label)
      expect(s.groupId).toBe(g.id)
    }
  })

  it('sets env, harness and providers per kind', () => {
    const specs = vaultSpecs(GROUPS)
    const by = (id: string) => specs.find(s => s.id === id)!
    expect(by('claude-sub')).toMatchObject({ env: 'CLAUDE_CODE_OAUTH_TOKEN', harness: 'claude' })
    expect(by('claude-b')).toMatchObject({ env: 'CLAUDE_CODE_OAUTH_TOKEN', harness: 'claude' })
    expect(by('opencode-go')).toMatchObject({ env: 'OPENCODE_GO_API_KEY', harness: 'opencode', opencodeProviders: ['opencode-go'] })
    expect(by('go-2')).toMatchObject({ env: 'OPENCODE_GO_API_KEY', harness: 'opencode', opencodeProviders: ['opencode-go'] })
    expect(by('openrouter')).toMatchObject({ env: 'OPENROUTER_API_KEY', harness: 'opencode', opencodeProviders: ['openrouter'] })
  })

  it('puts authJsonId only on the default opencode-go / openrouter groups', () => {
    const specs = vaultSpecs(GROUPS)
    const by = (id: string) => specs.find(s => s.id === id)!
    expect(by('opencode-go').authJsonId).toBe('opencode-go')
    expect(by('go-2').authJsonId).toBeUndefined()
    expect(by('openrouter').authJsonId).toBe('openrouter')
    expect(by('claude-sub').authJsonId).toBeUndefined()
    expect(by('claude-b').authJsonId).toBeUndefined()
  })

  it('is just the static entries with no groups', () => {
    expect(vaultSpecs([]).map(s => s.id)).toEqual(['opencode-zen', 'anthropic'])
  })

  it('looks up a spec by id', () => {
    expect(vaultSpec('go-2', GROUPS)).toMatchObject({ id: 'go-2', groupId: 'go-2', env: 'OPENCODE_GO_API_KEY' })
    expect(vaultSpec('anthropic', GROUPS)).toMatchObject({ id: 'anthropic', env: 'ANTHROPIC_API_KEY' })
    expect(vaultSpec('claude-oauth', GROUPS)).toBeUndefined()
    expect(vaultSpec('nope', GROUPS)).toBeUndefined()
  })
})

describe('setSecret with groups', () => {
  it('throws on unknown ids and lists the known ones', () => {
    let msg = ''
    try { setSecret(root, 'nope', 'x', GROUPS) } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/unknown vault entry/)
    for (const id of ['claude-sub', 'claude-b', 'opencode-go', 'go-2', 'openrouter', 'opencode-zen', 'anthropic']) expect(msg).toContain(id)
  })

  it('rejects the legacy claude-oauth id', () => {
    expect(() => setSecret(root, 'claude-oauth', 'x', GROUPS)).toThrow(/unknown vault entry/)
  })

  it('accepts group ids and static ids', () => {
    setSecret(root, 'claude-b', 'tok-b', GROUPS)
    setSecret(root, 'go-2', 'go2', GROUPS)
    setSecret(root, 'opencode-zen', 'zen', GROUPS)
    setSecret(root, 'anthropic', 'ant', GROUPS)
    expect(getSecret(root, 'claude-b')).toBe('tok-b')
    expect(getSecret(root, 'go-2')).toBe('go2')
    expect(getSecret(root, 'opencode-zen')).toBe('zen')
    expect(getSecret(root, 'anthropic')).toBe('ant')
  })

  it('only knows groups that are in the passed list', () => {
    expect(() => setSecret(root, 'go-2', 'x', GROUPS.filter(g => g.id !== 'go-2'))).toThrow(/unknown vault entry/)
  })
})

describe('listSecrets', () => {
  it('returns one row per spec with labels', () => {
    setSecret(root, 'claude-b', 'tok', GROUPS)
    const rows = listSecrets(root, GROUPS)
    expect(rows.map(r => r.id)).toEqual(vaultSpecs(GROUPS).map(s => s.id))
    expect(rows.find(r => r.id === 'claude-b')).toMatchObject({ label: 'Claude B', set: true })
    expect(rows.find(r => r.id === 'claude-sub')).toMatchObject({ label: 'Claude', set: false })
    expect(rows.filter(r => r.set).map(r => r.id)).toEqual(['claude-b'])
  })
})

describe('vaultEnvForAgent', () => {
  it('is empty when nothing is set', () => {
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'claude', model: 'sonnet' })).toEqual({})
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'opencode', model: 'opencode-go/x', group: 'go-2' })).toEqual({})
  })

  it("gives a Claude agent only its own group's token", () => {
    setSecret(root, 'claude-sub', 'tok-a', GROUPS)
    setSecret(root, 'claude-b', 'tok-b', GROUPS)
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'claude', model: 'sonnet', group: 'claude-b' }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-b' })
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'claude', model: 'sonnet' }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-a' })
  })

  it('never gives a Claude agent API keys (they would override the subscription)', () => {
    setSecret(root, 'anthropic', 'ant', GROUPS)
    setSecret(root, 'openrouter', 'or', GROUPS)
    setSecret(root, 'opencode-go', 'go', GROUPS)
    setSecret(root, 'opencode-zen', 'zen', GROUPS)
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'claude', model: 'sonnet', group: 'claude-b' })).toEqual({})
    setSecret(root, 'claude-b', 'tok-b', GROUPS)
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'claude', model: 'sonnet', group: 'claude-b' }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-b' })
  })

  it("gives an opencode agent its group's key plus the set static opencode entries", () => {
    setSecret(root, 'opencode-go', 'go-default', GROUPS)
    setSecret(root, 'go-2', 'go-second', GROUPS)
    setSecret(root, 'opencode-zen', 'zen', GROUPS)
    setSecret(root, 'anthropic', 'ant', GROUPS)
    setSecret(root, 'claude-sub', 'tok-a', GROUPS)
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'opencode', model: 'opencode-go/x', group: 'go-2' })).toEqual({
      OPENCODE_GO_API_KEY: 'go-second', OPENCODE_API_KEY: 'zen', ANTHROPIC_API_KEY: 'ant',
    })
  })

  it("does not hand an opencode-go agent another kind's group key", () => {
    setSecret(root, 'go-2', 'go-second', GROUPS)
    setSecret(root, 'openrouter', 'or', GROUPS)
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'opencode', model: 'opencode-go/x', group: 'go-2' }))
      .toEqual({ OPENCODE_GO_API_KEY: 'go-second' })
  })

  it("falls back to the default group's key when the agent's group does not fit its model", () => {
    setSecret(root, 'opencode-go', 'go-default', GROUPS)
    setSecret(root, 'go-2', 'go-second', GROUPS)
    setSecret(root, 'openrouter', 'or', GROUPS)
    // go-2 is an OpenCode Go group, the model needs OpenRouter
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'opencode', model: 'openrouter/some/model', group: 'go-2' }))
      .toEqual({ OPENROUTER_API_KEY: 'or' })
    // unknown group
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'opencode', model: 'opencode-go/x', group: 'gone' }))
      .toEqual({ OPENCODE_GO_API_KEY: 'go-default' })
  })

  it('gives an opencode agent with a non-group model only the static entries', () => {
    setSecret(root, 'opencode-go', 'go-default', GROUPS)
    setSecret(root, 'opencode-zen', 'zen', GROUPS)
    expect(vaultEnvForAgent(root, GROUPS, { harness: 'opencode', model: 'opencode/big-pickle' }))
      .toEqual({ OPENCODE_API_KEY: 'zen' })
  })
})

describe('vaultEnvDefaults', () => {
  it('uses only the default group of each kind plus static entries, per harness', () => {
    setSecret(root, 'claude-sub', 'tok-a', GROUPS)
    setSecret(root, 'claude-b', 'tok-b', GROUPS)
    setSecret(root, 'opencode-go', 'go-default', GROUPS)
    setSecret(root, 'go-2', 'go-second', GROUPS)
    setSecret(root, 'openrouter', 'or', GROUPS)
    setSecret(root, 'anthropic', 'ant', GROUPS)
    expect(vaultEnvDefaults(root, GROUPS, 'opencode')).toEqual({
      OPENCODE_GO_API_KEY: 'go-default', OPENROUTER_API_KEY: 'or', ANTHROPIC_API_KEY: 'ant',
    })
    expect(vaultEnvDefaults(root, GROUPS, 'claude')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-a' })
  })

  it('is empty when only non-default groups are set', () => {
    setSecret(root, 'claude-b', 'tok-b', GROUPS)
    setSecret(root, 'go-2', 'go-second', GROUPS)
    expect(vaultEnvDefaults(root, GROUPS, 'claude')).toEqual({})
    expect(vaultEnvDefaults(root, GROUPS, 'opencode')).toEqual({})
  })
})

describe('opencodeProviderOverrides', () => {
  it('points providers at env vars that are present only', () => {
    expect(opencodeProviderOverrides(GROUPS, { OPENCODE_GO_API_KEY: 'g' }))
      .toEqual({ 'opencode-go': { options: { apiKey: '{env:OPENCODE_GO_API_KEY}' } } })
    expect(opencodeProviderOverrides(GROUPS, { OPENROUTER_API_KEY: 'o', OPENCODE_API_KEY: 'z', ANTHROPIC_API_KEY: 'a' })).toEqual({
      openrouter: { options: { apiKey: '{env:OPENROUTER_API_KEY}' } },
      opencode: { options: { apiKey: '{env:OPENCODE_API_KEY}' } },
      anthropic: { options: { apiKey: '{env:ANTHROPIC_API_KEY}' } },
    })
  })

  it('is empty for no env and ignores Claude tokens', () => {
    expect(opencodeProviderOverrides(GROUPS, {})).toEqual({})
    expect(opencodeProviderOverrides(GROUPS, { CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({})
  })
})

describe('env file', () => {
  it('writes a chmod-600 env file that a shell sources, with awkward characters intact', () => {
    const dir = path.join(root, 'agents', 'ada')
    fs.mkdirSync(dir, { recursive: true })
    const file = writeAgentEnvFile(dir, { OPENROUTER_API_KEY: `it's $HOME "x"` })
    expect(file).toBe(path.join(dir, 'provider.env'))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const out = execFileSync('sh', ['-c', withEnvFile('printenv OPENROUTER_API_KEY', file)], { encoding: 'utf8' })
    expect(out.trim()).toBe(`it's $HOME "x"`)
  })

  it('writes an empty env file when there is nothing to hand over', () => {
    const dir = path.join(root, 'agents', 'bob')
    fs.mkdirSync(dir, { recursive: true })
    const file = writeAgentEnvFile(dir, {})
    expect(fs.readFileSync(file, 'utf8')).toBe('')
    expect(renderEnvFile({})).toBe('')
  })
})

describe('importableFromAuthJson', () => {
  it('imports only API-type entries matching default groups and static entries', () => {
    const json = JSON.stringify({
      openrouter: { type: 'api', key: 'or' },
      'opencode-go': { type: 'api', key: 'go' },
      opencode: { type: 'api', key: 'zen' },
      github: { type: 'oauth', refresh: 'r' },
      anthropic: { type: 'oauth', access: 'a' },
      'go-2': { type: 'api', key: 'nope' },
    })
    const got = importableFromAuthJson(json, GROUPS)
    expect(got).toHaveLength(3)
    expect(got).toEqual(expect.arrayContaining([
      { id: 'openrouter', value: 'or' },
      { id: 'opencode-go', value: 'go' },
      { id: 'opencode-zen', value: 'zen' },
    ]))
  })

  it('maps to the default group id, whatever it is called', () => {
    const groups: ResourceGroup[] = [{ id: 'go-main', kind: 'opencode-go', label: 'Go main' }, { id: 'go-2', kind: 'opencode-go', label: 'Go 2' }]
    expect(importableFromAuthJson(JSON.stringify({ 'opencode-go': { type: 'api', key: 'go' } }), groups))
      .toEqual([{ id: 'go-main', value: 'go' }])
  })

  it('returns nothing for bad JSON', () => {
    expect(importableFromAuthJson('not json', GROUPS)).toEqual([])
  })
})

describe('migrateLegacyVault', () => {
  it('moves claude-oauth to the default Claude group, once', () => {
    writeLegacyEntry(root, 'legacy-token')
    expect(migrateLegacyVault(root, GROUPS)).toBe(true)
    expect(getSecret(root, 'claude-sub')).toBe('legacy-token')
    expect(getSecret(root, 'claude-oauth')).toBeUndefined()
    expect(readStore(root)['claude-oauth']).toBeUndefined()
    expect(JSON.stringify(readStore(root))).not.toContain('legacy-token')
    expect(migrateLegacyVault(root, GROUPS)).toBe(false)
    expect(getSecret(root, 'claude-sub')).toBe('legacy-token')
  })

  it('keeps other entries intact', () => {
    setSecret(root, 'openrouter', 'or', GROUPS)
    writeLegacyEntry(root, 'legacy-token')
    expect(migrateLegacyVault(root, GROUPS)).toBe(true)
    expect(getSecret(root, 'openrouter')).toBe('or')
  })

  it('leaves the legacy entry alone when the default group already has one', () => {
    setSecret(root, 'claude-sub', 'new-token', GROUPS)
    writeLegacyEntry(root, 'legacy-token')
    expect(migrateLegacyVault(root, GROUPS)).toBe(false)
    expect(getSecret(root, 'claude-sub')).toBe('new-token')
    expect(getSecret(root, 'claude-oauth')).toBe('legacy-token')
  })

  it('leaves it alone when there is no Claude group', () => {
    writeLegacyEntry(root, 'legacy-token')
    const noClaude = GROUPS.filter(g => g.kind !== 'claude-subscription')
    expect(migrateLegacyVault(root, noClaude)).toBe(false)
    expect(getSecret(root, 'claude-oauth')).toBe('legacy-token')
  })

  it('is a no-op without a legacy entry or a vault', () => {
    expect(migrateLegacyVault(root, GROUPS)).toBe(false)
    setSecret(root, 'openrouter', 'or', GROUPS)
    expect(migrateLegacyVault(root, GROUPS)).toBe(false)
  })
})

describe('validateSecret', () => {
  const by = (id: string): VaultEntrySpec => vaultSpecs(GROUPS).find(s => s.id === id)!
  const mockFetch = (impl: () => Promise<Response>) => {
    const fn = vi.fn(impl)
    vi.stubGlobal('fetch', fn)
    return fn
  }
  const headerOf = (init: unknown, name: string): string | undefined => {
    const h = (init as RequestInit | undefined)?.headers
    if (!h) return undefined
    if (h instanceof Headers) return h.get(name) ?? undefined
    const rec = h as Record<string, string>
    return rec[name] ?? rec[name.toLowerCase()]
  }

  it('checks OpenRouter keys against /api/v1/key with Bearer auth', async () => {
    const fn = mockFetch(async () => new Response('{}', { status: 200 }))
    expect(await validateSecret(by('openrouter'), 'sk-or')).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    const [url, init] = fn.mock.calls[0] as unknown as [string | URL, RequestInit]
    expect(String(url)).toBe('https://openrouter.ai/api/v1/key')
    expect(headerOf(init, 'Authorization')).toBe('Bearer sk-or')
  })

  it('checks every OpenCode Go group key against the usage endpoint', async () => {
    const fn = mockFetch(async () => new Response('{}', { status: 200 }))
    expect(await validateSecret(by('go-2'), 'go-key')).toBe(true)
    const [url, init] = fn.mock.calls[0] as unknown as [string | URL, RequestInit]
    expect(String(url)).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(headerOf(init, 'Authorization')).toBe('Bearer go-key')
  })

  it('treats 401/403 as rejected', async () => {
    mockFetch(async () => new Response('', { status: 401 }))
    expect(await validateSecret(by('openrouter'), 'bad')).toBe(false)
    mockFetch(async () => new Response('', { status: 403 }))
    expect(await validateSecret(by('opencode-go'), 'bad')).toBe(false)
  })

  it('is unsure on server errors and network failures', async () => {
    mockFetch(async () => new Response('', { status: 500 }))
    expect(await validateSecret(by('openrouter'), 'k')).toBeUndefined()
    mockFetch(async () => { throw new Error('offline') })
    expect(await validateSecret(by('go-2'), 'k')).toBeUndefined()
  })

  it('does not call out for entries without a cheap check', async () => {
    const fn = mockFetch(async () => new Response('{}', { status: 200 }))
    for (const id of ['claude-sub', 'claude-b', 'opencode-zen', 'anthropic']) {
      expect(await validateSecret(by(id), 'k')).toBeUndefined()
    }
    expect(fn).not.toHaveBeenCalled()
  })
})
