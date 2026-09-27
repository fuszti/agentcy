// Claude Code harness: launch command, per-session hooks, tmux wake adapter.
// Claude agents run as interactive TUI sessions (subscription login) inside tmux.
// Channels are blocked by our org policy, so events are pasted into the TUI,
// but only when hooks report the session idle (never into an open dialog).
import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord, AgentStatus, WakeAdapter } from '../types.js'
import { capturePane, paneAlive, pasteAndSubmit, windowTarget } from '../tmux.js'

/** Pane text that means Claude is mid-turn: the spinner line, e.g. "* Ruminating… (7s · ↓ 496 tokens · thinking)". */
const BUSY_PATTERNS = [/esc to interrupt/, /…\s*\((\d+m\s*)?\d+s\s*·/]
/** Pane text that means a dialog is open and a paste would answer it. */
const DIALOG_MARKERS = ['Do you want to', '❯ 1. Yes', 'Yes, I trust this folder', 'Enter to confirm', 'Esc to cancel']

export function readStatus(statusFile: string): AgentStatus | undefined {
  try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')) as AgentStatus } catch { return undefined }
}

export function writeStatus(statusFile: string, state: AgentStatus['state'], detail = ''): void {
  const tmp = `${statusFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ state, at: new Date().toISOString(), detail }) + '\n')
  fs.renameSync(tmp, statusFile)
}

/** Settings passed with --settings: hooks that keep status.json current. */
export function claudeSettings(root: string, statusFile: string, workspace?: string): object {
  const hook = (state: string, detail = '') => [{
    hooks: [{ type: 'command', command: `${root}/scripts/hook-status.sh '${statusFile}' ${state} ${detail}`.trim(), timeout: 5 }],
  }]
  return {
    // Office + browser tools never need a prompt; everything else follows the permission mode.
    // Brain + own workspace edits are always fine (absolute paths use the // prefix).
    permissions: {
      allow: [
        'mcp__office', 'mcp__playwright',
        `Edit(/${root}/brain/**)`, `Write(/${root}/brain/**)`,
        ...(workspace ? [`Edit(/${workspace}/**)`, `Write(/${workspace}/**)`] : []),
        `Bash(git -C ${root}/brain *)`,
      ],
      deny: [
        `Read(/${root}/state/**)`, `Edit(/${root}/state/**)`, `Write(/${root}/state/**)`,
        `Read(/${root}/infra/.env)`, `Edit(/${root}/infra/.env)`, `Write(/${root}/infra/.env)`,
        `Bash(*${root}/state*)`, `Bash(*../state*)`,
        // The office CLI carries owner powers (hire/retire/merge): agents use their MCP tools instead.
        `Bash(*bin/office*)`, `Bash(*src/cli/office*)`, `Bash(*src/cli/bootstrap*)`,
      ],
    },
    hooks: {
      SessionStart: hook('idle', 'session-start'),
      UserPromptSubmit: hook('busy', 'prompt'),
      PostToolUse: hook('busy', 'tool'),
      Stop: hook('idle', 'stop'),
      Notification: [{
        matcher: 'permission_prompt|elicitation_dialog',
        hooks: [{ type: 'command', command: `${root}/scripts/hook-status.sh '${statusFile}' blocked dialog`, timeout: 5 }],
      }],
    },
  }
}

/** MCP config passed with --mcp-config (used with --strict-mcp-config). */
export function claudeMcpConfig(root: string, agent: string, opts: { playwright: boolean }): object {
  const servers: Record<string, unknown> = {
    office: {
      command: path.join(root, 'node_modules/.bin/tsx'),
      args: [path.join(root, 'src/mcp/server.ts')],
      env: { OFFICE_ROOT: root, OFFICE_AGENT: agent },
    },
  }
  if (opts.playwright) {
    servers.playwright = { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'] }
  }
  return { mcpServers: servers }
}

export interface ClaudeLaunch {
  root: string
  agent: AgentRecord
  workspace: string
  settingsFile: string
  mcpFile: string
  /** How to open the session. */
  mode: { kind: 'new'; sessionId: string } | { kind: 'resume'; sessionId: string } | { kind: 'fork'; parentSessionId: string; sessionId: string }
  /** Env-var assignments to prefix to the shell command (git identity, etc.). */
  envPrefix?: string
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Shell command run inside the agent's tmux window. */
export function claudeLaunchCommand(l: ClaudeLaunch): string {
  const args = ['claude']
  if (l.mode.kind === 'new') args.push('--session-id', l.mode.sessionId)
  if (l.mode.kind === 'resume') args.push('--resume', l.mode.sessionId)
  if (l.mode.kind === 'fork') args.push('--resume', l.mode.parentSessionId, '--fork-session', '--session-id', l.mode.sessionId)
  args.push('-n', l.agent.name, '--model', l.agent.model, '--permission-mode', 'auto',
    '--mcp-config', l.mcpFile, '--strict-mcp-config', '--settings', l.settingsFile,
    '--add-dir', path.join(l.root, 'brain'))
  if (l.agent.chrome) args.push('--chrome')
  // Env assignments must sit on the harness command itself: `A=b cd x && exec y` would give them to `cd` only.
  const env = l.envPrefix ? `env ${l.envPrefix}` : ''
  return `cd ${q(l.workspace)} && exec ${env}${args.map(a => (a.startsWith('--') || /^[\w./:-]+$/.test(a) ? a : q(a))).join(' ')}`
}

/** Does Claude Code already have a transcript for this session id (any project)? */
export function claudeSessionExists(sessionId: string): boolean {
  const base = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? '', '.claude'), 'projects')
  try {
    return fs.readdirSync(base).some(d => fs.existsSync(path.join(base, d, `${sessionId}.jsonl`)))
  } catch { return false }
}

/**
 * Answers the startup dialogs a fresh workspace shows (folder trust).
 * Polls the pane for up to `timeoutMs` and returns once the prompt box is ready.
 */
export async function settleClaudeStartup(target: string, timeoutMs = 45_000): Promise<'ready' | 'timeout' | 'dead'> {
  const { sendKeys } = await import('../tmux.js')
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!(await paneAlive(target))) return 'dead'
    const pane = await capturePane(target, 80).catch(() => '')
    if (pane.includes('Yes, I trust this folder')) {
      await sendKeys(target, 'Down'); await sendKeys(target, 'Enter')
    } else if (/manual mode|auto mode|accept edits|bypass permissions|for shortcuts|for agents/i.test(pane) && pane.includes('❯')) {
      return 'ready'
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return 'timeout'
}

/** Wake adapter for a Claude Code TUI in tmux. */
export class ClaudeTmuxWakeAdapter implements WakeAdapter {
  private readonly target: string
  constructor(private readonly opts: { tmuxSession: string; agent: string; statusFile: string; staleBusyMs?: number }) {
    this.target = windowTarget(opts.tmuxSession, opts.agent)
  }

  async isAlive(): Promise<boolean> { return paneAlive(this.target) }

  async isIdle(): Promise<boolean> {
    if (!(await this.isAlive())) return false
    const st = readStatus(this.opts.statusFile)
    const pane = await capturePane(this.target, 25).catch(() => '')
    const tail = pane.split('\n').slice(-25).join('\n')
    if (DIALOG_MARKERS.some(m => tail.includes(m))) return false
    const working = BUSY_PATTERNS.some(re => re.test(tail))
    if (!st || st.state === 'idle' || st.state === 'starting') return !working
    if (st.state === 'blocked') return false
    // busy: trust hooks while fresh; if stale (e.g. turn interrupted with Esc, no Stop hook), trust the pane.
    const age = Date.now() - Date.parse(st.at)
    return age > (this.opts.staleBusyMs ?? 90_000) && !working
  }

  async deliver(text: string): Promise<void> {
    await pasteAndSubmit(this.target, text, `office-${this.opts.agent}`,
      'Office inbox delivery from your office MCP (owner messages are marked human="true"): handle the events below per your office rules.')
    writeStatus(this.opts.statusFile, 'busy', 'delivered')
  }
}
