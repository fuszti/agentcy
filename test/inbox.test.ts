import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureInboxKey, signPrompt, verifyPrompt } from '../src/lib/inbox.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'))
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => fs.mkdirSync(tmp, { recursive: true }))

describe('inbox signature', () => {
  it('ensureInboxKey creates a 32-byte key with chmod 600', async () => {
    const key = await ensureInboxKey(tmp)
    expect(key).toHaveLength(32)
    const file = path.join(tmp, 'state', 'inbox.key')
    expect(fs.existsSync(file)).toBe(true)
    const stat = fs.statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
    const again = await ensureInboxKey(tmp)
    expect(again).toEqual(key)
  })

  it('signPrompt prepends a signature line and verifyPrompt strips it', () => {
    const key = Buffer.alloc(32, 0xab)
    const text = '<office-system>hello</office-system>'
    const signed = signPrompt(text, key)
    expect(signed.startsWith('<!-- office-sig:')).toBe(true)
    expect(signed).toContain('\n' + text)
    expect(verifyPrompt(signed, key)).toBe(text)
  })

  it('verifyPrompt rejects tampered text', () => {
    const key = Buffer.alloc(32, 0xab)
    const signed = signPrompt('original', key).replace('original', 'tampered')
    expect(verifyPrompt(signed, key)).toBeUndefined()
  })

  it('verifyPrompt rejects missing or wrong signature', () => {
    const key = Buffer.alloc(32, 0xab)
    expect(verifyPrompt('no sig', key)).toBeUndefined()
    const signed = signPrompt('x', key)
    const other = Buffer.alloc(32, 0xcd)
    expect(verifyPrompt(signed, other)).toBeUndefined()
  })
})
