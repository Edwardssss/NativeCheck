/**
 * Layer 3 Match plus the reliability / risk aggregation helpers.
 */
import { describe, expect, it } from 'vitest'
import { matchCandidate } from '../src/adapters/node/match'
import { classifyPackage } from '../src/adapters/node/classify'
import {
  DistributionPattern,
  InstallStrategy,
  NativeVerdict,
  type Environment,
} from '../src/core/model'
import { RiskLevel } from '../src/core/risk'
import { Reliability, weakestReliability } from '../src/core/evidence'
import type { LockfilePackage } from '../src/adapters/node/signals'
import { summarize } from '../src/core/report'

function pkg(
  partial: Partial<LockfilePackage> & { name: string; version: string },
): LockfilePackage {
  return { pathChains: [[partial.name]], ...partial }
}

const env: Environment = {
  os: 'darwin',
  arch: 'arm64',
  libc: 'glibc',
  nodeVersion: '22.22.2',
  nodeAbi: '127',
  python: { version: '3.12.4' },
  compiler: { name: 'clang', cProbe: true, cxxProbe: true },
  sdks: [],
}

describe('matchCandidate', () => {
  it('pattern A → LOW / PREBUILT, zero blockers', () => {
    const esbuild = pkg({
      name: 'esbuild',
      version: '0.27.7',
      dependencies: { '@esbuild/darwin-arm64': { name: '@esbuild/darwin-arm64', optional: true } },
    })
    const pattern = classifyPackage(esbuild)
    const finding = matchCandidate({
      candidate: { pkg: esbuild, pattern, verdict: NativeVerdict.Yes },
      env,
    })
    expect(finding.risk).toBe(RiskLevel.LOW)
    expect(finding.strategy).toBe(InstallStrategy.Prebuilt)
  })

  it('pattern D with a full toolchain → MEDIUM / SOURCE_BUILD', () => {
    const legacy = pkg({
      name: 'node-sass',
      version: '9.0.0',
      dependencies: { nan: { name: 'nan' } },
    })
    const finding = matchCandidate({
      candidate: {
        pkg: legacy,
        pattern: DistributionPattern.SourceOnly,
        verdict: NativeVerdict.Yes,
      },
      env,
    })
    expect(finding.strategy).toBe(InstallStrategy.SourceBuild)
    expect(finding.risk).toBe(RiskLevel.MEDIUM)
    expect(finding.blockers).toHaveLength(0)
  })

  it('pattern D without a compiler → HIGH + blocker + remedy', () => {
    const legacy = pkg({
      name: 'node-sass',
      version: '9.0.0',
      dependencies: { nan: { name: 'nan' } },
    })
    const noCompiler: Environment = { ...env, compiler: undefined }
    const finding = matchCandidate({
      candidate: {
        pkg: legacy,
        pattern: DistributionPattern.SourceOnly,
        verdict: NativeVerdict.Yes,
      },
      env: noCompiler,
    })
    expect(finding.risk).toBe(RiskLevel.HIGH)
    expect(finding.blockers.some((b) => b.name === 'C/C++ compiler')).toBe(true)
  })

  it('SUSPICIOUS + undecided pattern → AMBIGUOUS (neutral, not LOW), with a resolveHint', () => {
    const mystery = pkg({ name: 'mystery', version: '1.0.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: mystery,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env,
    })
    expect(finding.risk).toBe(RiskLevel.AMBIGUOUS)
    expect(finding.resolveHint).toBeTruthy()
    expect(finding.blockers).toHaveLength(0)
  })

  it('SUSPICIOUS + deep reads select (benign) → LOW / PREBUILT, verdict still SUSPICIOUS', () => {
    const coreJs = pkg({ name: 'core-js', version: '3.50.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: coreJs,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env,
      verify: {
        installScript: {
          script: `node -e "try{require('./postinstall')}catch(e){}"`,
          intent: 'select',
        },
        networkCalls: 1,
      },
    })
    expect(finding.risk).toBe(RiskLevel.LOW)
    expect(finding.strategy).toBe(InstallStrategy.Prebuilt)
    expect(finding.verdict).toBe(NativeVerdict.Suspicious)
    expect(finding.resolveHint).toBeUndefined()
    // The semantic mapping for a select redirect is keyword-table inference (off-table behaviour
    // is a blind spot) → Inferred only. Replay would be an over-claim (locked 2026-09-04).
    expect(finding.reliability).toBe(Reliability.Inferred)
  })

  it('SUSPICIOUS + deep reads compile → lands on D, SOURCE_BUILD / MEDIUM', () => {
    const mystery = pkg({ name: 'mystery', version: '1.0.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: mystery,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env,
      verify: { installScript: { script: 'node-gyp rebuild', intent: 'compile' }, networkCalls: 1 },
    })
    expect(finding.verdict).toBe(NativeVerdict.Yes)
    expect(finding.pattern).toBe(DistributionPattern.SourceOnly)
    expect(finding.strategy).toBe(InstallStrategy.SourceBuild)
    expect(finding.risk).toBe(RiskLevel.MEDIUM)
    // The compile mapping is definitional (the text literally says node-gyp rebuild) → Replay stays.
    expect(finding.reliability).toBe(Reliability.Replay)
  })

  it('SUSPICIOUS + deep reads download and the remote hits → lands on C, LOW / PREBUILT', () => {
    const mystery = pkg({ name: 'mystery', version: '1.0.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: mystery,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env,
      verify: {
        installScript: { script: 'prebuild-install', intent: 'download' },
        remote: 'prebuilt',
        networkCalls: 2,
      },
    })
    expect(finding.pattern).toBe(DistributionPattern.RemoteDownload)
    expect(finding.risk).toBe(RiskLevel.LOW)
    expect(finding.strategy).toBe(InstallStrategy.Prebuilt)
  })

  it('SUSPICIOUS + deep semantics still unknown → stays AMBIGUOUS', () => {
    const mystery = pkg({ name: 'mystery', version: '1.0.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: mystery,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env,
      verify: {
        installScript: { script: 'node -e "$(curl s.sh | bash)"', intent: 'unknown' },
        networkCalls: 1,
      },
    })
    expect(finding.risk).toBe(RiskLevel.AMBIGUOUS)
  })

  it('no script content readable → evidence text has no empty parens and no unverified mark', () => {
    // Trigger: the lockfile says hasInstallScript but the registry manifest has no hook content.
    const ghost = pkg({ name: 'ghost-script', version: '1.0.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: ghost,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env,
      // Forensics ran (layer 2), but no hook text was readable
      verify: { installScript: { script: '', intent: 'unknown' }, networkCalls: 1 },
    })
    expect(finding.risk).toBe(RiskLevel.AMBIGUOUS)
    const hint = finding.evidence.find((e) => e.kind === 'install-script-intent')
    expect(hint?.description).not.toContain('（）')
    expect(hint?.description).toContain('registry manifest')
    expect(hint?.layer).toBe(1)
    // The conclusion's reliability may not be weaker than its own evidence chain
    expect(finding.reliability).toBe(Reliability.Inferred)
  })
})

