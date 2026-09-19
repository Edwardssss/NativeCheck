/**
 * On-disk cache for Layer 2 forensics (--deep only).
 *
 * Design doc §W4. Registry content for a given `name@version` is effectively
 * immutable, so forensics results can be safely reused, cutting repeated
 * `--deep` network requests from O(candidates) to 0. The cache is an
 * optimization, not a failure point: a hit zeroes `networkCalls` (this module is
 * the only place that knows whether the network was really touched), but a hit
 * must never let UNVERIFIED be guessed into HIGH (match still reports Replay).
 *
 * The three implementation choices behind the cache format (key / TTL /
 * location) are recorded in §28.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Environment } from '../../core/model'
import type { DistributionPattern } from '../../core/model'
import type { VerifyOutcome } from './verify'

/** Persisted shape of a single cache record. */
export interface VerifyCacheRecord {
  /** Cache key (see `verifyCacheKey`). */
  readonly key: string
  /** Semantic content of the forensics result; `networkCalls` is overwritten to 0 by this module on a hit. */
  readonly outcome: VerifyOutcome
  /** Epoch ms. Used for TTL expiry checks. */
  readonly fetchedAt: number
}

/** The whole cache file (one file per project; size is on the order of the candidate count, usually < 100). */
export interface VerifyCacheFile {
  /**
   * Cache format version. Must be bumped whenever forensics **semantics** change
   * (e.g. adding the `--napi` build signal flips B from unknown to matched), so
   * that caches produced by older code are invalidated wholesale — otherwise a
   * stale UNVERIFIED would be served and hide the new conclusion until the 7-day
   * TTL expires naturally.
   */
  readonly version: 2
  readonly records: readonly VerifyCacheRecord[]
}

/** Injectable filesystem and clock, so the module is unit-testable (mirrors network.ts's injectable fetch design). */
export interface VerifyCacheFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  /** Atomic replace. Required (not optional): the write path's safety depends on it. */
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>
  now(): number
}

/** Production implementation: real node:fs + Date.now. */
export function defaultVerifyCacheFs(): VerifyCacheFs {
  return {
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, d) => writeFile(p, d, 'utf8'),
    rename: (from, to) => rename(from, to),
    mkdir: (p, o) => mkdir(p, o),
    now: () => Date.now(),
  }
}

/**
 * Cache key for a forensics result. Compresses "everything that determines the
 * result" into one string:
 *   - package identity (`name@version`): pinned, content-addressed;
 *   - distribution pattern: B scans a tarball while C issues a HEAD; the results are not interchangeable;
 *   - environment (os-arch-libc-abi): platform sub-packages / prebuilds / ABI suffixes all vary with it.
 */
export function verifyCacheKey(
  name: string,
  version: string,
  pattern: DistributionPattern,
  env: Environment,
): string {
  const ident = `${env.os}-${env.arch}-${env.libc ?? 'glibc'}-${env.nodeAbi ?? 'na'}`
  return `${name}@${version}#${pattern}#${ident}`
}

/** Canonical cache file path: `<projectRoot>/node_modules/.cache/nativecheck/verify.json`. */
export function verifyCachePath(projectRoot: string): string {
  return join(projectRoot, 'node_modules', '.cache', 'nativecheck', 'verify.json')
}

/**
 * Read and sanitize the cache file. Any corrupt / old-version / missing file
 * collapses into an empty cache — the cache is a performance optimization and
 * must never become a failure point. Failing to hit merely means "re-run
 * forensics this time", which is safe.
 */
export async function loadVerifyCache(
  path: string,
  fs: VerifyCacheFs = defaultVerifyCacheFs(),
): Promise<Map<string, VerifyCacheRecord>> {
  const out = new Map<string, VerifyCacheRecord>()
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch {
    return out // file missing / unreadable → empty cache
  }
  try {
    const parsed = JSON.parse(raw) as Partial<VerifyCacheFile>
    if (parsed?.version !== 2 || !Array.isArray(parsed.records)) return out
    for (const r of parsed.records) {
      if (!r || typeof r.key !== 'string' || !r.outcome) continue
      out.set(r.key, { key: r.key, outcome: r.outcome, fetchedAt: Number(r.fetchedAt) || 0 })
    }
  } catch {
    return out // corrupt JSON → treat as empty cache
  }
  return out
}

/**
 * Look up a record, handling TTL expiry. Hit and not expired → return the
 * outcome (the caller uses it and overwrites networkCalls to 0); expired /
 * missing → undefined (the caller hits the real network).
 */
export function lookupCachedOutcome(
  cache: Map<string, VerifyCacheRecord>,
  key: string,
  opts: { ttlMs?: number; now?: number } = {},
): VerifyOutcome | undefined {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now()
  const rec = cache.get(key)
  if (!rec) return undefined
  if (now - rec.fetchedAt > ttlMs) return undefined // expired counts as a miss
  // Hit: return the semantic content, but the network call count must be zeroed
  // — this is the only source of truth for "we didn't actually hit the network".
  return { ...rec.outcome, networkCalls: 0 }
}

/**
 * Merge a batch of new results back into the cache file.
 *
 * The write is **atomic**: the payload goes to `<path>.tmp` and is then renamed
 * over the target. A plain `writeFile` truncates first, so a crash (or a second
 * process writing at the same time) left a half-written JSON file — which this
 * module then treats as a corrupt cache and silently drops, losing every entry
 * rather than one. `rename` within a directory is atomic on POSIX and on NTFS.
 *
 * Expired records are pruned on the way out, so a long-lived cache does not grow
 * without bound (`pruneVerifyCache` used to be dead code).
 *
 * Write failures stay silent: the cache is an optimization, not a failure point.
 */
export async function saveVerifyCache(
  path: string,
  entries: readonly VerifyCacheRecord[],
  fs: VerifyCacheFs = defaultVerifyCacheFs(),
): Promise<void> {
  if (entries.length === 0) return
  try {
    const existing = await loadVerifyCache(path, fs)
    for (const e of entries) existing.set(e.key, e)
    // Drop what has expired before persisting, so the file stays proportional to
    // the live candidate set instead of accumulating one record per package that
    // was ever scanned.
    pruneVerifyCache(existing, { ttlMs: DEFAULT_TTL_MS, now: fs.now() })
    const data: VerifyCacheFile = {
      version: 2,
      records: [...existing.values()],
    }
    // Create the directory first, then write. When the directory is not under
    // projectRoot (e.g. /tmp in tests), `relative` falls back to the basename —
    // we only mkdir up to the directory containing the target, guaranteeing the
    // write location matches `path`.
    await fs.mkdir(dirname(path), { recursive: true })
    // Write-then-rename: the target file is only ever observed complete.
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2))
    await fs.rename(tmp, path)
  } catch {
    // A failed cache write does not affect the scan result — we only lose next time's speedup.
  }
}

/**
 * Drop stale / expired records. Called by `saveVerifyCache` on every write, and
 * exported for callers that want to maintain a cache without scanning.
 */
export function pruneVerifyCache(
  cache: Map<string, VerifyCacheRecord>,
  opts: { ttlMs?: number; now?: number } = {},
): number {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now()
  let removed = 0
  for (const [k, r] of cache) {
    if (now - r.fetchedAt > ttlMs) {
      cache.delete(k)
      removed++
    }
  }
  return removed
}

/** Default TTL: 7 days. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
