/**
 * target.ts — `--target` single-package diagnosis.
 *
 * fetch is mocked throughout, so no real network is touched. The point is to verify spec
 * parsing, the L1 classification of each pattern in fast mode (one manifest GET), and the
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

/** Build an HttpLike response. */
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

/** A mock fetch that counts requests and dispatches registry manifests vs HEADs by URL. */
function countingFetch(manifest: Record<string, unknown>): {
  fetch: HttpLike
  count: () => number
} {
  let n = 0
  const fetch: HttpLike = async (url: string, init?: { method?: string }) => {
    n++
    if (url.includes('registry.npmjs.org')) return body(200, JSON.stringify(manifest))
    // anything that is not the registry is a remote artifact HEAD
    expect(init?.method).toBe('HEAD')
    return { status: 200, ok: true, body: null }
  }
  return { fetch, count: () => n }
}

describe('parsePackageSpec', () => {
  it('a bare package name', () => {
    expect(parsePackageSpec('lodash')).toEqual({ name: 'lodash' })
  })
  it('name@version', () => {
    expect(parsePackageSpec('lodash@4.17.21')).toEqual({ name: 'lodash', version: '4.17.21' })
  })
  it('scoped without a version', () => {
    expect(parsePackageSpec('@scope/name')).toEqual({ name: '@scope/name' })
  })
  it('scoped with a version', () => {
    expect(parsePackageSpec('@scope/name@1.2.3')).toEqual({
      name: '@scope/name',
      version: '1.2.3',
    })
  })
  it('a scoped empty version falls back to the bare name', () => {
    expect(parsePackageSpec('@scope/name@')).toEqual({ name: '@scope/name' })
  })
  it('an empty string throws', () => {
    expect(() => parsePackageSpec('   ')).toThrow()
  })
})

describe('scanTarget · fast (one manifest GET, L1 classify per pattern)', () => {
  it('pure JS (lodash) → NotNative / LOW, networkCalls=1', async () => {
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

  it('B (better-sqlite3, node-addon-api without an install script) → Prebuildify / UNVERIFIED (fast does not verify)', async () => {
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
    // no version → resolve latest, and report.target uses the resolved version
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

  it('D (node-pty, nan) → SourceOnly / MEDIUM (toolchain complete)', async () => {
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

  it('A (esbuild, platform optional dependency cluster) → PlatformOptionalDeps / LOW', async () => {
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

describe('scanTarget · deep (L2 verification folding, network calls accumulate)', () => {
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

  it('pattern C deep: manifest GET(1) + verify manifest(1) + HEAD(1) → LOW, networkCalls=3', async () => {
    const { fetch, count } = countingFetch(canvasManifest)
    const report = await scanTarget('canvas', { env, fetchImpl: fetch, deep: true })
    expect(count()).toBe(3)
    expect(report.findings[0]?.risk).toBe(RiskLevel.LOW)
    expect(report.findings[0]?.strategy).toBe(InstallStrategy.Prebuilt)
  })

  it('pattern A deep does not verify anything (A needs no network), networkCalls=1', async () => {
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

  it('a failing manifest fetch propagates (the CLI catches it)', async () => {
    const fetchImpl: HttpLike = async () => {
      throw new Error('ETIMEDOUT')
    }
    await expect(scanTarget('lodash', { env, fetchImpl })).rejects.toThrow()
  })
})
