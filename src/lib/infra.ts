// Docker stack helpers shared by `office init/up/setup/export/import`.
//
// Agents, the MCP and the CLI always talk to Mattermost/Forgejo over 127.0.0.1 (they run on
// the office machine). What changes on a home server is only how the *owner* reaches them:
//   - infra/.env MM_SITE_URL / FORGEJO_ROOT_URL: the public URLs used in links and emails;
//   - infra/docker-compose.lan.yml (optional, generated): extra port bindings on a LAN/VPN IP,
//     added on top of the loopback bindings so 127.0.0.1 keeps working for the office itself.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { OfficeConfig } from './types.js'

export const LAN_OVERRIDE = 'docker-compose.lan.yml'

export function infraDir(root: string): string {
  return path.join(root, 'infra')
}

/** Compose override that swaps the bind-mounted infra/data for named volumes (dev instances). */
export const DEV_OVERRIDE = 'docker-compose.dev.yml'
export const DEFAULT_CONTAINER_PREFIX = 'agent-office'

/** OFFICE_INSTANCE from infra/.env: the dev instance name, or undefined for a normal office. */
export function instanceName(root: string): string | undefined {
  return readInfraEnv(root).OFFICE_INSTANCE || undefined
}

/** Container name prefix: OFFICE_CONTAINER_PREFIX from infra/.env, default 'agent-office'. */
export function containerPrefix(root: string): string {
  return readInfraEnv(root).OFFICE_CONTAINER_PREFIX || DEFAULT_CONTAINER_PREFIX
}

/** Compose project of a dev instance. Always passed as `-p`, never left to the environment. */
export function devProject(name: string): string {
  return `agentcy-${name}`
}

/**
 * `docker compose` arguments selecting this office's files. A dev instance gets an explicit
 * `-p` first (an absent COMPOSE_PROJECT_NAME line or a shell-exported one must never make a
 * dev command act on project `infra`) and the named-volume override before the LAN one.
 */
export function composeFileArgs(root: string): string[] {
  const dir = infraDir(root)
  const instance = instanceName(root)
  const args = instance ? ['-p', devProject(instance)] : []
  args.push('-f', path.join(dir, 'docker-compose.yml'))
  if (instance) args.push('-f', path.join(dir, DEV_OVERRIDE))
  if (fs.existsSync(path.join(dir, LAN_OVERRIDE))) args.push('-f', path.join(dir, LAN_OVERRIDE))
  return args
}

// ------------------------------------------------------------------ dev instances

/** `[a-z0-9-]`, at most 24 characters; never empty. */
export function instanceSlug(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '')
  return s || 'office'
}

/** `<slug>-<hash6>`: hash6 = first 6 hex of sha1(realpath(root)), so two checkouts never collide by accident. */
export function instanceNameFor(root: string, slugInput?: string): string {
  const real = fs.realpathSync(root)
  const hash = createHash('sha1').update(real).digest('hex').slice(0, 6)
  return `${instanceSlug(slugInput ?? path.basename(real))}-${hash}`
}

export const PORT_BLOCK = 100
const PORT_FIRST = 20000
const PORT_BLOCKS = 100

function nameHash(name: string): number {
  return createHash('sha1').update(name).digest().readUInt32BE(0)
}

/** First candidate port base for a name: 20000 + (hash % 100) * 100. */
export function startPortBase(name: string): number {
  return PORT_FIRST + (nameHash(name) % PORT_BLOCKS) * PORT_BLOCK
}

/** The host ports every instance publishes: chat, tickets, tickets ssh. */
export function instancePorts(base: number): { mm: number; forgejo: number; ssh: number } {
  return { mm: base, forgejo: base + 1, ssh: base + 2 }
}

/** First block (stepping by 100, wrapping inside 20000-29999) whose three published ports are free. */
export async function pickPortBase(name: string, isFree: (port: number) => Promise<boolean>): Promise<number> {
  const start = startPortBase(name)
  for (let i = 0; i < PORT_BLOCKS; i++) {
    const base = PORT_FIRST + (((start - PORT_FIRST) / PORT_BLOCK + i) % PORT_BLOCKS) * PORT_BLOCK
    const { mm, forgejo, ssh } = instancePorts(base)
    if (await isFree(mm) && await isFree(forgejo) && await isFree(ssh)) return base
  }
  throw new Error('no free port block between 20000 and 29999; pass --port-base N')
}

