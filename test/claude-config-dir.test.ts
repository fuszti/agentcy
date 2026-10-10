import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentRecord } from '../src/lib/types.js'
import { claudeLaunchCommand, claudeSessionExists, type ClaudeLaunch } from '../src/lib/harness/claude.js'
import { readAgentClaudeTokenUsage, readClaudeAccountInfo } from '../src/finance/claude.js'
import { claudeUsageCacheFile, probeCommand } from '../src/finance/claude-usage-probe.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-dir-test-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

function writeSession(configDir: string, slug: string, sessionId: string, lines: unknown[] = []): string {
  const file = path.join(configDir, 'projects', slug, `${sessionId}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('claudeSessionExists(configDir)', () => {
  const cfgA = path.join(tmp, 'exists-a')
  const cfgB = path.join(tmp, 'exists-b')
  writeSession(cfgA, '-w-a', 'ses-in-a')
  writeSession(cfgB, '-w-b', 'ses-in-b')

  it('looks in the given config dir, not the env one', () => {
    withEnv('CLAUDE_CONFIG_DIR', cfgA, () => {
      expect(claudeSessionExists('ses-in-b', cfgB)).toBe(true)
      expect(claudeSessionExists('ses-in-a', cfgB)).toBe(false)
    })
  })

  it('falls back to CLAUDE_CONFIG_DIR without a configDir', () => {
    withEnv('CLAUDE_CONFIG_DIR', cfgA, () => {
      expect(claudeSessionExists('ses-in-a')).toBe(true)
      expect(claudeSessionExists('ses-in-b')).toBe(false)
    })
  })

  it('is false for a config dir with no projects dir', () => {
    expect(claudeSessionExists('ses-in-a', path.join(tmp, 'no-such-dir'))).toBe(false)
  })
})

describe('claudeLaunchCommand configDir', () => {
  const agent: AgentRecord = {
    name: 'ada',
    displayName: 'Ada',
    harness: 'claude',
    model: 'sonnet',
    status: 'hired',
    pastSessions: [],
    chrome: false,
    mattermost: { userId: 'u1', token: 't1' },
    forgejo: { token: 'f1' },
    createdAt: '2026-09-28T00:00:00.000Z',
  }
  const base: ClaudeLaunch = {
    root: '/office',
    agent,
    workspace: '/office/workspaces/ada',
    settingsFile: '/office/state/agents/ada/settings.json',
    mcpFile: '/office/state/agents/ada/mcp.json',
    mode: { kind: 'new', sessionId: 'ses-1' },
    envPrefix: "GIT_AUTHOR_NAME='Ada' ",
  }

  /** Split into the `cd … &&` part and the `exec env … ` part before `claude`. */
  function parts(cmd: string): { cd: string; env: string } {
    const m = /^(cd .*?) && exec (.*?)claude --session-id /.exec(cmd)
    expect(m, cmd).not.toBeNull()
    return { cd: m![1], env: m![2] }
  }

  /** Evaluate the env part in a real shell and return what CLAUDE_CONFIG_DIR the harness would see. */
  function shellValue(envPart: string): string {
    return execFileSync('bash', ['-c', `exec ${envPart}printenv CLAUDE_CONFIG_DIR`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    }).replace(/\n$/, '')
  }

  it('puts CLAUDE_CONFIG_DIR on the exec env of the harness command, not on cd', () => {
    const cmd = claudeLaunchCommand({ ...base, configDir: '/cfg/claude-b' })
    const { cd, env } = parts(cmd)
    expect(cd).not.toContain('CLAUDE_CONFIG_DIR')
    expect(env.startsWith('env ')).toBe(true)
    expect(env).toContain("CLAUDE_CONFIG_DIR='/cfg/claude-b'")
    expect(env).toContain("GIT_AUTHOR_NAME='Ada'")
    expect(shellValue(env)).toBe('/cfg/claude-b')
  })

  it('works without an envPrefix', () => {
    const cmd = claudeLaunchCommand({ ...base, envPrefix: undefined, configDir: '/cfg/claude-b' })
    const { env } = parts(cmd)
    expect(env.startsWith('env ')).toBe(true)
    expect(env).toContain("CLAUDE_CONFIG_DIR='/cfg/claude-b'")
    expect(shellValue(env)).toBe('/cfg/claude-b')
  })

  it('shell-quotes a path with spaces and quotes safely', () => {
    const dir = "/tmp/my cfg/it's $HOME `x`"
    const cmd = claudeLaunchCommand({ ...base, configDir: dir })
    const { env } = parts(cmd)
    expect(shellValue(env)).toBe(dir)
  })

  it('omits CLAUDE_CONFIG_DIR without configDir and keeps the envPrefix', () => {
    const cmd = claudeLaunchCommand(base)
    expect(cmd).not.toContain('CLAUDE_CONFIG_DIR')
    const { env } = parts(cmd)
    expect(env).toContain("GIT_AUTHOR_NAME='Ada'")
    expect(cmd).toBe(claudeLaunchCommand({ ...base, configDir: undefined }))
  })
})

describe('probeCommand', () => {
  it('is the plain probe without a dir', () => {
    expect(probeCommand()).toBe('claude --model haiku --strict-mcp-config')
    expect(probeCommand(undefined)).toBe('claude --model haiku --strict-mcp-config')
  })

  it('prefixes env CLAUDE_CONFIG_DIR with a dir', () => {
    expect(probeCommand('/home/me/.claude-b')).toBe("env CLAUDE_CONFIG_DIR='/home/me/.claude-b' claude --model haiku --strict-mcp-config")
  })
})

describe('claudeUsageCacheFile', () => {
  it('is claude-usage.json for the default group', () => {
    expect(claudeUsageCacheFile('/office')).toBe(path.join('/office', 'state/finance/claude-usage.json'))
    expect(claudeUsageCacheFile('/office')).toBe('/office/state/finance/claude-usage.json')
  })

  it('is claude-usage-<groupId>.json for a group id', () => {
    expect(claudeUsageCacheFile('/office', 'claude-b')).toBe('/office/state/finance/claude-usage-claude-b.json')
  })
})

describe('readAgentClaudeTokenUsage across config dirs', () => {
  const usageLine = (input: number, output: number) => ({
    type: 'assistant',
    timestamp: '2026-09-27T10:00:00.000Z',
    message: { model: 'claude-sonnet-4-5', usage: { input_tokens: input, output_tokens: output } },
  })
  const cfgA = path.join(tmp, 'usage-a')
  const cfgB = path.join(tmp, 'usage-b')
  const cfgEnv = path.join(tmp, 'usage-env')
  // s1 lives in both A and B (e.g. a copied session): A must win when listed first.
  writeSession(cfgA, '-w-ada', 's1', [usageLine(100, 10)])
  writeSession(cfgB, '-w-ada', 's1', [usageLine(999, 999)])
  writeSession(cfgB, '-w-ada', 's2', [usageLine(20, 2)])
  writeSession(cfgEnv, '-w-ada', 's3', [usageLine(7, 1)])

  it('searches each dir in order, first hit per session id', () => {
    const rows = readAgentClaudeTokenUsage('ada', ['s1', 's2'], [cfgA, cfgB])
    expect(rows.map((r) => r.inputTokens).sort((a, b) => a - b)).toEqual([20, 100])
    expect(rows.every((r) => r.agent === 'ada')).toBe(true)
  })

  it('honours the order of the dirs', () => {
    const rows = readAgentClaudeTokenUsage('ada', ['s1'], [cfgB, cfgA])
    expect(rows.map((r) => r.inputTokens)).toEqual([999])
  })

  it('undefined in the list means the env/default dir', () => {
    withEnv('CLAUDE_CONFIG_DIR', cfgEnv, () => {
      const rows = readAgentClaudeTokenUsage('ada', ['s1', 's3'], [cfgA, undefined])
      expect(rows.map((r) => r.inputTokens).sort((a, b) => a - b)).toEqual([7, 100])
    })
  })

  it('defaults to the env/default dir only', () => {
    withEnv('CLAUDE_CONFIG_DIR', cfgEnv, () => {
      expect(readAgentClaudeTokenUsage('ada', ['s1', 's3']).map((r) => r.inputTokens)).toEqual([7])
    })
  })

  it('skips sessions found nowhere', () => {
    expect(readAgentClaudeTokenUsage('ada', ['nope'], [cfgA, cfgB])).toEqual([])
  })
})

describe('readClaudeAccountInfo(configDir)', () => {
  const bin = path.join(tmp, 'fake-bin')
  fs.mkdirSync(bin, { recursive: true })
  const fake = path.join(bin, 'claude')
  fs.writeFileSync(fake, '#!/bin/sh\nprintf \'{"loggedIn":true,"subscriptionType":"max","orgName":"%s"}\' "${CLAUDE_CONFIG_DIR:-unset}"\n')
  fs.chmodSync(fake, 0o755)
  const fakePath = `${bin}${path.delimiter}${process.env.PATH ?? ''}`

  it('passes CLAUDE_CONFIG_DIR to the child when a dir is given', () => {
    withEnv('PATH', fakePath, () =>
      withEnv('CLAUDE_CONFIG_DIR', '/env/dir', () => {
        expect(readClaudeAccountInfo('/cfg/claude-b')).toEqual({ loggedIn: true, plan: 'max', orgName: '/cfg/claude-b' })
      })
    )
  })

  it('inherits the env without a dir (today behaviour)', () => {
    withEnv('PATH', fakePath, () => {
      withEnv('CLAUDE_CONFIG_DIR', '/env/dir', () => {
        expect(readClaudeAccountInfo()?.orgName).toBe('/env/dir')
      })
      withEnv('CLAUDE_CONFIG_DIR', undefined, () => {
        expect(readClaudeAccountInfo()?.orgName).toBe('unset')
      })
    })
  })
})
