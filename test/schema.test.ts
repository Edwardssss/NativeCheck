/**
 * core/schema.ts — the JSON output contract.
 *
 * Two things matter here:
 * 1. the schema validates `--json` output (dogfooding the contract);
 * 2. it must declare every field that a finding can carry — zod `parse` strips
 *    unknown keys, so a missing field silently disappears from the JSON output
 *    (this is exactly what happened to `allowScripts` before it was declared).
 */
import { describe, expect, it } from 'vitest'
import { scanReportSchema } from '../src/core/schema'
import type { ScanReport } from '../src/core/report'

const baseReport: ScanReport = {
  target: '/proj',
  generatedAt: '2026-09-04T00:00:00.000Z',
  environment: { os: 'linux', arch: 'x64', libc: 'glibc', sdks: [] },
  mode: 'fast',
  durationMs: 1,
  findings: [],
  summary: {
    totalPackages: 1,
    nativeCandidates: 1,
    byRisk: { LOW: 0, MEDIUM: 1, HIGH: 0, UNVERIFIED: 0, AMBIGUOUS: 0 },
    networkCalls: 0,
  },
}

describe('scanReportSchema', () => {
  it('parses a minimal report round-trip', () => {
    expect(() => scanReportSchema.parse(baseReport)).not.toThrow()
  })

  it('keeps allowScripts on findings (regression: it was silently stripped)', () => {
    const report: ScanReport = {
      ...baseReport,
      findings: [
        {
          pkg: { name: 'node-pty', version: '1.1.0', ecosystem: 'node', paths: [], raw: {} },
          verdict: 'YES' as ScanReport['findings'][number]['verdict'],
          pattern: 'SourceOnly' as ScanReport['findings'][number]['pattern'],
          strategy: 'SOURCE_BUILD' as ScanReport['findings'][number]['strategy'],
          risk: 'MEDIUM' as ScanReport['findings'][number]['risk'],
          reliability: 'Replay' as ScanReport['findings'][number]['reliability'],
          evidence: [],
          artifacts: [],
          requirements: [],
          blockers: [],
          allowScripts: {
            policy: 'blocked',
            detail: 'npm 12 默认阻止 install 脚本',
            remedy: 'npm approve-scripts node-pty',
          },
          systemLibs: {
            libs: ['libpcap'],
            detail: '可能链接系统库 libpcap',
            remedy: 'apt install libpcap-dev',
          },
          paths: [],
        },
      ],
    }
    const parsed = scanReportSchema.parse(report)
    expect(parsed.findings[0]?.allowScripts?.policy).toBe('blocked')
    expect(parsed.findings[0]?.systemLibs?.libs).toEqual(['libpcap'])
  })

  it('keeps summary.platformExcluded (regression: zod must not strip it)', () => {
    const report: ScanReport = {
      ...baseReport,
      summary: { ...baseReport.summary, platformExcluded: 3 },
    }
    expect(scanReportSchema.parse(report).summary.platformExcluded).toBe(3)
  })

  it('rejects a report with a wrong-shaped finding', () => {
    expect(() =>
      scanReportSchema.parse({
        ...baseReport,
        findings: [{ pkg: { name: 'x' } }],
      }),
    ).toThrow()
  })

  it('keeps environment.systemLibs (regression: env field must be declared too)', () => {
    const report: ScanReport = {
      ...baseReport,
      environment: {
        os: 'linux',
        arch: 'x64',
        libc: 'glibc',
        sdks: [],
        systemLibs: { available: true, present: ['libpcap'] },
      },
    }
    const parsed = scanReportSchema.parse(report)
    expect(parsed.environment.systemLibs?.available).toBe(true)
    expect(parsed.environment.systemLibs?.present).toEqual(['libpcap'])
  })
})
