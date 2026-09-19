/**
 * Layer 3 Match (design doc §10.4) plus reliability / risk aggregation helpers.
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
  it('模式 A → LOW / PREBUILT，零 blocker', () => {
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

  it('模式 D 工具链齐全 → MEDIUM / SOURCE_BUILD', () => {
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

  it('模式 D 缺编译器 → HIGH + blocker + remedy', () => {
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

  it('SUSPICIOUS + 未定模式 → AMBIGUOUS（中性，非 LOW），带 resolveHint', () => {
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

  it('SUSPICIOUS + deep 解析为 select（良性脚本）→ 收敛 LOW / PREBUILT，verdict 仍 SUSPICIOUS', () => {
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
    // select 重定向的语义映射是关键词表推断（表外行为是盲区）→ 只能标 Inferred，
    // 不许声称 Replay（泛化性自审 2026-09-04 锁死，防止回退成过度声明）。
    expect(finding.reliability).toBe(Reliability.Inferred)
  })

  it('SUSPICIOUS + deep 解析为 compile → 落 D，SOURCE_BUILD / MEDIUM', () => {
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
    // compile 的语义映射是定义级的（脚本文本里明写 node-gyp rebuild）→ 保持 Replay。
    expect(finding.reliability).toBe(Reliability.Replay)
  })

  it('SUSPICIOUS + deep 解析为 download + 远端命中 → 落 C，LOW / PREBUILT', () => {
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

  it('SUSPICIOUS + deep 语义仍 unknown → 保持 AMBIGUOUS', () => {
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

  it('deep 取不到脚本内容时，证据文案不留空括号、不带未验证标记', () => {
    // 触发条件：lockfile 说 hasInstallScript，registry manifest 却没有任何 hook 内容。
    const ghost = pkg({ name: 'ghost-script', version: '1.0.0', hasInstallScript: true })
    const finding = matchCandidate({
      candidate: {
        pkg: ghost,
        pattern: DistributionPattern.NotNative,
        verdict: NativeVerdict.Suspicious,
      },
      env,
      // 已取证（layer 2），但没有任何 hook 文本可读
      verify: { installScript: { script: '', intent: 'unknown' }, networkCalls: 1 },
    })
    expect(finding.risk).toBe(RiskLevel.AMBIGUOUS)
    const hint = finding.evidence.find((e) => e.kind === 'install-script-intent')
    expect(hint?.description).not.toContain('（）')
    expect(hint?.description).toContain('registry manifest')
    expect(hint?.layer).toBe(1)
    // 结论的可靠性不能弱于自己的证据链
    expect(finding.reliability).toBe(Reliability.Inferred)
  })
})

describe('matchCandidate · npm allowScripts 提示', () => {
  // npm 12：allowScripts 默认关闭，install 脚本被阻止。
  const npm12: Environment = { ...env, npmVersion: '12.0.0' }

  it('模式 D（SourceOnly）+ npm 12 → 附加 blocked 提示', () => {
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

  it('模式 C（RemoteDownload）+ npm 12 → 附加 blocked 提示', () => {
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

  it('模式 B（Prebuildify，运行时 loader、无 install 脚本）+ npm 12 → 无提示', () => {
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

  it('模式 B + binding.gyp（隐式 node-gyp rebuild）+ npm 12 → 附加 blocked 提示', () => {
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

  it('npm 10（scripts-run）→ 无提示', () => {
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

  it('SUSPICIOUS + deep 确认良性（select）+ npm 12 → 抑制提示', () => {
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

describe('weakestReliability · Fail Closed 聚合', () => {
  it('有未验证 → 整体未验证', () => {
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
  it('SUSPICIOUS 不参与 native 统计（reported via byRisk only when finding）', () => {
    // 这里只验证计数结构与 networkCalls 透传
    const s = summarize([], 100, 0)
    expect(s.totalPackages).toBe(100)
    expect(s.networkCalls).toBe(0)
  })
})
