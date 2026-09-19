/**
 * Report model and aggregation.
 *
 * Maps to design doc `temp/NativeCheck_项目实施方案.md` §9.4, §11.3, §11.4
 */

import type {
  Artifact,
  Blocker,
  DependencyPath,
  DistributionPattern,
  Environment,
  InstallStrategy,
  NativeVerdict,
  PackageRef,
} from './model'
import type { Evidence, Reliability } from './evidence'
import { RiskLevel } from './risk'

/**
 * Fallback path.
 *
 * `prebuild-install || node-gyp rebuild` should be judged PREBUILT as the main
 * verdict, with the fallback path as an **annotation** rather than the main
 * judgment — the user gets "most likely fine, but if it breaks you know where".
 */
export interface FallbackPlan {
  readonly description: string
  readonly requirements: readonly string[]
  readonly blockers: readonly Blocker[]
  readonly evidence: readonly Evidence[]
}

/**
 * npm allowScripts note — an independent "package manager version" dimension
 * that does NOT participate in risk classification. Used on npm 11.16+
 * (advisory) / npm 12+ (blocked) to warn that packages with install scripts
 * may not be executed.
 */
export interface AllowScriptsNote {
  readonly policy: 'advisory' | 'blocked'
  readonly detail: string
  readonly remedy: string
}

/**
 * System-library advisory — an independent dimension that does NOT participate
 * in risk classification. Attached to SourceBuild findings when a curated
 * name→library hint matches but `pkg-config` did not detect the library:
 * "this package may need libpq-dev, which I don't see". Never a blocker —
 * `pkg-config` absence is weak evidence, and the package may bundle the library.
 */
export interface SystemLibNote {
  /** Display names of the possibly-missing libraries. */
  readonly libs: readonly string[]
  readonly detail: string
  readonly remedy: string
}

/** The complete conclusion for a single package. */
export interface PackageFinding {
  readonly pkg: PackageRef
  readonly verdict: NativeVerdict
  readonly pattern: DistributionPattern
  readonly strategy: InstallStrategy
  readonly risk: RiskLevel
  /** Reliability of the overall conclusion = the weakest of all evidence. Fail Closed. */
  readonly reliability: Reliability
  readonly evidence: readonly Evidence[]
  readonly artifacts: readonly Artifact[]
  readonly requirements: readonly string[]
  readonly blockers: readonly Blocker[]
  readonly fallback?: FallbackPlan
  /**
   * "How to turn this conclusion into a definitive one". Required for
   * UNVERIFIED / AMBIGUOUS. e.g. `nativecheck . --deep`.
   */
  readonly resolveHint?: string
  /** npm version policy note (attached when there is an install script and npm 11.16+/12+). */
  readonly allowScripts?: AllowScriptsNote
  /** System-library advisory (SourceBuild + a mapped-but-undetected system library). */
  readonly systemLibs?: SystemLibNote
  /** Dependency paths: answers "who brought native into the project". */
  readonly paths: readonly DependencyPath[]
}

/** Exit information when an unsupported project format is detected. **Exit explicitly, never guess.** */
export interface UnsupportedProject {
  readonly detected: string
  readonly reason: string
  readonly supported: readonly string[]
}

export interface ScanSummary {
  readonly totalPackages: number
  readonly nativeCandidates: number
  readonly byRisk: Readonly<Record<RiskLevel, number>>
  /**
   * Packages left out because the current platform cannot install them
   * (`os` / `cpu` / `libc` mismatch on an optional-only dependency — npm skips
   * exactly those). Present only when non-zero, so old reports stay valid.
   */
  readonly platformExcluded?: number
  /** Must always be 0 under `--fast`. This assertion is the only reliable way to keep the default path fully offline. */
  readonly networkCalls: number
}

export interface ScanReport {
  readonly target: string
  readonly generatedAt: string
  readonly environment: Environment
  readonly mode: 'fast' | 'deep'
  readonly durationMs: number
  readonly findings: readonly PackageFinding[]
  readonly summary: ScanSummary
  readonly unsupported?: UnsupportedProject
}

/**
 * Aggregate by risk level.
 *
 * An unresolved SUSPICIOUS finding is counted under `AMBIGUOUS`: it must show up
 * in the totals (otherwise the categories stop adding up to `nativeCandidates`),
 * it just never inflates HIGH — that is what "excluded from the risk statistics"
 * means here.
 */
export function summarize(
  findings: readonly PackageFinding[],
  totalPackages: number,
  networkCalls: number,
  platformExcluded = 0,
): ScanSummary {
  const byRisk: Record<RiskLevel, number> = {
    [RiskLevel.LOW]: 0,
    [RiskLevel.MEDIUM]: 0,
    [RiskLevel.HIGH]: 0,
    [RiskLevel.UNVERIFIED]: 0,
    [RiskLevel.AMBIGUOUS]: 0,
  }
  for (const finding of findings) {
    byRisk[finding.risk] += 1
  }
  return {
    totalPackages,
    nativeCandidates: findings.length,
    byRisk,
    networkCalls,
    ...(platformExcluded > 0 ? { platformExcluded } : {}),
  }
}
