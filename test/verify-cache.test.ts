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

/** 内存版 fs + 可拨动时钟。 */
function memFs(startMs: number): {
  fs: VerifyCacheFs
  clock: { now: number }
  disk: Map<string, string>
} {
  const disk = new Map<string, string>()
  let now = startMs
  const fs: VerifyCacheFs = {
    readFile: async (p) => {
      const v = disk.get(p)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    writeFile: async (p, d) => void disk.set(p, d),
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
  }
}

function outcome(status: 'matched' | 'absent' | 'unknown' = 'matched'): VerifyOutcome {
  return { b: { status, observed: [] }, networkCalls: 2 }
}

describe('verifyCacheKey', () => {
  it('把 包身份 + 模式 + 环境 编码进 key', () => {
    const k = verifyCacheKey('better-sqlite3', '13.0.3', DistributionPattern.Prebuildify, env)
    expect(k).toBe('better-sqlite3@13.0.3#Prebuildify#linux-x64-glibc-127')
  })

  it('环境变化 → key 变化（防止跨平台串味）', () => {
    const win: Environment = { ...env, os: 'win32', libc: undefined }
    const k1 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, env)
    const k2 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, win)
    expect(k1).not.toBe(k2)
  })

  it('同一环境下 libc=musl 与 glibc 的 key 不同', () => {
    const musl: Environment = { ...env, libc: 'musl' }
    const k1 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, env)
    const k2 = verifyCacheKey('a', '1', DistributionPattern.Prebuildify, musl)
    expect(k1).not.toBe(k2)
  })
})

describe('verifyCachePath', () => {
  it('落盘到 projectRoot/node_modules/.cache/nativecheck/verify.json', () => {
    expect(verifyCachePath('/proj')).toBe(
      join('/proj', 'node_modules', '.cache', 'nativecheck', 'verify.json'),
    )
  })
})

describe('loadVerifyCache / saveVerifyCache 往返', () => {
  it('save 后 load 能取回同 key 记录', async () => {
    const { fs } = memFs(1_000)
    const path = '/proj/node_modules/.cache/nativecheck/verify.json'
    const rec: VerifyCacheRecord = { key: 'k1', outcome: outcome('absent'), fetchedAt: 1_000 }
    await saveVerifyCache(path, [rec], fs)
    const loaded = await loadVerifyCache(path, fs)
    expect(loaded.get('k1')?.outcome.b?.status).toBe('absent')
    expect(loaded.get('k1')?.fetchedAt).toBe(1_000)
  })

  it('合并写回：新结果覆盖同 key 旧记录，异 key 保留', async () => {
    const { fs } = memFs(1_000)
    const path = '/x/y/verify.json'
    await saveVerifyCache(path, [{ key: 'a', outcome: outcome('absent'), fetchedAt: 1_000 }], fs)
    await saveVerifyCache(path, [{ key: 'b', outcome: outcome('matched'), fetchedAt: 2_000 }], fs)
    await saveVerifyCache(path, [{ key: 'a', outcome: outcome('unknown'), fetchedAt: 3_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    expect(loaded.size).toBe(2)
    expect(loaded.get('a')?.outcome.b?.status).toBe('unknown') // 覆盖
    expect(loaded.get('b')?.outcome.b?.status).toBe('matched') // 保留
    expect(loaded.get('a')?.fetchedAt).toBe(3_000)
  })

  it('save 不写目录时不抛（mkdir 幂等 / 静默容错）', async () => {
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
    ).resolves.toBeUndefined() // 写失败静默，不影响主路径
  })

  it('损坏 JSON → 视为空缓存，不抛', async () => {
    const { fs, disk } = memFs(1_000)
    disk.set('/x/verify.json', '{ not json !!!')
    const loaded = await loadVerifyCache('/x/verify.json', fs)
    expect(loaded.size).toBe(0)
  })

  it('缺文件 → 空缓存，不抛', async () => {
    const { fs } = memFs(1_000)
    const loaded = await loadVerifyCache('/nope/verify.json', fs)
    expect(loaded.size).toBe(0)
  })

  it('旧版缓存（version=1）→ 视为空缓存（取证语义变更后整体失效）', async () => {
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
    expect(loaded.size).toBe(0) // version 不匹配 → 丢弃，重新取证（F 方案语义变更）
  })
})

describe('lookupCachedOutcome', () => {
  const path = '/x/verify.json'

  it('命中 → 返回语义结果且 networkCalls 归零', async () => {
    const { fs } = memFs(5_000)
    await saveVerifyCache(path, [{ key: 'k1', outcome: outcome('matched'), fetchedAt: 4_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    const hit = lookupCachedOutcome(loaded, 'k1', { now: 5_000, ttlMs: DEFAULT_TTL_MS })
    expect(hit?.b?.status).toBe('matched')
    expect(hit?.networkCalls).toBe(0) // 命中 = 没打到网络
  })

  it('缺 key → undefined', async () => {
    const { fs } = memFs(5_000)
    const loaded = await loadVerifyCache(path, fs)
    expect(lookupCachedOutcome(loaded, 'missing', { now: 5_000 })).toBeUndefined()
  })

  it('TTL 过期 → undefined（不把陈旧当可信）', async () => {
    const { fs } = memFs(10_000)
    await saveVerifyCache(path, [{ key: 'k1', outcome: outcome('matched'), fetchedAt: 1_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    const ttlMs = 5_000 // 1_000 + 5_000 = 6_000 < 10_000 → 过期
    expect(lookupCachedOutcome(loaded, 'k1', { now: 10_000, ttlMs })).toBeUndefined()
  })

  it('恰好未过期 → 命中', async () => {
    const { fs } = memFs(6_000)
    await saveVerifyCache(path, [{ key: 'k1', outcome: outcome('matched'), fetchedAt: 1_000 }], fs)
    const loaded = await loadVerifyCache(path, fs)
    expect(lookupCachedOutcome(loaded, 'k1', { now: 6_000, ttlMs: 5_000 })).toBeDefined() // 1_000+5_000 = 6_000 边界未过期
  })
})

describe('pruneVerifyCache', () => {
  it('清掉过期记录，保留新鲜，返回清除数', async () => {
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
  it('使用真实时钟（Date.now 量级）', () => {
    const fs = defaultVerifyCacheFs()
    const before = Date.now()
    const now = fs.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})
