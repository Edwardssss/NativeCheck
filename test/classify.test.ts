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

describe('classifyPackage · the four distribution patterns', () => {
  it('A: platform optional-dependency cluster (esbuild style, 26 genuine optional deps)', () => {
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

  it('a root with many plain devDeps is no cluster (anti-false-positive: dev edges optional=false)', () => {
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

  it('B: depends on node-gyp-build (bcrypt style) → Prebuildify', () => {
    const bcrypt = pkg({
      name: 'bcrypt',
      version: '6.0.0',
      dependencies: { 'node-gyp-build': { name: 'node-gyp-build' } },
    })
    expect(classifyPackage(bcrypt)).toBe(DistributionPattern.Prebuildify)
  })

  it('B: better-sqlite3@13 with only node-addon-api → Prebuildify', () => {
    const bs3 = pkg({
      name: 'better-sqlite3',
      version: '13.0.3',
      dependencies: { 'node-addon-api': { name: 'node-addon-api' } },
    })
    expect(classifyPackage(bs3)).toBe(DistributionPattern.Prebuildify)
  })

  it('D: node-addon-api + install script (node-pty and its node-gyp rebuild) → SourceOnly', () => {
    const nodePty = pkg({
      name: 'node-pty',
      version: '1.1.0',
      hasInstallScript: true,
      dependencies: { 'node-addon-api': { name: 'node-addon-api' } },
    })
    expect(classifyPackage(nodePty)).toBe(DistributionPattern.SourceOnly)
  })

  it('C: depends on prebuild-install (canvas style) → RemoteDownload', () => {
    const canvas = pkg({
      name: 'canvas',
      version: '3.2.3',
      dependencies: { 'prebuild-install': { name: 'prebuild-install' } },
    })
    expect(classifyPackage(canvas)).toBe(DistributionPattern.RemoteDownload)
  })

  it('C: depends on @mapbox/node-pre-gyp (bcrypt@5 style) → RemoteDownload (not misread as B)', () => {
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

  it('C: depends on node-pre-gyp (bcrypt@3 style) → RemoteDownload', () => {
    const bcrypt3 = pkg({
      name: 'bcrypt',
      version: '3.0.8',
      dependencies: { 'node-pre-gyp': { name: 'node-pre-gyp' } },
    })
    expect(classifyPackage(bcrypt3)).toBe(DistributionPattern.RemoteDownload)
  })

  it('D: depends on nan / bindings (legacy) → SourceOnly', () => {
    const legacy = pkg({
      name: 'node-sass',
      version: '9.0.0',
      dependencies: { nan: { name: 'nan' } },
    })
    expect(classifyPackage(legacy)).toBe(DistributionPattern.SourceOnly)
  })

  it('pure JS with no signal → NotNative', () => {
    expect(classifyPackage(pkg({ name: 'lodash', version: '4.18.1' }))).toBe(
      DistributionPattern.NotNative,
    )
  })
})

describe('classifyGraph · root exclusion and candidate uniqueness', () => {
  it('the project root is never a candidate (its platform deps describe publishing, not installing)', () => {
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

  it('packages depending on a build tool are caught by forward signals (no reverse-lookup layer)', () => {
    // A → B → prebuild-install: B consumes the tool directly, so the S3 dependency-edge
    // signal catches it. The old "reverse lookup" layer never produced a candidate, because
    // classifyPackage judges every deps[tool] as B/C/D first; the chain answers "who pulled it in".
    const a = pkg({ name: 'legacy-addon', version: '1.4.2', dependencies: { db: { name: 'db' } } })
    const b = pkg({
      name: 'db',
      version: '2.0.0',
      dependencies: { 'prebuild-install': { name: 'prebuild-install' } },
    })
    const graph = indexPackages([a, b])
    const result = classifyGraph(graph)
    // Only db, which consumes the tool directly, is a native entry; legacy-addon just consumes.
    expect(result.candidates.map((c) => c.pkg.name)).toEqual(['db'])
    expect(result.candidates[0]?.pattern).toBe(DistributionPattern.RemoteDownload)
  })

  it('L1 always reports zero network calls', () => {
    const graph = indexPackages([pkg({ name: 'a', version: '1.0.0' })])
    expect(classifyGraph(graph).networkCalls).toBe(0)
  })
})
