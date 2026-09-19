// One-off performance baseline script: generate a big lockfile with N packages and benchmark the
// fast scan. Usage: node scripts/bench-large.mjs [N]   (default 2000)
// Requires `npm run build` first (it runs dist/cli.js).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// Use the current interpreter instead of hardcoding one machine's node path.
const NODE = process.execPath
const CLI = new URL('../dist/cli.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const N = Number(process.argv[2] ?? 2000)

// Generate: root depends on N leaf packages (pure JS, no native signal), with a few native
// packages mixed in.
function genLock(n) {
  const packages = {
    '': { name: 'big-repo', version: '1.0.0', dependencies: {} },
  }
  for (let i = 0; i < n; i++) {
    const name = `pkg-${i}`
    packages[''].dependencies[name] = '1.0.0'
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      integrity: `sha512-${String(i).padStart(40, '0')}`,
    }
  }
  // One native package (depending on nan) every 100 -> exercises classify's real path
  for (let i = 0; i < n; i += 100) {
    const name = `native-${i}`
    packages[''].dependencies[name] = '1.0.0'
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      hasInstallScript: true,
      dependencies: { nan: '2.18.0' },
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      integrity: `sha512-${String(i).padStart(40, '0')}`,
    }
    packages['node_modules/nan'] = {
      version: '2.18.0',
      resolved: 'https://registry.npmjs.org/nan/-/nan-2.18.0.tgz',
      integrity: `sha512-${'n'.padStart(40, 'n')}`,
    }
  }
  return {
    name: 'big-repo',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages,
  }
}

const root = mkdtempSync(join(tmpdir(), 'nc-bench-'))
const lock = genLock(N)
writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2))
// package.json dependencies must match the lockfile, otherwise arborist loadVirtual's root edgesOut is empty
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'big-repo',
    version: '1.0.0',
    dependencies: lock.packages[''].dependencies,
  }),
)

const t0 = Date.now()
const out = execFileSync(NODE, [CLI, root, '--json'], { encoding: 'utf8' })
const wallMs = Date.now() - t0
const r = JSON.parse(out)
console.log(
  `packages=${r.summary.totalPackages} nativeCandidates=${r.summary.nativeCandidates} networkCalls=${r.summary.networkCalls} wallMs=${wallMs} durationMs(internal)=${r.durationMs}`,
)
rmSync(root, { recursive: true, force: true })
