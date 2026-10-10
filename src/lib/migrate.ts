// `office export` / `office import`: move a whole office (chat + tickets data, state/, brain/,
// workspaces/) from one machine to another, e.g. from the laptop to a home server.
//
// Claude/opencode session transcripts are NOT moved (they live in the harness's own dirs and
// are keyed by absolute cwd). Every hired agent instead starts a new session on the new
// machine and carries on from its brain (memory + journal), exactly like a shift change.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AgentRecord } from './types.js'
import { assertNotDevInstance, assertStackOwnership, composeEnv, composeFileArgs, infraDir } from './infra.js'

export const EXPORT_VERSION = 1
/** Already pulled by the stack; its busybox tar runs as root so it can read/write the data dirs. */
const TAR_IMAGE = 'postgres:16-alpine'
const OFFICE_PATHS = ['state', 'brain', 'workspaces', 'infra/.env', 'office.config.json']

export interface ExportManifest {
  version: number
  createdAt: string
  sourceRoot: string
  agents: string[]
}

function run(cmd: string, args: string[], opts: { input?: number; output?: number } = {}): void {
  const r = spawnSync(cmd, args, { stdio: [opts.input ?? 'ignore', opts.output ?? 'inherit', 'inherit'], env: composeEnv() })
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}… failed (exit ${r.status ?? r.signal})`)
}

function compose(root: string, ...args: string[]): void {
  run('docker', ['compose', ...composeFileArgs(root), ...args])
}

/** Agent records found in an office root (tolerates unreadable ones). */
export function readAgentRecords(root: string): AgentRecord[] {
  const dir = path.join(root, 'state', 'agents')
  if (!fs.existsSync(dir)) return []
  const out: AgentRecord[] = []
  for (const name of fs.readdirSync(dir)) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name, 'agent.json'), 'utf8')) as AgentRecord) } catch { /* not an agent dir */ }
  }
  return out
}

/**
 * After a move, hired agents get a fresh session (the transcript stayed behind). The old id is
 * kept in pastSessions like a shift. Returns the names that need a "you moved" prompt.
 */
export function resetSessionsAfterMove(recs: AgentRecord[]): string[] {
  const moved: string[] = []
  for (const r of recs) {
    if (r.sessionId) r.pastSessions = [...(r.pastSessions ?? []), r.sessionId]
    r.sessionId = undefined
    if (r.status === 'hired') moved.push(r.name)
  }
  return moved
}

export const MOVED_PROMPT = '<office-system kind="new-shift">The office moved to a new machine, so this is a fresh session. ' +
  'Your persona and memory are loaded from the brain; your workspace, tickets and chat history came along. ' +
  'Paths may differ from what your memory mentions: re-check before relying on them. ' +
  'Check ticket_list(assignee=you) for open work; otherwise wait for events.</office-system>'

/** Write an export bundle into `outDir`. The caller stops agents + the admin daemon first. */
export function exportOffice(root: string, outDir: string): ExportManifest {
  assertNotDevInstance(root, 'export')
  assertStackOwnership(root)
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`)
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(outDir, 0o700)

  // Consistent copy of Postgres/Forgejo: stop the containers, don't just snapshot live files.
  compose(root, 'stop')
  const dataOut = fs.openSync(path.join(outDir, 'infra-data.tar.gz'), 'w', 0o600)
  try {
    run('docker', ['run', '--rm', '-v', `${path.join(infraDir(root), 'data')}:/data:ro`, '--entrypoint', 'tar', TAR_IMAGE, 'czf', '-', '-C', '/data', '.'], { output: dataOut })
  } finally { fs.closeSync(dataOut) }

  // Claude subscription logins are per-machine (each server runs `claude auth login` itself);
  // never move the OAuth credentials of any Claude group's config dir.
  const present = OFFICE_PATHS.filter(p => fs.existsSync(path.join(root, p)))
  run('tar', ['czf', path.join(outDir, 'office.tar.gz'), '--exclude=state/claude/*/.credentials.json', '-C', root, ...present])
  fs.chmodSync(path.join(outDir, 'office.tar.gz'), 0o600)

  const manifest: ExportManifest = {
    version: EXPORT_VERSION, createdAt: new Date().toISOString(), sourceRoot: root,
    agents: readAgentRecords(root).map(a => a.name),
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  return manifest
}

export function readManifest(dir: string): ExportManifest {
  const file = path.join(dir, 'manifest.json')
  if (!fs.existsSync(file)) throw new Error(`${dir} is not an office export (no manifest.json)`)
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as ExportManifest
  if (m.version !== EXPORT_VERSION) throw new Error(`unsupported export version ${m.version}`)
  for (const f of ['infra-data.tar.gz', 'office.tar.gz']) if (!fs.existsSync(path.join(dir, f))) throw new Error(`${dir}/${f} missing`)
  return m
}

/**
 * Restore a bundle into `root`. Refuses to overwrite an initialised office unless `force`.
 * Returns the agents that were reset to a fresh session (caller queues MOVED_PROMPT).
 */
export function importOffice(root: string, dir: string, opts: { force?: boolean } = {}): { manifest: ExportManifest; moved: string[] } {
  assertNotDevInstance(root, 'import')
  assertStackOwnership(root)
  const manifest = readManifest(dir)
  const dataDir = path.join(infraDir(root), 'data')
  const initialised = fs.existsSync(path.join(root, 'state', 'office.json'))
  const hasData = fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0
  if ((initialised || hasData) && !opts.force) {
    throw new Error('this machine already has an office (state/office.json or infra/data). Re-run with --force to replace it')
  }

  compose(root, 'down')
  fs.mkdirSync(dataDir, { recursive: true })
  if (hasData) {
    // Wipe as root inside a container: the data dirs belong to container users.
    run('docker', ['run', '--rm', '-v', `${dataDir}:/data`, '--entrypoint', 'sh', TAR_IMAGE, '-c', 'rm -rf /data/* /data/.[!.]* 2>/dev/null; true'])
  }
  const dataIn = fs.openSync(path.join(dir, 'infra-data.tar.gz'), 'r')
  try {
    run('docker', ['run', '--rm', '-i', '-v', `${dataDir}:/data`, '--entrypoint', 'tar', TAR_IMAGE, 'xzf', '-', '-C', '/data'], { input: dataIn })
  } finally { fs.closeSync(dataIn) }

  run('tar', ['xzf', path.join(dir, 'office.tar.gz'), '-C', root])

  const recs = readAgentRecords(root)
  const moved = resetSessionsAfterMove(recs)
  for (const r of recs) {
    const agentDir = path.join(root, 'state', 'agents', r.name)
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify(r, null, 2) + '\n', { mode: 0o600 })
    // Generated per start with this machine's paths; stale copies would point at the old root.
    for (const f of ['claude-settings.json', 'mcp.json', 'opencode.json', 'git-credentials', 'provider.env']) fs.rmSync(path.join(agentDir, f), { force: true })
  }
  return { manifest, moved }
}
