// `office dev` — isolated dev offices: init | info | down [--purge] | reset.
// A dev instance has its own compose project, containers, ports, named volumes and tmux session,
// so it runs next to the owner's live office. Nothing here may ever touch a normal office.
// Like group-cmd.ts, all side effects come in through DevDeps (this file must not import
// office.ts, which runs main() on import).

import fs from 'node:fs'
import path from 'node:path'
import type { OfficeConfig } from '../lib/types.js'
import {
  DEFAULT_CONTAINER_PREFIX, LAN_OVERRIDE, PORT_BLOCK, composeFileArgs, containerPrefix, devConfig, devEnv,
  devProject, infraDir, instanceName, instanceNameFor, instancePorts, pickPortBase, readInfraEnv, writeInfraEnv,
} from '../lib/infra.js'

export interface DevDeps {
  root: string
  bootstrap(): Promise<void>
  ensureBrain(): void
  shutdownOffice(): Promise<void>
  /** Runs a command; `capture` returns stdout instead of showing it. */
  run(cmd: string, args: string[], capture?: boolean): { status: number; stdout: string }
  portFree(port: number): Promise<boolean>
  /** assertStackOwnership(root) in production; called before every compose call. */
  assertOwnership(): void
  randomPassword(): string
  log(line: string): void
}

const PURGE_PATHS = ['state', 'workspaces', 'brain', 'office.config.json', path.join('infra', '.env')]

function numberFlag(v: string | boolean | undefined, what: string): number | undefined {
  if (v === undefined || v === false) return undefined
  const n = typeof v === 'string' ? Number(v) : NaN
  if (!Number.isInteger(n) || n < 1024 || n + PORT_BLOCK > 65535) throw new Error(`${what} must be an integer between 1024 and 65435`)
  return n
}

/** The instance name and project, or a refusal. Guards every command that stops or deletes things. */
export function requireDevInstance(root: string, what: string): { name: string; project: string } {
  const name = instanceName(root)
  if (!name) throw new Error(`office dev ${what}: this checkout is not a dev instance (no OFFICE_INSTANCE in infra/.env). Refusing: it would act on a normal office`)
  const env = readInfraEnv(root)
  const project = devProject(name)
  const prefix = containerPrefix(root)
  if (prefix === DEFAULT_CONTAINER_PREFIX || project === 'infra' || env.COMPOSE_PROJECT_NAME === 'infra') {
    throw new Error(`office dev ${what}: infra/.env points at the default office (container prefix ${prefix}, project ${env.COMPOSE_PROJECT_NAME ?? project}). Refusing`)
  }
  if (prefix !== project || (env.COMPOSE_PROJECT_NAME !== undefined && env.COMPOSE_PROJECT_NAME !== project)) {
    throw new Error(`office dev ${what}: infra/.env is inconsistent (instance ${name} expects project and container prefix ${project}, found ${env.COMPOSE_PROJECT_NAME ?? '(unset)'} / ${prefix}). Fix it or run \`office dev init\``)
  }
  return { name, project }
}

function describe(root: string, name: string): string[] {
  const env = readInfraEnv(root)
  return [
    `instance:        ${name}`,
    `compose project: ${devProject(name)}`,
    `chat:            ${env.MM_SITE_URL ?? `http://127.0.0.1:${env.MM_PORT}`}`,
    `tickets:         ${env.FORGEJO_ROOT_URL ?? `http://127.0.0.1:${env.FORGEJO_PORT}/`}`,
    `tmux session:    office-${name}`,
  ]
}

function readExample(root: string): OfficeConfig {
  return JSON.parse(fs.readFileSync(path.join(root, 'office.config.example.json'), 'utf8')) as OfficeConfig
}

function writeConfig(root: string, cfg: OfficeConfig): void {
  fs.writeFileSync(path.join(root, 'office.config.json'), JSON.stringify(cfg, null, 2) + '\n')
}

