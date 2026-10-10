// Guard for tests that act on a real stack: they only ever run against a dev instance.
import { repoRoot } from '../../src/lib/config.js'
import { instanceName } from '../../src/lib/infra.js'

/** Returns the dev instance name of this checkout, or throws when it is a normal office. */
export function requireDevInstance(): string {
  const name = instanceName(repoRoot())
  if (!name) {
    throw new Error(
      'These tests create bots and agents on the stack of this checkout, so they only run against a dev instance, never a normal office. ' +
        'Run `bin/office dev init` first, then run the tests again.',
    )
  }
  return name
}
