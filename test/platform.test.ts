/**
 * Platform applicability — the consuming side of the S1 signal.
 *
 * Layer 0 now records `os` / `cpu` / `libc`, so the funnel has to *use* them:
 *
 * 1. `matchesPlatform` replays npm's own gate (`npm-install-checks`), which means
 *    a conclusion drawn from it is Replay-grade, not a heuristic.
 * 2. An optional-only package the platform excludes is dropped entirely — npm
 *    does not install it, so calling fsevents an ambiguous native package on
 *    Windows is noise. A *required* package that excludes the platform is the
 *    opposite: a real `EBADPLATFORM` blocker, reported as UNSUPPORTED / HIGH.
 * 3. Pattern A's real risk is "is there a binary for *my* platform". The
 *    sub-packages carry their own constraints, so a match (or its absence) is
 *    evidence instead of an assumption.
 */
import { describe, expect, it } from 'vitest'
import { classifyGraph, matchesPlatform } from '../src/adapters/node/classify'
import { matchCandidate } from '../src/adapters/node/match'
import { indexPackages, type LockfilePackage } from '../src/adapters/node/signals'
import { renderSummary } from '../src/cli/render'
import type { ScanReport } from '../src/core/report'
import {
  DistributionPattern,
  InstallStrategy,
  NativeVerdict,
  type Environment,
} from '../src/core/model'
import { Reliability } from '../src/core/evidence'
import { RiskLevel } from '../src/core/risk'

const linuxEnv: Environment = {
  os: 'linux',
  arch: 'x64',
  libc: 'glibc',
  python: { version: '3.12.4' },
  compiler: { name: 'gcc', cProbe: true, cxxProbe: true },
  sdks: [],
}
const winEnv: Environment = { os: 'win32', arch: 'x64', sdks: [] }

function pkg(
  partial: Partial<LockfilePackage> & { name: string; version: string },
): LockfilePackage {
  return { pathChains: [[partial.name]], ...partial }
}

/** A Pattern-A parent whose optional sub-packages are the given `os-cpu` specs. */
function clusterParent(
  subPackages: Array<{ name: string; os?: string[]; cpu?: string[]; libc?: string[] }>,
): LockfilePackage {
  return pkg({
    name: 'esbuild-like',
    version: '0.27.7',
    hasInstallScript: true,
    dependencies: Object.fromEntries(
      subPackages.map((sub) => [
        sub.name,
        { name: sub.name, optional: true, os: sub.os, cpu: sub.cpu, libc: sub.libc },
      ]),
    ),
  })
}

describe('matchesPlatform · 复刻 npm 的 os / cpu / libc 闸门', () => {
  it('无约束 → 恒匹配', () => {
    expect(matchesPlatform({}, linuxEnv)).toBe(true)
    expect(matchesPlatform({ os: [], cpu: [] }, winEnv)).toBe(true)
  })

  it('正向列表是白名单', () => {
    expect(matchesPlatform({ os: ['darwin'] }, linuxEnv)).toBe(false)
    expect(matchesPlatform({ os: ['linux', 'darwin'] }, linuxEnv)).toBe(true)
    expect(matchesPlatform({ cpu: ['arm64'] }, linuxEnv)).toBe(false)
    expect(matchesPlatform({ cpu: ['x64', 'arm64'] }, linuxEnv)).toBe(true)
  })

  it('`!` 表示排除，且否定优先', () => {
    expect(matchesPlatform({ os: ['!win32'] }, linuxEnv)).toBe(true)
    expect(matchesPlatform({ os: ['!win32'] }, winEnv)).toBe(false)
    // 白名单命中但被否定项排除 → 仍然不匹配
    expect(matchesPlatform({ os: ['!linux', 'darwin'] }, linuxEnv)).toBe(false)
  })

  it('libc 只在 linux 上是判定维度', () => {
    expect(matchesPlatform({ libc: ['musl'] }, linuxEnv)).toBe(false)
    expect(matchesPlatform({ libc: ['glibc'] }, linuxEnv)).toBe(true)
    // win32 上 npm 不检查 libc
    expect(matchesPlatform({ libc: ['musl'] }, winEnv)).toBe(true)
    // 宿主 libc 探测失败时不否认（也不假装匹配）
    expect(matchesPlatform({ libc: ['musl'] }, { os: 'linux', arch: 'x64', sdks: [] })).toBe(true)
  })
})

describe('classifyGraph · 平台不适用的可选包被剔除，必需依赖保留', () => {
  const graph = indexPackages([
    pkg({
      name: 'fsevents',
      version: '2.3.3',
      optional: true,
      os: ['darwin'],
      hasInstallScript: true,
    }),
    pkg({ name: 'darwin-only-addon', version: '1.0.0', os: ['darwin'], hasInstallScript: true }),
  ])

  it('optional-only + 平台不匹配 → 不进候选（npm 根本不装）', () => {
    const result = classifyGraph(graph, { env: winEnv })
    expect(result.platformExcluded).toEqual(['fsevents@2.3.3'])
    expect(result.candidates.map((c) => c.pkg.name)).toEqual(['darwin-only-addon'])
  })

  it('缺省 env 时行为不变（纯图逻辑，向后兼容）', () => {
    const result = classifyGraph(graph)
    expect(result.platformExcluded).toEqual([])
    expect(result.candidates.map((c) => c.pkg.name).sort()).toEqual([
      'darwin-only-addon',
      'fsevents',
    ])
  })

  it('平台匹配时不影响候选（linux 上的 darwin 包只在 win32 被剔除）', () => {
    const linuxGraph = indexPackages([
      pkg({
        name: 'linux-only-addon',
        version: '1.0.0',
        optional: true,
        os: ['linux'],
        hasInstallScript: true,
      }),
    ])
    expect(classifyGraph(linuxGraph, { env: linuxEnv }).candidates).toHaveLength(1)
    expect(classifyGraph(linuxGraph, { env: winEnv }).platformExcluded).toEqual([
      'linux-only-addon@1.0.0',
    ])
  })

  it('普通平台子包不计入 platformExcluded（它们本来就不是候选）', () => {
    // 一个簇有 26 个平台子包，其中 25 个在本机不可用 —— 若全算进去，透明提示就成了噪声。
    const clusterGraph = indexPackages([
      pkg({ name: 'plain-sub', version: '1.0.0', optional: true, os: ['darwin'], cpu: ['arm64'] }),
    ])
    expect(classifyGraph(clusterGraph, { env: winEnv }).platformExcluded).toEqual([])
  })
})

