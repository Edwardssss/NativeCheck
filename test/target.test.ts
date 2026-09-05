/**
 * target.ts — `--target` 单包诊断模式。
 *
 * 全程注入 mock fetch，不碰真实网络。核心验证：spec 解析、fast 模式各分发形态
 * 的 L1 classify（一次 manifest GET）、deep 模式 B/C 的 L2 取证折叠（网络计数）。
 */
import { describe, expect, it } from 'vitest'
import { parsePackageSpec, scanTarget } from '../src/adapters/node/target'
import {
  DistributionPattern,
  InstallStrategy,
  NativeVerdict,
  type Environment,
} from '../src/core/model'
import { RiskLevel } from '../src/core/risk'
import type { HttpLike } from '../src/adapters/node/network'

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

/** 便捷构造一个 HttpLike 响应。 */
function body(
  status: number,
  text?: string,
): Promise<{ status: number; ok: boolean; body: ReadableStream<Uint8Array> | null }> {
  if (!text) return Promise.resolve({ status, ok: status >= 200 && status < 300, body: null })
  const payload = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(payload)
      c.close()
    },
  })
  return Promise.resolve({ status, ok: status >= 200 && status < 300, body: stream })
}

/** 带请求计数器的 mock fetch：按 url 分发 registry manifest / HEAD。 */
function countingFetch(manifest: Record<string, unknown>): {
  fetch: HttpLike
  count: () => number
} {
  let n = 0
  const fetch: HttpLike = async (url: string, init?: { method?: string }) => {
    n++
    if (url.includes('registry.npmjs.org')) return body(200, JSON.stringify(manifest))
    // 非 registry = 远端产物 HEAD
    expect(init?.method).toBe('HEAD')
    return { status: 200, ok: true, body: null }
  }
  return { fetch, count: () => n }
}

describe('parsePackageSpec', () => {
  it('裸包名', () => {
    expect(parsePackageSpec('lodash')).toEqual({ name: 'lodash' })
  })
  it('name@version', () => {
    expect(parsePackageSpec('lodash@4.17.21')).toEqual({ name: 'lodash', version: '4.17.21' })
  })
  it('scoped 无版本', () => {
    expect(parsePackageSpec('@scope/name')).toEqual({ name: '@scope/name' })
  })
  it('scoped 带版本', () => {
    expect(parsePackageSpec('@scope/name@1.2.3')).toEqual({
      name: '@scope/name',
      version: '1.2.3',
    })
  })
  it('scoped 空版本回落为裸名', () => {
    expect(parsePackageSpec('@scope/name@')).toEqual({ name: '@scope/name' })
  })
  it('空串抛错', () => {
    expect(() => parsePackageSpec('   ')).toThrow()
  })
})