/** infra/.env keys that make a checkout a dev instance. */
export function devEnv(name: string, base: number, password: string): Record<string, string> {
  const p = instancePorts(base)
  return {
    BIND_ADDR: '127.0.0.1',
    POSTGRES_PASSWORD: password,
    OFFICE_INSTANCE: name,
    COMPOSE_PROJECT_NAME: devProject(name),
    OFFICE_CONTAINER_PREFIX: devProject(name),
    MM_PORT: String(p.mm),
    FORGEJO_PORT: String(p.forgejo),
    FORGEJO_SSH_PORT: String(p.ssh),
    MM_SITE_URL: `http://127.0.0.1:${p.mm}`,
    FORGEJO_ROOT_URL: `http://127.0.0.1:${p.forgejo}/`,
  }
}

/** office.config.json for a dev instance: the example with its own ports/tmux session and the cheap model. */
export function devConfig(example: OfficeConfig, name: string, base: number): OfficeConfig {
  const p = instancePorts(base)
  return {
    ...example,
    mattermostUrl: `http://127.0.0.1:${p.mm}`,
    forgejoUrl: `http://127.0.0.1:${p.forgejo}`,
    tmuxSession: `office-${name}`,
    opencodeBasePort: base + 10,
    defaults: { ...example.defaults, opencodeModel: example.defaults.helperModel },
    publicUrls: undefined,
  }
}

function portOf(url: string): string {
  try { return new URL(url).port } catch { return '' }
}

/** Throws when infra/.env marks a dev instance but office.config.json does not match it. */
export function assertInstanceConfig(root: string, cfg: OfficeConfig): void {
  const env = readInfraEnv(root)
  const name = env.OFFICE_INSTANCE
  if (!name) return
  const problems: string[] = []
  if (cfg.tmuxSession !== `office-${name}`) problems.push(`tmuxSession is "${cfg.tmuxSession}", expected "office-${name}"`)
  if (portOf(cfg.mattermostUrl) !== env.MM_PORT) problems.push(`mattermostUrl port is "${portOf(cfg.mattermostUrl)}", expected ${env.MM_PORT}`)
  if (portOf(cfg.forgejoUrl) !== env.FORGEJO_PORT) problems.push(`forgejoUrl port is "${portOf(cfg.forgejoUrl)}", expected ${env.FORGEJO_PORT}`)
  if (problems.length) {
    throw new Error(`office.config.json does not match this dev instance (${name}): ${problems.join('; ')}. ` +
      'Refusing to run so it cannot act on another office. Run `office dev init` to repair it.')
  }
}

/** Refuse a command that only makes sense for a normal office. */
export function assertNotDevInstance(root: string, what: string): void {
  const name = instanceName(root)
  if (name) throw new Error(`\`office ${what}\` is not available on a dev instance (${name}): it assumes the bind-mounted infra/data and the default ports`)
}

/** Refuse to touch tmux/agents of a checkout that was never initialised (its config names the default session "office"). */
export function assertInitialised(root: string, what: string): void {
  if (!fs.existsSync(path.join(root, 'state', 'office.json'))) {
    throw new Error(`\`office ${what}\`: this checkout is not initialised (no state/office.json). Refusing, because the default tmux session name could belong to another office`)
  }
}

// ------------------------------------------------------------------ stack ownership

const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir'
const OWNED_SERVICES = ['mattermost', 'forgejo', 'postgres']

/** Compose working_dir label of a container (an existing, even stopped, one) or undefined. */
export type InspectLabel = (container: string) => string | undefined

export function dockerInspectLabel(container: string): string | undefined {
  const r = spawnSync('docker', ['inspect', '--format', `{{index .Config.Labels "${WORKING_DIR_LABEL}"}}`, container], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return undefined // no such container, or Docker not reachable
  const v = r.stdout.trim()
  return v && v !== '<no value>' ? v : undefined
}

function realOrUndefined(p: string, realpath: (p: string) => string): string | undefined {
  try { return realpath(p) } catch { return undefined }
}

/**
 * Pure comparison: the first container whose compose working dir resolves to a different
 * directory than this checkout's infra/, as `{ container, dir }`. A label path that no longer
 * exists is the same office at a new path, so it is not a conflict.
 */
export function findForeignContainer(
  root: string, prefix: string, inspect: InspectLabel, realpath: (p: string) => string = fs.realpathSync,
): { container: string; dir: string } | undefined {
  const mine = realOrUndefined(infraDir(root), realpath) ?? path.resolve(infraDir(root))
  for (const svc of OWNED_SERVICES) {
    const container = `${prefix}-${svc}`
    const label = inspect(container)
    if (!label) continue
    const theirs = realOrUndefined(label, realpath)
    if (theirs === undefined) continue
    if (theirs !== mine) return { container, dir: label }
  }
  return undefined
}

/** Throws when this office's containers exist but belong to another checkout. */
export function assertStackOwnership(root: string, inspect: InspectLabel = dockerInspectLabel): void {
  const prefix = containerPrefix(root)
  const other = findForeignContainer(root, prefix, inspect)
  if (!other) return
  throw new Error(`container ${other.container} belongs to the office in ${other.dir}, not this checkout (${root}). ` +
    'Refusing to touch it. For an isolated office in this checkout run `office dev init`.')
}

export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Replace/append KEY=value lines, keeping every other line (comments, unknown keys) as is. */
export function updateEnv(raw: string, updates: Record<string, string | undefined>): string {
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const done = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_]+)=/)
    if (m && m[1] in updates) {
      done.add(m[1])
      const v = updates[m[1]]
      if (v !== undefined) out.push(`${m[1]}=${v}`)
      continue
    }
    out.push(line)
  }
  for (const [k, v] of Object.entries(updates)) if (!done.has(k) && v !== undefined) out.push(`${k}=${v}`)
  return out.join('\n') + '\n'
}

