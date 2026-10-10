// `office setup` — first-run (and re-runnable) onboarding wizard for a home-server office.
// Run by install.sh as the office user, or by hand. Needs no sudo: tools are installed by
// install.sh; this only configures Agentcy (owner, access address, keys, Claude login) and
// then initialises (or imports) the office.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import { loadConfig, saveConfig } from '../lib/config.js'
import { applyAccessMode, tailscaleServeCommands, type AccessMode } from '../lib/infra.js'
import { MOVED_PROMPT, importOffice, readManifest } from '../lib/migrate.js'
import { queueSystemPrompt } from '../lib/inbox.js'
import type { ResourceGroup } from '../lib/types.js'
import { importableFromAuthJson, listSecrets, setSecret, vaultSpecs } from '../lib/vault.js'
import { opencodeAuthFile } from '../finance/openrouter.js'
import { vaultSetInteractive } from './vault-cmd.js'
import { bootstrap } from './bootstrap.js'

// ------------------------------------------------------------------ pure helpers (tested)

export interface AddressCandidate { iface: string; addr: string }

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|lo)/

/** Private IPv4 addresses (LAN, or 100.64/10 for Tailscale) on real interfaces. */
export function privateAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): AddressCandidate[] {
  const out: AddressCandidate[] = []
  for (const [iface, infos] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(iface)) continue
    for (const i of infos ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      const [a, b] = i.address.split('.').map(Number)
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      if (isPrivate) out.push({ iface, addr: i.address })
    }
  }
  return out
}

/** DNS name + first IPv4 from `tailscale status --json`, if logged in. */
export function parseTailscaleStatus(json: string): { dnsName: string; ip?: string } | undefined {
  try {
    const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } }
    if (s.BackendState !== 'Running' || !s.Self?.DNSName) return undefined
    return { dnsName: s.Self.DNSName.replace(/\.$/, ''), ip: s.Self.TailscaleIPs?.find(ip => ip.includes('.')) }
  } catch { return undefined }
}

export const USERNAME_RE = /^[a-z][a-z0-9._-]{2,21}$/

// ------------------------------------------------------------------ interactive

function has(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

async function ask(q: string, def = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim()
    return a || def
  } finally { rl.close() }
}

async function yes(q: string, def: boolean): Promise<boolean> {
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase()
  return a ? a.startsWith('y') : def
}

async function choose<T>(q: string, options: { label: string; value: T }[], def = 1): Promise<T> {
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`))
  for (;;) {
    const n = Number(await ask(q, String(def)))
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
    console.log(`  pick 1-${options.length}`)
  }
}

function step(n: number, title: string) { console.log(`\n\x1b[1m[${n}/6] ${title}\x1b[0m`) }

function checkTools(): { harnesses: string[] } {
  const rows: [string, boolean, string][] = [
    ['docker', has('docker') && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0, 'installed and usable by this user (docker group; log out/in after adding)'],
    ['docker compose', spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0, 'compose v2 plugin'],
    ['tmux', has('tmux'), 'required'],
    ['git', has('git'), 'required'],
    ['claude', has('claude'), 'Claude Code (optional if you only use opencode)'],
    ['opencode', has('opencode'), 'opencode (optional if you only use Claude; also used for merge summaries)'],
  ]
  for (const [name, ok, hint] of rows) console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — ${hint}`}`)
  const missing = rows.slice(0, 4).filter(r => !r[1]).map(r => r[0])
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}. Run ./install.sh (it offers to install them) and log in again.`)
  const harnesses = rows.slice(4).filter(r => r[1]).map(r => r[0])
  if (!harnesses.length) throw new Error('neither claude nor opencode is installed; install at least one (./install.sh offers both)')
  return { harnesses }
}

