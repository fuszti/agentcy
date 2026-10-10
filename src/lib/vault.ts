// Credential vault: provider API keys, encrypted at rest (AES-256-GCM) under state/.
// The key file (state/vault.key) and the store (state/vault.json) are chmod 600, like the
// inbox HMAC key. This guards against committing/copying the store by accident, not against
// someone who already has the office user's shell. Keys are handed to agents only as
// environment variables via a chmod-600 env file — never on a command line, never in chat.
//
// Vault entries are named after resource groups (office.config.json's `resourceGroups`): one
// entry per group, plus a few static, non-group entries (`opencode-zen`, `anthropic`). A Claude
// group's entry is an optional `claude setup-token` token (Claude subscription logins are
// otherwise NOT vaulted: each server runs `claude auth login` itself). An opencode-go/openrouter
// group's entry is its API key.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord, Harness, ResourceGroup, ResourceGroupKind } from './types.js'
import { defaultGroup, groupIdForAgent, isDefaultGroup } from '../finance/groups.js'

const KEY_FILE = 'vault.key'
const STORE_FILE = 'vault.json'

export interface VaultEntrySpec {
  /** Vault entry name, used on the CLI (`office vault set <id>`). Group id, or a static id. */
  id: string
  label: string
  /** Environment variable the harness reads. */
  env: string
  /** Which harness gets it injected. */
  harness: Harness
  /** opencode provider ids whose `options.apiKey` should point at the env var. */
  opencodeProviders?: string[]
  /** opencode auth.json entry this key can be imported from. */
  authJsonId?: string
  /** Resource group this entry belongs to, undefined for the static entries. */
  groupId?: string
}

/** Entries with no resource group behind them. */
export const STATIC_ENTRIES: VaultEntrySpec[] = [
  { id: 'opencode-zen', label: 'OpenCode Zen', env: 'OPENCODE_API_KEY', harness: 'opencode', opencodeProviders: ['opencode'], authJsonId: 'opencode' },
  // Only for opencode: injected into Claude it would override the subscription login.
  { id: 'anthropic', label: 'Anthropic API (opencode only)', env: 'ANTHROPIC_API_KEY', harness: 'opencode', opencodeProviders: ['anthropic'], authJsonId: 'anthropic' },
]

function groupSpec(g: ResourceGroup, groups: ResourceGroup[]): VaultEntrySpec {
  if (g.kind === 'claude-subscription') {
    return { id: g.id, label: g.label, env: 'CLAUDE_CODE_OAUTH_TOKEN', harness: 'claude', groupId: g.id }
  }
  if (g.kind === 'opencode-go') {
    return {
      id: g.id, label: g.label, env: 'OPENCODE_GO_API_KEY', harness: 'opencode', opencodeProviders: ['opencode-go'], groupId: g.id,
      ...(isDefaultGroup(g, groups) ? { authJsonId: 'opencode-go' } : {}),
    }
  }
  // openrouter
  return {
    id: g.id, label: g.label, env: 'OPENROUTER_API_KEY', harness: 'opencode', opencodeProviders: ['openrouter'], groupId: g.id,
    ...(isDefaultGroup(g, groups) ? { authJsonId: 'openrouter' } : {}),
  }
}

/** One spec per group (config order), then the static entries. */
export function vaultSpecs(groups: ResourceGroup[]): VaultEntrySpec[] {
  return [...groups.map(g => groupSpec(g, groups)), ...STATIC_ENTRIES]
}

/** Look up one spec by vault entry id. */
export function vaultSpec(id: string, groups: ResourceGroup[]): VaultEntrySpec | undefined {
  return vaultSpecs(groups).find(s => s.id === id)
}

interface StoredEntry {
  iv: string
  tag: string
  data: string
  setAt: string
  validatedAt?: string
  /** Last check result: true = the provider accepted it, false = rejected. */
  valid?: boolean
}

type Store = Record<string, StoredEntry>

export interface VaultEntryInfo {
  id: string
  label: string
  set: boolean
  setAt?: string
  validatedAt?: string
  valid?: boolean
}

const stateDirOf = (root: string) => path.join(root, 'state')

