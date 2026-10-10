// Guard for tests that act on a real stack: they only ever run against a dev instance.
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from '../../src/lib/config.js'
import { assertInstanceConfig, instanceName } from '../../src/lib/infra.js'
import type { OfficeConfig } from '../../src/lib/types.js'

/** Returns the dev instance name of this checkout, or throws when it is a normal office. */
export function requireDevInstance(): string {
  const root = repoRoot()
  const name = instanceName(root)
  if (!name) {
    throw new Error(
      'These tests create bots and agents on the stack of this checkout, so they only run against a dev instance, never a normal office. ' +
        'Run `bin/office dev init` first, then run the tests again.',
    )
  }
  // A missing or regenerated config has the default URLs, which are another office's.
  const file = path.join(root, 'office.config.json')
  if (!fs.existsSync(file)) throw new Error('office.config.json is missing. Run `bin/office dev init` to repair this dev instance.')
  assertInstanceConfig(root, JSON.parse(fs.readFileSync(file, 'utf8')) as OfficeConfig)
  return name
}
