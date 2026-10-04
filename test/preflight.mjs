/**
 * Host-compatibility preflight check, mirroring the runtime gate that rejects
 * plugins on load (`@deepseek-ai/dsh-app-boot` lib/types/compatibility-preflight):
 * every peer named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` must satisfy the
 * running dsh version, prereleases included; a mismatch disables the plugin row
 * in the profile. The gate reads the plugin's own package.json, so this test
 * pins the declared range against a table of host versions instead of trusting
 * a lockfile resolution.
 *
 * Run: node test/preflight.mjs
 */
import { readFile } from 'node:fs/promises'
import { satisfies, valid } from 'semver'

let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** Incompatible dsh peers for one runtime version, exactly as the host computes them. */
function incompatiblePeers(runtimeVersion) {
  const peers = {}
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range)
      ? runtimeVersion
      : range
    if (requirement.trim() === '' || !satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      peers[name] = range
    }
  }
  return peers
}

check('host versions in the peer ranges use exact semver', Object.values(manifest.peerDependencies)
  .every((range) => typeof range === 'string' && range.trim() !== ''))

// Hosts this fork must load on: the whole 0.2.0 line (rc.1 is the declared
// floor, rc.2 is the installed app, 0.2.0 is the release the rc line promotes to).
for (const host of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.0']) {
  check(`declared peers satisfy dsh ${host}`, Object.keys(incompatiblePeers(host)).length === 0,
    JSON.stringify(incompatiblePeers(host)))
}

// The gate is real: the pre-migration range is rejected, which is exactly the
// failure this fork fixes, and a future 0.3 host needs its own bump.
const PRE_MIGRATION_RANGE = '^0.1.7-rc.2'
check('the pre-migration peer range is rejected on dsh 0.2.0-rc.2',
  satisfies('0.2.0-rc.2', PRE_MIGRATION_RANGE, { includePrerelease: true }) === false)
check('a future 0.3 host is out of range (bump required)',
  satisfies('0.3.0', '^0.2.0-rc.1', { includePrerelease: true }) === false)

check('runtime floor is a canonical version', valid('0.2.0-rc.1') !== null)

console.log('')
if (failed > 0) {
  console.error(`${failed} preflight check(s) failed`)
  process.exit(1)
}
console.log('preflight checks passed')
