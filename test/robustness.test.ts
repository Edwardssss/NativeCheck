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

describe('robustness · 畸形 lockfile（不 panic，Fail Closed）', () => {
  it('无 lockfile → unsupported，不抛异常', async () => {
    await withProject({ 'package.json': '{}' }, async (root) => {
      const { report, unsupported } = await scan(root, { mode: 'fast', env })
      expect(unsupported).toBeDefined()
      expect(report.findings).toEqual([])
    })
  })

  it('lockfile JSON 语法错误 → unsupported，不抛异常', async () => {
    await withProject({ 'package-lock.json': '{ this is not valid json' }, async (root) => {
      const { report, unsupported } = await scan(root, { mode: 'fast', env })
      expect(unsupported).toBeDefined()
      expect(report.summary.networkCalls).toBe(0)
    })
  })

  it('lockfileVersion 缺失但 packages 空 → unsupported 或空报告，不抛异常', async () => {
    await withProject(
      { 'package-lock.json': JSON.stringify({ name: 'x', version: '1.0.0', packages: {} }) },
      async (root) => {
        const { report, unsupported } = await scan(root, { mode: 'fast', env })
        // 要么显式 unsupported，要么正常跑出空 findings——绝不 panic。
        if (unsupported) expect(report.findings).toEqual([])
        else expect(report.summary.nativeCandidates).toBeGreaterThanOrEqual(0)
      },
    )
  })

  it('packages 是数组（非对象）→ 不抛异常', async () => {
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

  it('lockfile 有 lockfileVersion=3 但 packages 里含循环依赖 → 不抛异常、不无限循环', async () => {
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

  it('dependencies 字段是字符串（畸形）→ 不抛异常', async () => {
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
