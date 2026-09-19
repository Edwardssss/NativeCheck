/**
 * Dependency path — "who brought this native dependency into my project".
 *
 * `PackageRef.paths` / `DependencyPath.chain` always promised the full root →
 * target chain (`['my-app', 'framework-x', 'database-y', 'legacy-addon']`), but
 * every adapter emitted `[[own name]]`, so the report's "Dependency path" block
 * just repeated the package name. The arborist adapter now collects real chains
 * while it walks the tree; this file pins that down, including the limits that
 * keep it from exploding on large lockfiles.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingest } from '../src/adapters/node/ingest'
import { scan } from '../src/adapters/node/pipeline'
import type { LockfilePackage } from '../src/adapters/node/signals'
import type { Environment } from '../src/core/model'

const env: Environment = {
  os: 'linux',
  arch: 'x64',
  libc: 'glibc',
  python: { version: '3.12.4' },
  compiler: { name: 'gcc', cProbe: true, cxxProbe: true },
  sdks: [],
}

interface LockPackage {
  readonly [key: string]: unknown
}

/** Write a lockfileVersion 3 project whose root requires `rootDeps`. */
function withProject(
  packages: Record<string, LockPackage>,
  rootDeps: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  return (async () => {
    const root = mkdtempSync(join(tmpdir(), 'nc-path-'))
    try {
      writeFileSync(
        join(root, 'package-lock.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'app', version: '1.0.0', dependencies: rootDeps },
            ...packages,
          },
        }),
      )
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', version: '1.0.0', dependencies: rootDeps }),
      )
      await fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })()
}

/**
 * Chain head = the project root node, whose name arborist takes from the
 * directory (`@npmcli/name-from-folder`), not from `package.json`. Tests resolve
 * it instead of hardcoding a temp-directory name.
 */
function rootName(packages: Record<string, LockfilePackage>): string {
  const root = Object.values(packages).find((p) => p.isRoot)
  if (!root) throw new Error('ingest produced no root node')
  return root.name
}

/** A project: app → framework → database → native-addon (four levels). */
const nested: Record<string, LockPackage> = {
  'node_modules/framework': { version: '2.0.0', dependencies: { helper: '1.0.0' } },
  'node_modules/helper': { version: '1.0.0' },
  'node_modules/framework2': { version: '3.0.0', dependencies: { helper: '1.0.0' } },
  'node_modules/database': { version: '2.0.0', dependencies: { 'native-addon': '1.0.0' } },
  'node_modules/native-addon': { version: '1.0.0', dependencies: { nan: '2.18.0' } },
  'node_modules/nan': { version: '2.18.0' },
}

describe('ingest · 真实依赖链（pathChains）', () => {
  it('记录从项目根到目标的完整链路，而不是只重复包名', async () => {
    await withProject(nested, { framework: '2.0.0', database: '2.0.0' }, async (root) => {
      const outcome = await ingest(root)
      if (!outcome.ok) throw new Error(outcome.reason)
      const addon = outcome.graph.packages['native-addon@1.0.0']
      expect(addon?.pathChains).toEqual([
        [rootName(outcome.graph.packages), 'database', 'native-addon'],
      ])
    })
  })

  it('同一包从多条路径可达时保留多条链（上限内）', async () => {
    await withProject(nested, { framework: '2.0.0', framework2: '3.0.0' }, async (root) => {
      const outcome = await ingest(root)
      if (!outcome.ok) throw new Error(outcome.reason)
      // helper 可经 framework 或 framework2 到达 → 两条链都保留
      const head = rootName(outcome.graph.packages)
      expect(outcome.graph.packages['helper@1.0.0']?.pathChains).toEqual([
        [head, 'framework', 'helper'],
        [head, 'framework2', 'helper'],
      ])
    })
  })

  it('环状依赖不会卡死，链上不重复出现同一包', async () => {
    const cyclic: Record<string, LockPackage> = {
      'node_modules/a': { version: '1.0.0', dependencies: { b: '1.0.0' } },
      'node_modules/b': { version: '1.0.0', dependencies: { a: '1.0.0' } },
    }
    await withProject(cyclic, { a: '1.0.0' }, async (root) => {
      const outcome = await ingest(root)
      if (!outcome.ok) throw new Error(outcome.reason)
      const head = rootName(outcome.graph.packages)
      expect(outcome.graph.packages['a@1.0.0']?.pathChains).toEqual([[head, 'a']])
      expect(outcome.graph.packages['b@1.0.0']?.pathChains).toEqual([[head, 'a', 'b']])
    })
  })
})

describe('scan · 报告的 Dependency path 段', () => {
  it('finding 的 paths 带上完整链与 dev 标记', async () => {
    await withProject(nested, { database: '2.0.0' }, async (root) => {
      const { report } = await scan(root, { mode: 'fast', env })
      const addon = report.findings.find((f) => f.pkg.name === 'native-addon')
      const chain = addon?.paths[0]?.chain ?? []
      expect(chain.slice(-2)).toEqual(['database', 'native-addon'])
      expect(chain).toHaveLength(3) // 根 → database → native-addon
      expect(addon?.paths[0]?.dev).toBe(false)
    })
  })
})