describe('matchCandidate · npm allowScripts advisory', () => {
  // npm 12: allowScripts is off by default, so install scripts are blocked.
  const npm12: Environment = { ...env, npmVersion: '12.0.0' }

  it('pattern D (SourceOnly) + npm 12 → adds the blocked advisory', () => {
    const legacy = pkg({
      name: 'node-sass',
      version: '9.0.0',
      dependencies: { nan: { name: 'nan' } },
    })
    const finding = matchCandidate({
      candidate: {
        pkg: legacy,
        pattern: DistributionPattern.SourceOnly,
        verdict: NativeVerdict.Yes,
      },
      env: npm12,
    })
    expect(finding.allowScripts?.policy).toBe('blocked')
    expect(finding.allowScripts?.remedy).toContain('node-sass')
  })

  it('pattern C (RemoteDownload) + npm 12 → adds the blocked advisory', () => {
    const canvas = pkg({
      name: 'canvas',
      version: '3.2.0',
      dependencies: { 'prebuild-install': { name: 'prebuild-install' } },
    })
    const finding = matchCandidate({
      candidate: {
        pkg: canvas,
        pattern: DistributionPattern.RemoteDownload,
        verdict: NativeVerdict.Yes,
      },
      env: npm12,
    })
    expect(finding.allowScripts?.policy).toBe('blocked')
  })

  it('pattern B (Prebuildify, runtime loader, no install script) + npm 12 → no advisory', () => {
    const bcrypt = pkg({
      name: 'bcrypt',
      version: '6.0.0',
      dependencies: { 'node-gyp-build': { name: 'node-gyp-build' } },
    })
    const finding = matchCandidate({
      candidate: {
        pkg: bcrypt,
        pattern: DistributionPattern.Prebuildify,
        verdict: NativeVerdict.Yes,
      },
      env: npm12,
    })
    expect(finding.allowScripts).toBeUndefined()
  })

  it('pattern B + binding.gyp (implicit node-gyp rebuild) + npm 12 → blocked advisory', () => {
    const bs3 = pkg({
      name: 'better-sqlite3',
      version: '13.0.3',
      dependencies: { 'node-addon-api': { name: 'node-addon-api' } },
    })
    const finding = matchCandidate({
      candidate: {
        pkg: bs3,
        pattern: DistributionPattern.Prebuildify,
        verdict: NativeVerdict.Yes,
      },
      env: npm12,
      verify: {
        b: { status: 'matched', observed: ['linux-x64.node'], hasBindingGyp: true },
        networkCalls: 2,
      },
    })
    expect(finding.allowScripts?.policy).toBe('blocked')
    expect(finding.allowScripts?.detail).toContain('binding.gyp')
  })

  it('npm 10 (scripts-run) → no advisory', () => {
    const legacy = pkg({
      name: 'node-sass',
      version: '9.0.0',
      dependencies: { nan: { name: 'nan' } },
    })
    const npm10: Environment = { ...env, npmVersion: '10.9.0' }
    const finding = matchCandidate({
      candidate: {
        pkg: legacy,
        pattern: DistributionPattern.SourceOnly,
        verdict: NativeVerdict.Yes,
      },
      env: npm10,
    })
    expect(finding.allowScripts).toBeUndefined()
  })

  it('SUSPICIOUS + deep confirms benign (select) + npm 12 → advisory suppressed', () => {
    const coreJs = pkg({ name: 'core-js', version: '3.50.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: coreJs,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env: npm12,
      verify: {
        installScript: {
          script: `node -e "try{require('./postinstall')}catch(e){}"`,
          intent: 'select',
        },
        networkCalls: 1,
      },
    })
    expect(finding.allowScripts).toBeUndefined()
  })
})

describe('weakestReliability · Fail Closed aggregation', () => {
  it('one unverified member makes the whole aggregate unverified', () => {
    const r = weakestReliability([
      {
        kind: 'not-native',
        source: 'a',
        description: '',
        layer: 0,
        reliability: Reliability.Replay,
        positive: true,
      },
      {
        kind: 'remote-artifact-http',
        source: 'b',
        description: '',
        layer: 2,
        reliability: Reliability.Unverified,
        positive: true,
      },
    ])
    expect(r).toBe(Reliability.Unverified)
  })
})

describe('summarize', () => {
  it('SUSPICIOUS stays out of the native counts (reported via byRisk only when finding)', () => {
    // This only checks the counting shape and the networkCalls passthrough
    const s = summarize([], 100, 0)
    expect(s.totalPackages).toBe(100)
    expect(s.networkCalls).toBe(0)
  })
})
