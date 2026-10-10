// Regression tests for the findings of the first PR review (home server / vault / groups).
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { vaultSetLeak } from '../src/admin/commands.js'
import { runHelper } from '../src/admin/helper.js'
import { createFinanceAlertState, detectLimitAlerts } from '../src/finance/alerts.js'
import type { LimitRow } from '../src/finance/render.js'
import { isValidHostname, publicUrlsFor } from '../src/lib/infra.js'
import { ensureVaultKey } from '../src/lib/vault.js'
import { promptHidden } from '../src/cli/vault-cmd.js'

const run = promisify(execFile)
const repo = path.resolve(import.meta.dirname, '..')

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fixes-')) })
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('vaultSetLeak', () => {
  it('spots a value after `vault set <id>` in every accepted spelling', () => {
    expect(vaultSetLeak('vault set openrouter sk-or-123')).toBe('openrouter')
    expect(vaultSetLeak('  !vault set go-2 abc')).toBe('go-2')
    expect(vaultSetLeak('office vault   set claude-b "tok en"')).toBe('claude-b')
    expect(vaultSetLeak('VAULT SET openrouter\nsk-or-123')).toBe('openrouter')
  })

  it('ignores commands that carry no value', () => {
    for (const ok of ['vault', 'vault set openrouter', 'vault set', 'vault check openrouter', 'vault rm openrouter', 'how do I vault set a key?', 'status']) {
      expect(vaultSetLeak(ok), ok).toBeUndefined()
    }
  })
})

describe('detectLimitAlerts legacy keys', () => {
  const row = (over: Partial<LimitRow> = {}): LimitRow => ({
    group: 'Claude subscription', groupId: 'claude-sub', window: 'week (all models)', usedText: '-', limitText: '-',
    percent: 85, remainingText: '15%', resets: 'Mon', ...over,
  })

  it('adopts a pre-groupId bucket instead of alerting again, and drops the old key', () => {
    const state = createFinanceAlertState()
    state.thresholdBucket.set('limit:Claude subscription:week (all models)', 80)
    expect(detectLimitAlerts([row()], [80, 95], state)).toEqual([])
    expect(state.thresholdBucket.get('limit:claude-sub:week (all models)')).toBe(80)
    expect(state.thresholdBucket.has('limit:Claude subscription:week (all models)')).toBe(false)
  })

  it('still alerts when the adopted bucket is lower than the current one', () => {
    const state = createFinanceAlertState()
    state.thresholdBucket.set('limit:Claude subscription:week (all models)', 80)
    expect(detectLimitAlerts([row({ percent: 96 })], [80, 95], state)).toHaveLength(1)
  })

  it('gives the legacy bucket to one group only when two share a label', () => {
    const state = createFinanceAlertState()
    state.thresholdBucket.set('limit:Claude subscription:week (all models)', 80)
    const alerts = detectLimitAlerts([row(), row({ groupId: 'claude-b' })], [80, 95], state)
    expect(alerts.map(a => a.key)).toEqual(['limit:claude-b:week (all models):80'])
  })

  it('removes a stale legacy key when the row is back under every threshold', () => {
    const state = createFinanceAlertState()
    state.thresholdBucket.set('limit:Claude subscription:week (all models)', 80)
    detectLimitAlerts([row({ percent: 10 })], [80, 95], state)
    expect([...state.thresholdBucket.keys()]).toEqual([])
  })
})

describe('LAN hostname', () => {
  it('accepts DNS-style names and rejects anything that would break the URL', () => {
    for (const ok of ['nas', 'nas.lan', 'my-server.home.arpa', 'NAS01']) expect(isValidHostname(ok), ok).toBe(true)
    for (const bad of ['', 'nas lan', 'nas/x', 'nas#x', 'http://nas', 'nas:8065', '-nas', 'nas.', 'a'.repeat(254)]) expect(isValidHostname(bad), bad).toBe(false)
  })

  it('publicUrlsFor refuses a bad host', () => {
    expect(() => publicUrlsFor({ kind: 'lan', addr: '192.168.1.5', host: 'nas lan' })).toThrow(/hostname/)
    expect(publicUrlsFor({ kind: 'lan', addr: '192.168.1.5', host: 'nas.lan' }).mattermost).toBe('http://nas.lan:8065')
  })
})

describe('ensureVaultKey under concurrent first use', () => {
  it('every process ends up with the same key and no temp files are left', async () => {
    const script = `import { ensureVaultKey } from ${JSON.stringify(path.join(repo, 'src/lib/vault.ts'))}; process.stdout.write(ensureVaultKey(${JSON.stringify(tmp)}).toString('hex'))`
    const file = path.join(tmp, 'race.mts')
    fs.writeFileSync(file, script)
    const outs = await Promise.all(Array.from({ length: 8 }, () => run(path.join(repo, 'node_modules/.bin/tsx'), [file])))
    const keys = new Set(outs.map(o => o.stdout))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toHaveLength(64)
    expect(ensureVaultKey(tmp).toString('hex')).toBe([...keys][0])
    expect(fs.readdirSync(path.join(tmp, 'state'))).toEqual(['vault.key'])
    expect(fs.statSync(path.join(tmp, 'state', 'vault.key')).mode & 0o777).toBe(0o600)
  }, 30_000)
})

describe('runHelper config', () => {
  it('is on disk (chmod 600) before opencode starts, even on the very first run', () => {
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\ncat "$OPENCODE_CONFIG"\n', { mode: 0o755 })
    const prevPath = process.env.PATH
    process.env.PATH = `${bin}:${prevPath}`
    try {
      const r = runHelper({ root: tmp, helperModel: 'x/y', prompt: 'hi' })
      expect(r.exitCode).toBe(0)
      expect(JSON.parse(r.output).permission.edit).toBe('deny')
      expect(fs.statSync(path.join(tmp, 'state', 'helper', 'opencode.json')).mode & 0o777).toBe(0o600)
    } finally { process.env.PATH = prevPath }
  })
})

describe('promptHidden', () => {
  it('resolves with the typed line and does not echo it', async () => {
    const input = new PassThrough()
    const shown: string[] = []
    const p = promptHidden('Key: ', input, s => shown.push(s))
    input.write('s3cret\n')
    expect(await p).toBe('s3cret')
    expect(shown.join('')).not.toContain('s3cret')
  })

  it('rejects instead of hanging when input ends', async () => {
    const input = new PassThrough()
    const p = promptHidden('Key: ', input, () => {})
    input.end()
    await expect(p).rejects.toThrow(/cancel/i)
  })

  it('rejects on Ctrl+C', async () => {
    const input = new PassThrough()
    const p = promptHidden('Key: ', input, () => {})
    input.write('\x03')
    await expect(p).rejects.toThrow(/cancel/i)
  })
})
