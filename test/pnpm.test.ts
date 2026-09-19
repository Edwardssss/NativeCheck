/**
 * pnpm-lock.yaml adapter — parse packages + snapshots into LockfilePackage[].
 */
import { describe, expect, it } from 'vitest'
import { parsePnpmLockfile } from '../src/adapters/node/pnpm'
import { scan } from '../src/adapters/node/pipeline'
import type { Environment } from '../src/core/model'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const env: Environment = {
  os: 'linux',
  arch: 'x64',
  libc: 'glibc',
  nodeVersion: '22.22.2',
  nodeAbi: '127',
  python: { version: '3.12.4' },
  compiler: { name: 'gcc', cProbe: true, cxxProbe: true },
  sdks: [],
}

const pnpmRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'testdata', 'pnpm')

const SAMPLE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      node-pty:
        specifier: ^1.0.0
        version: 1.1.0

packages:

  node-pty@1.1.0:
    resolution: {integrity: sha512-pty, tarball: https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz}

  node-addon-api@7.1.1:
    resolution: {integrity: sha512-napi, tarball: https://registry.npmjs.org/node-addon-api/-/node-addon-api-7.1.1.tgz}

  '@parcel/watcher@2.4.1':
    resolution: {integrity: sha512-parcel, tarball: https://registry.npmjs.org/@parcel/watcher/-/watcher-2.4.1.tgz}

  '@parcel/watcher-linux-x64-glibc@2.4.1':
    resolution: {integrity: sha512-plat, tarball: https://registry.npmjs.org/@parcel/watcher-linux-x64-glibc/-/watcher-2.4.1.tgz}
    cpu: [x64]
    libc: [glibc]
    os: [linux]

snapshots:

  node-pty@1.1.0:
    dependencies:
      node-addon-api: 7.1.1

  node-addon-api@7.1.1: {}

  '@parcel/watcher@2.4.1':
    dependencies:
      detect-libc: 1.0.3
      node-addon-api: 7.1.1
    optionalDependencies:
      '@parcel/watcher-linux-x64-glibc': 2.4.1

  '@parcel/watcher-linux-x64-glibc@2.4.1': {}
`

describe('parsePnpmLockfile', () => {
  it('parses packages + dependencies from snapshots, os/cpu/libc from packages', () => {
    const list = parsePnpmLockfile(SAMPLE)
    const byName = new Map(list.map((p) => [p.name, p]))

    expect(list.length).toBe(4)

    const nodePty = byName.get('node-pty')
    expect(nodePty?.version).toBe('1.1.0')
    expect(nodePty?.dependencies?.['node-addon-api']).toEqual({ name: 'node-addon-api' })

    const watcher = byName.get('@parcel/watcher')
    expect(watcher?.dependencies?.['detect-libc']).toEqual({ name: 'detect-libc' })
    // optional platform packages carry optional: true
    expect(watcher?.dependencies?.['@parcel/watcher-linux-x64-glibc']?.optional).toBe(true)

    const platform = byName.get('@parcel/watcher-linux-x64-glibc')
    expect(platform?.os).toEqual(['linux'])
    expect(platform?.cpu).toEqual(['x64'])
    expect(platform?.libc).toEqual(['glibc'])
  })

  it('splits scoped packages @scope/name@version correctly', () => {
    const list = parsePnpmLockfile(SAMPLE)
    const scoped = list.find((p) => p.name === '@parcel/watcher-linux-x64-glibc')
    expect(scoped?.version).toBe('2.4.1')
  })

  it('a peer suffix in a snapshot key does not pollute name / version', () => {
    // In a real pnpm v6+ lockfile every package with peers is keyed as
    // `name@version(peer@version)`. Splitting at the first @ would yield
    const PEER = `lockfileVersion: '9.0'

packages:

  react-dom@18.2.0:
    resolution: {integrity: sha512-dom}

  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-scoped}

snapshots:

  react-dom@18.2.0(react@18.2.0):
    dependencies:
      scheduler: 0.23.0

  '@scope/pkg@1.2.3(peer@1.0.0)':
    dependencies:
      lodash: 4.17.21
`
    const list = parsePnpmLockfile(PEER)
    expect(list.map((p) => `${p.name}@${p.version}`).sort()).toEqual([
      '@scope/pkg@1.2.3',
      'react-dom@18.2.0',
    ])
    expect(list.find((p) => p.name === 'react-dom')?.dependencies?.scheduler).toEqual({
      name: 'scheduler',
    })
  })

  it('empty / malformed YAML → empty list (fail closed)', () => {
    expect(parsePnpmLockfile('')).toEqual([])
    expect(parsePnpmLockfile('lockfileVersion: [unclosed')).toEqual([])
  })
})

describe('pnpm integration · scan against a real pnpm-lock.yaml', () => {
  it('fast scan: finds the native candidates, zero network', async () => {
    const { report } = await scan(pnpmRoot, { mode: 'fast', env })
    expect(report.summary.networkCalls).toBe(0)
    expect(report.summary.totalPackages).toBeGreaterThanOrEqual(40)

    const names = report.findings.map((f) => f.pkg.name)
    // better-sqlite3@11 depends on prebuild-install → C; node-pty depends on node-addon-api.
    expect(names).toContain('better-sqlite3')
    expect(names).toContain('node-pty')
  })

  it('without hasInstallScript node-pty is Prebuildify (B), not the SourceOnly (D) npm reports', async () => {
    // Documented limitation: pnpm-lock.yaml does not record hasInstallScript, so the
    // "node-addon-api + install script" signal for D is missing and node-pty degrades to B.
    // That costs determinism (fast → UNVERIFIED) but never reports a false all-clear.
    const { report } = await scan(pnpmRoot, { mode: 'fast', env })
    const nodePty = report.findings.find((f) => f.pkg.name === 'node-pty')
    expect(nodePty?.pattern).toBe('Prebuildify')
    expect(nodePty?.risk).toBe('UNVERIFIED')
  })
})
