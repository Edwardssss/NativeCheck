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

describe('ingest · real dependency chains (pathChains)', () => {
  it('records the full chain from project root to target, not just the package name again', async () => {
    await withProject(nested, { framework: '2.0.0', database: '2.0.0' }, async (root) => {
      const outcome = await ingest(root)
      if (!outcome.ok) throw new Error(outcome.reason)
      const addon = outcome.graph.packages['native-addon@1.0.0']
      expect(addon?.pathChains).toEqual([
        [rootName(outcome.graph.packages), 'database', 'native-addon'],
      ])
    })
  })

  it('keeps several chains when a package is reachable via several paths (within the cap)', async () => {
    await withProject(nested, { framework: '2.0.0', framework2: '3.0.0' }, async (root) => {
      const outcome = await ingest(root)
      if (!outcome.ok) throw new Error(outcome.reason)
      // helper is reachable via framework or framework2 → both chains are kept
      const head = rootName(outcome.graph.packages)
      expect(outcome.graph.packages['helper@1.0.0']?.pathChains).toEqual([
        [head, 'framework', 'helper'],
        [head, 'framework2', 'helper'],
      ])
    })
  })

  it('cyclic dependencies do not hang and no package repeats within a chain', async () => {
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

describe('scan · the Dependency path section of the report', () => {
  it('paths on a finding carry the full chain plus the dev flag', async () => {
    await withProject(nested, { database: '2.0.0' }, async (root) => {
      const { report } = await scan(root, { mode: 'fast', env })
      const addon = report.findings.find((f) => f.pkg.name === 'native-addon')
      const chain = addon?.paths[0]?.chain ?? []
      expect(chain.slice(-2)).toEqual(['database', 'native-addon'])
      expect(chain).toHaveLength(3) // root → database → native-addon
      expect(addon?.paths[0]?.dev).toBe(false)
    })
  })
})
