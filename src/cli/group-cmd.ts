// `office group` — resource group registry: list/add/rm/login/move.
// Kept thin and I/O-abstracted (GroupDeps) so it's unit-testable without touching a real office.

import fs from 'node:fs'
import path from 'node:path'
import type { AgentRecord, OfficeConfig, ResourceGroup, ResourceGroupKind } from '../lib/types.js'
import {
  addGroup, checkGroupForAgent, claudeConfigDir, groupIdForAgent, isDefaultGroup, kindForAgent,
  pickAutoGroup, removeGroup,
} from '../finance/groups.js'
import { listSecrets } from '../lib/vault.js'
import { copyClaudeSession } from '../lib/transcript.js'
import { workspaceDir } from '../lib/workspace.js'
import { ensureClaudeOnboarded } from '../lib/harness/claude.js'

export interface GroupDeps {
  root: string
  cfg: OfficeConfig
  saveConfig(cfg: OfficeConfig): Promise<void>
  agents(): Promise<AgentRecord[]> // all records (filter hired yourself)
  saveAgent(rec: AgentRecord): Promise<void>
  stopAgent(rec: AgentRecord): Promise<void>
  startAgent(rec: AgentRecord): Promise<void>
  claudeAuthStatus(configDir?: string): { loggedIn: boolean } | undefined
  runClaudeLogin(configDir?: string): number // exit code of `claude auth login`
  isTTY: boolean
  log(line: string): void
}

/** `claude` is a friendly alias for the full kind name; everything else passes through as-is. */
function resolveKind(input: string): ResourceGroupKind {
  return (input === 'claude' ? 'claude-subscription' : input) as ResourceGroupKind
}

async function cmdList(deps: GroupDeps): Promise<void> {
  const groups = deps.cfg.resourceGroups
  const hired = (await deps.agents()).filter((a) => a.status === 'hired')
  const secrets = listSecrets(deps.root, groups)
  for (const g of groups) {
    const names = hired.filter((a) => groupIdForAgent(a, groups) === g.id).map((a) => a.name)
    const secret = secrets.find((s) => s.id === g.id)
    const parts = [`${g.id} — ${g.label} (${g.kind}${isDefaultGroup(g, groups) ? ', default' : ''})`]
    if (g.kind === 'claude-subscription') {
      parts.push(`token: ${secret?.set ? 'set' : 'not set'}`)
      const status = deps.claudeAuthStatus(claudeConfigDir(deps.root, g))
      const loginText = status === undefined ? 'unknown' : status.loggedIn ? 'ok' : 'not logged in'
      parts.push(`login: ${loginText}`)
    } else {
      parts.push(`key: ${secret?.set ? 'set' : 'not set'}`)
    }
    parts.push(`agents: ${names.join(', ') || 'none'}`)
    deps.log(parts.join('  '))
  }
}

async function cmdAdd(pos: string[], flags: Record<string, string | boolean>, deps: GroupDeps): Promise<void> {
  const id = typeof flags.id === 'string' ? flags.id : undefined
  if (!pos[1] || !id) throw new Error('usage: office group add <kind> --id <id> [--label L]')
  const label = typeof flags.label === 'string' ? flags.label : undefined
  const groups = addGroup(deps.cfg.resourceGroups, { kind: resolveKind(pos[1]), id, label })
  const group = groups.at(-1)!
  if (group.kind === 'claude-subscription' && group.configDir) {
    const dir = path.resolve(deps.root, group.configDir)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700) // belt-and-braces against umask
    ensureClaudeOnboarded(dir)
  }
  deps.cfg.resourceGroups = groups
  await deps.saveConfig(deps.cfg)
  deps.log(
    group.kind === 'claude-subscription'
      ? `added ${group.id} (${group.label}, ${group.kind}). Next: \`office group login ${group.id}\` on the server shell.`
      : `added ${group.id} (${group.label}, ${group.kind}). Next: \`office vault set ${group.id}\`.`,
  )
}

async function cmdRm(pos: string[], deps: GroupDeps): Promise<void> {
  const id = pos[1]
  if (!id) throw new Error('usage: office group rm <id>')
  const before = deps.cfg.resourceGroups.find((g) => g.id === id)
  const hired = (await deps.agents()).filter((a) => a.status === 'hired')
  const groups = removeGroup(deps.cfg.resourceGroups, id, hired) // throws on unknown id / pinned agents
  deps.cfg.resourceGroups = groups
  await deps.saveConfig(deps.cfg)
  deps.log(
    before?.kind === 'claude-subscription' && before.configDir
      ? `removed ${id}. Its config dir (${before.configDir}) was kept — remove it manually if you no longer need it.`
      : `removed ${id}`,
  )
}

