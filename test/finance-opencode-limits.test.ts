import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOpencodeGoGroupLimits, countOpencodeGoRequestsSince, sumOpencodeGoCostSince } from '../src/finance/opencode-limits.js'

let dbPath: string

function sqlite(sql: string) {
  execFileSync('sqlite3', [dbPath, sql])
}

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finance-oc-')), 'opencode.db')
  sqlite(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `)
})

afterEach(() => {
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

function insertStep(id: string, provider: string, model: string, tCreated: number, cost: number) {
  const msgData = JSON.stringify({ role: 'assistant', providerID: provider, modelID: model })
  const partData = JSON.stringify({ type: 'step-finish', cost })
  sqlite(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('${id}', 'ses1', ${tCreated}, ${tCreated}, '${msgData.replace(/'/g, "''")}');`)
  sqlite(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p-${id}', '${id}', 'ses1', ${tCreated}, ${tCreated}, '${partData.replace(/'/g, "''")}');`)
}

describe('countOpencodeGoRequestsSince / sumOpencodeGoCostSince', () => {
  it('counts and sums only opencode-go step-finish parts at/after the cutoff', () => {
    const now = Date.parse('2026-09-27T12:00:00Z')
    insertStep('m1', 'opencode-go', 'kimi-k2.7-code', now - 1_000, 0.02)
    insertStep('m2', 'opencode-go', 'kimi-k2.7-code', now - 6 * 3600_000, 0.05) // outside 5h window
    insertStep('m3', 'openrouter', 'some-model', now - 1_000, 1.0) // different provider, ignored

    const counts = countOpencodeGoRequestsSince(dbPath, now - 5 * 3600_000)
    expect(counts.get('kimi-k2.7-code')).toBe(1)
    expect(counts.has('some-model')).toBe(false)

    const costs = sumOpencodeGoCostSince(dbPath, now - 5 * 3600_000)
    expect(costs.get('kimi-k2.7-code')).toBeCloseTo(0.02)

    const costsWeek = sumOpencodeGoCostSince(dbPath, now - 7 * 86_400_000)
    expect(costsWeek.get('kimi-k2.7-code')).toBeCloseTo(0.07)
  })

  it('returns empty maps when the db file does not exist', () => {
    expect(countOpencodeGoRequestsSince('/no/such/file.db', 0).size).toBe(0)
    expect(sumOpencodeGoCostSince('/no/such/file.db', 0).size).toBe(0)
  })
})

describe('buildOpencodeGoGroupLimits', () => {
  it('sums cost and the monthly-cap fraction across models of interest', () => {
    const now = Date.parse('2026-09-27T12:00:00Z')
    insertStep('m1', 'opencode-go', 'kimi-k2.7-code', now - 1_000, 1.5)
    insertStep('m2', 'opencode-go', 'deepseek-v4-pro', now - 1_000, 0.5)

    const rows = buildOpencodeGoGroupLimits(dbPath, { 'kimi-k2.7-code': 60, 'deepseek-v4-pro': 15 }, new Set(['kimi-k2.7-code', 'deepseek-v4-pro']), now)
    const month = rows.find((r) => r.window === 'month')!
    expect(month.usedCost).toBeCloseTo(2.0)
    expect(month.limitCost).toBeCloseTo(60 * 1.0 + 15 * 1.0)
    const fiveHour = rows.find((r) => r.window === '5h')!
    expect(fiveHour.limitCost).toBeCloseTo(60 * 0.2 + 15 * 0.2)
  })
})
