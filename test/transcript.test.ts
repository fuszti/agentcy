import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../src/lib/types.js'
import {
  claudeProjectSlug,
  claudeProjectsDir,
  claudeSessionFile,
  copyClaudeSession,
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

function withConfigDir<T>(dir: string | undefined, fn: () => T): T {
  const prev = process.env.CLAUDE_CONFIG_DIR
  if (dir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = dir
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  }
}

describe('explicit configDir', () => {
  it('claudeProjectsDir(configDir) wins over CLAUDE_CONFIG_DIR', () => {
    withConfigDir(path.join(tmp, 'env-cfg'), () => {
      expect(claudeProjectsDir(path.join(tmp, 'explicit'))).toBe(path.join(tmp, 'explicit', 'projects'))
      expect(claudeProjectsDir(undefined)).toBe(path.join(tmp, 'env-cfg', 'projects'))
    })
  })

  it('claudeSessionFile uses the given configDir', () => {
    withConfigDir(path.join(tmp, 'env-cfg'), () => {
      expect(claudeSessionFile('/w/space', 'ses-1', path.join(tmp, 'explicit'))).toBe(
        path.join(tmp, 'explicit', 'projects', '-w-space', 'ses-1.jsonl')
      )
    })
  })

  it('findClaudeSessionFile scans only the given configDir', () => {
    const cfgA = path.join(tmp, 'find-a')
    const cfgB = path.join(tmp, 'find-b')
    const fileA = path.join(cfgA, 'projects', '-w-a', 'ses-a.jsonl')
    const fileB = path.join(cfgB, 'projects', '-w-b', 'ses-b.jsonl')
    fs.mkdirSync(path.dirname(fileA), { recursive: true })
    fs.mkdirSync(path.dirname(fileB), { recursive: true })
    fs.writeFileSync(fileA, '')
    fs.writeFileSync(fileB, '')
    withConfigDir(cfgA, () => {
      expect(findClaudeSessionFile('ses-b', cfgB)).toBe(fileB)
      expect(findClaudeSessionFile('ses-a', cfgB)).toBeUndefined()
      // undefined = env/default dir, as before
      expect(findClaudeSessionFile('ses-a')).toBe(fileA)
      expect(findClaudeSessionFile('ses-a', undefined)).toBe(fileA)
    })
  })
})

describe('copyClaudeSession', () => {
  let n = 0
  function dirs() {
    n++
    const from = path.join(tmp, `copy-from-${String(n)}`)
    const to = path.join(tmp, `copy-to-${String(n)}`)
    return { from, to }
  }

  it('copies the transcript into toDir under the cwd slug, creating dirs', () => {
    const { from, to } = dirs()
    const src = path.join(from, 'projects', '-some-other-cwd', 'ses-c.jsonl')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, '{"type":"user"}\n')
    const ok = copyClaudeSession({ sessionId: 'ses-c', cwd: '/w/agent ws', fromDir: from, toDir: to })
    expect(ok).toBe(true)
    const dest = path.join(to, 'projects', '-w-agent-ws', 'ses-c.jsonl')
    expect(dest).toBe(claudeSessionFile('/w/agent ws', 'ses-c', to))
    expect(fs.readFileSync(dest, 'utf8')).toBe('{"type":"user"}\n')
    // source is left in place
    expect(fs.existsSync(src)).toBe(true)
  })

  it('copies a sibling <sessionId>/ directory recursively when present', () => {
    const { from, to } = dirs()
    const projDir = path.join(from, 'projects', '-src')
    fs.mkdirSync(path.join(projDir, 'ses-d', 'subagents'), { recursive: true })
    fs.mkdirSync(path.join(projDir, 'ses-d', 'tool-results'), { recursive: true })
    fs.writeFileSync(path.join(projDir, 'ses-d.jsonl'), 'main\n')
    fs.writeFileSync(path.join(projDir, 'ses-d', 'subagents', 'agent-1.jsonl'), 'sub\n')
    fs.writeFileSync(path.join(projDir, 'ses-d', 'tool-results', 'r.txt'), 'result')
    expect(copyClaudeSession({ sessionId: 'ses-d', cwd: '/w/dst', fromDir: from, toDir: to })).toBe(true)
    const destProj = path.join(to, 'projects', '-w-dst')
    expect(fs.readFileSync(path.join(destProj, 'ses-d.jsonl'), 'utf8')).toBe('main\n')
    expect(fs.readFileSync(path.join(destProj, 'ses-d', 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('sub\n')
    expect(fs.readFileSync(path.join(destProj, 'ses-d', 'tool-results', 'r.txt'), 'utf8')).toBe('result')
  })

  it('does not create a sibling dir when the source has none', () => {
    const { from, to } = dirs()
    const src = path.join(from, 'projects', '-src', 'ses-e.jsonl')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, 'x\n')
    expect(copyClaudeSession({ sessionId: 'ses-e', cwd: '/w/dst', fromDir: from, toDir: to })).toBe(true)
    expect(fs.existsSync(path.join(to, 'projects', '-w-dst', 'ses-e'))).toBe(false)
  })

  it('returns false when the session is missing in fromDir', () => {
    const { from, to } = dirs()
    fs.mkdirSync(path.join(from, 'projects', '-src'), { recursive: true })
    expect(copyClaudeSession({ sessionId: 'ses-nope', cwd: '/w/dst', fromDir: from, toDir: to })).toBe(false)
    expect(fs.existsSync(path.join(to, 'projects', '-w-dst', 'ses-nope.jsonl'))).toBe(false)
    // a fromDir with no projects dir at all is also just "not found"
    expect(copyClaudeSession({ sessionId: 'ses-nope', cwd: '/w/dst', fromDir: path.join(tmp, 'no-such-cfg'), toDir: to })).toBe(false)
  })

  it('overwrites an existing destination', () => {
    const { from, to } = dirs()
    const src = path.join(from, 'projects', '-src', 'ses-f.jsonl')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, 'new content\n')
    const dest = path.join(to, 'projects', '-w-dst', 'ses-f.jsonl')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'old content that is longer than the new one\n')
    expect(copyClaudeSession({ sessionId: 'ses-f', cwd: '/w/dst', fromDir: from, toDir: to })).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('new content\n')
  })

  it('undefined fromDir/toDir mean the env/default config dir', () => {
    const { from: envDir, to: other } = dirs()
    withConfigDir(envDir, () => {
      // from the env dir to an explicit dir
      const src = path.join(envDir, 'projects', '-src', 'ses-g.jsonl')
      fs.mkdirSync(path.dirname(src), { recursive: true })
      fs.writeFileSync(src, 'from env\n')
      expect(copyClaudeSession({ sessionId: 'ses-g', cwd: '/w/dst', toDir: other })).toBe(true)
      expect(fs.readFileSync(path.join(other, 'projects', '-w-dst', 'ses-g.jsonl'), 'utf8')).toBe('from env\n')

      // from an explicit dir to the env dir
      const src2 = path.join(other, 'projects', '-elsewhere', 'ses-h.jsonl')
      fs.mkdirSync(path.dirname(src2), { recursive: true })
      fs.writeFileSync(src2, 'to env\n')
      expect(copyClaudeSession({ sessionId: 'ses-h', cwd: '/w/back', fromDir: other })).toBe(true)
      expect(fs.readFileSync(path.join(envDir, 'projects', '-w-back', 'ses-h.jsonl'), 'utf8')).toBe('to env\n')

      // both undefined: copy within the env dir to a new cwd slug
      expect(copyClaudeSession({ sessionId: 'ses-g', cwd: '/w/moved' })).toBe(true)
      expect(fs.readFileSync(path.join(envDir, 'projects', '-w-moved', 'ses-g.jsonl'), 'utf8')).toBe('from env\n')
    })
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