/** Create or reuse this checkout's dev instance, then run the normal init (bootstrap + brain). */
export async function devInit(flags: Record<string, string | boolean>, deps: DevDeps, opts: { name?: string } = {}): Promise<void> {
  const { root } = deps
  const initialised = fs.existsSync(path.join(root, 'state', 'office.json'))
  const existing = instanceName(root)
  if (initialised && !existing) {
    throw new Error('this checkout already holds a normal office (state/office.json exists, infra/.env has no OFFICE_INSTANCE). ' +
      'Refusing to turn it into a dev instance; use a separate checkout or git worktree for a dev office')
  }
  // A normal office that is not initialised yet (setup ran, or init failed midway) still has an
  // infra/.env and maybe data that a dev init would overwrite or orphan.
  if (!existing && fs.existsSync(path.join(infraDir(root), '.env'))) {
    throw new Error('infra/.env exists without OFFICE_INSTANCE, so this checkout is set up as a normal office. ' +
      'Refusing to turn it into a dev instance; use a separate checkout or git worktree, or delete infra/.env if it is a leftover')
  }
  if (fs.existsSync(path.join(infraDir(root), 'data'))) {
    throw new Error('infra/data exists: this checkout has the bind-mounted data of a normal office. Refusing to make it a dev instance')
  }
  const portBase = numberFlag(flags['port-base'], '--port-base')

  let name: string
  if (existing) {
    name = existing
    // Re-assert every instance key (keeps name, ports and password) so a hand-edited infra/.env cannot point at the default office.
    const env = readInfraEnv(root)
    const base = Number(env.MM_PORT) || await pickPortBase(name, deps.portFree)
    writeInfraEnv(root, devEnv(name, base, env.POSTGRES_PASSWORD || deps.randomPassword()))
    if (flags.name !== undefined || portBase !== undefined) deps.log('dev instance already exists: keeping its name and ports (--name/--port-base ignored)')
  } else {
    if (flags.name !== undefined && typeof flags.name !== 'string') throw new Error('--name needs a value')
    name = opts.name ?? instanceNameFor(root, typeof flags.name === 'string' ? flags.name : undefined)
    if (fs.existsSync(path.join(infraDir(root), LAN_OVERRIDE))) {
      throw new Error(`infra/${LAN_OVERRIDE} exists and would publish the fixed default ports; delete it before \`office dev init\``)
    }
    // Volumes of a deleted checkout at this path would silently become the new office's data.
    const vols = deps.run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${devProject(name)}`], true)
    if (vols.status !== 0) throw new Error('could not list Docker volumes: is Docker running and usable by this user?')
    if (vols.stdout.trim()) {
      throw new Error(`Docker volumes of compose project ${devProject(name)} already exist (left over from an earlier checkout at this path). ` +
        `Remove them with \`docker volume rm ${vols.stdout.trim().split('\n').join(' ')}\` or run \`office dev down --purge\` in the old checkout`)
    }
    let base: number
    if (portBase !== undefined) {
      for (const port of Object.values(instancePorts(portBase))) if (!await deps.portFree(port)) throw new Error(`port ${port} is in use; pick another --port-base`)
      base = portBase
    } else {
      base = await pickPortBase(name, deps.portFree)
    }
    fs.mkdirSync(infraDir(root), { recursive: true })
    writeInfraEnv(root, devEnv(name, base, deps.randomPassword()))
  }

  // The CLI auto-creates the config from the example on any command, so replacing it is only
  // safe while the office has no state. With state, repair just the instance-specific fields.
  const env = readInfraEnv(root)
  const base = Number(env.MM_PORT)
  if (!initialised) {
    writeConfig(root, devConfig(readExample(root), name, base))
  } else {
    const cfgPath = path.join(root, 'office.config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as OfficeConfig
    const want = devConfig(cfg, name, base)
    writeConfig(root, { ...cfg, mattermostUrl: want.mattermostUrl, forgejoUrl: want.forgejoUrl, tmuxSession: want.tmuxSession })
  }
  await deps.bootstrap()
  deps.ensureBrain()
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'office.config.json'), 'utf8')) as OfficeConfig
  for (const line of describe(root, name)) deps.log(line)
  deps.log(`owner:           @${cfg.human.username} (password in state/office.json)`)
}

export function devInfo(deps: DevDeps): void {
  const name = instanceName(deps.root)
  if (!name) throw new Error('this checkout is not a dev instance (no OFFICE_INSTANCE in infra/.env). Run `office dev init`')
  for (const line of describe(deps.root, name)) deps.log(line)
}

/** Stop this instance's agents, admin daemon and containers. With purge, also delete its data and files. */
export async function devDown(flags: Record<string, string | boolean>, deps: DevDeps): Promise<void> {
  const { root } = deps
  requireDevInstance(root, 'down')
  const purge = flags.purge === true
  // Dev instances keep their data in named volumes; infra/data means a normal office lived here.
  if (purge && fs.existsSync(path.join(infraDir(root), 'data'))) {
    throw new Error('office dev down --purge: infra/data exists, which only a normal office has. Refusing to delete anything')
  }
  deps.assertOwnership()
  await deps.shutdownOffice()
  const r = deps.run('docker', ['compose', ...composeFileArgs(root), 'down', ...(purge ? ['-v'] : [])])
  if (r.status !== 0) throw new Error('docker compose down failed; nothing was deleted')
  if (!purge) return
  for (const p of PURGE_PATHS) fs.rmSync(path.join(root, p), { recursive: true, force: true })
  deps.log('dev instance removed: containers, volumes, state/, workspaces/, brain/, office.config.json, infra/.env')
}

/** `dev down --purge`, then `dev init` with the same name. */
export async function devReset(flags: Record<string, string | boolean>, deps: DevDeps): Promise<void> {
  const { name } = requireDevInstance(deps.root, 'reset')
  await devDown({ purge: true }, deps)
  await devInit(flags, deps, { name })
}

export async function cmdDev(pos: string[], flags: Record<string, string | boolean>, deps: DevDeps): Promise<void> {
  switch (pos[0]) {
    case 'init': return devInit(flags, deps)
    case 'info': return devInfo(deps)
    case 'down': return devDown(flags, deps)
    case 'reset': return devReset(flags, deps)
    default: throw new Error('usage: office dev init [--name n] [--port-base N] | info | down [--purge] | reset')
  }
}
