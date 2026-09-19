/**
 * Robustness of the Layer-2 network forensics boundary.
 *
 * The invariant under test: `verifyCandidate` / `probePrebuilds` /
 * `probeRemoteHead` must **never throw and never hang** on hostile input — a
 * corrupt tarball, truncated gzip, non-JSON manifest, a throwing fetch, an
 * oversized body — all degrade to a valid outcome (unknown / unverified /
 * absent), never a panic. This complements `robustness.test.ts` (lockfile layer)
 * with the verify layer.
 */
import { describe, expect, it } from 'vitest'
import { DistributionPattern, NativeVerdict, type Environment } from '../src/core/model'
import type { LockfilePackage } from '../src/adapters/node/signals'
import type { NativeCandidate } from '../src/adapters/node/classify'
import { probePrebuilds, probeRemoteHead, type HttpLike } from '../src/adapters/node/network'
import { verifyCandidate } from '../src/adapters/node/verify'

const env: Environment = {
  os: 'linux',
  arch: 'x64',
  libc: 'glibc',
  nodeVersion: '22.22.2',
  nodeAbi: '127',
  napiVersion: '8',
  sdks: [],
}

function pkg(name: string, version: string): LockfilePackage {
  return { name, version, pathChains: [[name]] }
}

function candidate(
  name: string,
  pattern: DistributionPattern,
  verdict: NativeVerdict,
): NativeCandidate {
  return { pkg: pkg(name, '1.0.0'), pattern, verdict }
}

/** Build a byte stream from chunks (network-style Uint8Array chunks). */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

function fetchReturning(body: ReadableStream<Uint8Array> | null, status = 200): HttpLike {
  return async () => ({ status, ok: status >= 200 && status < 400, body })
}

const throwingFetch: HttpLike = async () => {
  throw new Error('network down')
}

const VALID_STATUSES = ['matched', 'absent', 'unknown'] as const

describe('probePrebuilds · a malformed tarball neither throws nor hangs', () => {
  it('garbage bytes (not a tar) → a valid status, no throw', async () => {
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5])
    const r = await probePrebuilds('https://x/x.tgz', env, {
      fetchImpl: fetchReturning(streamOf(garbage)),
    })
    expect(VALID_STATUSES).toContain(r.status)
  })

  it('an empty stream → absent (read to the end, nothing found), no throw', async () => {
    const r = await probePrebuilds('https://x/x.tgz', env, {
      fetchImpl: fetchReturning(streamOf()),
    })
    expect(r.status).toBe('absent')
  })

  it('a truncated gzip stream → a valid status, no throw', async () => {
    // gzip magic (1f 8b 08) + a few garbage bytes, truncated before a full member.
    const truncated = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff])
    const r = await probePrebuilds('https://x/x.tgz', env, {
      fetchImpl: fetchReturning(streamOf(truncated)),
    })
    expect(VALID_STATUSES).toContain(r.status)
  })

  it('an oversized body hits the byte cap → unknown, does not hang', async () => {
    // 1 MiB of zeros exceeds a 1 KiB cap, forcing the safety stop.
    const big = new Uint8Array(1024 * 1024)
    const r = await probePrebuilds('https://x/x.tgz', env, {
      maxBytes: 1024,
      fetchImpl: fetchReturning(streamOf(big)),
    })
    expect(r.status).toBe('unknown')
  })
})

describe('verifyCandidate · broken network / response → degrades instead of throwing', () => {
  it('B + fetch throws → b=unknown, no throw', async () => {
    const r = await verifyCandidate(
      candidate('x', DistributionPattern.Prebuildify, NativeVerdict.Yes),
      env,
      throwingFetch,
    )
    expect(r.b?.status).toBe('unknown')
  })

  it('B + a non-JSON manifest → degrades to unknown, no throw', async () => {
    const garbage = new Uint8Array([0x7b, 0x22, 0x6e, 0x6f, 0x74, 0x20, 0x6a, 0x73, 0x6f, 0x6e])
    const r = await verifyCandidate(
      candidate('x', DistributionPattern.Prebuildify, NativeVerdict.Yes),
      env,
      fetchReturning(streamOf(garbage)),
    )
    expect(r.b?.status).toBe('unknown')
  })

  it('C + fetch throws → remote=unverified, no throw', async () => {
    const r = await verifyCandidate(
      candidate('x', DistributionPattern.RemoteDownload, NativeVerdict.Yes),
      env,
      throwingFetch,
    )
    expect(r.remote).toBe('unverified')
  })

  it('SUSPICIOUS + fetch throws → only the network call is counted, no throw', async () => {
    const r = await verifyCandidate(
      candidate('x', DistributionPattern.NotNative, NativeVerdict.Suspicious),
      env,
      throwingFetch,
    )
    expect(r.networkCalls).toBe(1)
  })
})

describe('probeRemoteHead · HEAD failures → unverified', () => {
  it('fetch throws → unverified, no throw', async () => {
    expect(await probeRemoteHead('https://x/releases/x.tar.gz', { fetchImpl: throwingFetch })).toBe(
      'unverified',
    )
  })

  it('HTTP 500 → unverified (anything that is not 200/404 is never guessed)', async () => {
    expect(
      await probeRemoteHead('https://x/releases/x.tar.gz', {
        fetchImpl: fetchReturning(null, 500),
      }),
    ).toBe('unverified')
  })

  it('HTTP 429 → unverified', async () => {
    expect(
      await probeRemoteHead('https://x/releases/x.tar.gz', {
        fetchImpl: fetchReturning(null, 429),
      }),
    ).toBe('unverified')
  })
})
