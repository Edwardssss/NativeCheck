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
  it('从 snapshots 解析包 + 依赖，从 packages 解析 os/cpu/libc', () => {
    const list = parsePnpmLockfile(SAMPLE)
    const byName = new Map(list.map((p) => [p.name, p]))

    expect(list.length).toBe(4)

    const nodePty = byName.get('node-pty')
    expect(nodePty?.version).toBe('1.1.0')
    expect(nodePty?.dependencies?.['node-addon-api']).toEqual({ name: 'node-addon-api' })

    const watcher = byName.get('@parcel/watcher')
    expect(watcher?.dependencies?.['detect-libc']).toEqual({ name: 'detect-libc' })
    // optional 平台包带 optional: true
    expect(watcher?.dependencies?.['@parcel/watcher-linux-x64-glibc']?.optional).toBe(true)

    const platform = byName.get('@parcel/watcher-linux-x64-glibc')
    expect(platform?.os).toEqual(['linux'])
    expect(platform?.cpu).toEqual(['x64'])
    expect(platform?.libc).toEqual(['glibc'])
  })

  it('scoped 包 @scope/name@version 正确切分', () => {
    const list = parsePnpmLockfile(SAMPLE)
    const scoped = list.find((p) => p.name === '@parcel/watcher-linux-x64-glibc')
    expect(scoped?.version).toBe('2.4.1')
  })

  it('peer 后缀的快照键不会污染 name / version', () => {
    // 真实 pnpm v6+ 锁文件里，任何带 peer 的包都以 `name@version(peer@version)` 为键。
    // 先按最后一个 @ 切分会得到 name=`react-dom@18.2.0(react`、version=`18.2.0)`。
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

  it('空 / 畸形 YAML → 空列表（Fail Closed）', () => {
    expect(parsePnpmLockfile('')).toEqual([])
    expect(parsePnpmLockfile('lockfileVersion: [unclosed')).toEqual([])
  })
})

describe('pnpm 集成 · scan 真实 pnpm-lock.yaml', () => {
  it('fast scan：识别 native 候选，零网络', async () => {
    const { report } = await scan(pnpmRoot, { mode: 'fast', env })
    expect(report.summary.networkCalls).toBe(0)
    expect(report.summary.totalPackages).toBeGreaterThanOrEqual(40)

    const names = report.findings.map((f) => f.pkg.name)
    // better-sqlite3@11 依赖 prebuild-install → C；node-pty 依赖 node-addon-api。
    expect(names).toContain('better-sqlite3')
    expect(names).toContain('node-pty')
  })

  it('pnpm 无 hasInstallScript → node-pty 判 Prebuildify（B）而非 npm 下的 SourceOnly（D）', async () => {
    // 记录 pnpm 的已知限制：pnpm-lock.yaml 不记录 hasInstallScript，因此
    // 「node-addon-api + install 脚本」这一 D 判定信号缺失，node-pty 退化为 B。
    // 这降低确定性（fast → UNVERIFIED），但不误报安全（deep 仍取证 prebuilds）。
    const { report } = await scan(pnpmRoot, { mode: 'fast', env })
    const nodePty = report.findings.find((f) => f.pkg.name === 'node-pty')
    expect(nodePty?.pattern).toBe('Prebuildify')
    expect(nodePty?.risk).toBe('UNVERIFIED')
  })
})
