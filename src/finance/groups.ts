// Maps a hired agent to the resource group its usage bills against.
// Pure: no I/O. Claude agents always bill the Claude subscription group;
// opencode agents bill opencode-go or openrouter depending on the model prefix.

import type { AgentRecord, ResourceGroup } from '../lib/types.js'

/** Resolve the resource group id an agent's usage should be attributed to. */
export function groupIdForAgent(rec: Pick<AgentRecord, 'harness' | 'model'>, groups: ResourceGroup[]): string | undefined {
  if (rec.harness === 'claude') {
    return groups.find((g) => g.kind === 'claude-subscription')?.id
  }
  // opencode: model looks like "<provider>/<model>", e.g. "opencode-go/kimi-k2.7-code"
  // or "openrouter/anthropic/claude-3.5-sonnet".
  const prefix = rec.model.split('/')[0]
  if (prefix === 'opencode-go') return groups.find((g) => g.kind === 'opencode-go')?.id
  if (prefix === 'openrouter') return groups.find((g) => g.kind === 'openrouter')?.id
  return undefined
}

/** Group agents by resolved resource group id. Agents with no match are omitted. */
export function groupAgents<T extends Pick<AgentRecord, 'name' | 'harness' | 'model'>>(
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
