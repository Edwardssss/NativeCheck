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

/** The user-visible "supported scope" promise; mirrors `SUPPORTED_LOCKFILES` one to one. */
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
  it('every risk level is rendered and the numbers sum to nativeCandidates', () => {
    const out = renderSummary(report)
    for (const level of Object.values(RiskLevel)) {
      expect(out, `missing the ${level} line`).toContain(RISK_META[level].label)
    }
    const sum = Object.values(report.summary.byRisk).reduce((a, b) => a + b, 0)
    expect(sum).toBe(report.summary.nativeCandidates)
  })
})

describe('renderReport · unsupported', () => {
  it('lists the formats the tool really supports (the field no longer lives only in JSON)', () => {
    const out = renderReport({
      ...report,
      summary: {
        ...report.summary,
        nativeCandidates: 0,
        byRisk: { ...report.summary.byRisk, LOW: 0, MEDIUM: 0, HIGH: 0, AMBIGUOUS: 0 },
      },
      unsupported: {
        detected: 'bun.lock (text)',
        reason:
          'the text bun.lock has a different structure and needs its own adapter (only the binary bun.lockb is supported today)',
        supported: [...SUPPORTED_LOCKFILES],
      },
    })
    expect(out).toContain('bun.lock (text)')
    expect(out).toContain('supported:')
    for (const format of SUPPORTED_FORMATS) {
      expect(out, `rendered output is missing ${format}`).toContain(format)
    }
  })

  it('the supported scope is a promise to users; changing it must be explicit', () => {
    // Same discipline as the fixtures/ snapshots: the supported list must not drift
    // silently (it used to be hardcoded to npm only, even when pnpm / yarn / bun failed).
    expect([...SUPPORTED_LOCKFILES]).toEqual(SUPPORTED_FORMATS)
  })
})
