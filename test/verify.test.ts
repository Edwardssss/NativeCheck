/**
 * verify.ts — verifyCandidate forensics orchestration + how match.ts folds verify results.
 *
 * A mock fetch is injected throughout; no real network is touched.
 */
import { describe, expect, it } from 'vitest'
import {
  verifyCandidate,
  patternNeedsNetwork,
  candidateNeedsNetwork,
} from '../src/adapters/node/verify'
import { matchCandidate } from '../src/adapters/node/match'
import { buildFindings } from '../src/adapters/node/pipeline'
import { classifyPackage } from '../src/adapters/node/classify'
import {
  DistributionPattern,
  InstallStrategy,
  NativeVerdict,
  type Environment,
} from '../src/core/model'
import { RiskLevel } from '../src/core/risk'
import type { LockfilePackage, LockfileDependency } from '../src/adapters/node/signals'
import type { HttpLike } from '../src/adapters/node/network'
import type { NativeCandidate } from '../src/adapters/node/classify'
import type { VerifyOutcome } from '../src/adapters/node/verify'
import {
  DEFAULT_TTL_MS,
  loadVerifyCache,
  type VerifyCacheFs,
} from '../src/adapters/node/verify-cache'

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

function deps(map: Record<string, string>): Record<string, LockfileDependency> {
  const out: Record<string, LockfileDependency> = {}
  for (const [name, _version] of Object.entries(map)) out[name] = { name }
  return out
}

function pkg(
  partial: Partial<LockfilePackage> & { name: string; version: string },
): LockfilePackage {
  return { pathChains: [[partial.name]], ...partial }
}

function candidateFor(p: LockfilePackage): NativeCandidate {
  const pattern = classifyPackage(p)
  return { pkg: p, pattern, verdict: NativeVerdict.Yes }
}