export function readInfraEnv(root: string): Record<string, string> {
  try { return parseEnv(fs.readFileSync(path.join(infraDir(root), '.env'), 'utf8')) } catch { return {} }
}

export function writeInfraEnv(root: string, updates: Record<string, string | undefined>): void {
  const file = path.join(infraDir(root), '.env')
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  fs.writeFileSync(file, updateEnv(raw, updates), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** Compose override publishing Mattermost/Forgejo on one extra address (a LAN or Tailscale IP). */
export function renderLanOverride(addr: string): string {
  if (!/^[0-9a-fA-F:.]+$/.test(addr)) throw new Error(`not an IP address: ${addr}`)
  if (addr === '0.0.0.0' || addr === '::') throw new Error('refusing to publish on all interfaces; pick the LAN or VPN address')
  const host = addr.includes(':') ? `[${addr}]` : addr
  return `# Generated by \`office setup\`: also publish the office on ${addr}. Delete this file to go back to loopback only.
services:
  mattermost:
    ports:
      - "${host}:8065:8065"
  forgejo:
    ports:
      - "${host}:3033:3000"
      - "${host}:2222:22"
`
}

export type AccessMode =
  | { kind: 'local' }
  | { kind: 'lan'; addr: string; host?: string }
  | { kind: 'tailscale'; dnsName: string }

export interface PublicUrls { mattermost: string; forgejo: string }

const HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const HOSTNAME_RE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`)

/** A plain DNS name (no scheme, port, path or spaces), safe to drop into a URL. */
export function isValidHostname(host: string): boolean {
  return host.length <= 253 && HOSTNAME_RE.test(host)
}

/** Public URLs for an access mode. Tailscale serves HTTPS on 443 (chat) and 8443 (tickets). */
export function publicUrlsFor(mode: AccessMode): PublicUrls {
  switch (mode.kind) {
    case 'local': return { mattermost: 'http://127.0.0.1:8065', forgejo: 'http://127.0.0.1:3033' }
    case 'lan': {
      if (mode.host !== undefined && !isValidHostname(mode.host)) throw new Error(`not a valid hostname: ${mode.host}`)
      const h = mode.host ?? (mode.addr.includes(':') ? `[${mode.addr}]` : mode.addr)
      return { mattermost: `http://${h}:8065`, forgejo: `http://${h}:3033` }
    }
    case 'tailscale': {
      const h = mode.dnsName.replace(/\.$/, '')
      return { mattermost: `https://${h}`, forgejo: `https://${h}:8443` }
    }
  }
}

/** `tailscale serve` commands that front the loopback ports with Tailscale HTTPS certificates. */
export function tailscaleServeCommands(): string[][] {
  return [
    ['tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:8065'],
    ['tailscale', 'serve', '--bg', '--https=8443', 'http://127.0.0.1:3033'],
  ]
}

/** Apply an access mode to infra/ (env + LAN override). Caller recreates the containers. */
export function applyAccessMode(root: string, mode: AccessMode): PublicUrls {
  const urls = publicUrlsFor(mode)
  writeInfraEnv(root, { MM_SITE_URL: urls.mattermost, FORGEJO_ROOT_URL: urls.forgejo.replace(/\/?$/, '/') })
  const override = path.join(infraDir(root), LAN_OVERRIDE)
  if (mode.kind === 'lan') fs.writeFileSync(override, renderLanOverride(mode.addr))
  else fs.rmSync(override, { force: true })
  return urls
}
