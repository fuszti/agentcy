// Maps a hired agent to the resource group its usage bills against, plus the group
// registry helpers (`office group add/rm/move`) built on top of it.
// Pure: no I/O except resolving a configDir path.

import path from 'node:path'
import type { AgentRecord, ResourceGroup, ResourceGroupKind } from '../lib/types.js'

/** Vault entry ids that a new group id may never collide with. */
export const RESERVED_GROUP_IDS: string[] = ['opencode-zen', 'anthropic', 'claude-oauth']

/** Human label for each resource group kind. */
export const KIND_LABELS: Record<ResourceGroupKind, string> = {
  'claude-subscription': 'Claude subscription',
  'opencode-go': 'OpenCode Go',
  openrouter: 'OpenRouter',
}

/** Resolve the resource group kind an agent's usage falls under, if any. */
export function kindForAgent(rec: Pick<AgentRecord, 'harness' | 'model'>): ResourceGroupKind | undefined {
  if (rec.harness === 'claude') return 'claude-subscription'
  // opencode: model looks like "<provider>/<model>", e.g. "opencode-go/kimi-k2.7-code"
  // or "openrouter/anthropic/claude-3.5-sonnet". A bare provider with no model part doesn't count.
  const slash = rec.model.indexOf('/')
  if (slash === -1) return undefined
  const prefix = rec.model.slice(0, slash)
  if (prefix === 'opencode-go') return 'opencode-go'
  if (prefix === 'openrouter') return 'openrouter'
  return undefined
}

/** The first (default) group of a kind, in config order. */
export function defaultGroup(kind: ResourceGroupKind, groups: ResourceGroup[]): ResourceGroup | undefined {
  return groups.find((g) => g.kind === kind)
}

/** True when `group` is the default group of its kind. */
export function isDefaultGroup(group: ResourceGroup, groups: ResourceGroup[]): boolean {
  return defaultGroup(group.kind, groups)?.id === group.id
}

/** Resolve the resource group id an agent's usage should be attributed to. */
export function groupIdForAgent(
  rec: Pick<AgentRecord, 'harness' | 'model' | 'group'>,
  groups: ResourceGroup[],
): string | undefined {
  const kind = kindForAgent(rec)
  if (!kind) return undefined
  if (rec.group) {
    const g = groups.find((g) => g.id === rec.group)
    if (g && g.kind === kind) return g.id
  }
  return defaultGroup(kind, groups)?.id
}

/** Group agents by resolved resource group id. Agents with no match are omitted. */
export function groupAgents<T extends Pick<AgentRecord, 'name' | 'harness' | 'model' | 'group'>>(
  agents: T[],
  groups: ResourceGroup[],
): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const a of agents) {
    const id = groupIdForAgent(a, groups)
    if (!id) continue
    const list = out.get(id) ?? []
    list.push(a)
    out.set(id, list)
  }
  return out
}

/** "a"/"an" for a kind label, e.g. "an OpenCode Go group" / "a Claude subscription group". */
function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a'
}

/** Validate an explicit group choice for an agent. undefined = ok. */
export function checkGroupForAgent(
  rec: Pick<AgentRecord, 'harness' | 'model'>,
  groupId: string,
  groups: ResourceGroup[],
): string | undefined {
  const group = groups.find((g) => g.id === groupId)
  if (!group) {
    return `unknown group ${groupId} (known groups: ${groups.map((g) => g.id).join(', ')})`
  }
  const kind = kindForAgent(rec)
  if (kind && group.kind !== kind) {
    const groupLabel = KIND_LABELS[group.kind]
    const kindLabel = KIND_LABELS[kind]
    return `group ${groupId} is ${article(groupLabel)} ${groupLabel} group, but ${rec.model} needs ${article(kindLabel)} ${kindLabel} group`
  }
  return undefined
}

/** Validate a new group id for `office group add`. undefined = ok. */
export function validateNewGroupId(id: string, groups: ResourceGroup[]): string | undefined {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) {
    return `invalid group id "${id}": must match ^[a-z][a-z0-9-]{1,30}$`
  }
  if (groups.some((g) => g.id === id)) {
    return `group id "${id}" is already in use`
  }
  if (RESERVED_GROUP_IDS.includes(id)) {
    return `group id "${id}" is reserved`
  }
  return undefined
}

