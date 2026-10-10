// Config + state helpers for the agent-office prototype.
// All JSON writes are atomic (temp file + rename); secrets files are chmod 600.

import { readFile, writeFile, mkdir, readdir, chmod, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OfficeConfig, OfficeSecrets, AgentRecord } from './types.js'

const CONFIG_NAME = 'office.config.json'
const CONFIG_EXAMPLE_NAME = 'office.config.example.json'
const SECRETS_NAME = 'office.json'

let cachedRoot: string | undefined

/** Directory containing office.config.json / office.config.example.json (or OFFICE_ROOT env). */
export function repoRoot(): string {
  if (process.env.OFFICE_ROOT) return path.resolve(process.env.OFFICE_ROOT)
  if (cachedRoot) return cachedRoot
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, CONFIG_NAME)) || existsSync(path.join(dir, CONFIG_EXAMPLE_NAME))) {
      cachedRoot = dir
      return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error(`Could not find ${CONFIG_NAME} from ${fileURLToPath(import.meta.url)}`)
}

/**
 * Load the local office config (office.config.json, gitignored). On a fresh clone this file
 * doesn't exist yet, so it's created from the committed office.config.example.json.
 */
export async function loadConfig(): Promise<OfficeConfig> {
  const root = repoRoot()
  const configPath = path.join(root, CONFIG_NAME)
  if (!existsSync(configPath)) {
    const examplePath = path.join(root, CONFIG_EXAMPLE_NAME)
    const raw = await readFile(examplePath, 'utf-8')
    await writeFile(configPath, raw, 'utf-8')
    console.log(`[office] ${CONFIG_NAME} not found; created it from ${CONFIG_EXAMPLE_NAME}. Edit it to customize your setup.`)
  }
  const raw = await readFile(configPath, 'utf-8')
  return JSON.parse(raw) as OfficeConfig
}

/** Write the local office.config.json (used by `office setup`). */
export async function saveConfig(cfg: OfficeConfig): Promise<void> {
  await writeJsonAtomic(path.join(repoRoot(), CONFIG_NAME), cfg)
}

/** Directory for runtime state (gitignored). */
export function stateDir(): string {
  return path.join(repoRoot(), 'state')
}

/** Directory for one agent's state. */
export function agentStateDir(name: string): string {
  return path.join(stateDir(), 'agents', name)
}

/** Atomic JSON write. Optionally chmod after writing (for secrets). */
export async function writeJsonAtomic(filePath: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  if (mode !== undefined) await chmod(tmp, mode)
  await rename(tmp, filePath)
}

/** Read and parse a JSON file if it exists; otherwise undefined. */
async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    throw err
  }
}

/** Load office secrets from state/office.json. */
export async function loadSecrets(): Promise<OfficeSecrets | undefined> {
  return readJsonIfExists<OfficeSecrets>(path.join(stateDir(), SECRETS_NAME))
}

/** Save office secrets atomically with 0600 permissions. */
export async function saveSecrets(secrets: OfficeSecrets): Promise<void> {
  await writeJsonAtomic(path.join(stateDir(), SECRETS_NAME), secrets, 0o600)
}

/** Load an agent record if it exists. */
export async function loadAgent(name: string): Promise<AgentRecord | undefined> {
  return readJsonIfExists<AgentRecord>(path.join(agentStateDir(name), 'agent.json'))
}

/** Save an agent record atomically with 0600 permissions. */
export async function saveAgent(rec: AgentRecord): Promise<void> {
  await writeJsonAtomic(path.join(agentStateDir(rec.name), 'agent.json'), rec, 0o600)
}

/** List all agent names that have a state directory. */
export async function listAgents(): Promise<string[]> {
  const dir = path.join(stateDir(), 'agents')
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}
