import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRequest, canonicalizeRequest, listRequests, loadRequest, setRequestStatus, signRequest, verifyRequest, writeRequest } from '../src/lib/requests.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-test-'))
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => fs.mkdirSync(tmp, { recursive: true }))

const key = Buffer.alloc(32, 0xab)

function sampleRequest(over: Partial<ReturnType<typeof buildRequest>> = {}) {
  const req = buildRequest('fork', 'ada', { task: 'test task' })
  return { ...req, ...over }
}

describe('canonicalizeRequest', () => {
  it('produces stable JSON with sorted keys', () => {
    const req = buildRequest('fork', 'ada', { task: 'x', extra: 1 })
    const canonical = canonicalizeRequest(req)
    expect(canonical).toContain('"agent":"ada"')
    expect(canonical).toContain('"args":{"extra":1,"task":"x"}')
    expect(canonical).toContain('"status":"pending"')
    expect(canonical).toContain('"type":"fork"')
  })
})

describe('signRequest / verifyRequest', () => {
  it('round-trips a signed request', () => {
    const req = sampleRequest()
    const signed = signRequest(req, key)
    expect(signed.startsWith('<!-- office-req-sig:')).toBe(true)
    const verified = verifyRequest(signed, key)
    expect(verified).toEqual(req)
  })

  it('rejects tampered request body', () => {
    const req = sampleRequest()
    let signed = signRequest(req, key)
    signed = signed.replace('test task', 'tampered task')
    expect(verifyRequest(signed, key)).toBeUndefined()
  })

  it('rejects missing or wrong signature', () => {
    expect(verifyRequest('no sig', key)).toBeUndefined()
    const signed = signRequest(sampleRequest(), key)
    const other = Buffer.alloc(32, 0xcd)
    expect(verifyRequest(signed, other)).toBeUndefined()
  })
})

describe('writeRequest / loadRequest / listRequests', () => {
  it('writes, loads and lists signed requests', async () => {
    const req = sampleRequest()
    await writeRequest(tmp, req)
    const loaded = await loadRequest(tmp, req.id)
    expect(loaded).toEqual(req)
    const all = await listRequests(tmp)
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(req)
  })

  it('skips invalid request files when listing', async () => {
    fs.mkdirSync(path.join(tmp, 'state', 'requests'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'requests', 'bad.json'), 'not signed')
    const req = sampleRequest()
    await writeRequest(tmp, req)
    const all = await listRequests(tmp)
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(req)
  })

  it('updates status and result', async () => {
    const req = sampleRequest()
    await writeRequest(tmp, req)
    const updated = await setRequestStatus(tmp, req.id, 'approved')
    expect(updated?.status).toBe('approved')
    const loaded = await loadRequest(tmp, req.id)
    expect(loaded?.status).toBe('approved')
  })
})