describe('scanTarget · fast（仅一次 manifest GET，各分发形态 L1 classify）', () => {
  it('纯 JS（lodash）→ NotNative / LOW，networkCalls=1', async () => {
    const { fetch, count } = countingFetch({
      name: 'lodash',
      version: '4.17.21',
      dist: { tarball: 'https://t/lodash.tgz' },
    })
    const report = await scanTarget('lodash@4.17.21', { env, fetchImpl: fetch })
    expect(count()).toBe(1)
    expect(report.findings[0]?.pattern).toBe(DistributionPattern.NotNative)
    expect(report.findings[0]?.verdict).toBe(NativeVerdict.No)
    expect(report.findings[0]?.risk).toBe(RiskLevel.LOW)
    expect(report.target).toBe('lodash@4.17.21')
  })

  it('B（better-sqlite3，node-addon-api 无 install 脚本）→ Prebuildify / UNVERIFIED（fast 不取证）', async () => {
    const { fetch, count } = countingFetch({
      name: 'better-sqlite3',
      version: '13.0.3',
      dist: { tarball: 'https://t/bs.tgz' },
      dependencies: { 'node-addon-api': '^8.0.0' },
    })
    const report = await scanTarget('better-sqlite3', { env, fetchImpl: fetch })
    expect(count()).toBe(1)
    expect(report.findings[0]?.pattern).toBe(DistributionPattern.Prebuildify)
    expect(report.findings[0]?.risk).toBe(RiskLevel.UNVERIFIED)
    // 缺 version → 解析 latest，report.target 用 manifest 实际版本
    expect(report.target).toBe('better-sqlite3@13.0.3')
  })

  it('C（canvas，prebuild-install）→ RemoteDownload / UNVERIFIED（fast）', async () => {
    const { fetch, count } = countingFetch({
      name: 'canvas',
      version: '3.2.0',
      dist: { tarball: 'https://t/canvas.tgz' },
      dependencies: { 'prebuild-install': '^7.0.0' },
    })
    const report = await scanTarget('canvas', { env, fetchImpl: fetch })
    expect(count()).toBe(1)
    expect(report.findings[0]?.pattern).toBe(DistributionPattern.RemoteDownload)
    expect(report.findings[0]?.risk).toBe(RiskLevel.UNVERIFIED)
  })

  it('D（node-pty，nan）→ SourceOnly / MEDIUM（工具链齐全）', async () => {
    const { fetch, count } = countingFetch({
      name: 'node-pty',
      version: '1.1.0',
      dist: { tarball: 'https://t/pty.tgz' },
      dependencies: { nan: '^2.18.0' },
    })
    const report = await scanTarget('node-pty', { env, fetchImpl: fetch })
    expect(count()).toBe(1)
    expect(report.findings[0]?.pattern).toBe(DistributionPattern.SourceOnly)
    expect(report.findings[0]?.strategy).toBe(InstallStrategy.SourceBuild)
    expect(report.findings[0]?.risk).toBe(RiskLevel.MEDIUM)
  })

  it('A（esbuild，平台可选依赖簇）→ PlatformOptionalDeps / LOW', async () => {
    const optional: Record<string, string> = {
      '@esbuild/linux-x64': '0.27.0',
      '@esbuild/linux-arm64': '0.27.0',
      '@esbuild/win32-x64': '0.27.0',
      '@esbuild/darwin-arm64': '0.27.0',
      '@esbuild/darwin-x64': '0.27.0',
    }
    const { fetch, count } = countingFetch({
      name: 'esbuild',
      version: '0.27.0',
      dist: { tarball: 'https://t/esbuild.tgz' },
      optionalDependencies: optional,
    })
    const report = await scanTarget('esbuild', { env, fetchImpl: fetch })
    expect(count()).toBe(1)
    expect(report.findings[0]?.pattern).toBe(DistributionPattern.PlatformOptionalDeps)
    expect(report.findings[0]?.risk).toBe(RiskLevel.LOW)
  })
})

describe('scanTarget · deep（L2 取证折叠，网络计数累计）', () => {
  const canvasManifest = {
    name: 'canvas',
    version: '3.2.0',
    dist: { tarball: 'https://t/canvas.tgz' },
    dependencies: { 'prebuild-install': '^7.0.0' },
    binary: { napi_versions: [7] },
    config: null,
    repository: { url: 'git://github.com/Automattic/node-canvas.git', type: 'git' },
    scripts: { install: 'prebuild-install -r napi || node-gyp rebuild' },
  }

  it('C 模式 deep：manifest GET(1) + verify manifest(1) + HEAD(1) → LOW，networkCalls=3', async () => {
    const { fetch, count } = countingFetch(canvasManifest)
    const report = await scanTarget('canvas', { env, fetchImpl: fetch, deep: true })
    expect(count()).toBe(3)
    expect(report.findings[0]?.risk).toBe(RiskLevel.LOW)
    expect(report.findings[0]?.strategy).toBe(InstallStrategy.Prebuilt)
  })

  it('A 模式 deep 不额外取证（A 无需联网），networkCalls=1', async () => {
    const optional: Record<string, string> = {
      '@esbuild/linux-x64': '0.27.0',
      '@esbuild/linux-arm64': '0.27.0',
      '@esbuild/win32-x64': '0.27.0',
      '@esbuild/darwin-arm64': '0.27.0',
      '@esbuild/darwin-x64': '0.27.0',
    }
    const { fetch, count } = countingFetch({
      name: 'esbuild',
      version: '0.27.0',
      dist: { tarball: 'https://t/esbuild.tgz' },
      optionalDependencies: optional,
    })
    const report = await scanTarget('esbuild', { env, fetchImpl: fetch, deep: true })
    expect(count()).toBe(1)
    expect(report.findings[0]?.risk).toBe(RiskLevel.LOW)
  })

  it('manifest 拉取异常 → 向上抛（CLI 兜底）', async () => {
    const fetchImpl: HttpLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    await expect(scanTarget('lodash', { env, fetchImpl })).rejects.toThrow()
  })
})
