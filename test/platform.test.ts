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

describe('matchesPlatform · replicates the npm os / cpu / libc gate', () => {
  it('no constraints → always matches', () => {
    expect(matchesPlatform({}, linuxEnv)).toBe(true)
    expect(matchesPlatform({ os: [], cpu: [] }, winEnv)).toBe(true)
  })

  it('a positive list is a whitelist', () => {
    expect(matchesPlatform({ os: ['darwin'] }, linuxEnv)).toBe(false)
    expect(matchesPlatform({ os: ['linux', 'darwin'] }, linuxEnv)).toBe(true)
    expect(matchesPlatform({ cpu: ['arm64'] }, linuxEnv)).toBe(false)
    expect(matchesPlatform({ cpu: ['x64', 'arm64'] }, linuxEnv)).toBe(true)
  })

  it('`!` means exclude, and negation wins', () => {
    expect(matchesPlatform({ os: ['!win32'] }, linuxEnv)).toBe(true)
    expect(matchesPlatform({ os: ['!win32'] }, winEnv)).toBe(false)
    // Listed by the whitelist but excluded by a negation → still no match
    expect(matchesPlatform({ os: ['!linux', 'darwin'] }, linuxEnv)).toBe(false)
  })

  it('libc is only a decision dimension on linux', () => {
    expect(matchesPlatform({ libc: ['musl'] }, linuxEnv)).toBe(false)
    expect(matchesPlatform({ libc: ['glibc'] }, linuxEnv)).toBe(true)
    // npm does not check libc on win32
    expect(matchesPlatform({ libc: ['musl'] }, winEnv)).toBe(true)
    // A failed host libc probe denies nothing (and does not pretend to match)
    expect(matchesPlatform({ libc: ['musl'] }, { os: 'linux', arch: 'x64', sdks: [] })).toBe(true)
  })
})

describe('classifyGraph · inapplicable optional packages are dropped, required ones stay', () => {
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

  it('optional-only + platform mismatch → never a candidate (npm would not install it)', () => {
    const result = classifyGraph(graph, { env: winEnv })
    expect(result.platformExcluded).toEqual(['fsevents@2.3.3'])
    expect(result.candidates.map((c) => c.pkg.name)).toEqual(['darwin-only-addon'])
  })

  it('omitting env changes nothing (pure graph logic, backwards compatible)', () => {
    const result = classifyGraph(graph)
    expect(result.platformExcluded).toEqual([])
    expect(result.candidates.map((c) => c.pkg.name).sort()).toEqual([
      'darwin-only-addon',
      'fsevents',
    ])
  })

  it('a match leaves candidates alone (the darwin package is dropped only on win32)', () => {
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

  it('plain platform sub-packages never count as platformExcluded (they were no candidates)', () => {
    // A cluster has 26 platform sub-packages, 25 unusable here — counting all 25 is just noise.
    const clusterGraph = indexPackages([
      pkg({ name: 'plain-sub', version: '1.0.0', optional: true, os: ['darwin'], cpu: ['arm64'] }),
    ])
    expect(classifyGraph(clusterGraph, { env: winEnv }).platformExcluded).toEqual([])
  })
})

describe('matchCandidate · a required dep on a mismatched platform = EBADPLATFORM blocker', () => {
  it('denies a conclusion instead of saying LOW', () => {
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
    expect(finding.blockers[0]?.name).toBe('platform not applicable')
    expect(finding.blockers[0]?.detail).toContain('os=linux')
    expect(finding.evidence[0]?.kind).toBe('platform-constraint')
  })

  it('a platform match still follows the normal decision path', () => {
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

describe('matchCandidate · pattern A uses sub-package constraints instead of guessing', () => {
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

  it('hit on a sub-package for this platform → LOW + Replay + recorded artifact', () => {
    const finding = matchCandidate({ candidate, env: linuxEnv })
    expect(finding.risk).toBe(RiskLevel.LOW)
    expect(finding.reliability).toBe(Reliability.Replay)
    expect(finding.artifacts[0]?.source).toBe('optional-dependency')
    expect(finding.evidence.some((e) => e.description.includes('@esbuild-like/linux-x64'))).toBe(
      true,
    )
  })

  it('sub-packages exist but none matches → UNVERIFIED (no guessing LOW or HIGH)', () => {
    const finding = matchCandidate({
      candidate,
      env: { os: 'linux', arch: 's390x', libc: 'glibc', sdks: [] },
    })
    expect(finding.risk).toBe(RiskLevel.UNVERIFIED)
    expect(finding.resolveHint).toContain('package-lock-only')
    const hint = finding.evidence.find((e) =>
      e.description.includes('none of the optional sub-packages'),
    )
    expect(hint?.description).toContain('darwin-arm64')
  })

  it('sub-packages carry no platform info → still A, but reliability drops to unverified', () => {
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

describe('renderSummary · skipped packages must stay visible', () => {
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

  it('silently dropping packages looks like a miss, so the summary must state the count', () => {
    expect(renderSummary(base)).not.toContain('platform not applicable')
    const withExcluded: ScanReport = {
      ...base,
      summary: { ...base.summary, platformExcluded: 2 },
    }
    expect(renderSummary(withExcluded)).toContain('2 optional packages skipped')
  })
})