async function pickAccess(): Promise<AccessMode> {
  const ts = has('tailscale') ? parseTailscaleStatus(spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' }).stdout ?? '') : undefined
  const lan = privateAddresses(os.networkInterfaces()).filter(c => c.addr !== ts?.ip)
  const options: { label: string; value: AccessMode }[] = []
  if (ts) options.push({ label: `Tailscale HTTPS  https://${ts.dnsName}  (recommended: works from anywhere on your tailnet, needed by the mobile app)`, value: { kind: 'tailscale', dnsName: ts.dnsName } })
  for (const c of lan) options.push({ label: `LAN  http://${c.addr}:8065  (${c.iface})`, value: { kind: 'lan', addr: c.addr } })
  options.push({ label: 'This machine only  http://127.0.0.1:8065  (use an SSH tunnel from other machines)', value: { kind: 'local' } })
  console.log('How will you open the office (chat + tickets) from your laptop/phone?')
  const mode = await choose('Choice', options)
  if (mode.kind === 'lan') {
    const host = await ask('Hostname to use in links instead of the IP (e.g. nas.lan; empty = use the IP)')
    if (host) mode.host = host
  }
  return mode
}

async function providerKeys(root: string, groups: ResourceGroup[]): Promise<void> {
  const auth = opencodeAuthFile()
  if (fs.existsSync(auth)) {
    const found = importableFromAuthJson(fs.readFileSync(auth, 'utf8'), groups)
    if (found.length && await yes(`Import ${found.map(f => f.id).join(', ')} from this machine's opencode login into the vault?`, true)) {
      for (const f of found) setSecret(root, f.id, f.value, groups)
    }
  }
  const set = new Set(listSecrets(root, groups).filter(e => e.set).map(e => e.id))
  // opencode-harness entries only: its groups (opencode-go / openrouter) plus opencode-zen, never anthropic or a Claude group.
  const offered = vaultSpecs(groups).filter(s => s.harness === 'opencode' && s.id !== 'anthropic')
  for (const s of offered) {
    const prompt = set.has(s.id) ? `${s.label}: already in the vault. Replace it?` : `Add an ${s.label} API key?`
    if (await yes(prompt, false)) console.log('  ' + await vaultSetInteractive(root, groups, s.id))
  }
  console.log('  (more later: `office vault set <id>`; see `office vault`)')
}

async function claudeLogin(): Promise<void> {
  const st = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' })
  let loggedIn = false
  try { loggedIn = JSON.parse(st.stdout).loggedIn === true } catch { /* not JSON = not logged in */ }
  if (loggedIn) { console.log('  ✓ Claude Code is logged in for this user'); return }
  console.log('  Claude Code is not logged in for this user. Each machine logs in by itself;')
  console.log('  Agentcy never copies Claude subscription credentials between machines.')
  if (await yes('Log in now (opens a URL to confirm in your browser)?', true)) {
    spawnSync('claude', ['auth', 'login'], { stdio: 'inherit' })
  } else {
    console.log('  later: run `claude auth login` as this user before hiring Claude agents')
  }
}

export async function runSetup(root: string, flags: Record<string, string | boolean>): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('office setup is interactive: run it in a terminal on the office server')
  console.log(`\x1b[1mAgentcy setup\x1b[0m — office at ${root} (user ${os.userInfo().username})`)
  console.log('Re-running is safe: it only changes what you choose to change.')

  step(1, 'Tools')
  const { harnesses } = checkTools()

  step(2, 'New office or move an existing one')
  const initialised = fs.existsSync(path.join(root, 'state', 'office.json'))
  let importDir = typeof flags.import === 'string' ? flags.import : undefined
  if (initialised) {
    console.log('  This machine already has an office: reconfiguring access, keys and login only.')
  } else if (!importDir) {
    const how = await choose('Choice', [
      { label: 'Start a new, empty office', value: 'new' },
      { label: 'Import an office exported with `office export` (e.g. from your laptop)', value: 'import' },
    ])
    if (how === 'import') importDir = await ask('Path to the export directory on this machine')
  }
  if (importDir) {
    const m = readManifest(path.resolve(importDir))
    console.log(`  export from ${m.sourceRoot}, ${m.createdAt.slice(0, 16)}, agents: ${m.agents.join(', ') || '(none)'}`)
    const { moved } = importOffice(root, path.resolve(importDir), { force: flags.force === true })
    for (const name of moved) await queueSystemPrompt(root, name, 'moved', MOVED_PROMPT)
    console.log(`  ✓ imported; ${moved.length} agent(s) will start fresh sessions from their brains`)
  }

  const cfg = await loadConfig()
  step(3, 'Owner account')
  if (!initialised && !importDir) {
    let username = ''
    while (!USERNAME_RE.test(username)) username = (await ask('Your chat/tickets username', cfg.human.username)).toLowerCase()
    cfg.human = { username, displayName: await ask('Display name', cfg.human.displayName === 'Owner' ? username : cfg.human.displayName) }
  } else {
    console.log(`  owner: @${cfg.human.username} (unchanged)`)
  }

  step(4, 'Access from your other devices')
  const mode = await pickAccess()
  cfg.publicUrls = applyAccessMode(root, mode)
  await saveConfig(cfg)

  step(5, 'AI provider keys (encrypted vault)')
  if (harnesses.includes('opencode')) await providerKeys(root, cfg.resourceGroups)
  else console.log('  opencode not installed; skipping API keys')

  step(6, 'Claude login')
  if (harnesses.includes('claude')) await claudeLogin()
  else console.log('  claude not installed; skipping')

  console.log('\n\x1b[1mStarting the stack and initialising the office…\x1b[0m')
  await bootstrap()

  if (mode.kind === 'tailscale') {
    for (const cmd of tailscaleServeCommands()) {
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' })
      if (r.status !== 0) console.log(`  could not run \`${cmd.join(' ')}\`; run it with sudo, or once: sudo tailscale set --operator=${os.userInfo().username}`)
    }
  }

  console.log(`\n\x1b[1mDone.\x1b[0m
  Chat:     ${cfg.publicUrls.mattermost}   (log in as @${cfg.human.username}; password above, also in state/office.json)
  Tickets:  ${cfg.publicUrls.forgejo}
  Admin:    #${cfg.adminChannel} in chat — type \`help\`. \`vault\` shows key status.
  Next:     \`office hire <name>\` here, or \`hire <name>\` in #${cfg.adminChannel}; \`office start\` starts everything.`)
}
