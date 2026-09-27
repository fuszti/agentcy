// Throwaway `/usage` probe: opens Claude Code in its own hidden tmux session (never the
// live "office" session or any agent window), reads the exact session/weekly rolling-window
// percentages, then kills the session. `/usage` makes no model call. Never pass anything but
// `--model haiku --strict-mcp-config` — no --dangerously flags, ever. Results are cached to
// disk and reused for up to CACHE_MAX_AGE_MS so this runs at most every ~10 minutes.
import fs from 'node:fs'
import path from 'node:path'
import { capturePane, killSession, openWindow, sendKeys, windowTarget } from '../lib/tmux.js'
import { settleClaudeStartup } from '../lib/harness/claude.js'
import { parseClaudeUsageOutput, type ClaudeUsageLimits } from './claude-usage.js'

export const PROBE_SESSION = 'office-probe'
const PROBE_WINDOW = 'probe'
export const CACHE_MAX_AGE_MS = 10 * 60_000

export interface ClaudeUsageCache {
  timestamp: string // ISO
  limits?: ClaudeUsageLimits
  error?: string
}

export function readUsageCache(cacheFile: string): ClaudeUsageCache | undefined {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as ClaudeUsageCache
  } catch {
    return undefined
  }
}

export function writeUsageCache(cacheFile: string, cache: ClaudeUsageCache): void {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  const tmp = `${cacheFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n')
  fs.renameSync(tmp, cacheFile)
}

export function isCacheFresh(cache: ClaudeUsageCache | undefined, now = Date.now(), maxAgeMs = CACHE_MAX_AGE_MS): boolean {
  if (!cache) return false
  const age = now - Date.parse(cache.timestamp)
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs
}

/**
 * Open a throwaway `claude` TUI in tmux session `office-probe` (cwd `state/finance/probe`),
 * answer the folder-trust dialog, wait for the prompt, run `/usage`, capture and parse the
 * result, then kill the probe session. Returns undefined on any failure (never throws).
 */
export async function runClaudeUsageProbe(root: string): Promise<ClaudeUsageLimits | undefined> {
  const cwd = path.join(root, 'state/finance/probe')
  fs.mkdirSync(cwd, { recursive: true })
  const target = windowTarget(PROBE_SESSION, PROBE_WINDOW)
  try {
    await openWindow(PROBE_SESSION, PROBE_WINDOW, cwd, 'claude --model haiku --strict-mcp-config')
    // /usage is a panel: at 50 rows its bottom ("Usage credits are on/off") is cut off.
    const { tmux } = await import('../lib/tmux.js')
    await tmux('resize-window', '-t', windowTarget(PROBE_SESSION, PROBE_WINDOW), '-y', '140').catch(() => {})
    const state = await settleClaudeStartup(target, 45_000)
    if (state !== 'ready') return undefined
    await sendKeys(target, '-l', '/usage')
    await sendKeys(target, 'Enter')
    // Give the usage screen time to render.
    await new Promise((r) => setTimeout(r, 2500))
    const pane = await capturePane(target, 80)
    const limits = parseClaudeUsageOutput(pane)
    return limits
  } catch {
    return undefined
  } finally {
    await killSession(PROBE_SESSION)
  }
}

/** Cache-aware accessor: reuses a fresh cache, otherwise runs the probe and refreshes it. */
export async function getClaudeUsageLimits(root: string, cacheFile?: string): Promise<ClaudeUsageLimits | undefined> {
  const file = cacheFile ?? path.join(root, 'state/finance/claude-usage.json')
  const cached = readUsageCache(file)
  if (isCacheFresh(cached)) return cached!.limits
  const limits = await runClaudeUsageProbe(root)
  writeUsageCache(file, { timestamp: new Date().toISOString(), limits, error: limits ? undefined : 'probe failed or timed out' })
  return limits
}