describe('matchCandidate · 必需依赖平台不匹配 = EBADPLATFORM 阻塞', () => {
  it('否定结论而不是 LOW', () => {
    const candidate = {
      pkg: pkg({
        name: 'linux-only-addon',
        version: '1.0.0',
        os: ['linux'],
        hasInstallScript: true,
      }),
      pattern: DistributionPattern.SourceOnly,
      verdict: NativeVerdict.Yes,
    }
    const finding = matchCandidate({ candidate, env: winEnv })
    expect(finding.strategy).toBe(InstallStrategy.Unsupported)
    expect(finding.risk).toBe(RiskLevel.HIGH)
    expect(finding.reliability).toBe(Reliability.Replay)
    expect(finding.blockers[0]?.name).toBe('平台不适用')
    expect(finding.blockers[0]?.detail).toContain('os=linux')
    expect(finding.evidence[0]?.kind).toBe('platform-constraint')
  })

  it('平台匹配时照常走原有判定', () => {
    const candidate = {
      pkg: pkg({
        name: 'linux-only-addon',
        version: '1.0.0',
        os: ['linux'],
        hasInstallScript: true,
      }),
      pattern: DistributionPattern.SourceOnly,
      verdict: NativeVerdict.Yes,
    }
    const finding = matchCandidate({ candidate, env: linuxEnv })
    expect(finding.strategy).toBe(InstallStrategy.SourceBuild)
    expect(finding.risk).toBe(RiskLevel.MEDIUM)
  })
})

describe('matchCandidate · 模式 A 用子包平台约束替代猜测', () => {
  const parent = clusterParent([
    { name: '@esbuild-like/darwin-arm64', os: ['darwin'], cpu: ['arm64'] },
    { name: '@esbuild-like/linux-x64', os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
    { name: '@esbuild-like/win32-x64', os: ['win32'], cpu: ['x64'] },
  ])
  const candidate = {
    pkg: parent,
    pattern: DistributionPattern.PlatformOptionalDeps,
    verdict: NativeVerdict.Yes,
  }

  it('命中本平台子包 → LOW + Replay + 记录 artifact', () => {
    const finding = matchCandidate({ candidate, env: linuxEnv })
    expect(finding.risk).toBe(RiskLevel.LOW)
    expect(finding.reliability).toBe(Reliability.Replay)
    expect(finding.artifacts[0]?.source).toBe('optional-dependency')
    expect(finding.evidence.some((e) => e.description.includes('@esbuild-like/linux-x64'))).toBe(
      true,
    )
  })

  it('子包存在但都不匹配当前平台 → UNVERIFIED（不猜成 LOW，也不猜成 HIGH）', () => {
    const finding = matchCandidate({
      candidate,
      env: { os: 'linux', arch: 's390x', libc: 'glibc', sdks: [] },
    })
    expect(finding.risk).toBe(RiskLevel.UNVERIFIED)
    expect(finding.resolveHint).toContain('package-lock-only')
    const hint = finding.evidence.find((e) => e.description.includes('没有任何一个匹配'))
    expect(hint?.description).toContain('darwin-arm64')
  })

  it('子包没有平台信息 → 仍判 A，但可靠性降为未验证（不假装已确认）', () => {
    const finding = matchCandidate({
      candidate: {
        pkg: clusterParent([{ name: 'sub-a' }, { name: 'sub-b' }]),
        pattern: DistributionPattern.PlatformOptionalDeps,
        verdict: NativeVerdict.Yes,
      },
      env: linuxEnv,
    })
    expect(finding.risk).toBe(RiskLevel.LOW)
    expect(finding.reliability).toBe(Reliability.Unverified)
  })
})

describe('renderSummary · 被跳过的包必须可见', () => {
  const base: ScanReport = {
    target: '/proj',
    generatedAt: '2026-09-19T00:00:00.000Z',
    environment: linuxEnv,
    mode: 'fast',
    durationMs: 1,
    findings: [],
    summary: {
      totalPackages: 10,
      nativeCandidates: 0,
      byRisk: { LOW: 0, MEDIUM: 0, HIGH: 0, UNVERIFIED: 0, AMBIGUOUS: 0 },
      networkCalls: 0,
    },
  }

  it('静默丢包看起来就像漏报，所以摘要必须说明跳过了几个', () => {
    expect(renderSummary(base)).not.toContain('平台不适用')
    const withExcluded: ScanReport = {
      ...base,
      summary: { ...base.summary, platformExcluded: 2 },
    }
    expect(renderSummary(withExcluded)).toContain('2 个可选包因平台不适用')
  })
})