/** Build npm-layout tarball bytes containing a .node for the given platform (entries may include subdirectories). */
async function tarForPlatforms(platforms: string[]): Promise<Uint8Array> {
  const { mkdtemp, mkdir, writeFile, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const tar = await import('tar')
  const dir = await mkdtemp(join(tmpdir(), 'nc-vfy-'))
  const pkgDir = join(dir, 'package')
  try {
    await mkdir(join(pkgDir, 'prebuilds'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), '{}')
    for (const p of platforms) {
      const target = join(pkgDir, 'prebuilds', `${p}.node`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'binary')
    }
    const out = join(dir, 'bundle.tgz')
    await tar.c({ gzip: false, file: out, cwd: dir, portable: true }, ['package'])
    return new Uint8Array(await readFile(out))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('patternNeedsNetwork', () => {
  it('only B / C need network verification', () => {
    expect(patternNeedsNetwork(DistributionPattern.Prebuildify)).toBe(true)
    expect(patternNeedsNetwork(DistributionPattern.RemoteDownload)).toBe(true)
    expect(patternNeedsNetwork(DistributionPattern.PlatformOptionalDeps)).toBe(false)
    expect(patternNeedsNetwork(DistributionPattern.SourceOnly)).toBe(false)
  })
})

describe('candidateNeedsNetwork', () => {
  it('SUSPICIOUS + NotNative (has an install script) also needs verification', () => {
    const cand = {
      pkg: pkg({ name: 'core-js', version: '3.50.0', hasInstallScript: true }),
      pattern: DistributionPattern.NotNative,
      verdict: NativeVerdict.Suspicious,
    }
    expect(candidateNeedsNetwork(cand)).toBe(true)
  })

  it('NotNative + No (pure JS, no script) needs none', () => {
    const cand = {
      pkg: pkg({ name: 'lodash', version: '4.18.1' }),
      pattern: DistributionPattern.NotNative,
      verdict: NativeVerdict.No,
    }
    expect(candidateNeedsNetwork(cand)).toBe(false)
  })

  it('B / C always need it, A / D never do', () => {
    expect(
      candidateNeedsNetwork(
        candidateFor(
          pkg({ name: 'bcrypt', version: '6.0.0', dependencies: deps({ 'node-gyp-build': '^4' }) }),
        ),
      ),
    ).toBe(true)
    expect(
      candidateNeedsNetwork(
        candidateFor(
          pkg({ name: 'node-sass', version: '9.0.0', dependencies: deps({ nan: '1' }) }),
        ),
      ),
    ).toBe(false)
  })
})

describe('verifyCandidate · pattern B', () => {
  it('a legacy flat artifact without an ABI marker → b.status=unknown (no longer optimistically matched)', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64', 'win32-x64'])
    const fetchImpl: HttpLike = async (url: string) => {
      if (url.includes('registry.npmjs.org/better-sqlite3/')) {
        return body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
      }
      // tarball
      return body(200, undefined, tarBytes)
    }
    const cand = candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8.0.0' }),
      }),
    )
    const o = await verifyCandidate(cand, env, fetchImpl)
    expect(o.b?.status).toBe('unknown')
    expect(o.networkCalls).toBe(2)
  })

  it('an N-API artifact → b.status=matched, 2 network calls', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetchImpl: HttpLike = async (url: string) => {
      if (url.includes('registry.npmjs.org/better-sqlite3/')) {
        return body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
      }
      return body(200, undefined, tarBytes)
    }
    const cand = candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8.0.0' }),
      }),
    )
    const o = await verifyCandidate(cand, env, fetchImpl)
    expect(o.b?.status).toBe('matched')
    expect(o.networkCalls).toBe(2)
  })

  it('reading the whole package and still finding nothing for this platform → b.status=absent', async () => {
    const tarBytes = await tarForPlatforms(['win32-x64'])
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
        : body(200, undefined, tarBytes)
    const cand = candidateFor(
      pkg({ name: 'bcrypt', version: '6.0.0', dependencies: deps({ 'node-gyp-build': '^4' }) }),
    )
    const o = await verifyCandidate(cand, env, fetchImpl)
    expect(o.b?.status).toBe('absent')
  })

  it('a bcrypt --napi artifact (bcrypt.glibc.node without an ABI marker) → matched', async () => {
    // bcrypt@6 builds with `prebuildify --napi --tag-libc`: the artifact is N-API (stable
    // across ABIs), but --tag-libc renames it to bcrypt.glibc.node and drops the napi
    const tarBytes = await tarForPlatforms(['linux-x64/bcrypt.glibc'])
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(
            200,
            JSON.stringify({
              dist: { tarball: 'https://t/x.tgz' },
              scripts: { build: 'prebuildify --napi --tag-libc' },
            }),
          )
        : body(200, undefined, tarBytes)
    const cand = candidateFor(
      pkg({ name: 'bcrypt', version: '6.0.0', dependencies: deps({ 'node-gyp-build': '^4' }) }),
    )
    const o = await verifyCandidate(cand, env, fetchImpl)
    expect(o.b?.status).toBe('matched')
    expect(o.networkCalls).toBe(2)
  })

  it('pattern B: a failing manifest fetch does not throw → b.status=unknown (network trouble is not absence)', async () => {
    const fetchImpl: HttpLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    const cand = candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8.0.0' }),
      }),
    )
    const o = await verifyCandidate(cand, env, fetchImpl)
    expect(o.b?.status).toBe('unknown')
    expect(o.networkCalls).toBe(1)
  })

  it('pattern B: a failing tarball fetch does not throw → b.status=unknown', async () => {
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
        : { status: 500, ok: false, body: null }
    const cand = candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8.0.0' }),
      }),
    )
    const o = await verifyCandidate(cand, env, fetchImpl)
    expect(o.b?.status).toBe('unknown')
    expect(o.networkCalls).toBe(2)
  })
})

