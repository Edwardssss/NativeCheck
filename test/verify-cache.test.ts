/**
 * verify-cache.ts — the on-disk cache for --deep forensics.
 *
 * Focus: key construction, load/save round-trip, TTL expiry, hits zeroing
 * networkCalls, tolerance of corrupt files. Everything uses an in-memory fs and a
 * controllable clock; no real disk or network is touched.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { DistributionPattern, type Environment } from '../src/core/model'
import {
  DEFAULT_TTL_MS,
  defaultVerifyCacheFs,
  loadVerifyCache,
  lookupCachedOutcome,
  pruneVerifyCache,
  saveVerifyCache,
  verifyCacheKey,
  verifyCachePath,
  type VerifyCacheFs,
  type VerifyCacheRecord,
} from '../src/adapters/node/verify-cache'
import type { VerifyOutcome } from '../src/adapters/node/verify'

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

/**
 * An in-memory fs with a clock that can be moved forward.
 *
 * `writes` records the target of every writeFile call, which is how the test proves the
 * cache is written through "temporary file + rename" rather than overwriting the target
 */
function memFs(startMs: number): {
  fs: VerifyCacheFs
  clock: { now: number }
  disk: Map<string, string>
  writes: string[]
} {
  const disk = new Map<string, string>()
  const writes: string[] = []
  let now = startMs
  const fs: VerifyCacheFs = {
    readFile: async (p) => {
      const v = disk.get(p)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    writeFile: async (p, d) => {
      writes.push(p)
      void disk.set(p, d)
    },
    rename: async (from, to) => {
      const v = disk.get(from)
      if (v === undefined) throw new Error('ENOENT')
      disk.set(to, v)
      disk.delete(from)
    },
    mkdir: async () => undefined,
    now: () => now,
  }
  return {
    fs,
    clock: {
      get now() {
        return now
      },
      set now(v) {
        now = v
      },
    },
    disk,
    writes,
  }
}

function outcome(status: 'matched' | 'absent' | 'unknown' = 'matched'): VerifyOutcome {
  return { b: { status, observed: [] }, networkCalls: 2 }
}

describe('verifyCacheKey', () => {
  it('encodes package identity + pattern + environment into the key', () => {
    const k = verifyCacheKey('better-sqlite3', '13.0.3', DistributionPattern.Prebuildify, env)
    expect(k).toBe('better-sqlite3@13.0.3#Prebuildify#linux-x64-glibc-127')
  })

  it('a changed environment changes the key (no cross-platform bleed)', () => {
    const win: Environment = { ...env, os: 'win32', libc: undefined }
    const k1 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, env)
    const k2 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, win)
    expect(k1).not.toBe(k2)
  })

  it('libc=musl and glibc keys differ inside one environment', () => {
    const musl: Environment = { ...env, libc: 'musl' }
    const k1 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, env)
    const k2 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, musl)
    expect(k1).not.toBe(k2)
  })
})

describe('verifyCachePath', () => {
  it('is written to projectRoot/node_modules/.cache/nativecheck/verify.json', () => {
    expect(verifyCachePath('/proj')).toBe(
      join('/proj', 'node_modules', '.cache', 'nativecheck', 'verify.json'),
    )
  })
})

