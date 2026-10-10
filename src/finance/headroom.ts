// Per-group headroom snapshot: the highest known used % for each resource group, written by
// the finance collector and read by `pickAutoGroup` / `suggestMoveText` callers (hire --group
// auto, alert suggestions) so they don't need a full finance snapshot on hand.

import fs from 'node:fs'
import path from 'node:path'
import type { GroupRow, LimitRow } from './render.js'

export interface HeadroomFile {
  at: string // ISO
  usedPercent: Record<string, number | undefined>
}

/** Per group id: the max of every LimitRow.percent and GroupRow.usagePercent with that id. */
export function headroomFromSnapshot(limits: LimitRow[], groups: GroupRow[]): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {}
  const consider = (id: string | undefined, percent: number | undefined) => {
    if (!id || percent === undefined) return
    const cur = out[id]
    if (cur === undefined || percent > cur) out[id] = percent
  }
  for (const l of limits) consider(l.groupId, l.percent)
  for (const g of groups) consider(g.id, g.usagePercent)
  return out
}

function headroomFile(root: string): string {
  return path.join(root, 'state', 'finance', 'headroom.json')
}

/** Atomically write state/finance/headroom.json (temp file + rename in the same dir). */
export function writeHeadroom(root: string, usedPercent: Record<string, number | undefined>): void {
  const file = headroomFile(root)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const data: HeadroomFile = { at: new Date().toISOString(), usedPercent }
  const tmp = path.join(dir, `.headroom.json.${process.pid}-${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

/** Read state/finance/headroom.json. undefined when missing or corrupt. */
export function readHeadroom(root: string): HeadroomFile | undefined {
  try {
    const raw = fs.readFileSync(headroomFile(root), 'utf8')
    return JSON.parse(raw) as HeadroomFile
  } catch {
    return undefined
  }
}