function writeFile600(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

/** Load the vault key, creating it (32 random bytes, chmod 600) on first use. */
export function ensureVaultKey(root: string): Buffer {
  const file = path.join(stateDirOf(root), KEY_FILE)
  try {
    const key = fs.readFileSync(file)
    if (key.length !== 32) throw new Error(`${file} is corrupt (expected 32 bytes)`)
    return key
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const key = randomBytes(32)
  writeFile600(file, key)
  return key
}

function readStore(root: string): Store {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDirOf(root), STORE_FILE), 'utf8')) as Store
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

function writeStore(root: string, store: Store): void {
  writeFile600(path.join(stateDirOf(root), STORE_FILE), JSON.stringify(store, null, 2) + '\n')
}

/** Encrypt one value, AAD-bound to its entry id. */
function encrypt(root: string, id: string, value: string): StoredEntry {
  const key = ensureVaultKey(root)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(id))
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), setAt: new Date().toISOString() }
}

/** Decrypt one stored entry, checked against its entry id. */
function decrypt(root: string, id: string, e: StoredEntry): string {
  const decipher = createDecipheriv('aes-256-gcm', ensureVaultKey(root), Buffer.from(e.iv, 'base64'))
  decipher.setAAD(Buffer.from(id))
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]).toString('utf8')
}

function requireSpec(id: string, groups: ResourceGroup[]): VaultEntrySpec {
  const s = vaultSpec(id, groups)
  if (!s) throw new Error(`unknown vault entry "${id}" (known: ${vaultSpecs(groups).map(x => x.id).join(', ')})`)
  return s
}

export function setSecret(root: string, id: string, value: string, groups: ResourceGroup[]): void {
  requireSpec(id, groups)
  const v = value.trim()
  if (!v) throw new Error('empty value')
  if (/[\r\n]/.test(v)) throw new Error('value must be a single line')
  const store = readStore(root)
  store[id] = encrypt(root, id, v)
  writeStore(root, store)
}

export function getSecret(root: string, id: string): string | undefined {
  const e = readStore(root)[id]
  if (!e) return undefined
  return decrypt(root, id, e)
}

export function removeSecret(root: string, id: string): boolean {
  const store = readStore(root)
  if (!store[id]) return false
  delete store[id]
  writeStore(root, store)
  return true
}

export function markValidated(root: string, id: string, valid: boolean): void {
  const store = readStore(root)
  if (!store[id]) return
  store[id].validatedAt = new Date().toISOString()
  store[id].valid = valid
  writeStore(root, store)
}

/** Metadata only — never the values. Safe to print or post. */
export function listSecrets(root: string, groups: ResourceGroup[]): VaultEntryInfo[] {
  const store = readStore(root)
  return vaultSpecs(groups).map(s => {
    const e = store[s.id]
    return { id: s.id, label: s.label, set: !!e, setAt: e?.setAt, validatedAt: e?.validatedAt, valid: e?.valid }
  })
}

/**
 * Env vars for one agent's harness process: the static entries for its harness, plus its own
 * resource group's entry (only when that group's spec matches the agent's harness — a Claude
 * agent never gets handed an API key, which would override the subscription login).
 */
export function vaultEnvForAgent(root: string, groups: ResourceGroup[], rec: Pick<AgentRecord, 'harness' | 'model' | 'group'>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const s of STATIC_ENTRIES) {
    if (s.harness !== rec.harness) continue
    const v = getSecret(root, s.id)
    if (v) env[s.env] = v
  }
  const groupId = groupIdForAgent(rec, groups)
  if (groupId) {
    const spec = vaultSpec(groupId, groups)
    if (spec && spec.harness === rec.harness) {
      const v = getSecret(root, groupId)
      if (v) env[spec.env] = v
    }
  }
  return env
}

const GROUP_KINDS: ResourceGroupKind[] = ['claude-subscription', 'opencode-go', 'openrouter']

/**
 * Env vars for a process with no single agent behind it (the admin helper, the merge
 * summarizer): the static entries plus the DEFAULT group of each kind, for the given harness.
 */
