import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertInitialised, assertInstanceConfig, assertNotDevInstance, assertStackOwnership, composeFileArgs, containerPrefix,
  devConfig, devEnv, devProject, findForeignContainer, instanceName, instanceNameFor, instanceSlug, parseEnv, pickPortBase, startPortBase,
} from '../src/lib/infra.js'
import { exportOffice, importOffice } from '../src/lib/migrate.js'
import { runSetup } from '../src/cli/setup.js'
import { cmdDev, devDown, devInfo, devInit, devReset, requireDevInstance, type DevDeps } from '../src/cli/dev-cmd.js'
import { claudeSettings } from '../src/lib/harness/claude.js'
import type { OfficeConfig } from '../src/lib/types.js'

const example = JSON.parse(fs.readFileSync(path.resolve('office.config.example.json'), 'utf8')) as OfficeConfig

let tmp: string
let root: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-instance-test-'))
  root = path.join(tmp, 'My_Checkout')
  fs.mkdirSync(path.join(root, 'infra'), { recursive: true })
  fs.copyFileSync(path.resolve('office.config.example.json'), path.join(root, 'office.config.example.json'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const writeEnv = (text: string, r = root) => fs.writeFileSync(path.join(r, 'infra', '.env'), text)
const markInitialised = () => { fs.mkdirSync(path.join(root, 'state'), { recursive: true }); fs.writeFileSync(path.join(root, 'state', 'office.json'), '{}') }
const devEnvText = (name: string, base = 20100) => Object.entries(devEnv(name, base, 'pw')).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'

describe('names and ports', () => {
  it('slugs to [a-z0-9-], at most 24 chars, never empty', () => {
    expect(instanceSlug('My_Checkout.v2')).toBe('my-checkout-v2')
    expect(instanceSlug('--A  B--')).toBe('a-b')
    expect(instanceSlug('x'.repeat(40))).toHaveLength(24)
    expect(instanceSlug('a'.repeat(23) + '-bbb')).toBe('a'.repeat(23))
    expect(instanceSlug('!!!')).toBe('office')
  })

  it('name is <slug>-<sha1(realpath) 6 hex>, same through a symlink, different per checkout', () => {
    const name = instanceNameFor(root)
    expect(name).toMatch(/^my-checkout-[0-9a-f]{6}$/)
    const link = path.join(tmp, 'link')
    fs.symlinkSync(root, link)
    expect(instanceNameFor(link, 'my-checkout')).toBe(name)
    const other = path.join(tmp, 'other')
    fs.mkdirSync(other)
    expect(instanceNameFor(other, 'my-checkout')).not.toBe(name)
    expect(instanceNameFor(root, 'CI').startsWith('ci-')).toBe(true)
  })

  it('start port base is a multiple-of-100 block in 20000-29900', () => {
    for (const n of ['a-111111', 'b-222222', 'ci-abcdef']) {
      const b = startPortBase(n)
      expect(b % 100).toBe(0)
      expect(b).toBeGreaterThanOrEqual(20000)
      expect(b).toBeLessThanOrEqual(29900)
    }
  })

  it('picks the start block when free, steps by 100 when any of the 3 ports is taken, wraps, and gives up', async () => {
    const start = startPortBase('x-000000')
    expect(await pickPortBase('x-000000', async () => true)).toBe(start)
    const taken = new Set([start + 2])
    expect(await pickPortBase('x-000000', async p => !taken.has(p))).toBe(start === 29900 ? 20000 : start + 100)
    const probed: number[] = []
    await pickPortBase('x-000000', async p => { probed.push(p); return p !== start + 1 && p !== start + 2 && p !== start })
    expect(probed.slice(0, 2)).toEqual([start, start + 100])
    // wraps past 29999 back to 20000
    const high = 'h-0'
    const base = startPortBase(high)
    const seen: number[] = []
    await expect(pickPortBase(high, async p => { seen.push(p); return false })).rejects.toThrow(/no free port block/)
    expect(new Set(seen.filter(p => p % 100 === 0)).size).toBe(100)
    expect(seen[0]).toBe(base)
  })
})

describe('generated env and config', () => {
  it('env has every contract key', () => {
    expect(devEnv('foo-abc123', 20100, 'pw')).toEqual({
      BIND_ADDR: '127.0.0.1', POSTGRES_PASSWORD: 'pw', OFFICE_INSTANCE: 'foo-abc123',
      COMPOSE_PROJECT_NAME: 'agentcy-foo-abc123', OFFICE_CONTAINER_PREFIX: 'agentcy-foo-abc123',
      MM_PORT: '20100', FORGEJO_PORT: '20101', FORGEJO_SSH_PORT: '20102',
      MM_SITE_URL: 'http://127.0.0.1:20100', FORGEJO_ROOT_URL: 'http://127.0.0.1:20101/',
    })
  })

  it('config is the example with own urls, tmux session, opencode port base and the cheap model', () => {
    const c = devConfig(example, 'foo-abc123', 20100)
    expect(c.mattermostUrl).toBe('http://127.0.0.1:20100')
    expect(c.forgejoUrl).toBe('http://127.0.0.1:20101')
    expect(c.tmuxSession).toBe('office-foo-abc123')
    expect(c.opencodeBasePort).toBe(20110)
    expect(c.defaults.opencodeModel).toBe(example.defaults.helperModel)
    expect(c.defaults.claudeModel).toBe(example.defaults.claudeModel)
    expect(c.selfManagement.maxAgents).toBe(example.selfManagement.maxAgents)
    expect(example.tmuxSession).toBe('office') // the example itself is not modified
  })
})

describe('composeFileArgs and prefix', () => {
  it('normal office: no -p, no dev override', () => {
    writeEnv('POSTGRES_PASSWORD=p\n')
    expect(instanceName(root)).toBeUndefined()
    expect(containerPrefix(root)).toBe('agent-office')
    expect(composeFileArgs(root)).toEqual(['-f', path.join(root, 'infra', 'docker-compose.yml')])
  })

  it('dev instance: explicit -p first, dev override after the main file and before the LAN one', () => {
    writeEnv('OFFICE_INSTANCE=foo-abc123\nCOMPOSE_PROJECT_NAME=infra\n') // a wrong/shell-like project line cannot win
    fs.writeFileSync(path.join(root, 'infra', 'docker-compose.lan.yml'), '')
    const i = path.join(root, 'infra')
    expect(composeFileArgs(root)).toEqual(['-p', 'agentcy-foo-abc123', '-f', path.join(i, 'docker-compose.yml'), '-f', path.join(i, 'docker-compose.dev.yml'), '-f', path.join(i, 'docker-compose.lan.yml')])
  })

  it('dev instance without COMPOSE_PROJECT_NAME still gets -p', () => {
    writeEnv('OFFICE_INSTANCE=foo-abc123\n')
    expect(composeFileArgs(root).slice(0, 2)).toEqual(['-p', 'agentcy-foo-abc123'])
  })

  it('compose files: defaults keep the live office, dev override has no ./data bind', () => {
    const main = fs.readFileSync(path.resolve('infra/docker-compose.yml'), 'utf8')
    for (const s of ['${OFFICE_CONTAINER_PREFIX:-agent-office}-postgres', '${OFFICE_CONTAINER_PREFIX:-agent-office}-mattermost', '${OFFICE_CONTAINER_PREFIX:-agent-office}-forgejo', ':${MM_PORT:-8065}:8065', ':${FORGEJO_PORT:-3033}:3000', ':${FORGEJO_SSH_PORT:-2222}:22', 'name: ${OFFICE_CONTAINER_PREFIX:-agent-office}']) expect(main).toContain(s)
    const dev = fs.readFileSync(path.resolve('infra/docker-compose.dev.yml'), 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    expect(dev).not.toContain('./data')
    expect(dev).toContain('forgejo-data:/data')
  })
})

describe('stack ownership', () => {
  const infra = () => fs.realpathSync(path.join(root, 'infra'))

  it('same dir, no container, or a path that vanished: fine', () => {
    expect(findForeignContainer(root, 'agent-office', () => infra())).toBeUndefined()
    expect(findForeignContainer(root, 'agent-office', () => undefined)).toBeUndefined()
    expect(findForeignContainer(root, 'agent-office', () => path.join(tmp, 'moved-away', 'infra'))).toBeUndefined()
  })

  it('symlinked label path resolves to the same dir', () => {
    const link = path.join(tmp, 'ln')
    fs.symlinkSync(path.join(root, 'infra'), link)
    expect(findForeignContainer(root, 'agent-office', () => link)).toBeUndefined()
  })

  it('other existing dir: names it, for the first offending container', () => {
    const other = path.join(tmp, 'live', 'infra')
    fs.mkdirSync(other, { recursive: true })
    const seen: string[] = []
    const r = findForeignContainer(root, 'agent-office', c => { seen.push(c); return c.endsWith('forgejo') ? other : infra() })
    expect(r).toEqual({ container: 'agent-office-forgejo', dir: other })
    expect(seen).toEqual(['agent-office-mattermost', 'agent-office-forgejo'])
  })

  it('assertStackOwnership uses the .env prefix and throws with the way out', () => {
    const other = path.join(tmp, 'live', 'infra')
    fs.mkdirSync(other, { recursive: true })
    const asked: string[] = []
    expect(() => assertStackOwnership(root, c => { asked.push(c); return other })).toThrow(/live\/infra.*office dev init/s)
    writeEnv('OFFICE_CONTAINER_PREFIX=agentcy-z\n')
    asked.length = 0
    expect(() => assertStackOwnership(root, c => { asked.push(c); return undefined })).not.toThrow()
    expect(asked).toEqual(['agentcy-z-mattermost', 'agentcy-z-forgejo', 'agentcy-z-postgres'])
  })
})

describe('assertInstanceConfig', () => {
  const cfgFor = (name: string, base = 20100) => devConfig(example, name, base)

  it('normal office: anything goes', () => {
    writeEnv('POSTGRES_PASSWORD=p\n')
    expect(() => assertInstanceConfig(root, example)).not.toThrow()
  })

  it('matching dev config passes', () => {
    writeEnv(devEnvText('foo-abc123'))
    expect(() => assertInstanceConfig(root, cfgFor('foo-abc123'))).not.toThrow()
  })

  it('a regenerated default config (tmux session office, ports 8065/3033) is refused', () => {
    writeEnv(devEnvText('foo-abc123'))
    expect(() => assertInstanceConfig(root, example)).toThrow(/tmuxSession.*office-foo-abc123.*8065.*3033.*office dev init/s)
  })

  it('each field is checked on its own', () => {
    writeEnv(devEnvText('foo-abc123'))
    expect(() => assertInstanceConfig(root, { ...cfgFor('foo-abc123'), tmuxSession: 'office' })).toThrow(/tmuxSession/)
    expect(() => assertInstanceConfig(root, { ...cfgFor('foo-abc123'), mattermostUrl: 'http://127.0.0.1:8065' })).toThrow(/mattermostUrl/)
    expect(() => assertInstanceConfig(root, { ...cfgFor('foo-abc123'), forgejoUrl: 'http://127.0.0.1:3033' })).toThrow(/forgejoUrl/)
  })
})

describe('guards for normal-office-only commands', () => {
  it('assertNotDevInstance / assertInitialised', () => {
    writeEnv('POSTGRES_PASSWORD=p\n')
    expect(() => assertNotDevInstance(root, 'export')).not.toThrow()
    writeEnv(devEnvText('foo-abc123'))
    expect(() => assertNotDevInstance(root, 'export')).toThrow(/not available on a dev instance/)
    expect(() => assertInitialised(root, 'shutdown')).toThrow(/not initialised/)
    markInitialised()
    expect(() => assertInitialised(root, 'shutdown')).not.toThrow()
  })

  it('export, import and setup refuse on a dev instance before touching Docker', async () => {
    writeEnv(devEnvText('foo-abc123'))
    expect(() => exportOffice(root, path.join(tmp, 'out'))).toThrow(/dev instance/)
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false)
    expect(() => importOffice(root, path.join(tmp, 'bundle'))).toThrow(/dev instance/)
    await expect(runSetup(root, {})).rejects.toThrow(/dev instance/)
  })
})

describe('claudeSettings', () => {
  it('keeps the repo-root CLAUDE.md away from hired agents', () => {
    const s = claudeSettings('/srv/office', '/srv/office/state/agents/a/status.json', '/srv/office/workspaces/a') as { claudeMdExcludes: string[] }
    expect(s.claudeMdExcludes).toEqual(['/srv/office/CLAUDE.md'])
  })
})

// ------------------------------------------------------------------ office dev

interface Harness { deps: DevDeps; calls: string[]; run: ReturnType<typeof vi.fn>; logs: string[] }
function harness(over: Partial<DevDeps> & { volumes?: string; freePorts?: (p: number) => boolean } = {}): Harness {
  const calls: string[] = []
  const logs: string[] = []
  const run = vi.fn((cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(' ')}`)
    return { status: 0, stdout: args[0] === 'volume' ? over.volumes ?? '' : '' }
  })
  const deps: DevDeps = {
    root,
    bootstrap: async () => { calls.push('bootstrap') },
    ensureBrain: () => { calls.push('ensureBrain') },
    shutdownOffice: async () => { calls.push('shutdown') },
    run,
    portFree: async p => over.freePorts?.(p) ?? true,
    assertOwnership: () => { calls.push('ownership') },
    randomPassword: () => 'rand-pw',
    log: l => logs.push(l),
    ...over,
  }
  return { deps, calls, run, logs }
}

describe('office dev init', () => {
  it('creates a named instance on a fresh clone: env, config from the example, then bootstrap + brain', async () => {
    const h = harness()
    await devInit({ name: 'CI' }, h.deps)
    const name = instanceNameFor(root, 'CI')
    const env = parseEnv(fs.readFileSync(path.join(root, 'infra', '.env'), 'utf8'))
    expect(env).toEqual(devEnv(name, startPortBase(name), 'rand-pw'))
    expect(fs.statSync(path.join(root, 'infra', '.env')).mode & 0o777).toBe(0o600)
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'office.config.json'), 'utf8')) as OfficeConfig
    expect(cfg).toEqual(JSON.parse(JSON.stringify(devConfig(example, name, startPortBase(name)))))
    expect(() => assertInstanceConfig(root, cfg)).not.toThrow()
    expect(h.calls.at(-2)).toBe('bootstrap')
    expect(h.calls.at(-1)).toBe('ensureBrain')
    expect(h.calls[0]).toMatch(/^docker volume ls -q --filter label=com\.docker\.compose\.project=agentcy-ci-[0-9a-f]{6}$/)
    expect(h.logs.join('\n')).toMatch(/instance:\s+ci-[0-9a-f]{6}[\s\S]*owner:\s+@owner/)
  })

  it('replaces an auto-created config while there is no state', async () => {
    fs.writeFileSync(path.join(root, 'office.config.json'), JSON.stringify(example))
    await devInit({}, harness().deps)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'office.config.json'), 'utf8')).tmuxSession).toMatch(/^office-my-checkout-/)
  })

  it('is idempotent: an existing instance keeps name, ports and password', async () => {
    writeEnv(devEnvText('foo-abc123', 20500))
    const h = harness()
    await devInit({ name: 'other', 'port-base': '21000' }, h.deps)
    const env = parseEnv(fs.readFileSync(path.join(root, 'infra', '.env'), 'utf8'))
    expect(env.OFFICE_INSTANCE).toBe('foo-abc123')
    expect(env.MM_PORT).toBe('20500')
    expect(env.POSTGRES_PASSWORD).toBe('pw')
    expect(h.calls.some(c => c.startsWith('docker volume'))).toBe(false)
    expect(h.logs[0]).toMatch(/ignored/)
  })

  it('with state, an existing instance only gets its instance fields repaired (config is not replaced)', async () => {
    writeEnv(devEnvText('foo-abc123', 20500))
    markInitialised()
    fs.writeFileSync(path.join(root, 'office.config.json'), JSON.stringify({ ...example, team: 'mine', opencodeBasePort: 4321 }))
    await devInit({}, harness().deps)
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'office.config.json'), 'utf8')) as OfficeConfig
    expect(cfg.team).toBe('mine')
    expect(cfg.opencodeBasePort).toBe(4321)
    expect(cfg.tmuxSession).toBe('office-foo-abc123')
    expect(cfg.mattermostUrl).toBe('http://127.0.0.1:20500')
  })

  it('repairs a hand-edited env that points at the default office', async () => {
    writeEnv(devEnvText('foo-abc123', 20500).replace('OFFICE_CONTAINER_PREFIX=agentcy-foo-abc123', 'OFFICE_CONTAINER_PREFIX=agent-office'))
    await devInit({}, harness().deps)
    expect(containerPrefix(root)).toBe('agentcy-foo-abc123')
  })

  it('refuses a checkout that holds a normal office, and changes nothing', async () => {
    markInitialised()
    writeEnv('POSTGRES_PASSWORD=p\n')
    const h = harness()
    await expect(devInit({}, h.deps)).rejects.toThrow(/normal office/)
    expect(fs.readFileSync(path.join(root, 'infra', '.env'), 'utf8')).toBe('POSTGRES_PASSWORD=p\n')
    expect(fs.existsSync(path.join(root, 'office.config.json'))).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('refuses when volumes of the project already exist', async () => {
    const h = harness({ volumes: 'v1\nv2\n' })
    await expect(devInit({}, h.deps)).rejects.toThrow(/docker volume rm v1 v2.*dev down --purge/s)
    expect(fs.existsSync(path.join(root, 'infra', '.env'))).toBe(false)
    expect(h.calls.includes('bootstrap')).toBe(false)
  })

  it('refuses when Docker cannot list volumes', async () => {
    const h = harness({ run: () => ({ status: 1, stdout: '' }) })
    await expect(devInit({}, h.deps)).rejects.toThrow(/Docker/)
  })

  it('refuses a LAN override file (fixed default ports)', async () => {
    fs.writeFileSync(path.join(root, 'infra', 'docker-compose.lan.yml'), '')
    await expect(devInit({}, harness().deps)).rejects.toThrow(/lan/)
  })

  it('--port-base: honoured, validated and probed', async () => {
    await devInit({ 'port-base': '23000' }, harness().deps)
    expect(readEnvPort()).toBe('23000')
    fs.rmSync(path.join(root, 'infra', '.env'))
    await expect(devInit({ 'port-base': '80' }, harness().deps)).rejects.toThrow(/--port-base/)
    await expect(devInit({ 'port-base': 'abc' }, harness().deps)).rejects.toThrow(/--port-base/)
    await expect(devInit({ 'port-base': '23000' }, harness({ freePorts: p => p !== 23002 }).deps)).rejects.toThrow(/port 23002 is in use/)
  })

  it('without --port-base, probes and steps past busy blocks', async () => {
    const start = startPortBase(instanceNameFor(root))
    await devInit({}, harness({ freePorts: p => p !== start + 1 }).deps)
    expect(Number(readEnvPort())).toBe(start === 29900 ? 20000 : start + 100)
  })
})
const readEnvPort = () => parseEnv(fs.readFileSync(path.join(root, 'infra', '.env'), 'utf8')).MM_PORT

describe('office dev info / down / reset refusals', () => {
  it('info prints the instance and exits non-zero (throws) elsewhere', () => {
    const h = harness()
    expect(() => devInfo(h.deps)).toThrow(/not a dev instance/)
    writeEnv(devEnvText('foo-abc123'))
    devInfo(h.deps)
    expect(h.logs.join('\n')).toMatch(/compose project: agentcy-foo-abc123[\s\S]*chat:\s+http:\/\/127.0.0.1:20100[\s\S]*tmux session:\s+office-foo-abc123/)
  })

  it('down and reset refuse a normal office and never reach Docker', async () => {
    writeEnv('POSTGRES_PASSWORD=p\n')
    for (const f of [(d: DevDeps) => devDown({}, d), (d: DevDeps) => devDown({ purge: true }, d), (d: DevDeps) => devReset({}, d)]) {
      const h = harness()
      await expect(f(h.deps)).rejects.toThrow(/not a dev instance/)
      expect(h.calls).toEqual([])
    }
    expect(fs.existsSync(path.join(root, 'infra', '.env'))).toBe(true)
  })

  it('refuses when the env points at the default prefix or project infra', async () => {
    markInitialised()
    for (const text of [
      devEnvText('foo-abc123').replace('OFFICE_CONTAINER_PREFIX=agentcy-foo-abc123', 'OFFICE_CONTAINER_PREFIX=agent-office'),
      devEnvText('foo-abc123').replace('COMPOSE_PROJECT_NAME=agentcy-foo-abc123', 'COMPOSE_PROJECT_NAME=infra'),
      devEnvText('foo-abc123').replace('OFFICE_CONTAINER_PREFIX=agentcy-foo-abc123', 'OFFICE_CONTAINER_PREFIX=agentcy-other'),
      devEnvText('foo-abc123').replace('COMPOSE_PROJECT_NAME=agentcy-foo-abc123', 'COMPOSE_PROJECT_NAME=agentcy-other'),
    ]) {
      writeEnv(text)
      expect(() => requireDevInstance(root, 'down')).toThrow(/Refusing|inconsistent/)
      const h = harness()
      await expect(devDown({ purge: true }, h.deps)).rejects.toThrow()
      expect(h.calls).toEqual([])
      expect(fs.existsSync(path.join(root, 'state'))).toBe(true)
    }
  })

  it('down: ownership first, agents stopped, compose with explicit -p and the dev override; files kept', async () => {
    writeEnv(devEnvText('foo-abc123'))
    markInitialised()
    const h = harness()
    await devDown({}, h.deps)
    expect(h.calls[0]).toBe('ownership')
    expect(h.calls[1]).toBe('shutdown')
    expect(h.calls[2]).toBe(`docker compose ${composeFileArgs(root).join(' ')} down`)
    expect(h.calls[2]).toContain('-p agentcy-foo-abc123')
    expect(h.calls[2]).toContain('docker-compose.dev.yml')
    expect(fs.existsSync(path.join(root, 'state'))).toBe(true)
  })

  it('down aborts on a foreign stack without stopping anything', async () => {
    writeEnv(devEnvText('foo-abc123'))
    const h = harness({ assertOwnership: () => { throw new Error('belongs to another checkout') } })
    await expect(devDown({}, h.deps)).rejects.toThrow(/another checkout/)
    expect(h.calls).toEqual([])
  })

  it('down --purge: down -v, then deletes state, workspaces, brain, config and env but not the example', async () => {
    writeEnv(devEnvText('foo-abc123'))
    for (const d of ['state', 'workspaces', 'brain']) fs.mkdirSync(path.join(root, d))
    fs.writeFileSync(path.join(root, 'office.config.json'), '{}')
    const h = harness()
    await devDown({ purge: true }, h.deps)
    expect(h.calls[2]).toMatch(/ down -v$/)
    for (const p of ['state', 'workspaces', 'brain', 'office.config.json', 'infra/.env']) expect(fs.existsSync(path.join(root, p))).toBe(false)
    expect(fs.existsSync(path.join(root, 'office.config.example.json'))).toBe(true)
  })

  it('down --purge keeps everything when compose down fails', async () => {
    writeEnv(devEnvText('foo-abc123'))
    fs.mkdirSync(path.join(root, 'state'))
    const h = harness({ run: () => ({ status: 1, stdout: '' }) })
    await expect(devDown({ purge: true }, h.deps)).rejects.toThrow(/nothing was deleted/)
    expect(fs.existsSync(path.join(root, 'state'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'infra', '.env'))).toBe(true)
  })

  it('reset: purge, then init with the same name (new password, config regenerated)', async () => {
    writeEnv(devEnvText('foo-abc123', 20500))
    markInitialised()
    const h = harness()
    await devReset({}, h.deps)
    expect(h.calls.filter(c => c.includes(' down -v'))).toHaveLength(1)
    expect(instanceName(root)).toBe('foo-abc123')
    expect(devProject('foo-abc123')).toBe('agentcy-foo-abc123')
    expect(h.calls.at(-2)).toBe('bootstrap')
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'office.config.json'), 'utf8')) as OfficeConfig
    expect(cfg.tmuxSession).toBe('office-foo-abc123')
    expect(fs.existsSync(path.join(root, 'state', 'office.json'))).toBe(false)
  })

  it('cmdDev dispatches and rejects unknown subcommands', async () => {
    await expect(cmdDev(['bogus'], {}, harness().deps)).rejects.toThrow(/usage: office dev/)
    await expect(cmdDev([], {}, harness().deps)).rejects.toThrow(/usage: office dev/)
  })
})
