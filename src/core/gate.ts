/**
 * CI gate policy: decide whether a scan should fail a build.
 *
 * Ecosystem-agnostic on purpose — it only reads the unified `PackageFinding`
 * model, so an adapter for another ecosystem gets the same gate for free.
 *
 * Design constraints learned from using the tool as a gate:
 *
 * - **A gate must be able to ignore things.** Without an allowlist, one
 *   acceptable native dependency (a vendored addon, a package the team decided to
 *   live with) turns every pull request red and the gate gets switched off.
 * - **A gate must compare against a baseline.** Real projects are not clean; what
 *   matters is "did this change make things worse", not "is this project perfect".
 * - **Fail Closed keeps its meaning.** UNVERIFIED / AMBIGUOUS never fail a build
 *   at any level, because "I could not determine this" is not a defect in the
 *   project being scanned. `--fail-on` only ever widens the set downward from
 *   HIGH through MEDIUM.
 */
import type { PackageFinding, ScanReport } from './report'
import { RiskLevel } from './risk'

/** How severe a finding has to be before the build fails. */
export type FailOn = 'never' | 'blocker' | 'high' | 'medium'

export const FAIL_ON_LEVELS: readonly FailOn[] = ['never', 'blocker', 'high', 'medium']

/** Per-package snapshot of a previous run, used for "new since baseline" logic. */
export interface BaselineEntry {
  readonly risk: RiskLevel
  readonly blockers: number
}

export interface Baseline {
  /** Keyed by `name@version`. */
  readonly entries: ReadonlyMap<string, BaselineEntry>
  /** Packages present in the baseline but absent now (informational). */
  readonly removed: readonly string[]
}

export interface GateOptions {
  /** Default `blocker`: any blocker, or any HIGH risk. */
  readonly failOn?: FailOn
  /** Package name patterns to exclude from the gate (`*` wildcards allowed). */
  readonly ignore?: readonly string[]
  /** Previous report: only findings that are new or worse than this can fail. */
  readonly baseline?: Baseline
}

export interface GateDecision {
  readonly failed: boolean
  /** Human-readable reasons, one per finding that contributed. */
  readonly reasons: readonly string[]
  /** Keys of findings that are new or worse than the baseline. */
  readonly regressions: readonly string[]
  /** Keys of findings suppressed by the allowlist. */
  readonly ignored: readonly string[]
}

/** `foo`, `@scope/*`, `*-prebuild` — glob with `*`, everything else literal. */
export function matchesIgnore(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes('*')) return pattern === name
    const rx = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
    return rx.test(name)
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split a `--ignore` value: `a,b @scope/*` → `['a', 'b', '@scope/*']`. */
export function parseIgnoreList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** `name@version` — the key a baseline is keyed by. */
export function findingKey(finding: PackageFinding): string {
  return `${finding.pkg.name}@${finding.pkg.version}`
}

/** Build a baseline from a previous `--json` report (the documented workflow). */
export function baselineFromReport(report: {
  readonly findings: readonly PackageFinding[]
}): Baseline {
  const entries = new Map<string, BaselineEntry>()
  for (const finding of report.findings) {
    entries.set(findingKey(finding), {
      risk: finding.risk,
      blockers: finding.blockers.length,
    })
  }
  return { entries, removed: [] }
}

/**
 * Parse a baseline file's contents. Accepts the `--json` output of a previous
 * run; anything unparseable is ignored (a broken baseline must not fail a build
 * with an obscure error — the caller reports it instead).
 */
export function parseBaseline(text: string): Baseline | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<ScanReport>
    if (!Array.isArray(parsed.findings)) return undefined
    return baselineFromReport({ findings: parsed.findings })
  } catch {
    return undefined
  }
}

/** Severity ordering for "is this worse than the baseline". UNVERIFIED/AMBIGUOUS sit below LOW on purpose. */
const RANK: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.UNVERIFIED]: 0,
  [RiskLevel.AMBIGUOUS]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
}

/** Whether a finding is severe enough for the requested level (ignoring the baseline). */
function exceedsLevel(finding: PackageFinding, failOn: FailOn): boolean {
  switch (failOn) {
    case 'never':
      return false
    case 'blocker':
      return finding.blockers.length > 0 || finding.risk === RiskLevel.HIGH
    case 'high':
      return finding.risk === RiskLevel.HIGH
    case 'medium':
      return finding.risk === RiskLevel.HIGH || finding.risk === RiskLevel.MEDIUM
  }
}

/**
 * Decide the build outcome.
 *
 * A finding can only fail if it exceeds `failOn` **and** is new or worse than the
 * baseline (when one is supplied). Ignored findings never fail, are never counted
 * as regressions, and are reported back so the renderer can show why a red build
 * is not red.
 */
export function evaluateGate(
  findings: readonly PackageFinding[],
  options: GateOptions = {},
): GateDecision {
  const failOn = options.failOn ?? 'blocker'
  const ignore = options.ignore ?? []
  const reasons: string[] = []
  const regressions: string[] = []
  const ignored: string[] = []

  for (const finding of findings) {
    const key = findingKey(finding)
    // Two ways in: the caller already marked it (`--ignore` during scan), or the
    // gate is given the pattern list itself.
    if (finding.ignored === true || matchesIgnore(finding.pkg.name, ignore)) {
      ignored.push(key)
      continue
    }
    if (!exceedsLevel(finding, failOn)) continue

    const before = options.baseline?.entries.get(key)
    if (before) {
      const worse =
        RANK[finding.risk] > RANK[before.risk] || finding.blockers.length > before.blockers
      if (!worse) continue // same or better than the baseline → not a regression
    }
    regressions.push(key)
    reasons.push(describe(finding, before))
  }

  return { failed: regressions.length > 0, reasons, regressions, ignored }
}

function describe(finding: PackageFinding, before: BaselineEntry | undefined): string {
  const key = findingKey(finding)
  const blockers =
    finding.blockers.length > 0 ? ` (${finding.blockers.map((b) => b.name).join(', ')})` : ''
  return before
    ? `${key}: ${before.risk} -> ${finding.risk}${blockers}`
    : `${key}: ${finding.risk}${blockers}`
}
