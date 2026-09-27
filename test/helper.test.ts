import { describe, expect, it } from 'vitest'
import {
  buildCommandReference,
  buildHelperConfig,
  buildHelperPrompt,
  extractJsonBlock,
  parseModelsOutput,
  renderProposalMessage,
  shellEscape,
  stripGenerateTrigger,
  validateProposal,
} from '../src/admin/helper.js'
import type { BuildHelperPromptInput } from '../src/admin/helper.js'

describe('buildHelperPrompt', () => {
  function input(over: Partial<BuildHelperPromptInput> = {}): BuildHelperPromptInput {
    return {
      commandReference: buildCommandReference(),
      statusOutput: '| Name | Status |\n| --- | --- |\n| ada | idle |',
      pendingRequests: [],
      availableModels: ['opencode-go/deepseek-v4.1-flash'],
      helperNotes: 'notes',
      conversation: [{ role: 'owner', text: 'hire a researcher' }],
      ...over,
    }
  }

  it('includes the command reference', () => {
    const prompt = buildHelperPrompt(input())
    expect(prompt).toContain('Available office commands')
    expect(prompt).toContain('hire <name>')
    expect(prompt).toContain('"bin/office" usage:')
  })

  it('includes the status output', () => {
    const prompt = buildHelperPrompt(input())
    expect(prompt).toContain('| ada | idle |')
  })

  it('lists pending requests', () => {
    const prompt = buildHelperPrompt(input({
      pendingRequests: [{
        id: 'req_abc',
        type: 'hire',
        agent: 'ada',
        args: { name: 'rita', harness: 'opencode' },
        status: 'pending',
        createdAt: '2026-01-01T00:00:00Z',
      }],
    }))
    expect(prompt).toContain('req_abc')
    expect(prompt).toContain('@ada')
  })

  it('includes available models and Claude aliases', () => {
    const prompt = buildHelperPrompt(input())
    expect(prompt).toContain('opencode-go/deepseek-v4.1-flash')
    expect(prompt).toContain('sonnet')
    expect(prompt).toContain('opus')
    expect(prompt).toContain('haiku')
  })

  it('includes helper notes', () => {
    const prompt = buildHelperPrompt(input())
    expect(prompt).toContain('notes')
  })

  it('includes the conversation', () => {
    const prompt = buildHelperPrompt(input({
      conversation: [
        { role: 'owner', text: 'hire a researcher' },
        { role: 'helper', text: 'office hire rita --harness opencode' },
        { role: 'owner', text: 'make it cheaper' },
      ],
    }))
    expect(prompt).toContain('hire a researcher')
    expect(prompt).toContain('office hire rita')
    expect(prompt).toContain('make it cheaper')
  })

  it('requires a JSON block with the contract', () => {
    const prompt = buildHelperPrompt(input())
    expect(prompt).toContain('Reply with ONE fenced')
    expect(prompt).toContain('"commands"')
    expect(prompt).toContain('"explanation"')
    expect(prompt).toContain('"questions"')
  })
})

