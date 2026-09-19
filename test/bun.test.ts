/**
 * bun.lockb adapter — parse the binary lockfile via @hyrious/bun.lockb into
 * LockfilePackage[], plus a scan integration over a real bun project.
 *
 * bun.lockb is decoded to yarn-lock-v1 text by @hyrious/bun.lockb and then
 * normalised by the shared yarn v1 parser (see src/adapters/node/bun.ts).
 * The integration assertions therefore mirror the yarn v1 ones.
 */
import { describe, expect, it } from 'vitest'
import { parseBunLockfile } from '../src/adapters/node/bun'
import { scan } from '../src/adapters/node/pipeline'
import type { Environment } from '../src/core/model'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

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

const bunRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'testdata', 'bun-lockb')

describe('parseBunLockfile', () => {
  it('real bun.lockb → parses packages + an optional platform cluster (Pattern A signal)', () => {
    const buf = readFileSync(join(bunRoot, 'bun.lockb'))
    const list = parseBunLockfile(buf)
    const byName = new Map(list.map((p) => [p.name, p]))

    expect(list.length).toBeGreaterThan(30)
    const esbuild = byName.get('esbuild')
    expect(esbuild).toBeDefined()
    // The yarn-v1 conversion of bun.lockb keeps optionalDependencies → esbuild platform cluster.
    const optCount = Object.values(esbuild?.dependencies ?? {}).filter((d) => d.optional).length
    expect(optCount).toBeGreaterThanOrEqual(20)

    const bs = byName.get('better-sqlite3')
    expect(bs?.dependencies?.['prebuild-install']).toEqual({ name: 'prebuild-install' })
  })

  it('malformed input (a non-bun.lockb buffer) → throws (ingest turns that into Fail Closed)', () => {
    expect(() => parseBunLockfile(Buffer.from('not a lockb', 'utf8'))).toThrow()
  })
})

describe('bun integration · scan of a real bun.lockb (zero network)', () => {
  it('esbuild → Pattern A，better-sqlite3 → Pattern C', async () => {
    const { report, unsupported } = await scan(bunRoot, { mode: 'fast', env })
    expect(unsupported).toBeUndefined()
    expect(report.summary.networkCalls).toBe(0)
    expect(report.summary.totalPackages).toBeGreaterThanOrEqual(40)

    const esbuild = report.findings.find((f) => f.pkg.name === 'esbuild')
    expect(esbuild?.pattern).toBe('PlatformOptionalDeps')
    expect(esbuild?.risk).toBe('LOW')

    const bs = report.findings.find((f) => f.pkg.name === 'better-sqlite3')
    expect(bs?.pattern).toBe('RemoteDownload')
  })
})
