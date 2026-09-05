/**
 * Layer 1 classifier — the core rule table (design doc §10.2).
 *
 * These fixtures test pure functions: no real lockfile is generated, hand-written
 * LockfilePackage records are fed in directly. In the spirit of
 * `networkCalls: 0` — L1 is purely local logic and must never touch the network.
 */
import { describe, expect, it } from 'vitest'
import { classifyGraph, classifyPackage } from '../src/adapters/node/classify'
import { DistributionPattern } from '../src/core/model'
import type { IngestedGraph, LockfilePackage } from '../src/adapters/node/signals'
import { indexPackages } from '../src/adapters/node/signals'

function pkg(
  partial: Partial<LockfilePackage> & { name: string; version: string },
): LockfilePackage {
  return { pathChains: [[partial.name]], ...partial }
}

describe('classifyPackage · 四种分发模式', () => {
  it('A：平台可选依赖簇（esbuild 式，26 个 genuinely-optional 子包）', () => {
    const esbuild = pkg({
      name: 'esbuild',
      version: '0.27.7',
      hasInstallScript: true,
      dependencies: Object.fromEntries(
        ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'].map(
          (p) => [`@esbuild/${p}`, { name: `@esbuild/${p}`, optional: true }],
        ),
      ),
    })
    expect(classifyPackage(esbuild)).toBe(DistributionPattern.PlatformOptionalDeps)
  })

  it('根项目大量普通 devDeps 不算簇（防误报，dev 边 optional=false）', () => {
    const root = pkg({
      name: 'my-app',
      version: '1.0.0',
      isRoot: true,
      dependencies: Object.fromEntries(
        ['tsup', 'vitest', 'eslint', 'prettier', 'typescript', 'tsx'].map((d) => [
          d,
          { name: d, optional: false },
        ]),
      ),
    })
    expect(classifyPackage(root)).toBe(DistributionPattern.NotNative)
  })

  it('B：依赖 node-gyp-build（bcrypt 式）→ Prebuildify', () => {
    const bcrypt = pkg({
      name: 'bcrypt',
      version: '6.0.0',
      dependencies: { 'node-gyp-build': { name: 'node-gyp-build' } },
    })
    expect(classifyPackage(bcrypt)).toBe(DistributionPattern.Prebuildify)
  })

  it('B：better-sqlite3@13 只有 node-addon-api → Prebuildify', () => {
    const bs3 = pkg({
      name: 'better-sqlite3',
      version: '13.0.3',
      dependencies: { 'node-addon-api': { name: 'node-addon-api' } },
    })
    expect(classifyPackage(bs3)).toBe(DistributionPattern.Prebuildify)
  })

  it('D：node-addon-api + install 脚本（node-pty 的 node-gyp rebuild）→ SourceOnly', () => {
    const nodePty = pkg({
      name: 'node-pty',
      version: '1.1.0',
      hasInstallScript: true,
      dependencies: { 'node-addon-api': { name: 'node-addon-api' } },
    })
    expect(classifyPackage(nodePty)).toBe(DistributionPattern.SourceOnly)
  })

  it('C：依赖 prebuild-install（canvas 式）→ RemoteDownload', () => {
    const canvas = pkg({
      name: 'canvas',
      version: '3.2.3',
      dependencies: { 'prebuild-install': { name: 'prebuild-install' } },
    })
    expect(classifyPackage(canvas)).toBe(DistributionPattern.RemoteDownload)
  })

  it('C：依赖 @mapbox/node-pre-gyp（bcrypt@5 式）→ RemoteDownload（不误判 B）', () => {
    const bcrypt5 = pkg({
      name: 'bcrypt',
      version: '5.1.1',
      dependencies: {
        'node-addon-api': { name: 'node-addon-api' },
        '@mapbox/node-pre-gyp': { name: '@mapbox/node-pre-gyp' },
      },
    })
    expect(classifyPackage(bcrypt5)).toBe(DistributionPattern.RemoteDownload)
  })

  it('C：依赖 node-pre-gyp（bcrypt@3 式）→ RemoteDownload', () => {
    const bcrypt3 = pkg({
      name: 'bcrypt',
      version: '3.0.8',
      dependencies: { 'node-pre-gyp': { name: 'node-pre-gyp' } },
    })
    expect(classifyPackage(bcrypt3)).toBe(DistributionPattern.RemoteDownload)
  })

  it('D：依赖 nan / bindings（老式）→ SourceOnly', () => {
    const legacy = pkg({
      name: 'node-sass',
      version: '9.0.0',
      dependencies: { nan: { name: 'nan' } },
    })
    expect(classifyPackage(legacy)).toBe(DistributionPattern.SourceOnly)
  })

  it('纯 JS 无信号 → NotNative', () => {
    expect(classifyPackage(pkg({ name: 'lodash', version: '4.18.1' }))).toBe(
      DistributionPattern.NotNative,
    )
  })
})

describe('classifyGraph · 反查与根排除', () => {
  it('项目根不作为 native 候选（根的平台依赖描述发布，非安装）', () => {
    const graph: IngestedGraph = indexPackages([
      pkg({
        name: 'my-app',
        version: '1.0.0',
        isRoot: true,
        dependencies: { esbuild: { name: 'esbuild' } },
      }),
      pkg({
        name: 'esbuild',
        version: '0.27.7',
        dependencies: {
          '@esbuild/darwin-arm64': { name: '@esbuild/darwin-arm64', optional: true },
        },
      }),
    ])
    const result = classifyGraph(graph)
    expect(result.candidates.map((c) => c.pkg.name)).not.toContain('my-app')
  })

  it('native 包不声明特征、只传递依赖构建工具 → 反查仍能命中', () => {
    // A → B → prebuild-install：B 直接消费工具，A 是真正入口
    const a = pkg({ name: 'legacy-addon', version: '1.4.2', dependencies: { db: { name: 'db' } } })
    const b = pkg({
      name: 'db',
      version: '2.0.0',
      dependencies: { 'prebuild-install': { name: 'prebuild-install' } },
    })
    const graph = indexPackages([a, b])
    const result = classifyGraph(graph)
    // 直接消费者 db 被反查命中为 C
    expect(result.candidates.some((c) => c.pkg.name === 'db')).toBe(true)
    expect(result.candidates.find((c) => c.pkg.name === 'db')?.pattern).toBe(
      DistributionPattern.RemoteDownload,
    )
  })

  it('L1 恒零网络', () => {
    const graph = indexPackages([pkg({ name: 'a', version: '1.0.0' })])
    expect(classifyGraph(graph).networkCalls).toBe(0)
  })
})
