// gnauralcity GCY1.6 (GCY-D17): writes a host's generated tsconfig.hostkit.json from the `hostUi` its
// quasar.config.ts exports (see host-tsconfig.ts). Run with bun from the host's ui/ directory, after
// changing the pin (pins.ts), the host's modulePins or its own aliases:
//
//   bun ../../HostKitCore/ui/factory/write-host-tsconfig.ts .
//
// The host directory is an ARGUMENT: HostKitCore knows no host. validate-qa.js (workspace root) makes the
// same comparison for every host of hosts.json, without the write.

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { HOST_TSCONFIG_FILE, loadHostUi, renderHostTsconfig } from './host-tsconfig'

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('usage: bun <HostKitCore>/ui/factory/write-host-tsconfig.ts <host ui dir> [...]  (from the host: `.`)')
  process.exit(2)
}
for (const dir of dirs.map((d) => resolve(d))) {
  const file = join(dir, HOST_TSCONFIG_FILE)
  writeFileSync(file, renderHostTsconfig(await loadHostUi(dir)))
  console.log(`wrote ${file}`)
}
