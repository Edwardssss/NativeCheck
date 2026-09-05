/**
 * Evidence and reliability annotation.
 *
 * Maps to design doc `temp/NativeCheck_项目实施方案.md` §4.5, §9.2, §9.3, §11, §19.4
 *
 * Core claim: **output should not carry a single confidence percentage, but
 * describe how each conclusion was derived.** "87% confidence" is false
 * precision; "this conclusion replays npm's own decision logic" is a
 * checkable fact.
 */

/**
 * Reliability — every conclusion must state where it came from.
 *
 * - `Replay`: the decision logic *is* npm / node-gyp's own logic, ≈100%
 * - `Inferred`: based on conventions and heuristics, 80–95%
 * - `Unverified`: offline mode did not query, or behaviour cannot be determined statically
 */
export enum Reliability {
  Replay = 'Replay',
  Inferred = 'Inferred',
  Unverified = 'Unverified',
}

/** Kind of evidence. */
export type NativeEvidenceKind =
  // Layer 0 / 1 · zero network
  | 'platform-constraint' // os / cpu / libc fields in the lockfile
  | 'install-script' // scripts.install / postinstall content
  | 'build-tool-dependency' // dependencies hit the native build-tool allowlist
  | 'platform-package-cluster' // a large cluster of platform-constrained optionalDependencies
  | 'reverse-lookup' // reverse lookup: who depends on a build tool
  | 'install-script-intent' // semantic parse result of the install script
  | 'not-native' // no native signal at all
  // Layer 2 · requires network (--deep only)
  | 'prebuilds-in-tarball' // prebuilds/ listing read from streamed tarball headers
  | 'remote-artifact-http' // HEAD result for a prebuilt URL
  // Layer 3
  | 'platform-match' // environment comparison result
  | 'toolchain-probe' // compiler probe / command lookup result

/** Which layer the evidence came from. Separates offline from online forensics. */
export type EvidenceLayer = 0 | 1 | 2

export interface Evidence {
  readonly kind: NativeEvidenceKind
  /** Where the evidence came from: lockfield field path / path inside tarball / HTTP status. Must be traceable. */
  readonly source: string
  readonly description: string
  readonly layer: EvidenceLayer
  readonly reliability: Reliability
  /**
   * Whether this evidence points at risk.
   * `false` means "this is negative evidence" (e.g. the script parsed as
   * `select`, i.e. it does not compile).
   */
  readonly positive: boolean
}

/** Terminal markers. The UI must distinguish "I don't know" from "you're doomed". */
export const MARKER: Record<Reliability, string> = {
  [Reliability.Replay]: '✓',
  [Reliability.Inferred]: '~',
  [Reliability.Unverified]: '?',
}

/** Localized labels (Chinese) for the HTML report and non-terminal rendering. */
export const RELIABILITY_LABEL: Record<Reliability, string> = {
  [Reliability.Replay]: '复刻型',
  [Reliability.Inferred]: '推测型',
  [Reliability.Unverified]: '未验证',
}

/** Reliability ordering: used to take the *weakest* item as the aggregate annotation. */
const ORDER: Record<Reliability, number> = {
  [Reliability.Replay]: 0,
  [Reliability.Inferred]: 1,
  [Reliability.Unverified]: 2,
}

/** Aggregate the reliability of a group of evidence: any unverified makes the whole unverified. Fail Closed. */
export function weakestReliability(items: readonly Evidence[]): Reliability {
  let worst: Reliability = Reliability.Replay
  for (const item of items) {
    if (ORDER[item.reliability] > ORDER[worst]) worst = item.reliability
  }
  return worst
}

/** Build one piece of evidence. Layer defaults to 0; callers must mark online forensics explicitly. */
export function evidence(
  kind: NativeEvidenceKind,
  source: string,
  description: string,
  reliability: Reliability,
  options: { layer?: EvidenceLayer; positive?: boolean } = {},
): Evidence {
  return {
    kind,
    source,
    description,
    layer: options.layer ?? 0,
    reliability,
    positive: options.positive ?? true,
  }
}
