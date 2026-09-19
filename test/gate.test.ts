/**
 * CI gate policy.
 *
 * A gate is only useful if it can be switched on without becoming noise, so the
 * tests here pin the three properties that make that possible: an allowlist that
 * really suppresses, a severity threshold that only ever moves downward from HIGH
 * (UNVERIFIED / AMBIGUOUS never fail — "I could not determine this" is not a
 * defect in the scanned project), and baseline comparison so that a project with
 * pre-existing findings can still gate on *new* regressions.
 */
import { describe, expect, it } from 'vitest'
import {
  baselineFromReport,
  evaluateGate,
  matchesIgnore,
  parseBaseline,
  parseIgnoreList,
} from '../src/core/gate'
import { DistributionPattern, InstallStrategy, NativeVerdict } from '../src/core/model'
import type { PackageFinding } from '../src/core/report'
import { Reliability } from '../src/core/evidence'
import { RiskLevel } from '../src/core/risk'

function finding(
  name: string,
  risk: RiskLevel,
  opts: { version?: string; blockers?: number; ignored?: boolean } = {},
): PackageFinding {
  const blockers = Array.from({ length: opts.blockers ?? 0 }, (_, i) => ({
    name: `blocker-${i}`,
    detail: 'missing toolchain',
  }))
  return {
    pkg: {
      name,
      version: opts.version ?? '1.0.0',
      ecosystem: 'node',
      paths: [],
      raw: {},
    },
    verdict: NativeVerdict.Yes,
    pattern: DistributionPattern.SourceOnly,
    strategy: InstallStrategy.SourceBuild,
    risk,
    reliability: Reliability.Replay,
    evidence: [],
    artifacts: [],
    requirements: [],
    blockers,
    paths: [],
    ...(opts.ignored ? { ignored: true } : {}),
  }
}

describe('matchesIgnore / parseIgnoreList', () => {
  it('exact names, scoped wildcards, bare wildcards', () => {
    expect(matchesIgnore('node-pty', ['node-pty'])).toBe(true)
    expect(matchesIgnore('node-pty', ['node-pty@1.0.0'])).toBe(false)
    expect(matchesIgnore('@img/sharp-linux-x64', ['@img/*'])).toBe(true)
    expect(matchesIgnore('node-pty', ['*-pty'])).toBe(true)
    expect(matchesIgnore('node-pty', ['pty'])).toBe(false)
    // a wildcard must not drift into "contains"
    expect(matchesIgnore('my-node-pty', ['*-pty'])).toBe(true)
    expect(matchesIgnore('node-pty-x', ['*-pty'])).toBe(false)
  })

  it('comma and space separated, blank entries ignored', () => {
    expect(parseIgnoreList('a,b , @scope/*')).toEqual(['a', 'b', '@scope/*'])
    expect(parseIgnoreList(undefined)).toEqual([])
    expect(parseIgnoreList('  ')).toEqual([])
  })
})

describe('evaluateGate · thresholds', () => {
  const highNoBlocker = [finding('a', RiskLevel.HIGH)]
  const highWithBlocker = [finding('b', RiskLevel.HIGH, { blockers: 1 })]
  const medium = [finding('c', RiskLevel.MEDIUM)]
  const unverified = [finding('d', RiskLevel.UNVERIFIED)]
  const ambiguous = [finding('e', RiskLevel.AMBIGUOUS)]

  it('default blocker: a blocker or a HIGH risk fails', () => {
    expect(evaluateGate(highNoBlocker).failed).toBe(true)
    expect(evaluateGate(highWithBlocker).failed).toBe(true)
    expect(evaluateGate(medium).failed).toBe(false)
  })

  it('high: only HIGH fails, medium risk does not', () => {
    expect(evaluateGate(medium, { failOn: 'high' }).failed).toBe(false)
    expect(evaluateGate(highNoBlocker, { failOn: 'high' }).failed).toBe(true)
  })

  it('medium: medium risk is caught too', () => {
    expect(evaluateGate(medium, { failOn: 'medium' }).failed).toBe(true)
  })

  it('never: always passes, even with a blocker', () => {
    expect(evaluateGate([...highWithBlocker, ...medium], { failOn: 'never' }).failed).toBe(false)
  })

  it('UNVERIFIED / AMBIGUOUS never fail at any threshold (fail closed is not the same as red)', () => {
    for (const failOn of ['blocker', 'high', 'medium'] as const) {
      expect(evaluateGate(unverified, { failOn }).failed).toBe(false)
      expect(evaluateGate(ambiguous, { failOn }).failed).toBe(false)
    }
  })
})

