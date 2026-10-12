// Brain + workspace files for an agent: persona/memory/journal in the brain repo,
// and the generated CLAUDE.md / AGENTS.md that every new session reads.
import fs from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AgentRecord, OfficeConfig } from './types.js'
import { agentStateDir, listAgents, loadAgent } from './config.js'
import { listProjects } from './projects.js'
import { activeMembers, loadMembers } from './members.js'

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)
}

export function brainDir(root: string): string { return path.join(root, 'brain') }
export function agentBrainDir(root: string, name: string): string { return path.join(brainDir(root), 'agents', name) }
export function projectBrainDir(root: string, name: string): string { return path.join(brainDir(root), 'projects', name) }
export function workspaceDir(root: string, name: string): string { return path.join(root, 'workspaces', name) }

// ---------------------------------------------------------------- attachments

/** Fallback attachment size cap when office.config.json does not set attachments.maxBytes. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Human-readable "N.N MB" for a byte count (always MB, matching the skip-reason wording). */
export function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** undefined when `bytes` fits under `maxBytes`, else a "too large (N.N MB)" reason. */
export function checkAttachmentSize(bytes: number, maxBytes: number): string | undefined {
  return bytes > maxBytes ? `too large (${formatMB(bytes)})` : undefined
}

/**
 * Sanitize a filename for safe on-disk storage: strips any directory components (so
 * "../../etc/passwd" becomes "passwd") and replaces anything but safe characters with "_".
 * Never returns an empty string or one that starts with ".".
 */
export function sanitizeAttachmentFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).trim()
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_')
  return cleaned || 'file'
}

/**
 * Resolve `filePath` (absolute, or relative to the agent's workspace) and verify the
 * REAL path (symlinks followed) lies inside that workspace. Returns the resolved real
 * path, or undefined when the file does not exist or would escape the workspace
 * (including via a symlink pointing outside it).
 */
export function resolveInWorkspace(root: string, agentName: string, filePath: string): string | undefined {
  const ws = workspaceDir(root, agentName)
  fs.mkdirSync(ws, { recursive: true })
  const wsReal = fs.realpathSync(ws)
  const abs = path.isAbsolute(filePath) ? filePath : path.join(ws, filePath)
  let real: string
  try {
    real = fs.realpathSync(abs)
  } catch {
    return undefined
  }
  if (real !== wsReal && !real.startsWith(wsReal + path.sep)) return undefined
  return real
}

/** Create the brain git repo with a wiki skeleton if missing. */
export function ensureBrain(root: string): void {
  const dir = brainDir(root)
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'wiki'), { recursive: true })
  const seed: Record<string, string> = {
    'README.md': '# Office brain\n\nPer-agent memory (`agents/<name>/`) and the shared wiki (`wiki/`). Markdown in git: fork = copy, merge = 3-way merge.\n',
    'wiki/roles.md': '# Roles\n\nThere is no lead. Agents define roles here when useful: role, owner(s), responsibilities, since when.\n',
    'wiki/how-we-work.md': '# How we work\n\nTeam conventions agreed in chat. Add a line with date + link to the discussion when something is decided.\n',
  }
  for (const [rel, body] of Object.entries(seed)) {
    const f = path.join(dir, rel)
    if (!fs.existsSync(f)) fs.writeFileSync(f, body)
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    commitBrain(root, 'Initialise office brain')
  }
}

export function commitBrain(root: string, message: string): void {
  const dir = brainDir(root)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  try {
    execFileSync('git', ['-c', 'user.name=office', '-c', 'user.email=office@office.local', 'commit', '-q', '-m', message], { cwd: dir, stdio: 'ignore' })
  } catch { /* nothing to commit */ }
}

/** Seed persona/memory/journal for a newly hired agent (no-op for existing files). */
export function seedAgentBrain(root: string, rec: AgentRecord, focus: string): void {
  const dir = agentBrainDir(root, rec.name)
  fs.mkdirSync(dir, { recursive: true })
  const vars = { name: rec.name, displayName: rec.displayName, harness: rec.harness, model: rec.model, date: rec.createdAt.slice(0, 10), focus: focus || 'general' }
  const files: Record<string, string> = {
    'persona.md': fill(fs.readFileSync(path.join(root, 'templates/persona.md'), 'utf8'), vars),
    'memory.md': fill(fs.readFileSync(path.join(root, 'templates/memory.md'), 'utf8'), vars),
    'journal.md': `# Journal of @${rec.name}\n\n- ${vars.date}: hired (${rec.harness}, ${rec.model}).\n`,
  }
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel)
    if (!fs.existsSync(f)) fs.writeFileSync(f, body)
  }
}