describe('loadVerifyCache / saveVerifyCache round trip', () => {
  it('a record saved under a key loads back', async () => {
    const { fs } = memFs(1_000)
    const path = '/proj/node_modules/.cache/nativecheck/verify.json'
    const rec: VerifyCacheRecord = { key: 'k1', outcome: outcome('absent'), fetchedAt: 1_000 }
    await saveVerifyCache(path, [rec], fs)
    const loaded = await loadVerifyCache(path, fs)
    expect(loaded.get('k1')?.outcome.b?.status).toBe('absent')
    expect(loaded.get('k1')?.fetchedAt).toBe(1_000)
  })

  it('merges on write: a new result replaces the same key, other keys survive', async () => {
    const { fs } = memFs(1_000)
    const path = '/x/y/verify.json'
    await saveVerifyCache(path, [{ key: 'a', outcome: outcome('absent'), fetchedAt: 1_000 }], fs)
    await saveVerifyCache(path, [{ key: 'b', outcome: outcome('matched'), fetchedAt: 2_000 }], fs)
    await saveVerifyCache(path, [{ key: 'a', outcome: outcome('unknown'), fetchedAt: 3_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    expect(loaded.size).toBe(2)
    expect(loaded.get('a')?.outcome.b?.status).toBe('unknown') // replaced
    expect(loaded.get('b')?.outcome.b?.status).toBe('matched') // kept
    expect(loaded.get('a')?.fetchedAt).toBe(3_000)
  })

  it('save does not throw when it cannot write the directory (mkdir is idempotent)', async () => {
    const { fs } = memFs(1_000)
    const failMkdir: VerifyCacheFs = {
      ...fs,
      mkdir: async () => {
        throw new Error('EROFS')
      },
    }
    await expect(
      saveVerifyCache(
        '/ro/verify.json',
        [{ key: 'a', outcome: outcome(), fetchedAt: 1 }],
        failMkdir,
      ),
    ).resolves.toBeUndefined() // a failed write stays silent, the main path is unaffected
  })

  it('writes through "temp file + rename" so the target never holds half a cache', async () => {
    const { fs, writes, disk } = memFs(1_000)
    const path = '/x/verify.json'
    await saveVerifyCache(path, [{ key: 'a', outcome: outcome(), fetchedAt: 1_000 }], fs)
    // Overwriting the target directly is the dangerous option: a crash mid-write leaves
    expect(writes).toEqual([`${path}.tmp`])
    expect(disk.has(`${path}.tmp`)).toBe(false) // the temp file is gone after the rename
    expect(JSON.parse(disk.get(path) ?? '{}')).toMatchObject({ version: 2 })
  })

  it('keeps the old file when the rename fails (better to lose a record than to write a corrupt cache)', async () => {
    const { fs, disk } = memFs(1_000)
    const path = '/x/verify.json'
    await saveVerifyCache(path, [{ key: 'old', outcome: outcome(), fetchedAt: 1_000 }], fs)
    const before = disk.get(path)
    const failRename: VerifyCacheFs = {
      ...fs,
      rename: async () => {
        throw new Error('EPERM')
      },
    }
    await expect(
      saveVerifyCache(path, [{ key: 'new', outcome: outcome(), fetchedAt: 2_000 }], failRename),
    ).resolves.toBeUndefined()
    expect(disk.get(path)).toBe(before) // the old contents are intact and still parse
  })

  it('prunes expired records while writing (the cache cannot grow without bound)', async () => {
    const { fs } = memFs(1_000)
    const path = '/x/verify.json'
    await saveVerifyCache(path, [{ key: 'stale', outcome: outcome(), fetchedAt: 1_000 }], fs)
    // push the clock past the TTL, then write a new record: stale entries must not come back
    const { fs: lateFs } = memFs(1_000 + DEFAULT_TTL_MS + 1)
    await saveVerifyCache(path, [{ key: 'fresh', outcome: outcome(), fetchedAt: 2_000 }], lateFs)
    const loaded = await loadVerifyCache(path, lateFs)
    expect([...loaded.keys()]).toEqual(['fresh'])
  })

  it('corrupt JSON → treated as an empty cache, no throw', async () => {
    const { fs, disk } = memFs(1_000)
    disk.set('/x/verify.json', '{ not json !!!')
    const loaded = await loadVerifyCache('/x/verify.json', fs)
    expect(loaded.size).toBe(0)
  })

  it('a missing file → empty cache, no throw', async () => {
    const { fs } = memFs(1_000)
    const loaded = await loadVerifyCache('/nope/verify.json', fs)
    expect(loaded.size).toBe(0)
  })

  it('an old cache (version=1) → empty cache (the semantics changed, so everything is stale)', async () => {
    const { fs, disk } = memFs(1_000)
    disk.set(
      '/x/verify.json',
      JSON.stringify({
        version: 1,
        records: [
          { key: 'bcrypt@6.0.0#2#linux-x64-glibc-127', outcome: outcome('unknown'), fetchedAt: 1 },
        ],
      }),
    )
    const loaded = await loadVerifyCache('/x/verify.json', fs)
    expect(loaded.size).toBe(0) // version mismatch → discard and verify again
  })
})

describe('lookupCachedOutcome', () => {
  const path = '/x/verify.json'

  it('a hit returns the semantic result with networkCalls zeroed', async () => {
    const { fs } = memFs(5_000)
    await saveVerifyCache(path, [{ key: 'k1', outcome: outcome('matched'), fetchedAt: 4_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    const hit = lookupCachedOutcome(loaded, 'k1', { now: 5_000, ttlMs: DEFAULT_TTL_MS })
    expect(hit?.b?.status).toBe('matched')
    expect(hit?.networkCalls).toBe(0) // a hit means the network was never touched
  })

  it('a missing key → undefined', async () => {
    const { fs } = memFs(5_000)
    const loaded = await loadVerifyCache(path, fs)
    expect(lookupCachedOutcome(loaded, 'missing', { now: 5_000 })).toBeUndefined()
  })

  it('an expired TTL → undefined (stale is never treated as trusted)', async () => {
    const { fs } = memFs(10_000)
    await saveVerifyCache(path, [{ key: 'k1', outcome: outcome('matched'), fetchedAt: 1_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    const ttlMs = 5_000 // 1_000 + 5_000 = 6_000 < 10_000 → expired
    expect(lookupCachedOutcome(loaded, 'k1', { now: 10_000, ttlMs })).toBeUndefined()
  })

  it('exactly at the boundary (not yet expired) → hit', async () => {
    const { fs } = memFs(6_000)
    await saveVerifyCache(path, [{ key: 'k1', outcome: outcome('matched'), fetchedAt: 1_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    expect(lookupCachedOutcome(loaded, 'k1', { now: 6_000, ttlMs: 5_000 })).toBeDefined() // 1_000 + 5_000 = 6_000, still fresh
  })
})

describe('pruneVerifyCache', () => {
  it('drops expired records, keeps fresh ones, returns how many it dropped', async () => {
    const m = new Map<string, VerifyCacheRecord>()
    m.set('old', { key: 'old', outcome: outcome(), fetchedAt: 0 })
    m.set('fresh', { key: 'fresh', outcome: outcome(), fetchedAt: 99_000 })
    const removed = pruneVerifyCache(m, { now: 100_000, ttlMs: 10_000 })
    expect(removed).toBe(1)
    expect(m.has('old')).toBe(false)
    expect(m.has('fresh')).toBe(true)
  })
})

describe('defaultVerifyCacheFs', () => {
  it('uses the real clock (a Date.now-scale timestamp)', () => {
    const fs = defaultVerifyCacheFs()
    const before = Date.now()
    const now = fs.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})
