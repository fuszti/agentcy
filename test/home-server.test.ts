import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyAccessMode, composeFileArgs, parseEnv, publicUrlsFor, renderLanOverride, updateEnv } from '../src/lib/infra.js'
import { readAgentRecords, readManifest, resetSessionsAfterMove } from '../src/lib/migrate.js'
import { parseTailscaleStatus, privateAddresses } from '../src/cli/setup.js'
import type { AgentRecord } from '../src/lib/types.js'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-server-test-')); fs.mkdirSync(path.join(root, 'infra')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('infra env', () => {
  it('updates keys in place, appends new ones, keeps comments and drops undefined-less keys untouched', () => {
    const raw = '# c\nBIND_ADDR=127.0.0.1\nPOSTGRES_PASSWORD=x\n'
    const out = updateEnv(raw, { MM_SITE_URL: 'http://nas:8065', BIND_ADDR: '127.0.0.1', GONE: undefined })
    expect(out).toBe('# c\nBIND_ADDR=127.0.0.1\nPOSTGRES_PASSWORD=x\nMM_SITE_URL=http://nas:8065\n')
    expect(parseEnv(updateEnv(out, { POSTGRES_PASSWORD: undefined }))).toEqual({ BIND_ADDR: '127.0.0.1', MM_SITE_URL: 'http://nas:8065' })
  })
})

describe('access modes', () => {
  it('computes public URLs', () => {
    expect(publicUrlsFor({ kind: 'local' }).mattermost).toBe('http://127.0.0.1:8065')
    expect(publicUrlsFor({ kind: 'lan', addr: '192.168.1.5' })).toEqual({ mattermost: 'http://192.168.1.5:8065', forgejo: 'http://192.168.1.5:3033' })
    expect(publicUrlsFor({ kind: 'lan', addr: '192.168.1.5', host: 'nas.lan' }).forgejo).toBe('http://nas.lan:3033')
    expect(publicUrlsFor({ kind: 'tailscale', dnsName: 'nas.tail1.ts.net.' })).toEqual({ mattermost: 'https://nas.tail1.ts.net', forgejo: 'https://nas.tail1.ts.net:8443' })
  })

  it('refuses to publish on all interfaces or on a non-IP', () => {
    expect(() => renderLanOverride('0.0.0.0')).toThrow(/all interfaces/)
    expect(() => renderLanOverride('nas; rm -rf /')).toThrow(/not an IP/)
    expect(renderLanOverride('192.168.1.5')).toContain('"192.168.1.5:3033:3000"')
  })

  it('LAN mode writes the override (picked up by compose) and env; other modes remove it', () => {
    fs.writeFileSync(path.join(root, 'infra', '.env'), 'POSTGRES_PASSWORD=p\n')
    applyAccessMode(root, { kind: 'lan', addr: '10.0.0.7' })
    expect(composeFileArgs(root)).toHaveLength(6)
    const env = parseEnv(fs.readFileSync(path.join(root, 'infra', '.env'), 'utf8'))
    expect(env).toEqual({ POSTGRES_PASSWORD: 'p', MM_SITE_URL: 'http://10.0.0.7:8065', FORGEJO_ROOT_URL: 'http://10.0.0.7:3033/' })
    expect(fs.statSync(path.join(root, 'infra', '.env')).mode & 0o777).toBe(0o600)
    applyAccessMode(root, { kind: 'tailscale', dnsName: 'nas.ts.net' })
    expect(composeFileArgs(root)).toHaveLength(4)
  })
})

describe('setup detection', () => {
  it('keeps private IPv4 on real interfaces only', () => {
    const mk = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo
    expect(privateAddresses({
      lo: [mk('127.0.0.1', 'IPv4', true)],
      eth0: [mk('192.168.1.5'), mk('fe80::1', 'IPv6')],
      wlan0: [mk('8.8.8.8')],
      docker0: [mk('172.17.0.1')],
      'br-abc': [mk('172.18.0.1')],
      tailscale0: [mk('100.101.1.2')],
    })).toEqual([{ iface: 'eth0', addr: '192.168.1.5' }, { iface: 'tailscale0', addr: '100.101.1.2' }])
  })

  it('parses tailscale status only when running', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'nas.tail.ts.net.', TailscaleIPs: ['fd7a::1', '100.64.0.1'] } })))
      .toEqual({ dnsName: 'nas.tail.ts.net', ip: '100.64.0.1' })
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: 'x.' } }))).toBeUndefined()
    expect(parseTailscaleStatus('garbage')).toBeUndefined()
  })
})

describe('migration', () => {
  const rec = (name: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
    name, displayName: name, harness: 'claude', model: 'sonnet', status: 'hired', pastSessions: [], chrome: false,
    mattermost: { userId: 'u', token: 't' }, forgejo: { token: 'f' }, createdAt: '2026-01-01T00:00:00Z', ...extra,
  })

  it('moves live session ids to pastSessions and lists hired agents for the moved prompt', () => {
    const recs = [rec('ada', { sessionId: 's1', pastSessions: ['s0'] }), rec('kim'), rec('old', { status: 'retired', sessionId: 's9' })]
    expect(resetSessionsAfterMove(recs)).toEqual(['ada', 'kim'])
    expect(recs[0]).toMatchObject({ sessionId: undefined, pastSessions: ['s0', 's1'] })
    expect(recs[2].pastSessions).toEqual(['s9'])
  })

  it('reads agent records, skipping non-agent dirs', () => {
    fs.mkdirSync(path.join(root, 'state', 'agents', 'ada'), { recursive: true })
    fs.mkdirSync(path.join(root, 'state', 'agents', 'junk'), { recursive: true })
    fs.writeFileSync(path.join(root, 'state', 'agents', 'ada', 'agent.json'), JSON.stringify(rec('ada')))
    expect(readAgentRecords(root).map(r => r.name)).toEqual(['ada'])
  })

  it('validates export bundles', () => {
    expect(() => readManifest(root)).toThrow(/not an office export/)
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, createdAt: '', sourceRoot: '/x', agents: [] }))
    expect(() => readManifest(root)).toThrow(/infra-data.tar.gz missing/)
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 99 }))
    expect(() => readManifest(root)).toThrow(/unsupported/)
  })
})
