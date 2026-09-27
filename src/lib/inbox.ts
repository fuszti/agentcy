// Signed inbox: system prompts from the office CLI are HMAC-signed so the
// per-agent MCP can verify provenance before delivering them as trusted
// instructions. Agents cannot forge the signature because the key lives
// outside their workspace/state trees (state/inbox.key, chmod 600).

import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { agentStateDir } from './config.js'

const SIG_PREFIX = '<!-- office-sig:'
const SIG_SUFFIX = ' -->'
const KEY_FILE = 'inbox.key'
const KEY_BYTES = 32

/** Ensure the shared inbox signing key exists under state/ (created once, chmod 600). */
export async function ensureInboxKey(root: string): Promise<Buffer> {
  const dir = path.join(root, 'state')
  const file = path.join(dir, KEY_FILE)
  try {
    return await readFile(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
  await mkdir(dir, { recursive: true })
  const key = randomBytes(KEY_BYTES)
  await writeFile(`${file}.tmp`, key)
  await chmod(`${file}.tmp`, 0o600)
  await renameAtomic(`${file}.tmp`, file)
  return key
}

async function renameAtomic(tmp: string, file: string): Promise<void> {
  const { rename } = await import('node:fs/promises')
  await rename(tmp, file)
}

/** Sign prompt text, returning a single-line signature header followed by the text. */
export function signPrompt(text: string, key: Buffer): string {
  const sig = createHmac('sha256', key).update(text, 'utf8').digest('hex')
  return `${SIG_PREFIX}${sig}${SIG_SUFFIX}\n${text}`
}

/**
 * Verify a signed inbox file. Returns the prompt text with the signature line
 * stripped if the signature is valid, otherwise undefined.
 */
export function verifyPrompt(fileText: string, key: Buffer): string | undefined {
  if (!fileText.startsWith(SIG_PREFIX)) return undefined
  const end = fileText.indexOf(SIG_SUFFIX)
  if (end < 0) return undefined
  const sig = fileText.slice(SIG_PREFIX.length, end)
  const rest = fileText.slice(end + SIG_SUFFIX.length)
  const text = rest.startsWith('\n') ? rest.slice(1) : rest
  const expected = createHmac('sha256', key).update(text, 'utf8').digest('hex')
  if (!timingSafeEqual(sig, expected)) return undefined
  return text
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Queue a signed verbatim prompt for an agent; its office-mcp verifies and delivers it at the next idle moment. */
export async function queueSystemPrompt(root: string, agent: string, label: string, text: string): Promise<string> {
  const dir = path.join(agentStateDir(agent), 'inbox')
  fs.mkdirSync(dir, { recursive: true })
  const key = await ensureInboxKey(root)
  const signed = signPrompt(text, key)
  const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.md`)
  fs.writeFileSync(f, signed)
  return f
}
