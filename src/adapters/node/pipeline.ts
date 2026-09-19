/**
 * Scan orchestration for the Node adapter (the four-layer funnel).
 *
 *   ingest (L0, 0 net) → classify (L1, 0 net) → verify (L2, --deep only)
 *                                            → match (L3, 0 net) → ScanReport
 *
 * Network requests drop from O(all packages) to O(candidates). Fast mode hard
 * asserts zero network (networkCalls === 0); that assertion is the only reliable
 * way to keep the default path fully offline.
 */
import { scanEnvironment } from '../../env'
import { summarize, type ScanReport } from '../../core/report'
import type { Environment } from '../../core/model'
import { classifyGraph, type NativeCandidate } from './classify'
import { ingest, SUPPORTED_LOCKFILES } from './ingest'
import { matchCandidate } from './match'
import { candidateNeedsNetwork, verifyCandidate } from './verify'
import type { VerifyOutcome } from './verify'
import { defaultFetch, type HttpLike } from './network'
import {
  DEFAULT_TTL_MS,
  defaultVerifyCacheFs,
  loadVerifyCache,
  lookupCachedOutcome,
  saveVerifyCache,
  verifyCacheKey,
  verifyCachePath,
  type VerifyCacheFs,
  type VerifyCacheRecord,
} from './verify-cache'
import type { IngestOutcome } from './ingest'

export interface ScanOptions {
  /** Layer 2 online forensics only with `--deep` (B / C candidates only). Fast is always zero-network. */
  readonly deep?: boolean
  /** Inject an environment snapshot for unit tests; otherwise scan the live environment. */
  readonly env?: Environment
  readonly mode?: 'fast' | 'deep'
  /** Inject the HTTP transport (for tests); defaults to global fetch. */
  readonly fetchImpl?: HttpLike
  /** Forensics cache file path. Defaults to under projectRoot/node_modules/.cache; pass null to disable the disk cache. */
  readonly cachePath?: string | null
  /** Inject cache fs / clock (for tests); defaults to real node:fs. */
  readonly cacheFs?: VerifyCacheFs
  /** Forensics cache TTL (ms). Defaults to 7 days. */
  readonly cacheTtlMs?: number
  /**
   * Proxy URL for the `--deep` requests. Defaults to the standard environment
   * variables (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NC_PROXY`), which
   * Node's global fetch does not read on its own.
   */
  readonly proxy?: string
}

/** Cache context for buildFindings: null means "do not persist, run forensics live each time" (used by tests to disable caching). */
export type FindingCache = { path: string; fs: VerifyCacheFs; ttlMs: number } | null

export interface ScanOutcome {
  readonly report: ScanReport
  /** For an unsupported format: an explicit exit message. */
  readonly unsupported?: IngestOutcome & { ok: false }
}

/**
 * Run a full scan from a project root.
 * Always returns a ScanReport: even for unsupported projects, so the CLI has
 * something to render the exit message from.
 */
export async function scan(projectRoot: string, options: ScanOptions = {}): Promise<ScanOutcome> {
  const mode = options.mode ?? (options.deep ? 'deep' : 'fast')
  const started = Date.now()
  const env = options.env ?? scanEnvironment()

  const ingestOutcome = await ingest(projectRoot)
  if (!ingestOutcome.ok) {
    const report = emptyReport(projectRoot, env, mode, started, ingestOutcome)
    return { report, unsupported: ingestOutcome }
  }

  const classification = classifyGraph(ingestOutcome.graph, { env })
  const cache: FindingCache = buildFindingCache(projectRoot, options, mode)
  const { findings, networkCalls } = await buildFindings(classification.candidates, env, {
    deep: mode === 'deep',
    fetchImpl: options.fetchImpl ?? defaultFetch(options.proxy),
    cache,
  })

  const report: ScanReport = {
    target: projectRoot,
    generatedAt: new Date().toISOString(),
    environment: env,
    mode,
    durationMs: Date.now() - started,
    findings,
    summary: summarize(
      findings,
      ingestOutcome.graph.totalPackages,
      networkCalls,
      classification.platformExcluded.length,
      classification.workspaceMembers,
    ),
  }
  return { report }
}

