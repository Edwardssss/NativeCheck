/**
 * Terminal summary block.
 *
 * It is the only place where the five risk levels appear side by side, which also
 * makes it the only place where a missing line becomes a silent arithmetic error:
 * AMBIGUOUS was counted in `byRisk` but never rendered, so the visible numbers did
 * not add up to `native candidates`.
 */
import { describe, expect, it } from 'vitest'
import { renderReport, renderSummary } from '../src/cli/render'
import { SUPPORTED_LOCKFILES } from '../src/adapters/node/ingest'
import type { ScanReport } from '../src/core/report'
import { RISK_META, RiskLevel } from '../src/core/risk'

/** 用户可见的「支持范围」承诺；与 `SUPPORTED_LOCKFILES` 逐一对应。 */
const SUPPORTED_FORMATS = [
  'package-lock.json (lockfileVersion 2 / 3)',
  'pnpm-lock.yaml (packages + snapshots)',
  'yarn.lock (v1 classic / Berry)',
  'bun.lockb (binary)',
]

const report: ScanReport = {
  target: '/proj',
  generatedAt: '2026-09-19T00:00:00.000Z',
  environment: { os: 'linux', arch: 'x64', libc: 'glibc', sdks: [] },
  mode: 'fast',
  durationMs: 1,
  findings: [],
  summary: {
    totalPackages: 412,
    nativeCandidates: 8,
    byRisk: { LOW: 5, MEDIUM: 1, HIGH: 1, UNVERIFIED: 0, AMBIGUOUS: 1 },
    networkCalls: 0,
  },
}

describe('renderSummary', () => {
  it('每一类风险都渲染出来，数字之和等于 nativeCandidates', () => {
    const out = renderSummary(report)
    for (const level of Object.values(RiskLevel)) {
      expect(out, `缺少 ${level} 行`).toContain(RISK_META[level].label)
    }
    const sum = Object.values(report.summary.byRisk).reduce((a, b) => a + b, 0)
    expect(sum).toBe(report.summary.nativeCandidates)
  })
})

describe('renderReport · unsupported', () => {
  it('列出工具真正支持的格式（字段不再只存在于 JSON 里）', () => {
    const out = renderReport({
      ...report,
      summary: {
        ...report.summary,
        nativeCandidates: 0,
        byRisk: { ...report.summary.byRisk, LOW: 0, MEDIUM: 0, HIGH: 0, AMBIGUOUS: 0 },
      },
      unsupported: {
        detected: 'bun.lock (text)',
        reason: 'bun 文本 lockfile 结构不同，需单独适配（当前仅支持二进制 bun.lockb）',
        supported: [...SUPPORTED_LOCKFILES],
      },
    })
    expect(out).toContain('bun.lock (text)')
    expect(out).toContain('supported:')
    for (const format of SUPPORTED_FORMATS) {
      expect(out, `渲染结果缺少 ${format}`).toContain(format)
    }
  })

  it('支持范围是对用户的承诺，改动必须显式改这份清单', () => {
    // 与 fixtures/ 的 snapshot 纪律同理：支持列表不能悄悄漂移（它曾经写死成
    // 只有 npm，即使失败的是 pnpm / yarn / bun）。
    expect([...SUPPORTED_LOCKFILES]).toEqual(SUPPORTED_FORMATS)
  })
})