describe('verifyCandidate · pattern C', () => {
  const canvasPkg = () =>
    pkg({ name: 'canvas', version: '3.2.0', dependencies: deps({ 'prebuild-install': '^7' }) })

  /** canvas registry manifest: napi runtime plus the Automattic/node-canvas repository. */
  const canvasManifest = JSON.stringify({
    dist: { tarball: 'https://t/canvas.tgz' },
    binary: { napi_versions: [7] },
    config: null,
    repository: { url: 'git://github.com/Automattic/node-canvas.git', type: 'git' },
    scripts: { install: 'prebuild-install -r napi || node-gyp rebuild' },
  })

  it('HEAD 200 → remote=prebuilt, 2 network calls, URL built from the real repository rather than github.com/canvas', async () => {
    const fetchImpl: HttpLike = async (url: string, init?: { method?: string }) => {
      if (url.includes('registry.npmjs.org')) return body(200, canvasManifest)
      expect(init?.method).toBe('HEAD')
      expect(url).toBe(
        'https://github.com/Automattic/node-canvas/releases/download/v3.2.0/canvas-v3.2.0-napi-v7-linux-x64.tar.gz',
      )
      return { status: 200, ok: true, body: null }
    }
    const o = await verifyCandidate(candidateFor(canvasPkg()), env, fetchImpl)
    expect(o.remote).toBe('prebuilt')
    expect(o.networkCalls).toBe(2)
  })

  it('HEAD 404 → remote=source-build', async () => {
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(200, canvasManifest)
        : { status: 404, ok: false, body: null }
    const o = await verifyCandidate(candidateFor(canvasPkg()), env, fetchImpl)
    expect(o.remote).toBe('source-build')
    expect(o.networkCalls).toBe(2)
  })

  it('a failing manifest fetch does not throw → remote=unverified', async () => {
    const fetchImpl: HttpLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    const o = await verifyCandidate(candidateFor(canvasPkg()), env, fetchImpl)
    expect(o.remote).toBe('unverified')
    expect(o.networkCalls).toBe(1)
  })

  it('a manifest without a repository → no URL derivable → remote=unverified (never guesses github.com/{name})', async () => {
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
        : { status: 404, ok: false, body: null }
    const o = await verifyCandidate(candidateFor(canvasPkg()), env, fetchImpl)
    expect(o.remote).toBe('unverified')
    expect(o.networkCalls).toBe(1)
  })
})

describe('verifyCandidate · SUSPICIOUS install-script forensics', () => {
  /** Build a SUSPICIOUS + NotNative candidate (an install script, no native dependency signal). */
  const suspicious = (name: string, version: string): NativeCandidate => ({
    pkg: pkg({ name, version, hasInstallScript: true }),
    pattern: DistributionPattern.NotNative,
    verdict: NativeVerdict.Suspicious,
  })

  it('a core-js style benign postinstall (node -e) → intent=select, 1 network call', async () => {
    const fetchImpl: HttpLike = async () =>
      body(
        200,
        JSON.stringify({
          dist: { tarball: 'https://t/x.tgz' },
          scripts: { postinstall: `node -e "try{require('./postinstall')}catch(e){}"` },
        }),
      )
    const o = await verifyCandidate(suspicious('core-js', '3.50.0'), env, fetchImpl)
    expect(o.installScript?.intent).toBe('select')
    expect(o.networkCalls).toBe(1)
  })

  it('an install script containing node-gyp rebuild → intent=compile, 1 network call', async () => {
    const fetchImpl: HttpLike = async () =>
      body(
        200,
        JSON.stringify({
          dist: { tarball: 'https://t/x.tgz' },
          scripts: { install: 'node-gyp rebuild' },
        }),
      )
    const o = await verifyCandidate(suspicious('mystery-native', '1.0.0'), env, fetchImpl)
    expect(o.installScript?.intent).toBe('compile')
    expect(o.networkCalls).toBe(1)
  })

  it('an install script containing prebuild-install → intent=download, then a HEAD probe, 2 network calls', async () => {
    const fetchImpl: HttpLike = async (url: string, init?: { method?: string }) => {
      if (url.includes('registry.npmjs.org')) {
        return body(
          200,
          JSON.stringify({
            dist: { tarball: 'https://t/x.tgz' },
            repository: { url: 'git://github.com/foo/bar.git', type: 'git' },
            scripts: { install: 'prebuild-install || node-gyp rebuild' },
          }),
        )
      }
      expect(init?.method).toBe('HEAD')
      return { status: 200, ok: true, body: null }
    }
    const o = await verifyCandidate(suspicious('bar', '1.0.0'), env, fetchImpl)
    expect(o.installScript?.intent).toBe('download_then_compile')
    expect(o.remote).toBe('prebuilt')
    expect(o.networkCalls).toBe(2)
  })

  it('across hooks: install=download + postinstall=compile → intent=compile', async () => {
    // Downloading in install and compiling in postinstall are two independent hooks that
    // both run. Joining them with `||` used to read as download_then_compile (a fallback);
    const fetchImpl: HttpLike = async () =>
      body(
        200,
        JSON.stringify({
          dist: { tarball: 'https://t/x.tgz' },
          scripts: { install: 'prebuild-install', postinstall: 'node-gyp rebuild' },
        }),
      )
    const o = await verifyCandidate(suspicious('cross-hook', '1.0.0'), env, fetchImpl)
    expect(o.installScript?.intent).toBe('compile')
    expect(o.installScript?.script).toBe('prebuild-install ; node-gyp rebuild')
    expect(o.networkCalls).toBe(1)
  })

  it('node-gyp rebuild inside preinstall is parsed too (preinstall used to be ignored outright)', async () => {
    // npm runs preinstall → install → postinstall in order, and all three run. Looking
    // only at install / postinstall leaves a preinstall-only package at AMBIGUOUS forever.
    const fetchImpl: HttpLike = async () =>
      body(
        200,
        JSON.stringify({
          dist: { tarball: 'https://t/x.tgz' },
          scripts: { preinstall: 'node-gyp rebuild' },
        }),
      )
    const o = await verifyCandidate(suspicious('preinstall-compiler', '1.0.0'), env, fetchImpl)
    expect(o.installScript?.intent).toBe('compile')
    expect(o.installScript?.script).toBe('node-gyp rebuild')
    expect(o.networkCalls).toBe(1)
  })

  it('across hooks: preinstall=download + install=compile → intent=compile (merged by severity)', async () => {
    const fetchImpl: HttpLike = async () =>
      body(
        200,
        JSON.stringify({
          dist: { tarball: 'https://t/x.tgz' },
          scripts: { preinstall: 'prebuild-install', install: 'node-gyp rebuild' },
        }),
      )
    const o = await verifyCandidate(suspicious('three-hooks', '1.0.0'), env, fetchImpl)
    expect(o.installScript?.intent).toBe('compile')
    // order preserved: the order npm runs them in (preinstall → install → postinstall)
    expect(o.installScript?.script).toBe('prebuild-install ; node-gyp rebuild')
  })

  it('a failing manifest fetch does not throw → no installScript, 1 network call', async () => {
    const fetchImpl: HttpLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    const o = await verifyCandidate(suspicious('core-js', '3.50.0'), env, fetchImpl)
    expect(o.installScript).toBeUndefined()
    expect(o.networkCalls).toBe(1)
  })
})

