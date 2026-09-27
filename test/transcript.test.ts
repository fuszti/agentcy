import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../src/lib/types.js'
import {
  claudeProjectSlug,
  claudeProjectsDir,
  claudeSessionFile,
  findClaudeSessionFile,
  readClaudeTranscript,
  renderTranscript
} from '../src/lib/transcript.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function writeFixture(name: string, lines: unknown[]): string {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('claudeProjectSlug', () => {
  // Pairs verified against real ~/.claude/projects entries on this machine.
  const cases: [string, string][] = [
    ['/home/owner/workspace/agent-office', '-home-owner-workspace-agent-office'],
    [
      '/tmp/claude-1234/-home-owner-workspace-agent-office/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/scratchpad/spike/ws1',
      '-tmp-claude-1234--home-owner-workspace-agent-office-a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d-scratchpad-spike-ws1'
    ],
    ['/home/owner/workspace/example_project', '-home-owner-workspace-example-project'],
    [
      '/home/owner/workspace/example-org/repositories/example-app/.worktrees/feature-frontend-design',
      '-home-owner-workspace-example-org-repositories-example-app--worktrees-feature-frontend-design'
    ],
    [
      '/home/owner/workspace/example-org/repositories/example-app/.worktrees/feature-testing-679/evaluation/results/pr679_requirements_coverage_retry2/move_rotate_resize_single_element',
      '-home-owner-workspace-example-org-repositories-example-app--worktrees-feature-testing-679-evaluation-results-pr679-requirements-coverage-retry2-move-rotate-resize-single-element'
    ]
  ]

  it('matches the slugs observed on this machine', () => {
    for (const [cwd, slug] of cases) {
      expect(claudeProjectSlug(cwd), cwd).toBe(slug)
    }
  })

  it('caps very long slugs at 200 chars with a hash suffix', () => {
    const cwd = '/home/owner/workspace/' + 'a_very_long_segment/'.repeat(20)
    const slug = claudeProjectSlug(cwd)
    expect(slug.length).toBeGreaterThan(200)
    expect(slug).toMatch(/^[a-zA-Z0-9-]{200}-[0-9a-z]+$/)
  })
})

describe('claudeProjectsDir / claudeSessionFile', () => {
  it('honours CLAUDE_CONFIG_DIR', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'cfg')
    try {
      expect(claudeProjectsDir()).toBe(path.join(tmp, 'cfg', 'projects'))
      expect(claudeSessionFile('/w/space', 'ses-1')).toBe(
        path.join(tmp, 'cfg', 'projects', '-w-space', 'ses-1.jsonl')
      )
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })

  it('finds a session file by scanning project dirs', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    const cfg = path.join(tmp, 'cfg2')
    const proj = path.join(cfg, 'projects', '-w-space')
    fs.mkdirSync(proj, { recursive: true })
    const file = path.join(proj, 'ses-2.jsonl')
    fs.writeFileSync(file, '')
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      expect(findClaudeSessionFile('ses-2')).toBe(file)
      expect(findClaudeSessionFile('ses-missing')).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })
})