export function vaultEnvDefaults(root: string, groups: ResourceGroup[], harness: Harness): Record<string, string> {
  const env: Record<string, string> = {}
  for (const s of STATIC_ENTRIES) {
    if (s.harness !== harness) continue
    const v = getSecret(root, s.id)
    if (v) env[s.env] = v
  }
  for (const kind of GROUP_KINDS) {
    const g = defaultGroup(kind, groups)
    if (!g) continue
    const spec = vaultSpec(g.id, groups)
    if (!spec || spec.harness !== harness) continue
    const v = getSecret(root, g.id)
    if (v) env[spec.env] = v
  }
  return env
}

/** opencode `provider` config block pointing every env var present in `env` at its provider(s). */
export function opencodeProviderOverrides(groups: ResourceGroup[], env: Record<string, string>): Record<string, { options: { apiKey: string } }> {
  const out: Record<string, { options: { apiKey: string } }> = {}
  for (const s of vaultSpecs(groups)) {
    if (s.harness !== 'opencode' || !(s.env in env)) continue
    for (const prov of s.opencodeProviders ?? []) out[prov] = { options: { apiKey: `{env:${s.env}}` } }
  }
  return out
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Render KEY='value' lines for `set -a; . file`. */
export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`).join('\n') + (Object.keys(env).length ? '\n' : '')
}

/** Write the per-agent env file (chmod 600) and return its path. Always written, possibly empty. */
export function writeAgentEnvFile(agentDir: string, env: Record<string, string>): string {
  const file = path.join(agentDir, 'provider.env')
  writeFile600(file, renderEnvFile(env))
  return file
}

/** Prefix a shell command so it runs with the env file's variables exported. */
export function withEnvFile(command: string, envFile: string): string {
  return `set -a && . ${shQuote(envFile)} && set +a && ${command}`
}

/** API-type entries of an opencode auth.json that map to vault ids (default groups + static). */
export function importableFromAuthJson(authJson: string, groups: ResourceGroup[]): { id: string; value: string }[] {
  let parsed: Record<string, { type?: string; key?: string }>
  try { parsed = JSON.parse(authJson) } catch { return [] }
  const out: { id: string; value: string }[] = []
  for (const s of vaultSpecs(groups)) {
    const e = s.authJsonId ? parsed[s.authJsonId] : undefined
    if (e?.type === 'api' && typeof e.key === 'string' && e.key) out.push({ id: s.id, value: e.key })
  }
  return out
}

/**
 * Move the milestone-1 `claude-oauth` entry to the default Claude group's entry, once. Leaves
 * the legacy entry alone (returns false) when there's nothing to migrate, there's no Claude
 * group, or the default group already has its own entry. Idempotent.
 */
export function migrateLegacyVault(root: string, groups: ResourceGroup[]): boolean {
  const store = readStore(root)
  const legacy = store['claude-oauth']
  if (!legacy) return false
  const def = defaultGroup('claude-subscription', groups)
  if (!def || store[def.id]) return false
  const value = decrypt(root, 'claude-oauth', legacy)
  store[def.id] = encrypt(root, def.id, value)
  delete store['claude-oauth']
  writeStore(root, store)
  return true
}

/**
 * Ask the provider whether the key works. Returns undefined when the entry has no cheap check
 * (it is then shown as "stored, unchecked").
 */
export async function validateSecret(spec: VaultEntrySpec, value: string): Promise<boolean | undefined> {
  const check: Record<string, string> = {
    OPENROUTER_API_KEY: 'https://openrouter.ai/api/v1/key',
    OPENCODE_GO_API_KEY: 'https://opencode.ai/zen/go/v1/usage',
  }
  const url = check[spec.env]
  if (!url) return undefined
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(10_000) })
    if (res.status === 401 || res.status === 403) return false
    return res.ok ? true : undefined
  } catch {
    return undefined
  }
}

/** Markdown/plain status table. Values are never included. */
export function renderVaultStatus(entries: VaultEntryInfo[]): string {
  const lines = entries.map(e => {
    if (!e.set) return `- ${e.id} (${e.label}): not set`
    const check = e.valid === true ? `validated ${e.validatedAt!.slice(0, 10)}`
      : e.valid === false ? `REJECTED by provider ${e.validatedAt!.slice(0, 10)}`
        : 'unchecked'
    return `- ${e.id} (${e.label}): set ${e.setAt!.slice(0, 10)}, ${check}`
  })
  return lines.join('\n')
}