/* verify folding inside match.ts */
function matchWith(cand: NativeCandidate, verify?: VerifyOutcome) {
  return matchCandidate({ candidate: cand, env, verify })
}
describe('matchCandidate · pattern B verify folding', () => {
  const bCand = () =>
    candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8' }),
      }),
    )

  it('fast (no verify) → UNVERIFIED + resolveHint', () => {
    const f = matchWith(bCand())
    expect(f.risk).toBe(RiskLevel.UNVERIFIED)
    expect(f.resolveHint).toBeTruthy()
    expect(f.strategy).toBe(InstallStrategy.Prebuilt)
  })
  it('deep hit → LOW / PREBUILT, with an artifact', () => {
    const f = matchWith(bCand(), {
      b: { status: 'matched', observed: ['linux-x64.node'] },
      networkCalls: 2,
    })
    expect(f.risk).toBe(RiskLevel.LOW)
    expect(f.strategy).toBe(InstallStrategy.Prebuilt)
    expect(f.artifacts.some((a) => a.platform === 'linux' && a.arch === 'x64')).toBe(true)
    expect(f.resolveHint).toBeUndefined()
  })
  it('deep reads the whole package without a hit, toolchain complete → MEDIUM / SOURCE_BUILD', () => {
    const f = matchWith(bCand(), {
      b: { status: 'absent', observed: ['win32-x64.node'] },
      networkCalls: 2,
    })
    expect(f.strategy).toBe(InstallStrategy.SourceBuild)
    expect(f.risk).toBe(RiskLevel.MEDIUM)
  })
  it('deep miss + no compiler → HIGH / blocker', () => {
    const noCompiler: Environment = { ...env, compiler: undefined }
    const f = matchCandidate({
      candidate: bCand(),
      env: noCompiler,
      verify: { b: { status: 'absent', observed: [] }, networkCalls: 2 },
    })
    expect(f.risk).toBe(RiskLevel.HIGH)
    expect(f.blockers.some((b) => b.name === 'C/C++ compiler')).toBe(true)
  })
  it('deep verification hit its budget (unknown) → stays UNVERIFIED (never downgraded to missing)', () => {
    const f = matchWith(bCand(), {
      b: { status: 'unknown', observed: [] },
      networkCalls: 2,
    })
    expect(f.risk).toBe(RiskLevel.UNVERIFIED)
    expect(f.strategy).toBe(InstallStrategy.Prebuilt)
    expect(f.resolveHint).toBeTruthy()
  })
})

