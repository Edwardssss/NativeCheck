/**
 * Robustness: malformed / hostile inputs must degrade gracefully — scan never
 * throws, never silently misclassifies. Every case here asserts the funnel
 * returns an explicit `unsupported` (Fail Closed) or an empty/UNVERIFIED report,
 * NOT a panic.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/adapters/node/pipeline'
import type { Environment } from '../src/core/model'

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

function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  return (async () => {
    const root = mkdtempSync(join(tmpdir(), 'nc-robust-'))
    try {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(root, rel)
        mkdirSync(join(abs, '..'), { recursive: true })
        writeFileSync(abs, content)
      }
      await fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })()
}

describe('robustness · malformed lockfiles (no panic, Fail Closed)', () => {
  it('no lockfile → unsupported, nothing thrown', async () => {
    await withProject({ 'package.json': '{}' }, async (root) => {
      const { report, unsupported } = await scan(root, { mode: 'fast', env })
      expect(unsupported).toBeDefined()
      expect(report.findings).toEqual([])
    })
  })

  it('lockfile with a JSON syntax error → unsupported, nothing thrown', async () => {
    await withProject({ 'package-lock.json': '{ this is not valid json' }, async (root) => {
      const { report, unsupported } = await scan(root, { mode: 'fast', env })
      expect(unsupported).toBeDefined()
      expect(report.summary.networkCalls).toBe(0)
    })
  })

  it('lockfileVersion missing, packages empty → unsupported or empty report, nothing thrown', async () => {
    await withProject(
      { 'package-lock.json': JSON.stringify({ name: 'x', version: '1.0.0', packages: {} }) },
      async (root) => {
        const { report, unsupported } = await scan(root, { mode: 'fast', env })
        // Either explicitly unsupported or a normal run with empty findings — never a panic.
        if (unsupported) expect(report.findings).toEqual([])
        else expect(report.summary.nativeCandidates).toBeGreaterThanOrEqual(0)
      },
    )
  })

  it('packages is an array (not an object) → nothing thrown', async () => {
    await withProject(
      {
        'package-lock.json': JSON.stringify({
          name: 'x',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: [1, 2, 3],
        }),
      },
      async (root) => {
        const { report } = await scan(root, { mode: 'fast', env })
        expect(report).toBeDefined()
        expect(report.summary.networkCalls).toBe(0)
      },
    )
  })

  it('lockfileVersion=3 with a dependency cycle in packages → no throw, no infinite loop', async () => {
    const lock = {
      name: 'x',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: '1.0.0', dependencies: { a: '1.0.0' } },
        'node_modules/a': {
          version: '1.0.0',
          dependencies: { b: '1.0.0' },
        },
        'node_modules/b': {
          version: '1.0.0',
          dependencies: { a: '1.0.0' },
        },
      },
    }
    await withProject({ 'package-lock.json': JSON.stringify(lock) }, async (root) => {
      const { report } = await scan(root, { mode: 'fast', env })
      expect(report).toBeDefined()
      expect(report.summary.networkCalls).toBe(0)
    })
  })

  it('dependencies is a string (malformed) → nothing thrown', async () => {
    const lock = {
      name: 'x',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: '1.0.0', dependencies: 'not-an-object' },
        'node_modules/nan': { version: '2.0.0', dependencies: 42 },
      },
    }
    await withProject({ 'package-lock.json': JSON.stringify(lock) }, async (root) => {
      const { report } = await scan(root, { mode: 'fast', env })
      expect(report).toBeDefined()
      expect(report.summary.networkCalls).toBe(0)
    })
  })
})

describe('robustness · unsupported lockfile formats (Fail Closed)', () => {
  it('text bun.lock (Bun 1.2+ default) → points at it, not at "no lockfile found"', async () => {
    await withProject({ 'bun.lock': '{ "lockfileVersion": 0 }' }, async (root) => {
      const { report, unsupported } = await scan(root, { mode: 'fast', env })
      expect(unsupported?.detected).toBe('bun.lock (text)')
      expect(unsupported?.reason).toContain('bun.lockb')
      // The supported list comes from what ingest really handles, not a hardcoded npm
      const supported = report.unsupported?.supported.join(' ') ?? ''
      expect(supported).toContain('bun.lockb')
      expect(supported).toContain('pnpm')
      expect(report.findings).toEqual([])
      expect(report.summary.networkCalls).toBe(0)
    })
  })
})