describe('extractJsonBlock', () => {
  it('parses a simple json block', () => {
    expect(extractJsonBlock('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('parses a block without the json label', () => {
    expect(extractJsonBlock('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('uses the LAST block when multiple are present', () => {
    expect(extractJsonBlock('```json\n{"a":1}\n```\n```json\n{"b":2}\n```')).toEqual({ b: 2 })
  })

  it('tolerates surrounding garbage', () => {
    expect(extractJsonBlock('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 })
  })

  it('returns undefined when no block exists', () => {
    expect(extractJsonBlock('no json here')).toBeUndefined()
  })

  it('returns undefined for invalid JSON', () => {
    expect(extractJsonBlock('```json\nnot json\n```')).toBeUndefined()
  })
})

describe('validateProposal', () => {
  it('accepts a valid proposal', () => {
    const parsed = { commands: [['hire', 'rita', '--harness', 'opencode']], explanation: 'Hire rita.', questions: [] }
    const result = validateProposal(parsed)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proposal.commands).toEqual([['hire', 'rita', '--harness', 'opencode']])
      expect(result.proposal.explanation).toBe('Hire rita.')
    }
  })

  it('rejects admin-stop', () => {
    const result = validateProposal({ commands: [['admin-stop']], explanation: '', questions: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('admin-stop')
  })

  it('rejects unknown commands', () => {
    const result = validateProposal({ commands: [['rm', '-rf', '/']], explanation: '', questions: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('disallowed')
  })

  it('rejects non-object output', () => {
    expect(validateProposal(null).ok).toBe(false)
    expect(validateProposal('string').ok).toBe(false)
  })

  it('rejects bad commands shape', () => {
    expect(validateProposal({ commands: 'bad', explanation: '', questions: [] }).ok).toBe(false)
    expect(validateProposal({ commands: [[]], explanation: '', questions: [] }).ok).toBe(false)
  })

  it('rejects missing explanation', () => {
    expect(validateProposal({ commands: [], questions: [] }).ok).toBe(false)
  })

  it('rejects bad questions shape', () => {
    expect(validateProposal({ commands: [], explanation: '', questions: [1] }).ok).toBe(false)
  })

  it('accepts empty commands with questions', () => {
    const result = validateProposal({ commands: [], explanation: 'Need more info.', questions: ['Which model?'] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proposal.commands).toEqual([])
      expect(result.proposal.questions).toEqual(['Which model?'])
    }
  })
})

describe('renderProposalMessage', () => {
  it('renders commands in a bash block', () => {
    const msg = renderProposalMessage({
      commands: [['hire', 'rita', '--harness', 'opencode', '--focus', 'AI trends']],
      explanation: 'Hire a researcher.',
      questions: [],
    })
    expect(msg).toContain('```bash')
    expect(msg).toContain("office hire rita --harness opencode --focus 'AI trends'")
    expect(msg).toContain('Hire a researcher.')
    expect(msg).toContain('React :white_check_mark: to run')
  })

  it('renders questions', () => {
    const msg = renderProposalMessage({
      commands: [],
      explanation: 'Need more info.',
      questions: ['Which model?', 'What focus?'],
    })
    expect(msg).not.toContain('```bash')
    expect(msg).toContain('Which model?')
    expect(msg).toContain('What focus?')
  })
})

describe('shellEscape', () => {
  it('keeps plain tokens unquoted', () => {
    expect(shellEscape(['hire', 'rita', '--harness', 'opencode'])).toBe('hire rita --harness opencode')
  })

  it('quotes tokens with spaces', () => {
    expect(shellEscape(['say', 'hello world'])).toBe("say 'hello world'")
  })
})

describe('stripGenerateTrigger', () => {
  it('strips generate, gen, and ? prefixes', () => {
    expect(stripGenerateTrigger('generate hire rita')).toBe('hire rita')
    expect(stripGenerateTrigger('gen status')).toBe('status')
    expect(stripGenerateTrigger('? who is busy')).toBe('who is busy')
  })
})

describe('buildHelperConfig', () => {
  it('denies every tool', () => {
    const cfg = buildHelperConfig() as Record<string, unknown>
    const perms = cfg.permission as Record<string, unknown>
    expect(perms.bash).toEqual({ '*': 'deny' })
    expect(perms.edit).toBe('deny')
    expect(perms.webfetch).toBe('deny')
    expect(perms.task).toBe('deny')
  })
})

describe('parseModelsOutput', () => {
  it('keeps opencode-go models', () => {
    const out = parseModelsOutput('opencode-go/kimi-k2.7-code\nopencode-go/deepseek-v4.1-flash\nopenai/gpt-4')
    expect(out).toEqual(['opencode-go/kimi-k2.7-code', 'opencode-go/deepseek-v4.1-flash'])
  })

  it('deduplicates', () => {
    const out = parseModelsOutput('opencode-go/a\nopencode-go/a')
    expect(out).toEqual(['opencode-go/a'])
  })

  it('returns empty when there are no opencode-go models', () => {
    expect(parseModelsOutput('openai/gpt-4\nanthropic/claude')).toEqual([])
  })
})
