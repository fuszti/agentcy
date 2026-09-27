import { describe, expect, it } from 'vitest'
import { allowedCommands, helpText, isAllowedCommand, parseCommandLine, parseRequestId, renderStatusMarkdown } from '../src/admin/commands.js'
import type { StatusRow } from '../src/admin/commands.js'

function row(over: Partial<StatusRow> = {}): StatusRow {
  return {
    name: 'ada',
    harness: 'claude',
    model: 'sonnet',
    status: 'hired',
    window: 'up',
    state: 'idle',
    since: '12:34:56',
    pending: 0,
    session: 'sess',
    fork: '',
    ...over,
  }
}

describe('parseCommandLine', () => {
  it('parses a bare command', () => {
    expect(parseCommandLine('status')).toEqual({ kind: 'command', command: 'status', args: [] })
  })

  it('strips an optional leading office prefix', () => {
    expect(parseCommandLine('office status --all')).toEqual({ kind: 'command', command: 'status', args: ['--all'] })
    expect(parseCommandLine('office logs ada')).toEqual({ kind: 'command', command: 'logs', args: ['ada'] })
  })

  it('strips an optional leading bang', () => {
    expect(parseCommandLine('!status')).toEqual({ kind: 'command', command: 'status', args: [] })
    expect(parseCommandLine('!help')).toEqual({ kind: 'command', command: 'help', args: [] })
  })

  it('supports double-quoted arguments with spaces', () => {
    expect(parseCommandLine('say "hello world"')).toEqual({ kind: 'command', command: 'say', args: ['hello world'] })
    expect(parseCommandLine('office prompt ada "look at #12"')).toEqual({
      kind: 'command',
      command: 'prompt',
      args: ['ada', 'look at #12'],
    })
  })

  it('supports single-quoted arguments with spaces', () => {
    expect(parseCommandLine("say 'hello world'")).toEqual({ kind: 'command', command: 'say', args: ['hello world'] })
  })

  it('keeps adjacent quoted tokens separate', () => {
    expect(parseCommandLine('say "a" "b"')).toEqual({ kind: 'command', command: 'say', args: ['a', 'b'] })
  })

  it('is case-insensitive for the command name', () => {
    expect(parseCommandLine('STATUS')).toEqual({ kind: 'command', command: 'status', args: [] })
  })

  it('rejects empty input', () => {
    expect(parseCommandLine('')).toHaveProperty('error')
    expect(parseCommandLine('   ')).toHaveProperty('error')
  })

  it('rejects unmatched quotes', () => {
    expect(parseCommandLine('say "hello')).toEqual({ kind: 'error', error: expect.stringContaining('unmatched') })
  })

  it('treats disallowed commands as generate requests', () => {
    expect(parseCommandLine('rm -rf /')).toEqual({ kind: 'generate', text: 'rm -rf /' })
    expect(parseCommandLine('office rm -rf /')).toEqual({ kind: 'generate', text: 'office rm -rf /' })
    expect(parseCommandLine('!rm')).toEqual({ kind: 'generate', text: '!rm' })
  })

  it('recognises generate triggers', () => {
    expect(parseCommandLine('generate hire a researcher')).toEqual({ kind: 'generate', text: 'hire a researcher' })
    expect(parseCommandLine('gen status')).toEqual({ kind: 'generate', text: 'status' })
    expect(parseCommandLine('? who is busy')).toEqual({ kind: 'generate', text: 'who is busy' })
  })

  it('treats replies to a proposal as refinement requests', () => {
    expect(parseCommandLine('make it cheaper', { threadParentIsProposal: true })).toEqual({
      kind: 'generate',
      text: 'make it cheaper',
    })
  })
})

describe('isAllowedCommand', () => {
  it('returns true for every allowed command', () => {
    for (const c of allowedCommands) {
      expect(isAllowedCommand(c)).toBe(true)
      expect(isAllowedCommand(c.toUpperCase())).toBe(true)
    }
  })

  it('returns false for arbitrary shell commands', () => {
    expect(isAllowedCommand('rm')).toBe(false)
    expect(isAllowedCommand('bash')).toBe(false)
  })
})

describe('helpText', () => {
  it('mentions each allowed command', () => {
    for (const c of allowedCommands) {
      expect(helpText).toContain(`**${c}**`)
    }
  })
})

describe('renderStatusMarkdown', () => {
  it('renders a markdown table', () => {
    const out = renderStatusMarkdown([row()], { footer: 'chat: http://mm' })
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^\| Name \|/)
    expect(lines[1]).toMatch(/^\| --- \|/)
    expect(lines[2]).toContain('| ada | claude | sonnet | hired | up | idle |')
    expect(lines[lines.length - 1]).toBe('chat: http://mm')
  })

  it('hides retired agents unless includeRetired is true', () => {
    const rows = [row({ name: 'ada', status: 'retired' }), row({ name: 'kim' })]
    const out = renderStatusMarkdown(rows, { footer: '' })
    expect(out).not.toContain('ada')
    expect(out).toContain('kim')
    const all = renderStatusMarkdown(rows, { footer: '', includeRetired: true })
    expect(all).toContain('ada')
    expect(all).toContain('kim')
  })

  it('includes the footer when provided', () => {
    expect(renderStatusMarkdown([], { footer: 'FROZEN' })).toContain('FROZEN')
  })

  it('renders pending as a number', () => {
    const out = renderStatusMarkdown([row({ pending: 3 })], { footer: '' })
    expect(out).toContain('| 3 |')
  })
})

describe('parseRequestId', () => {
  it('parses a valid request id', () => {
    expect(parseRequestId(['req_abc123'])).toEqual({ id: 'req_abc123' })
  })

  it('errors on missing id', () => {
    expect(parseRequestId([])).toHaveProperty('error')
  })

  it('errors on invalid id characters', () => {
    expect(parseRequestId(['../secret'])).toHaveProperty('error')
    expect(parseRequestId(['req_abc!'])).toHaveProperty('error')
  })
})