describe('readClaudeTranscript', () => {
  const fixture = writeFixture('session.jsonl', [
    { type: 'summary', summary: 'topic', leafUuid: 'u1' },
    { type: 'attachment', attachment: { type: 'hook_success' }, isSidechain: false },
    { type: 'system', subtype: 'turn_duration', isMeta: false },
    { type: 'file-history-snapshot', snapshotId: 's1' },
    {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: generated while running local commands.' },
      timestamp: '2026-09-25T09:59:00.000Z'
    },
    {
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'subagent internal work' },
      timestamp: '2026-09-25T09:59:30.000Z'
    },
    {
      type: 'user',
      message: { role: 'user', content: 'Please run ls' },
      timestamp: '2026-09-25T10:00:00.000Z'
    },
    {
      type: 'assistant',
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'let me look' }] },
      timestamp: '2026-09-25T10:00:01.000Z'
    },
    {
      type: 'assistant',
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Running it now.' }] },
      timestamp: '2026-09-25T10:00:02.000Z'
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]
      },
      timestamp: '2026-09-25T10:00:03.000Z'
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file.txt', is_error: false }]
      },
      timestamp: '2026-09-25T10:00:04.000Z'
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_2',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'bad' } }]
      },
      timestamp: '2026-09-25T10:00:05.000Z'
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'boom' }], is_error: true }]
      },
      timestamp: '2026-09-25T10:00:06.000Z'
    },
    {
      type: 'user',
      message: { role: 'user', content: '<system-reminder>internal note</system-reminder>Thanks!' },
      timestamp: '2026-09-25T10:00:07.000Z'
    },
    {
      type: 'assistant',
      isApiErrorMessage: true,
      message: { id: 'msg_err', role: 'assistant', content: [{ type: 'text', text: 'You hit your session limit' }] },
      timestamp: '2026-09-25T10:00:08.000Z'
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data: 'aaa' } }]
      },
      timestamp: '2026-09-25T10:00:09.000Z'
    }
  ])

  const entries = readClaudeTranscript(fixture)

  it('keeps only real conversation messages', () => {
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
    expect(entries[0]).toMatchObject({ text: 'Please run ls', at: '2026-09-25T10:00:00.000Z' })
    expect(entries[3]).toMatchObject({ text: 'Thanks!' })
  })

  it('merges streamed assistant blocks of one message and drops thinking', () => {
    expect(entries[1]).toMatchObject({ role: 'assistant', text: 'Running it now.', at: '2026-09-25T10:00:01.000Z' })
  })

  it('folds tool_use + tool_result into the assistant entry', () => {
    expect(entries[1].tools).toEqual([{ name: 'Bash', input: '{"command":"ls"}', result: 'file.txt', isError: undefined }])
    expect(entries[2].tools).toEqual([{ name: 'Bash', input: '{"command":"bad"}', result: 'boom', isError: true }])
    expect(entries[2].text).toBe('')
  })
})

describe('renderTranscript', () => {
  const entries: TranscriptEntry[] = [
    {
      role: 'user',
      text: 'Please run ls',
      tools: [],
      at: '2026-09-25T10:00:00.000Z'
    },
    {
      role: 'assistant',
      text: 'Running it now.',
      tools: [{ name: 'Bash', input: '{"command":"ls"}', result: 'file.txt' }],
      at: '2026-09-25T10:00:01.000Z'
    }
  ]

  it('renders USER/ASSISTANT lines with tool arrows', () => {
    expect(renderTranscript(entries)).toBe(
      [
        'USER: Please run ls',
        'ASSISTANT: Running it now.',
        '  ↳ tool Bash({"command":"ls"}) ⇒ file.txt'
      ].join('\n')
    )
  })

  it('truncates tool inputs and results and marks errors', () => {
    const out = renderTranscript(
      [
        {
          role: 'assistant',
          text: '',
          tools: [
            { name: 'Bash', input: 'i'.repeat(300), result: 'r'.repeat(300), isError: true },
            { name: 'Read', input: '{}', result: undefined }
          ]
        }
      ],
      { toolInputChars: 10, toolResultChars: 5 }
    )
    expect(out).toContain('  ↳ tool Bash(iiiiiiiiii…) ⇒ error: rrrrr…')
    expect(out).toContain('  ↳ tool Read({}) ⇒ (no result)')
  })

  it('keeps head and tail over maxChars, with an omission marker', () => {
    const many: TranscriptEntry[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `message number ${String(i)}`,
      tools: []
    }))
    const out = renderTranscript(many, { maxChars: 200 })
    const lines = out.split('\n')
    expect(lines[0]).toBe('USER: message number 0')
    expect(lines[1]).toBe('ASSISTANT: message number 1')
    expect(lines[2]).toMatch(/^… \[\d+ entries omitted\] …$/)
    expect(lines[lines.length - 1]).toBe('ASSISTANT: message number 9')
    expect(out.length).toBeLessThanOrEqual(240)
  })
})