async function cmdLogin(pos: string[], deps: GroupDeps): Promise<void> {
  const id = pos[1]
  if (!id) throw new Error('usage: office group login <id>')
  const group = deps.cfg.resourceGroups.find((g) => g.id === id)
  if (!group) throw new Error(`unknown group ${id} (known groups: ${deps.cfg.resourceGroups.map((g) => g.id).join(', ')})`)
  if (group.kind !== 'claude-subscription') {
    throw new Error(`${id} is not a Claude group — set its API key with \`office vault set ${id}\` instead`)
  }
  if (!deps.isTTY) {
    throw new Error("office group login needs an interactive prompt — run it on the office server's shell")
  }
  const dir = claudeConfigDir(deps.root, group)
  const code = deps.runClaudeLogin(dir)
  if (code !== 0) throw new Error(`claude auth login exited with code ${code}`)
  if (dir) ensureClaudeOnboarded(dir)
  const status = deps.claudeAuthStatus(dir)
  const loginText = status === undefined ? 'unknown' : status.loggedIn ? 'ok' : 'not logged in'
  deps.log(`${id}: login ${loginText}`)
}

async function cmdMove(pos: string[], deps: GroupDeps): Promise<void> {
  const name = pos[1]
  const targetId = pos[2]
  if (!name || !targetId) throw new Error('usage: office group move <agent> <groupId>')
  const rec = (await deps.agents()).find((a) => a.name === name)
  if (!rec) throw new Error(`no such agent: ${name}`)
  if (rec.status !== 'hired') throw new Error(`${name} is not hired`)
  const groups = deps.cfg.resourceGroups
  const err = checkGroupForAgent(rec, targetId, groups)
  if (err) throw new Error(err)

  const currentId = groupIdForAgent(rec, groups)
  if (currentId === targetId) {
    deps.log(`${name} is already in ${targetId}`)
    return
  }
  const targetGroup = groups.find((g) => g.id === targetId)!

  if (rec.harness === 'claude') {
    const currentGroup = groups.find((g) => g.id === currentId)
    const fromDir = claudeConfigDir(deps.root, currentGroup)
    const toDir = claudeConfigDir(deps.root, targetGroup)
    if (fromDir !== toDir && rec.sessionId) {
      await deps.stopAgent(rec)
      const copied = copyClaudeSession({ sessionId: rec.sessionId, cwd: workspaceDir(deps.root, name), fromDir, toDir })
      if (!copied) {
        rec.pastSessions = [...rec.pastSessions, rec.sessionId]
        rec.sessionId = undefined
        deps.log(`${name}: no transcript found for the old group — starting a fresh session in ${targetId}`)
      }
      rec.group = targetId
      await deps.saveAgent(rec)
      await deps.startAgent(rec)
      return
    }
  }

  // opencode, or a Claude move within the same config dir: just restart with the new group.
  await deps.stopAgent(rec)
  rec.group = targetId
  await deps.saveAgent(rec)
  await deps.startAgent(rec)
}

/**
 * Resolve `hire --group <flag>` to a group id, before the agent's chat/Forgejo identity is
 * created. undefined/empty means "no preference" (the agent falls back to the default group of
 * its kind at run time); `auto` picks the same-kind group with the lowest known used %; an
 * explicit id is validated against the agent's harness/model and returned as-is.
 */
export function resolveHireGroup(
  flag: string | undefined,
  rec: Pick<AgentRecord, 'harness' | 'model'>,
  groups: ResourceGroup[],
  usedPercent: Record<string, number | undefined>,
): string | undefined {
  if (!flag) return undefined
  if (flag === 'auto') {
    const kind = kindForAgent(rec)
    if (!kind) return undefined
    return pickAutoGroup(kind, groups, usedPercent)?.id
  }
  const err = checkGroupForAgent(rec, flag, groups)
  if (err) throw new Error(err)
  return flag
}

export async function cmdGroup(pos: string[], flags: Record<string, string | boolean>, deps: GroupDeps): Promise<void> {
  const sub = pos[0] ?? 'list'
  switch (sub) {
    case 'list': return cmdList(deps)
    case 'add': return cmdAdd(pos, flags, deps)
    case 'rm': return cmdRm(pos, deps)
    case 'login': return cmdLogin(pos, deps)
    case 'move': return cmdMove(pos, deps)
    default: throw new Error('usage: office group [list|add <kind> --id X [--label L]|rm <id>|login <id>|move <agent> <group>]')
  }
}