describe('evaluateGate · the ignore list', () => {
  it('a package matched by --ignore is not part of the failure reason, and is listed', () => {
    const decision = evaluateGate(
      [finding('node-pty', RiskLevel.HIGH, { blockers: 1 }), finding('other', RiskLevel.HIGH)],
      { ignore: ['node-pty'] },
    )
    expect(decision.failed).toBe(true)
    expect(decision.reasons.join(' ')).toContain('other@1.0.0')
    expect(decision.ignored).toEqual(['node-pty@1.0.0'])
  })

  it('a finding already marked ignored during the scan is skipped as well', () => {
    const decision = evaluateGate([finding('x', RiskLevel.HIGH, { ignored: true })])
    expect(decision.failed).toBe(false)
    expect(decision.ignored).toEqual(['x@1.0.0'])
  })

  it('everything ignored → no failure', () => {
    const decision = evaluateGate([finding('a', RiskLevel.HIGH, { blockers: 1 })], {
      ignore: ['a'],
    })
    expect(decision.failed).toBe(false)
    expect(decision.regressions).toEqual([])
  })
})

describe('evaluateGate · baseline', () => {
  const baseline = baselineFromReport({
    findings: [
      finding('old-high', RiskLevel.HIGH, { blockers: 1 }),
      finding('improving', RiskLevel.MEDIUM),
    ],
  })

  it('an existing problem does not fail: it is equally severe in the baseline', () => {
    const decision = evaluateGate([finding('old-high', RiskLevel.HIGH, { blockers: 1 })], {
      baseline,
    })
    expect(decision.failed).toBe(false)
    expect(decision.regressions).toEqual([])
  })

  it('a newly appearing problem fails', () => {
    const decision = evaluateGate([finding('brand-new', RiskLevel.HIGH)], { baseline })
    expect(decision.failed).toBe(true)
    expect(decision.reasons[0]).toContain('brand-new@1.0.0: HIGH')
  })

  it('a regression fails (printing before -> after), an improvement passes', () => {
    const worse = evaluateGate([finding('improving', RiskLevel.HIGH, { blockers: 1 })], {
      baseline,
    })
    expect(worse.failed).toBe(true)
    expect(worse.reasons[0]).toContain('MEDIUM -> HIGH')

    const better = evaluateGate([finding('old-high', RiskLevel.MEDIUM)], { baseline })
    expect(better.failed).toBe(false)
  })

  it('a growing blocker count also counts as a regression', () => {
    const decision = evaluateGate([finding('old-high', RiskLevel.HIGH, { blockers: 2 })], {
      baseline,
    })
    expect(decision.failed).toBe(true)
  })
})

describe('parseBaseline', () => {
  it('accepts a previous --json report', () => {
    const baseline = parseBaseline(
      JSON.stringify({ findings: [finding('a', RiskLevel.HIGH, { blockers: 1 })] }),
    )
    expect(baseline?.entries.get('a@1.0.0')).toEqual({ risk: RiskLevel.HIGH, blockers: 1 })
  })

  it('broken JSON / wrong shape → undefined (the caller reports it and ignores it rather than hiding a real verdict)', () => {
    expect(parseBaseline('{ not json')).toBeUndefined()
    expect(parseBaseline(JSON.stringify({ summary: {} }))).toBeUndefined()
  })
})