describe('matchCandidate · pattern C verify folding', () => {
  const cCand = () =>
    candidateFor(
      pkg({ name: 'canvas', version: '3.2.0', dependencies: deps({ 'prebuild-install': '^7' }) }),
    )

  it('fast → UNVERIFIED', () => {
    expect(matchWith(cCand()).risk).toBe(RiskLevel.UNVERIFIED)
  })
  it('HEAD 200 → LOW / PREBUILT', () => {
    const f = matchWith(cCand(), { remote: 'prebuilt', networkCalls: 1 })
    expect(f.risk).toBe(RiskLevel.LOW)
    expect(f.strategy).toBe(InstallStrategy.Prebuilt)
  })
  it('HEAD 200 + no compiler → the fallback note lists the C/C++ compiler blocker (a failed download would compile and fail)', () => {
    const noCompiler: Environment = { ...env, compiler: undefined }
    const f = matchCandidate({
      candidate: cCand(),
      env: noCompiler,
      verify: { remote: 'prebuilt', networkCalls: 1 },
    })
    expect(f.risk).toBe(RiskLevel.LOW) // the main path still needs no compile
    expect(f.fallback).toBeDefined()
    expect(f.fallback?.blockers.map((b) => b.name)).toContain('C/C++ compiler')
  })
  it('HEAD 404 → MEDIUM / SOURCE_BUILD', () => {
    const f = matchWith(cCand(), { remote: 'source-build', networkCalls: 1 })
    expect(f.risk).toBe(RiskLevel.MEDIUM)
    expect(f.strategy).toBe(InstallStrategy.SourceBuild)
  })
  it('HEAD unverified → stays UNVERIFIED (network trouble is not danger)', () => {
    expect(matchWith(cCand(), { remote: 'unverified', networkCalls: 1 }).risk).toBe(
      RiskLevel.UNVERIFIED,
    )
  })
})

/* pipeline glue: buildFindings (verifies only under --deep, always zero network under fast) */
describe('buildFindings · deep glue', () => {
  it('fast: B/C are not verified, network stays at zero, they land on UNVERIFIED', async () => {
    const bCand = candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8' }),
      }),
    )
    const { findings, networkCalls } = await buildFindings([bCand], env, { deep: false })
    expect(networkCalls).toBe(0)
    expect(findings[0]?.risk).toBe(RiskLevel.UNVERIFIED)
  })

  it('deep + a mocked hit → network counted + LOW', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
        : body(200, undefined, tarBytes)
    const bCand = candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8' }),
      }),
    )
    const { findings, networkCalls } = await buildFindings([bCand], env, {
      deep: true,
      fetchImpl,
    })
    expect(networkCalls).toBe(2) // manifest GET + tarball GET
    expect(findings[0]?.risk).toBe(RiskLevel.LOW)
  })

  it('deep + mixed candidates: only B/C are counted, pattern A never touches the network', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
        : body(200, undefined, tarBytes)
    const aCand = candidateFor(
      pkg({
        name: 'esbuild',
        version: '0.27.7',
        dependencies: {
          '@esbuild/linux-x64': { name: '@esbuild/linux-x64', optional: true },
          '@esbuild/linux-arm64': { name: '@esbuild/linux-arm64', optional: true },
          '@esbuild/win32-x64': { name: '@esbuild/win32-x64', optional: true },
          '@esbuild/darwin-arm64': { name: '@esbuild/darwin-arm64', optional: true },
          '@esbuild/darwin-x64': { name: '@esbuild/darwin-x64', optional: true },
        },
      }),
    )
    const bCand = candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8' }),
      }),
    )
    const { findings, networkCalls } = await buildFindings([aCand, bCand], env, {
      deep: true,
      fetchImpl,
    })
    expect(networkCalls).toBe(2) // only B produces 2 calls, A produces 0
    const aFinding = findings.find((f) => f.pkg.name === 'esbuild')
    const bFinding = findings.find((f) => f.pkg.name === 'better-sqlite3')
    expect(aFinding?.risk).toBe(RiskLevel.LOW) // platform optional cluster → LOW (no network)
    expect(bFinding?.risk).toBe(RiskLevel.LOW) // hit → LOW
  })
})

