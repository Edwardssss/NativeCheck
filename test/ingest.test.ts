/**
 * Layer 0 — arborist mapping regression tests (S1 platform constraints / S5 platform cluster).
 *
 * These go through the real `ingest()` (real `arborist.loadVirtual`, real
 * package-lock.json) instead of hand-written `LockfilePackage` records, because
 * the defect lives exactly in the "arborist tree → normalized record" step:
 *
 * 1. **S1 was silently empty.** arborist's `Node` exposes no `os` / `cpu` /
 *    `libc` getters (only `package`), so `node.os` was always `undefined` and
 *    neither the `raw` fields nor any future platform matching could work.
 * 2. **S5 counted the wrong thing.** `Edge.optional` is
 *    `type === 'optional' || type === 'peerOptional'`, so an *optional peer*
 *    (`peerDependenciesMeta[x].optional`) counted as a "genuinely optional
 *    platform sub-package". vite@8 declares one optionalDependency (fsevents)
 *    but has 13 optional edges → wrongly Pattern A → `PREBUILT` / `LOW`.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingest } from '../src/adapters/node/ingest'
import { classifyPackage } from '../src/adapters/node/classify'
import { DistributionPattern } from '../src/core/model'
import type { LockfilePackage } from '../src/adapters/node/signals'

interface ProjectSpec {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  /** `packages` map entries other than the root, keyed by lockfile path. */
  readonly packages: Readonly<Record<string, unknown>>
}

/** Write a minimal but valid lockfileVersion 3 project and ingest it. */
async function ingestProject(spec: ProjectSpec): Promise<Record<string, LockfilePackage>> {
  const root = mkdtempSync(join(tmpdir(), 'nc-ingest-'))
  try {
    const rootEntry = {
      name: 'fixture-app',
      version: '1.0.0',
      ...(spec.dependencies ? { dependencies: spec.dependencies } : {}),
      ...(spec.devDependencies ? { devDependencies: spec.devDependencies } : {}),
    }
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': rootEntry, ...spec.packages },
      }),
    )
    // package.json must agree with the lockfile root, otherwise arborist builds
    // an empty root edge set (same caveat as scripts/bench-large.mjs).
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        dependencies: spec.dependencies ?? {},
        devDependencies: spec.devDependencies ?? {},
      }),
    )
    const outcome = await ingest(root)
    if (!outcome.ok) throw new Error(`ingest failed: ${outcome.reason}`)
    return { ...outcome.graph.packages }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Names of the platform sub-packages used by the cluster case. */
const PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64',
]

/** vite@8 shape: optional *peers* only — its sole optionalDependency is fsevents. */
function viteLike(peerNames: readonly string[]): Record<string, unknown> {
  return {
    'node_modules/vite-like': {
      version: '1.0.0',
      peerDependencies: Object.fromEntries(peerNames.map((n) => [n, '1.0.0'])),
      peerDependenciesMeta: Object.fromEntries(peerNames.map((n) => [n, { optional: true }])),
    },
  }
}

describe("ingest · S5 platform cluster counts only the package's own optionalDependencies", () => {
  it('optional peers (peerDependenciesMeta.optional) are not a platform cluster', async () => {
    const peers = ['less', 'sass', 'terser', 'tsx', 'yaml', 'sugarss']
    const packages = await ingestProject({
      dependencies: { 'vite-like': '1.0.0' },
      devDependencies: Object.fromEntries(peers.map((n) => [n, '1.0.0'])),
      packages: {
        ...viteLike(peers),
        ...Object.fromEntries(peers.map((n) => [`node_modules/${n}`, { version: '1.0.0' }])),
      },
    })
    const vite = packages['vite-like@1.0.0']
    expect(vite).toBeDefined()
    // 6 optional peers, 0 optionalDependencies → must not look like Pattern A.
    expect(classifyPackage(vite as LockfilePackage)).toBe(DistributionPattern.NotNative)
  })

  it('genuine optionalDependencies still classify as pattern A (no overcorrection)', async () => {
    const packages = await ingestProject({
      dependencies: { 'esbuild-like': '1.0.0' },
      packages: {
        'node_modules/esbuild-like': {
          version: '1.0.0',
          optionalDependencies: Object.fromEntries(
            PLATFORMS.map((p) => [`@esbuild-like/${p}`, '1.0.0']),
          ),
        },
        ...Object.fromEntries(
          PLATFORMS.map((p) => {
            const [os, cpu] = p.split('-')
            return [`node_modules/@esbuild-like/${p}`, { version: '1.0.0', os: [os], cpu: [cpu] }]
          }),
        ),
      },
    })
    const esbuild = packages['esbuild-like@1.0.0']
    expect(classifyPackage(esbuild as LockfilePackage)).toBe(
      DistributionPattern.PlatformOptionalDeps,
    )
  })
})

describe('ingest · S1 platform constraints (os / cpu / libc) are no longer dropped', () => {
  it("a sub-package's os / cpu are collected (arborist keeps them only on node.package)", async () => {
    const packages = await ingestProject({
      dependencies: { 'esbuild-like': '1.0.0' },
      packages: {
        'node_modules/esbuild-like': {
          version: '1.0.0',
          optionalDependencies: { '@esbuild-like/linux-x64': '1.0.0' },
        },
        'node_modules/@esbuild-like/linux-x64': {
          version: '1.0.0',
          os: ['linux'],
          cpu: ['x64'],
        },
      },
    })
    const sub = packages['@esbuild-like/linux-x64@1.0.0']
    expect(sub?.os).toEqual(['linux'])
    expect(sub?.cpu).toEqual(['x64'])
  })

  it('libc constraints are collected (the Alpine case)', async () => {
    const packages = await ingestProject({
      dependencies: { 'musl-addon': '1.0.0' },
      packages: {
        'node_modules/musl-addon': { version: '1.0.0', os: ['linux'], libc: ['musl'] },
      },
    })
    expect(packages['musl-addon@1.0.0']?.libc).toEqual(['musl'])
  })

  it('a package without platform constraints stays undefined (nothing invented)', async () => {
    const packages = await ingestProject({
      dependencies: { plain: '1.0.0' },
      packages: { 'node_modules/plain': { version: '1.0.0' } },
    })
    expect(packages['plain@1.0.0']?.os).toBeUndefined()
    expect(packages['plain@1.0.0']?.cpu).toBeUndefined()
  })
})
