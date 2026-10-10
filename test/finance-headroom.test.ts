import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { headroomFromSnapshot, readHeadroom, writeHeadroom } from '../src/finance/headroom.js'
import type { GroupRow, LimitRow } from '../src/finance/render.js'

function limit(groupId: string | undefined, percent: number | undefined, window = 'week'): LimitRow {
  return {
    group: 'X',
    window,
    usedText: '-',
    limitText: '-',
    percent,
    remainingText: '-',
    resets: '-',
    ...(groupId ? { groupId } : {}),
  } as LimitRow
}

function groupRow(id: string, usagePercent: number | undefined): GroupRow {
  return { id, label: id, status: 'ok', usagePercent, agents: [] }
}

describe('headroomFromSnapshot', () => {
  it('takes the max over limit rows and the group row per group id', () => {
    const out = headroomFromSnapshot(
      [
        limit('claude-sub', 40, '5-hour session'),
        limit('claude-sub', 72, 'week (all models)'),
        limit('go-2', 10, 'Rolling (5h)'),
        limit('go-2', 55, 'Monthly'),
      ],
      [groupRow('claude-sub', 30), groupRow('go-2', 80), groupRow('openrouter', 12)],
    )
    expect(out['claude-sub']).toBe(72)
    expect(out['go-2']).toBe(80)
    expect(out.openrouter).toBe(12)
  })

  it('uses limit rows alone when the group row has no %', () => {
    const out = headroomFromSnapshot([limit('claude-b', 33)], [groupRow('claude-b', undefined)])
    expect(out['claude-b']).toBe(33)
  })

  it('ignores rows with an unknown % or without a groupId', () => {
    const out = headroomFromSnapshot(
      [limit('claude-b', undefined), limit(undefined, 99)],
      [groupRow('claude-sub', 20)],
    )
    expect(out['claude-sub']).toBe(20)
    expect(out['claude-b']).toBeUndefined()
    expect(Object.values(out)).not.toContain(99)
  })

  it('is undefined for a group with nothing known', () => {
    const out = headroomFromSnapshot([], [groupRow('openrouter', undefined)])
    expect(out.openrouter).toBeUndefined()
    expect(headroomFromSnapshot([], [])).toEqual({})
  })
})

describe('writeHeadroom / readHeadroom', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const file = () => path.join(root, 'state', 'finance', 'headroom.json')

  it('round-trips through state/finance/headroom.json, creating the dirs', () => {
    const before = Date.now()
    writeHeadroom(root, { 'claude-sub': 72, 'go-2': 10, openrouter: undefined })
    expect(fs.existsSync(file())).toBe(true)
    const got = readHeadroom(root)
    expect(got).toBeDefined()
    expect(got!.usedPercent['claude-sub']).toBe(72)
    expect(got!.usedPercent['go-2']).toBe(10)
    expect(got!.usedPercent.openrouter).toBeUndefined()
    expect(typeof got!.at).toBe('string')
    expect(new Date(got!.at).toISOString()).toBe(got!.at)
    const at = Date.parse(got!.at)
    expect(at).toBeGreaterThanOrEqual(before - 1000)
    expect(at).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('overwrites a previous file', () => {
    writeHeadroom(root, { 'claude-sub': 10 })
    writeHeadroom(root, { 'claude-sub': 90 })
    expect(readHeadroom(root)!.usedPercent['claude-sub']).toBe(90)
    // Atomic write leaves no temp files behind.
    expect(fs.readdirSync(path.dirname(file()))).toEqual(['headroom.json'])
  })

  it('returns undefined when the file is missing', () => {
    expect(readHeadroom(root)).toBeUndefined()
  })

  it('returns undefined when the file is corrupt', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), '{not json')
    expect(readHeadroom(root)).toBeUndefined()
  })
})