/** Build an HttpLike response. */
async function body(
  status: number,
  text?: string,
  tarBytes?: Uint8Array,
): Promise<{ status: number; ok: boolean; body: ReadableStream<Uint8Array> | null }> {
  if (!text && !tarBytes) return { status, ok: status >= 200 && status < 300, body: null }
  const payload = tarBytes ?? new TextEncoder().encode(text ?? '')
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(payload)
      c.close()
    },
  })
  return { status, ok: status >= 200 && status < 300, body: stream }
}

/* pipeline cache glue: a cold run writes to disk, a warm run hits it with zero network */
describe('buildFindings · deep on-disk cache', () => {
  const bCand = () =>
    candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8' }),
      }),
    )
  /** A mock fetch that counts requests: a registry GET plus a tarball GET. */
  function countingFetch(tarBytes: Uint8Array): { fetch: HttpLike; count: () => number } {
    let n = 0
    const fetch: HttpLike = async (url: string) => {
      n++
      return url.includes('registry.npmjs.org')
        ? body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
        : body(200, undefined, tarBytes)
    }
    return { fetch, count: () => n }
  }
  /** A cache context with an in-memory disk and a controllable clock. */
  function memCache(nowMs = 10_000) {
    const disk = new Map<string, string>()
    let now = nowMs
    const fs: VerifyCacheFs = {
      readFile: async (p) => {
        const v = disk.get(p)
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
      writeFile: async (p, d) => void disk.set(p, d),
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
      cache: { path: '/cache/verify.json', fs, ttlMs: DEFAULT_TTL_MS },
      disk,
      clock: {
        set now(v: number) {
          now = v
        },
      },
    }
  }

  it('cold run: 2 network calls and the result is written; warm run: cache hit → zero network with the same verdict', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetcher = countingFetch(tarBytes)
    const { cache } = memCache(10_000)

    // first (cold): the cache is empty, so verification must really happen → 2 calls, then written
    const cold = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
      cache,
    })
    expect(cold.networkCalls).toBe(2)
    expect(cold.findings[0]?.risk).toBe(RiskLevel.LOW)
    // the disk has been written (loading again finds the same key)
    const reloaded = await loadVerifyCache(cache.path, cache.fs)
    expect(reloaded.size).toBe(1)

    // second (warm): the same key hits → no network → 0 calls, and the verdict is still LOW
    const warm = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
      cache,
    })
    expect(warm.networkCalls).toBe(0)
    expect(warm.findings[0]?.risk).toBe(RiskLevel.LOW)
    expect(warm.findings[0]?.artifacts.some((a) => a.platform === 'linux')).toBe(true)
  })

  it('no cache passed (null / omitted) → nothing written, verification runs every time', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetcher = countingFetch(tarBytes)
    const one = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
    })
    expect(one.networkCalls).toBe(2)
    const two = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
    })
    expect(two.networkCalls).toBe(2) // no cache → verification every time
  })

  it('an expired cache (past the TTL) → treated as a miss and verified again', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetcher = countingFetch(tarBytes)
    const c = memCache(10_000)

    // the cold run wrote it (fetchedAt = 10_000)
    await buildFindings([bCand()], env, { deep: true, fetchImpl: fetcher.fetch, cache: c.cache })
    // move the clock past the TTL → the lookup must miss and go back to the network
    c.clock.now = 10_000 + DEFAULT_TTL_MS + 1
    const after = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
      cache: c.cache,
    })
    expect(after.networkCalls).toBe(2) // TTL expired → verified again
  })
})
