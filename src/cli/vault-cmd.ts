// `office vault …` — manage resource-group secrets in the encrypted vault (src/lib/vault.ts).
// Values are only ever read from a hidden TTY prompt or opencode's auth.json, never from argv:
// argv ends up in shell history, `ps`, and (via #office-admin) in the chat database.

import fs from 'node:fs'
import readline from 'node:readline'
import { Writable } from 'node:stream'
import type { ResourceGroup } from '../lib/types.js'
import { opencodeAuthFile } from '../finance/openrouter.js'
import {
  getSecret, importableFromAuthJson, listSecrets, markValidated, migrateLegacyVault, removeSecret,
  renderVaultStatus, setSecret, validateSecret, vaultSpec, vaultSpecs,
} from '../lib/vault.js'

/** Prompt without echoing what is typed. */
export function promptHidden(question: string): Promise<string> {
  let muted = false
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb() } })
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true })
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer) })
    muted = true
  })
}

async function check(root: string, groups: ResourceGroup[], id: string): Promise<string> {
  const value = getSecret(root, id)
  if (!value) return `${id}: not set`
  const spec = vaultSpec(id, groups)
  const ok = spec ? await validateSecret(spec, value) : undefined
  if (ok === undefined) return `${id}: stored (no automatic check for this entry)`
  markValidated(root, id, ok)
  return ok ? `${id}: accepted by the provider` : `${id}: REJECTED by the provider — set it again`
}

/** Store one key read from a hidden prompt. Shared with `office setup`. */
export async function vaultSetInteractive(root: string, groups: ResourceGroup[], id: string): Promise<string> {
  const spec = vaultSpec(id, groups)
  if (!spec) throw new Error(`unknown vault entry "${id}" (known: ${vaultSpecs(groups).map(x => x.id).join(', ')})`)
  const value = await promptHidden(`${spec.label} key (input hidden): `)
  if (!value.trim()) return `${id}: unchanged (empty input)`
  setSecret(root, id, value, groups)
  return check(root, groups, id)
}

function usage(groups: ResourceGroup[]): string {
  return `usage: office vault [status]
       office vault set <${vaultSpecs(groups).map(s => s.id).join('|')}>   (prompts, input hidden; run on the office server's shell)
       office vault rm <id>
       office vault check [id]
       office vault import-opencode   copy API keys from opencode's auth.json into the vault`
}

export async function cmdVault(root: string, groups: ResourceGroup[], pos: string[]): Promise<void> {
  migrateLegacyVault(root, groups)
  const [sub = 'status', id, extra] = pos
  switch (sub) {
    case 'status':
    case 'list':
      console.log(renderVaultStatus(listSecrets(root, groups)))
      return
    case 'set': {
      if (!id) throw new Error(usage(groups))
      const spec = vaultSpec(id, groups)
      if (!spec) throw new Error(`unknown vault entry "${id}" (known: ${vaultSpecs(groups).map(x => x.id).join(', ')})`)
      if (extra !== undefined) {
        throw new Error('never pass a key as an argument (it lands in shell history, and in chat when sent from #office-admin). ' +
          'If you just posted a key in chat: delete that post and rotate the key at the provider. Then run `office vault set ' + id + '` on the server shell.')
      }
      if (!process.stdin.isTTY) throw new Error(`vault set needs a terminal: SSH to the office server and run \`office vault set ${id}\` (keys never go through chat)`)
      console.log(await vaultSetInteractive(root, groups, id))
      return
    }
    case 'rm':
    case 'remove':
      if (!id) throw new Error(usage(groups))
      console.log(removeSecret(root, id) ? `${id}: removed (restart agents to drop it from running sessions)` : `${id}: was not set`)
      return
    case 'check':
      for (const e of listSecrets(root, groups).filter(e => e.set && (!id || e.id === id))) console.log(await check(root, groups, e.id))
      return
    case 'import-opencode': {
      const file = opencodeAuthFile()
      if (!fs.existsSync(file)) throw new Error(`${file} not found`)
      const found = importableFromAuthJson(fs.readFileSync(file, 'utf8'), groups)
      if (!found.length) { console.log('no API-key entries to import (OAuth logins are not copied)'); return }
      for (const f of found) { setSecret(root, f.id, f.value, groups); console.log(`${f.id}: imported`) }
      return
    }
    default:
      throw new Error(usage(groups))
  }
}