/**
 * Return a NEW array with the group appended (input untouched). Throws on an invalid id or
 * unknown kind.
 */
export function addGroup(
  groups: ResourceGroup[],
  input: { kind: ResourceGroupKind; id: string; label?: string },
): ResourceGroup[] {
  if (!(input.kind in KIND_LABELS)) {
    throw new Error(`unknown resource group kind "${input.kind}"`)
  }
  const err = validateNewGroupId(input.id, groups)
  if (err) throw new Error(err)
  const label = input.label ?? `${KIND_LABELS[input.kind]} (${input.id})`
  const group: ResourceGroup = { id: input.id, kind: input.kind, label }
  if (input.kind === 'claude-subscription' && defaultGroup('claude-subscription', groups)) {
    group.configDir = `state/claude/${input.id}`
  }
  return [...groups, group]
}

/**
 * Return a NEW array without the group `id` (input untouched). Throws on an unknown id, or if
 * any hired agent currently resolves to it (by explicit `group` or default fallback).
 */
export function removeGroup(
  groups: ResourceGroup[],
  id: string,
  hiredAgents: Pick<AgentRecord, 'name' | 'harness' | 'model' | 'group'>[],
): ResourceGroup[] {
  if (!groups.some((g) => g.id === id)) {
    throw new Error(`unknown group ${id}`)
  }
  const remaining = groups.filter((g) => g.id !== id)
  const pinned = hiredAgents.filter((a) => groupIdForAgent(a, groups) === id).map((a) => a.name)
  if (pinned.length) {
    throw new Error(
      `cannot remove group ${id}: ${pinned.join(', ')} still resolve${pinned.length === 1 ? 's' : ''} to it — use \`office group move\` first`,
    )
  }
  return remaining
}

/** Absolute CLAUDE_CONFIG_DIR for a group, or undefined for the harness default. */
export function claudeConfigDir(root: string, group: ResourceGroup | undefined): string | undefined {
  return group?.configDir ? path.resolve(root, group.configDir) : undefined
}

/**
 * Pick the group of `kind` with the lowest known used %. Groups with an unknown % rank after
 * every known one; ties (including all-unknown) fall back to config order.
 */
export function pickAutoGroup(
  kind: ResourceGroupKind,
  groups: ResourceGroup[],
  usedPercent: Record<string, number | undefined>,
): ResourceGroup | undefined {
  const candidates = groups.filter((g) => g.kind === kind)
  if (!candidates.length) return undefined
  let best: ResourceGroup | undefined
  let bestRank = Infinity
  for (const g of candidates) {
    const p = usedPercent[g.id]
    const rank = p === undefined ? Infinity : p
    if (best === undefined || rank < bestRank) {
      best = g
      bestRank = rank
    }
  }
  return best
}

/**
 * Suggested `group move` text for an alert on `fromGroupId`, naming the same-kind group with
 * the most headroom (a strictly lower known used %; the source's unknown % is beaten by any
 * known one). undefined when no other group is strictly better.
 */
export function suggestMoveText(
  fromGroupId: string,
  groups: ResourceGroup[],
  usedPercent: Record<string, number | undefined>,
  agentNames: string[],
): string | undefined {
  const from = groups.find((g) => g.id === fromGroupId)
  if (!from) return undefined
  const fromPercent = usedPercent[fromGroupId]
  let best: ResourceGroup | undefined
  let bestPercent = Infinity
  for (const g of groups) {
    if (g.id === fromGroupId || g.kind !== from.kind) continue
    const p = usedPercent[g.id]
    if (p === undefined) continue
    const better = fromPercent === undefined ? true : p < fromPercent
    if (!better) continue
    if (p < bestPercent) {
      best = g
      bestPercent = p
    }
  }
  if (!best) return undefined
  const agent = agentNames[0] ?? '<agent>'
  return ` Most headroom: **${best.label}** (${Math.round(bestPercent)}% used) — \`group move ${agent} ${best.id}\``
}