/** Read the first "Initial focus" line from an agent's persona.md. */
function readFocus(root: string, name: string): string {
  try {
    const text = fs.readFileSync(path.join(agentBrainDir(root, name), 'persona.md'), 'utf8')
    const m = /Initial focus:\s*(.*)/.exec(text)
    return m?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/** Build a "Your colleagues" section from hired agent records, including their projects. */
export async function buildColleaguesSection(root: string, cfg: OfficeConfig, self: AgentRecord): Promise<string> {
  const names = await listAgents()
  const recs = (await Promise.all(names.map(n => loadAgent(n)))).filter(Boolean) as AgentRecord[]
  const hired = recs.filter(r => r.status === 'hired' && r.name !== self.name)
  const projects = await listProjects(root)
  const projectsByMember = (username: string) => projects.filter(p => !p.archived && p.members.includes(username)).map(p => p.name)
  const lines = hired.map(r => {
    const focus = readFocus(root, r.name)
    const forkNote = r.forkedFrom ? ` (fork of @${r.forkedFrom.parent})` : ''
    const memberOf = projectsByMember(r.name)
    const projectsPart = memberOf.length ? `; projects: ${memberOf.join(', ')}` : ''
    return `- @${r.name} (${r.displayName}) — ${r.harness}, ${r.model}${forkNote}; focus: ${focus || 'general'}${projectsPart}`
  })
  lines.push(`- @${cfg.human.username} (${cfg.human.displayName}) — human owner`)
  let members: ReturnType<typeof loadMembers> = []
  try { members = activeMembers(loadMembers(root)) } catch { /* an invalid roster must not block a session start */ }
  for (const m of members) {
    lines.push(`- @${m.username} (${m.displayName}) — invited member (a person, not the owner); projects: ${m.projects.join(', ') || 'none'}`)
  }
  return ['## Your colleagues', lines.join('\n')].join('\n')
}

/** (Re)generate the instruction file the harness reads at session start. */
export async function writeWorkspaceInstructions(root: string, cfg: OfficeConfig, rec: AgentRecord): Promise<string> {
  const ws = workspaceDir(root, rec.name)
  fs.mkdirSync(ws, { recursive: true })
  // Own git repo: keeps the agent's git commands (and opencode's project scoping) out of the office repo.
  if (!fs.existsSync(path.join(ws, '.git'))) execFileSync('git', ['init', '-q'], { cwd: ws })
  const vars = {
    name: rec.name, displayName: rec.displayName, human: cfg.human.username, prefix: cfg.agentChannelPrefix,
    org: cfg.forgejoOrg, tickets: cfg.ticketsRepo, brain: brainDir(root),
  }
  const rules = fill(fs.readFileSync(path.join(root, 'templates/office-rules.md'), 'utf8'), vars)
  const read = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
  const colleagues = await buildColleaguesSection(root, cfg, rec)
  const body = [
    `<!-- Generated by \`office\` at each session start. Do not edit: change ${agentBrainDir(root, rec.name)}/*.md instead. -->`,
    rules,
    '---',
    colleagues,
    '---',
    '# Your persona (brain/agents/' + rec.name + '/persona.md)',
    read(path.join(agentBrainDir(root, rec.name), 'persona.md')),
    '---',
    '# Your memory (brain/agents/' + rec.name + '/memory.md)',
    read(path.join(agentBrainDir(root, rec.name), 'memory.md')),
  ].join('\n\n')
  const file = path.join(ws, rec.harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')
  fs.writeFileSync(file, body)
  return file
}

/** Shell-quote a value for a POSIX env-var assignment. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Prepare per-agent git identity and credentials, returning an env prefix to
 * prepend to the harness launch command.
 */
export async function prepareAgentGitIdentity(root: string, cfg: OfficeConfig, rec: AgentRecord): Promise<string> {
  const dir = agentStateDir(rec.name)
  fs.mkdirSync(dir, { recursive: true })
  const credFile = path.join(dir, 'git-credentials')
  const credLine = `http://${rec.name}:${rec.forgejo.token}@${cfg.forgejoUrl.replace(/^https?:\/\//, '')}\n`
  await writeFile(credFile, credLine)
  await chmod(credFile, 0o600)

  const ws = workspaceDir(root, rec.name)
  fs.mkdirSync(ws, { recursive: true })
  const gitName = `${rec.displayName} (agent)`
  const gitEmail = `${rec.name}@office.local`
  execFileSync('git', ['config', 'user.name', gitName], { cwd: ws })
  execFileSync('git', ['config', 'user.email', gitEmail], { cwd: ws })

  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: gitName,
    GIT_COMMITTER_NAME: gitName,
    GIT_AUTHOR_EMAIL: gitEmail,
    GIT_COMMITTER_EMAIL: gitEmail,
  }

  const gitConfigKeys: string[] = []
  const gitConfigValues: string[] = []

  gitConfigKeys.push(`credential.${cfg.forgejoUrl}.helper`)
  gitConfigValues.push(`store --file=${credFile}`)

  if (!cfg.git.allowGithubPush) {
    gitConfigKeys.push('url.https://push-blocked.invalid/.pushInsteadOf', 'url.https://push-blocked.invalid/.pushInsteadOf')
    gitConfigValues.push('https://github.com/', 'git@github.com:')
    env.GH_TOKEN = 'blocked-by-agent-office'
  }

  env.GIT_CONFIG_COUNT = String(gitConfigKeys.length)
  for (let i = 0; i < gitConfigKeys.length; i++) {
    env[`GIT_CONFIG_KEY_${i}`] = gitConfigKeys[i]
    env[`GIT_CONFIG_VALUE_${i}`] = gitConfigValues[i]
  }

  return Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`).join(' ') + ' '
}
