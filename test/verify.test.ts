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

/** 构造含指定平台 .node 的 npm 布局 tarball 字节（file 可含子目录）。 */
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
  it('只有 B / C 需要联网取证', () => {
    expect(patternNeedsNetwork(DistributionPattern.Prebuildify)).toBe(true)
    expect(patternNeedsNetwork(DistributionPattern.RemoteDownload)).toBe(true)
    expect(patternNeedsNetwork(DistributionPattern.PlatformOptionalDeps)).toBe(false)
    expect(patternNeedsNetwork(DistributionPattern.SourceOnly)).toBe(false)
  })
})

describe('candidateNeedsNetwork', () => {
  it('SUSPICIOUS + NotNative（有 install 脚本）也需取证', () => {
    const cand = {
      pkg: pkg({ name: 'core-js', version: '3.50.0', hasInstallScript: true }),
      pattern: DistributionPattern.NotNative,
      verdict: NativeVerdict.Suspicious,
    }
    expect(candidateNeedsNetwork(cand)).toBe(true)
  })

  it('NotNative + No（纯 JS 无脚本）无需取证', () => {
    const cand = {
      pkg: pkg({ name: 'lodash', version: '4.18.1' }),
      pattern: DistributionPattern.NotNative,
      verdict: NativeVerdict.No,
    }
    expect(candidateNeedsNetwork(cand)).toBe(false)
  })

  it('B / C 恒需，A / D 无需', () => {
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

describe('verifyCandidate · 模式 B', () => {
  it('老式平铺产物无 ABI 标注 → b.status=unknown（不再乐观判 matched）', async () => {
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

  it('N-API 产物 → b.status=matched，2 次网络', async () => {
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

  it('读完整包仍无本平台 → b.status=absent', async () => {
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

  it('bcrypt --napi 产物（bcrypt.glibc.node 无 ABI 标注）→ matched', async () => {
    // bcrypt@6 构建脚本 `prebuildify --napi --tag-libc`：产物是 N-API（跨 ABI），
    // 文件名被 tag-libc 改成 bcrypt.glibc.node、丢了 napi 标记 → 应靠 build 信号判 match。
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

  it('模式 B manifest 拉取异常不抛 → b.status=unknown（网络波动不当作缺失）', async () => {
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

  it('模式 B tarball 拉取失败不抛 → b.status=unknown', async () => {
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

describe('verifyCandidate · 模式 C', () => {
  const canvasPkg = () =>
    pkg({ name: 'canvas', version: '3.2.0', dependencies: deps({ 'prebuild-install': '^7' }) })

  /** canvas 的 registry manifest：napi 运行时 + Automattic/node-canvas 仓库。 */
  const canvasManifest = JSON.stringify({
    dist: { tarball: 'https://t/canvas.tgz' },
    binary: { napi_versions: [7] },
    config: null,
    repository: { url: 'git://github.com/Automattic/node-canvas.git', type: 'git' },
    scripts: { install: 'prebuild-install -r napi || node-gyp rebuild' },
  })

  it('HEAD 200 → remote=prebuilt，2 次网络，URL 用真实仓库而非 github.com/canvas', async () => {
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

  it('manifest 拉取异常不抛 → remote=unverified', async () => {
    const fetchImpl: HttpLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    const o = await verifyCandidate(candidateFor(canvasPkg()), env, fetchImpl)
    expect(o.remote).toBe('unverified')
    expect(o.networkCalls).toBe(1)
  })

  it('manifest 缺仓库 → 推导不出 URL → remote=unverified（不猜 github.com/{name}）', async () => {
    const fetchImpl: HttpLike = async (url: string) =>
      url.includes('registry.npmjs.org')
        ? body(200, JSON.stringify({ dist: { tarball: 'https://t/x.tgz' } }))
        : { status: 404, ok: false, body: null }
    const o = await verifyCandidate(candidateFor(canvasPkg()), env, fetchImpl)
    expect(o.remote).toBe('unverified')
    expect(o.networkCalls).toBe(1)
  })
})

describe('verifyCandidate · SUSPICIOUS install 脚本取证', () => {
  /** 构造 SUSPICIOUS + NotNative 候选（有 install 脚本、无任何 native 依赖信号）。 */
  const suspicious = (name: string, version: string): NativeCandidate => ({
    pkg: pkg({ name, version, hasInstallScript: true }),
    pattern: DistributionPattern.NotNative,
    verdict: NativeVerdict.Suspicious,
  })

  it('core-js 式 benign postinstall（node -e）→ intent=select，1 次网络', async () => {
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

  it('install 脚本含 node-gyp rebuild → intent=compile，1 次网络', async () => {
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

  it('install 脚本含 prebuild-install → intent=download 且继续 HEAD 探远端，2 次网络', async () => {
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

  it('跨 hook：install=download + postinstall=compile → intent=compile（§1.4 修复）', async () => {
    // install 下载 + postinstall 编译是两个都要执行的独立 hook；此前用 `||` 拼接
    // 误读成 download_then_compile（fallback），修复后正确合并为 compile（编译是终态）。
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

  it('manifest 拉取异常不抛 → 无 installScript，1 次网络', async () => {
    const fetchImpl: HttpLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    const o = await verifyCandidate(suspicious('core-js', '3.50.0'), env, fetchImpl)
    expect(o.installScript).toBeUndefined()
    expect(o.networkCalls).toBe(1)
  })
})

/* match.ts 的 verify 折叠 */
function matchWith(cand: NativeCandidate, verify?: VerifyOutcome) {
  return matchCandidate({ candidate: cand, env, verify })
}
describe('matchCandidate · 模式 B verify 折叠', () => {
  const bCand = () =>
    candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8' }),
      }),
    )

  it('fast（无 verify）→ UNVERIFIED + resolveHint', () => {
    const f = matchWith(bCand())
    expect(f.risk).toBe(RiskLevel.UNVERIFIED)
    expect(f.resolveHint).toBeTruthy()
    expect(f.strategy).toBe(InstallStrategy.Prebuilt)
  })
  it('deep 命中 → LOW / PREBUILT，含 artifact', () => {
    const f = matchWith(bCand(), {
      b: { status: 'matched', observed: ['linux-x64.node'] },
      networkCalls: 2,
    })
    expect(f.risk).toBe(RiskLevel.LOW)
    expect(f.strategy).toBe(InstallStrategy.Prebuilt)
    expect(f.artifacts.some((a) => a.platform === 'linux' && a.arch === 'x64')).toBe(true)
    expect(f.resolveHint).toBeUndefined()
  })
  it('deep 读完整包未命中 + 工具链齐全 → MEDIUM / SOURCE_BUILD', () => {
    const f = matchWith(bCand(), {
      b: { status: 'absent', observed: ['win32-x64.node'] },
      networkCalls: 2,
    })
    expect(f.strategy).toBe(InstallStrategy.SourceBuild)
    expect(f.risk).toBe(RiskLevel.MEDIUM)
  })
  it('deep 未命中 + 缺编译器 → HIGH / blocker', () => {
    const noCompiler: Environment = { ...env, compiler: undefined }
    const f = matchCandidate({
      candidate: bCand(),
      env: noCompiler,
      verify: { b: { status: 'absent', observed: [] }, networkCalls: 2 },
    })
    expect(f.risk).toBe(RiskLevel.HIGH)
    expect(f.blockers.some((b) => b.name === 'C/C++ 编译器')).toBe(true)
  })
  it('deep 取证触顶 unknown → 保持 UNVERIFIED（绝不当作缺失降级）', () => {
    const f = matchWith(bCand(), {
      b: { status: 'unknown', observed: [] },
      networkCalls: 2,
    })
    expect(f.risk).toBe(RiskLevel.UNVERIFIED)
    expect(f.strategy).toBe(InstallStrategy.Prebuilt)
    expect(f.resolveHint).toBeTruthy()
  })
})

describe('matchCandidate · 模式 C verify 折叠', () => {
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
  it('HEAD 200 + 缺编译器 → fallback 附注列出 C/C++ 编译器阻塞（下载失败退编译会失败）', () => {
    const noCompiler: Environment = { ...env, compiler: undefined }
    const f = matchCandidate({
      candidate: cCand(),
      env: noCompiler,
      verify: { remote: 'prebuilt', networkCalls: 1 },
    })
    expect(f.risk).toBe(RiskLevel.LOW) // 主路径仍免编
    expect(f.fallback).toBeDefined()
    expect(f.fallback?.blockers.map((b) => b.name)).toContain('C/C++ 编译器')
  })
  it('HEAD 404 → MEDIUM / SOURCE_BUILD', () => {
    const f = matchWith(cCand(), { remote: 'source-build', networkCalls: 1 })
    expect(f.risk).toBe(RiskLevel.MEDIUM)
    expect(f.strategy).toBe(InstallStrategy.SourceBuild)
  })
  it('HEAD 未验证 → 保持 UNVERIFIED（不把网络波动当危险）', () => {
    expect(matchWith(cCand(), { remote: 'unverified', networkCalls: 1 }).risk).toBe(
      RiskLevel.UNVERIFIED,
    )
  })
})

/* pipeline 胶水：buildFindings（deep 才取证，fast 恒零网络） */
describe('buildFindings · deep 胶水', () => {
  it('fast：B/C 不取证，恒零网络，落到 UNVERIFIED', async () => {
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

  it('deep + mock 命中 → 网络计数 + LOW', async () => {
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

  it('deep + 混合候选：只对 B/C 计数，A 类不动网络', async () => {
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
    expect(networkCalls).toBe(2) // 只有 B 产生 2 次，A 是 0
    const aFinding = findings.find((f) => f.pkg.name === 'esbuild')
    const bFinding = findings.find((f) => f.pkg.name === 'better-sqlite3')
    expect(aFinding?.risk).toBe(RiskLevel.LOW) // 平台可选依赖簇 → LOW（无网络）
    expect(bFinding?.risk).toBe(RiskLevel.LOW) // 命中 → LOW
  })
})

/** 便捷构造一个 HttpLike 响应。 */
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

/* pipeline 缓存胶水：冷跑写盘 → 温跑命中零网络 */
describe('buildFindings · deep 磁盘缓存', () => {
  const bCand = () =>
    candidateFor(
      pkg({
        name: 'better-sqlite3',
        version: '13.0.3',
        dependencies: deps({ 'node-addon-api': '^8' }),
      }),
    )
  /** 带请求计数器的 mock fetch：registry GET + tarball GET。 */
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
  /** 内存盘 + 可控时钟的缓存上下文。 */
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

  it('冷跑：网络 2 次 + 结果落盘；温跑：命中缓存 → 零网络且结论一致', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetcher = countingFetch(tarBytes)
    const { cache } = memCache(10_000)

    // 第一次（冷）：缓存空 → 必须真实取证 → 2 次网络，结果落盘
    const cold = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
      cache,
    })
    expect(cold.networkCalls).toBe(2)
    expect(cold.findings[0]?.risk).toBe(RiskLevel.LOW)
    // 磁盘已被写入（再次 load 能读到同 key）
    const reloaded = await loadVerifyCache(cache.path, cache.fs)
    expect(reloaded.size).toBe(1)

    // 第二次（温）：同 key 命中缓存 → 不再发网络 → 0 次，结论依旧 LOW
    const warm = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
      cache,
    })
    expect(warm.networkCalls).toBe(0)
    expect(warm.findings[0]?.risk).toBe(RiskLevel.LOW)
    expect(warm.findings[0]?.artifacts.some((a) => a.platform === 'linux')).toBe(true)
  })

  it('未传 cache（null/缺省）→ 不落盘、每次现场取证', async () => {
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
    expect(two.networkCalls).toBe(2) // 无缓存 → 每次都取证
  })

  it('缓存过期（超过 TTL）→ 视为未命中，重新取证', async () => {
    const tarBytes = await tarForPlatforms(['linux-x64/node.napi'])
    const fetcher = countingFetch(tarBytes)
    const c = memCache(10_000)

    // 冷跑写入（fetchedAt = 10_000）
    await buildFindings([bCand()], env, { deep: true, fetchImpl: fetcher.fetch, cache: c.cache })
    // 拨快时钟越过 TTL → 命中失败，必须重新发网络
    c.clock.now = 10_000 + DEFAULT_TTL_MS + 1
    const after = await buildFindings([bCand()], env, {
      deep: true,
      fetchImpl: fetcher.fetch,
      cache: c.cache,
    })
    expect(after.networkCalls).toBe(2) // TTL 过期 → 重新取证
  })
})
