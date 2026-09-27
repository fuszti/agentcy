// Claude Code transcript access: project directory slugs, session file lookup
// and JSONL parsing into the harness-neutral TranscriptEntry view (fork/merge).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TranscriptEntry } from './types.js'

/** Root of the Claude Code project store (~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects). */
export function claudeProjectsDir(): string {
  const root = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(root, 'projects')
}

const SLUG_MAX = 200

/** int32 string hash used by Claude Code for long-path suffixes (31*h + c). */
function hash31(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}

/** Directory name Claude Code uses for a cwd (verified against real project dirs). */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= SLUG_MAX) return slug
  return `${slug.slice(0, SLUG_MAX)}-${Math.abs(hash31(cwd)).toString(36)}`
}

/** Expected path of the session transcript for a cwd + session id. */
export function claudeSessionFile(cwd: string, sessionId: string): string {
  return path.join(claudeProjectsDir(), claudeProjectSlug(cwd), `${sessionId}.jsonl`)
}

/** Find a session transcript by id anywhere under the projects dir (read-only scan). */
export function findClaudeSessionFile(sessionId: string): string | undefined {
  const root = claudeProjectsDir()
  let projects: fs.Dirent[]
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  const names = projects
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  for (const name of names) {
    const file = path.join(root, name, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return undefined
}

// ---------------------------------------------------------------- JSONL parsing

interface JsonPart {
  type?: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface JsonLine {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  isApiErrorMessage?: boolean
  timestamp?: string
  message?: { role?: string; id?: string; content?: string | JsonPart[] }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const p of content as JsonPart[]) {
      if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
      else if (p.type === 'image') parts.push('[image]')
    }
    return parts.join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function textParts(parts: JsonPart[]): string {
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p.text ?? '').replace(SYSTEM_REMINDER, ''))
    .join('\n\n')
    .trim()
}

/**
 * Parse a Claude Code session JSONL into conversation entries: real user/assistant
 * messages only, tool_use/tool_result pairs folded into the assistant turn.
 */
export function readClaudeTranscript(file: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const toolSlot = new Map<string, { entry: TranscriptEntry; index: number }>()
  let last: TranscriptEntry | null = null
  let lastMessageId: string | undefined

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let o: JsonLine
    try {
      o = JSON.parse(line) as JsonLine
    } catch {
      continue
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue
    if (o.isMeta || o.isSidechain || o.isApiErrorMessage) continue
    const msg = o.message
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue
    const raw = msg.content
    const parts: JsonPart[] = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? [{ type: 'text', text: raw }]
        : []

    if (o.type === 'assistant') {
      const sameTurn = last !== null && last.role === 'assistant' && msg.id !== undefined && msg.id === lastMessageId
      const entry: TranscriptEntry = sameTurn
        ? (last as TranscriptEntry)
        : { role: 'assistant', text: '', tools: [], at: o.timestamp }
      if (!sameTurn) {
        entries.push(entry)
        last = entry
        lastMessageId = msg.id
      }
      for (const p of parts) {
        if (p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '') {
          entry.text = entry.text === '' ? p.text : `${entry.text}\n\n${p.text}`
        } else if (p.type === 'tool_use' && typeof p.name === 'string') {
          const tool = {
            name: p.name,
            input: JSON.stringify(p.input ?? {}),
            result: undefined as string | undefined,
            isError: undefined as boolean | undefined
          }
          if (p.id !== undefined) toolSlot.set(p.id, { entry, index: entry.tools.length })
          entry.tools.push(tool)
        }
      }
      continue
    }

    // user line: fold tool_result parts into the matching assistant tools
    for (const p of parts) {
      if (p.type !== 'tool_result') continue
      const slot = toolSlot.get(String(p.tool_use_id ?? ''))
      if (!slot) continue
      slot.entry.tools[slot.index].result = resultText(p.content)
      if (p.is_error) slot.entry.tools[slot.index].isError = true
    }
    const text = textParts(parts)
    if (text === '') continue
    const entry: TranscriptEntry = { role: 'user', text, tools: [], at: o.timestamp }
    entries.push(entry)
    last = entry
    lastMessageId = undefined
  }

  return entries.filter((e) => e.text !== '' || e.tools.length > 0)
}

// ---------------------------------------------------------------- rendering

export interface RenderTranscriptOptions {
  /** Budget for the whole rendered text (default 20000). */
  maxChars?: number
  /** Per-tool input budget (default 200). */
  toolInputChars?: number
  /** Per-tool result budget (default 400). */
  toolResultChars?: number
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function renderEntry(e: TranscriptEntry, toolInputChars: number, toolResultChars: number): string {
  const lines = [`${e.role === 'user' ? 'USER' : 'ASSISTANT'}: ${e.text}`]
  for (const t of e.tools) {
    const result = t.result === undefined ? '(no result)' : clip(t.result, toolResultChars)
    lines.push(`  ↳ tool ${t.name}(${clip(t.input, toolInputChars)}) ⇒ ${t.isError ? 'error: ' : ''}${result}`)
  }
  return lines.join('\n')
}

/**
 * Compact transcript text for merge/inspection. When over maxChars the head
 * (first 20% of the entries) and the tail are kept, with an omission marker between.
 */
export function renderTranscript(entries: TranscriptEntry[], opts?: RenderTranscriptOptions): string {
  const maxChars = opts?.maxChars ?? 20_000
  const toolInputChars = opts?.toolInputChars ?? 200
  const toolResultChars = opts?.toolResultChars ?? 400
  const blocks = entries.map((e) => renderEntry(e, toolInputChars, toolResultChars))
  const all = blocks.join('\n')
  if (all.length <= maxChars) return all

  const headCount = Math.max(1, Math.floor(entries.length * 0.2))
  const head = blocks.slice(0, headCount)
  const tail: string[] = []
  const markerReserve = 40
  let used = head.join('\n').length + markerReserve
  for (let i = blocks.length - 1; i >= headCount; i--) {
    const extra = 1 + blocks[i].length
    if (used + extra > maxChars && tail.length > 0) break
    tail.unshift(blocks[i])
    used += extra
    if (used >= maxChars) break
  }
  const omitted = entries.length - headCount - tail.length
  return [...head, `… [${String(omitted)} entries omitted] …`, ...tail].join('\n')
}