/**
 * Advance Layer 1 candidates into findings. In deep mode, run online forensics
 * for B / C candidates first and then fold the results in.
 *
 * Extracted as a standalone function so it can be unit tested — with no real
 * lockfile / ingest dependency, hand-written candidates are enough to verify the
 * "deep → verifyCandidate → matchCandidate(verify)" glue logic.
 *
 * When `options.cache` is null (the default) nothing is persisted and every deep
 * run does live forensics — tests take this path to isolate the disk. `scan()`
 * passes a real cache path, and cache hits cost zero network.
 */
export async function buildFindings(
  candidates: readonly NativeCandidate[],
  env: Environment,
  options: {
    deep?: boolean
    fetchImpl?: HttpLike
    /** Default null = disk cache disabled (live forensics every time). */
    cache?: FindingCache
  } = {},
): Promise<{ findings: Array<ReturnType<typeof matchCandidate>>; networkCalls: number }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch()
  const findings: Array<ReturnType<typeof matchCandidate>> = []
  let networkCalls = 0

  // Load the cache once and reuse it per candidate (avoids one disk read per candidate).
  const cache = options.cache
  const diskCache = cache ? await loadVerifyCache(cache.path, cache.fs) : undefined
  // Freshly obtained results from this run (key → outcome), merged back to disk at the end of deep mode.
  const fresh = new Map<string, VerifyOutcome>()

  for (const candidate of candidates) {
    let verify: VerifyOutcome | undefined
    if (options.deep && candidateNeedsNetwork(candidate)) {
      const key = verifyCacheKey(candidate.pkg.name, candidate.pkg.version, candidate.pattern, env)
      if (diskCache) {
        const hit = lookupCachedOutcome(diskCache, key, {
          ttlMs: cache?.ttlMs,
          now: cache?.fs.now(),
        })
        if (hit) {
          // Cache hit: reuse the semantic result with zero network requests — the
          // single source of truth for the zero-network rule is already set to 0
          // inside lookupCachedOutcome, so we just carry it through without adding.
          verify = hit
        }
      }
      if (!verify) {
        const outcome = await verifyCandidate(candidate, env, fetchImpl)
        networkCalls += outcome.networkCalls
        verify = outcome
        if (cache) fresh.set(key, outcome)
      }
    }
    findings.push(matchCandidate({ candidate, env, verify }))
  }

  // With a cache path and fresh results → merge and write back. Write failures are silent (an optimization).
  if (cache && fresh.size > 0) {
    const records: VerifyCacheRecord[] = [...fresh].map(([key, outcome]) => ({
      key,
      outcome,
      fetchedAt: cache.fs.now(),
    }))
    await saveVerifyCache(cache.path, records, cache.fs)
  }
  return { findings, networkCalls }
}

/**
 * Decide from projectRoot and ScanOptions whether to enable the disk cache and where it lands.
 * Fast mode performs no online forensics, so enabling the cache would have
 * nothing to write — return null to avoid empty-file noise; but respect an
 * explicit `cachePath` from the caller (e.g. writing in both deep and fast).
 * @param mode The resolved scan mode (derived in scan() from options.deep OR options.mode).
 */
function buildFindingCache(
  projectRoot: string,
  options: ScanOptions,
  mode: 'fast' | 'deep',
): FindingCache {
  if (options.cachePath === null) return null // explicitly disabled
  if (mode !== 'deep' && options.cachePath === undefined) return null // fast defaults to off
  const cacheFs = options.cacheFs ?? defaultVerifyCacheFs()
  const ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS
  const path = options.cachePath ?? verifyCachePath(projectRoot)
  return { path, fs: cacheFs, ttlMs }
}

function emptyReport(
  projectRoot: string,
  env: Environment,
  mode: 'fast' | 'deep',
  started: number,
  unsupported: IngestOutcome & { ok: false },
): ScanReport {
  return {
    target: projectRoot,
    generatedAt: new Date().toISOString(),
    environment: env,
    mode,
    durationMs: Date.now() - started,
    findings: [],
    summary: summarize([], 0, 0),
    unsupported: {
      detected: unsupported.detected,
      reason: unsupported.reason,
      supported: [...SUPPORTED_LOCKFILES],
    },
  }
}
