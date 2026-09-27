// Minimal tmux helpers. One tmux session hosts one window per agent.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await run('tmux', args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/**
 * Run tmux without capturing output. Needed for commands that may start the tmux
 * server: the daemon inherits our stdio, so execFile would wait on the pipe forever.
 */
function tmuxDetached(...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('tmux', args, { stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`tmux ${args[0]} exited with ${code}`))))
  })
}

/** Exact-match target for a window: "<session>:=<window>". */
export function windowTarget(session: string, window: string): string {
  return `${session}:=${window}`
}

export async function hasSession(session: string): Promise<boolean> {
  try { await tmux('has-session', '-t', `=${session}`); return true } catch { return false }
}

export async function windowExists(session: string, window: string): Promise<boolean> {
  try {
    const out = await tmux('list-windows', '-t', `=${session}`, '-F', '#{window_name}')
    return out.split('\n').includes(window)
  } catch { return false }
}

/** Start `command` in a new window (creating the session if needed). */
export async function openWindow(session: string, window: string, cwd: string, command: string): Promise<void> {
  if (!(await hasSession(session))) {
    await tmuxDetached('new-session', '-d', '-s', session, '-n', window, '-c', cwd, '-x', '220', '-y', '50', command)
  } else {
    await tmuxDetached('new-window', '-d', '-t', `=${session}:`, '-n', window, '-c', cwd, command)
  }
  // Keep the pane around if the harness exits so its last output stays readable.
  await tmux('set-option', '-w', '-t', windowTarget(session, window), 'remain-on-exit', 'on').catch(() => {})
}

export async function killWindow(session: string, window: string): Promise<void> {
  await tmux('kill-window', '-t', windowTarget(session, window)).catch(() => {})
}

/** Kill an entire tmux session (used for throwaway probe sessions, never the main office session). */
export async function killSession(session: string): Promise<void> {
  await tmux('kill-session', '-t', `=${session}`).catch(() => {})
}

export async function capturePane(target: string, lines = 60): Promise<string> {
  return tmux('capture-pane', '-p', '-t', target, '-S', `-${lines}`)
}

/** Is the pane's process still running (remain-on-exit keeps dead panes)? */
export async function paneAlive(target: string): Promise<boolean> {
  try {
    const out = await tmux('list-panes', '-t', target, '-F', '#{pane_dead}')
    return out.trim().split('\n')[0] === '0'
  } catch { return false }
}

/**
 * Type an optional one-line note, paste text as one bracketed paste, then press Enter.
 * The typed note matters: Claude Code treats a message that is *only* a paste as content
 * of unknown origin and may refuse to act on it; a typed note makes it the user's request.
 */
export async function pasteAndSubmit(target: string, text: string, bufferName: string, note?: string): Promise<void> {
  if (note) await tmux('send-keys', '-t', target, '-l', note.replace(/[\r\n]+/g, ' ') + ' ')
  await tmux('set-buffer', '-b', bufferName, '--', text)
  await tmux('paste-buffer', '-d', '-p', '-b', bufferName, '-t', target)
  await new Promise(r => setTimeout(r, 400))
  await tmux('send-keys', '-t', target, 'Enter')
}

export async function sendKeys(target: string, ...keys: string[]): Promise<void> {
  await tmux('send-keys', '-t', target, ...keys)
}
