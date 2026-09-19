/**
 * Risk classification.
 *
 * Risk levels and how they are ordered against each other.
 *
 * Key constraint: **UNVERIFIED and AMBIGUOUS are never rendered in red**, and
 * they must always carry a hint on how to become conclusive. When the
 * detection itself has holes, Fail Closed would render "I don't understand
 * this" and "this is genuinely dangerous" as the same HIGH — the long-term
 * result is HIGH inflation and users stop trusting the tool.
 */

export enum RiskLevel {
  /** A clearly matching prebuilt artifact exists */
  LOW = 'LOW',
  /** Source build required, but the toolchain is complete */
  MEDIUM = 'MEDIUM',
  /** Source build required and the toolchain is missing — evidence points at danger */
  HIGH = 'HIGH',
  /** Offline mode: the remote artifact was not verified */
  UNVERIFIED = 'UNVERIFIED',
  /** Package behaviour cannot be determined statically (custom install script etc.) */
  AMBIGUOUS = 'AMBIGUOUS',
}

export interface RiskMeta {
  /** Terminal emoji. The gray family (🔵) is reserved for UNVERIFIED / AMBIGUOUS and is never mixed with HIGH. */
  readonly badge: string
  readonly label: string
  readonly color: 'green' | 'yellow' | 'red' | 'grey'
}

export const RISK_META: Record<RiskLevel, RiskMeta> = {
  [RiskLevel.LOW]: { badge: '🟢', label: 'prebuilt-compatible', color: 'green' },
  [RiskLevel.MEDIUM]: { badge: '🟡', label: 'source-build', color: 'yellow' },
  [RiskLevel.HIGH]: { badge: '🔴', label: 'likely blocked', color: 'red' },
  [RiskLevel.UNVERIFIED]: { badge: '🔵', label: 'unverified', color: 'grey' },
  [RiskLevel.AMBIGUOUS]: { badge: '🔵', label: 'ambiguous', color: 'grey' },
}

/* Risk severity ordering / project-level aggregation are implemented where they
 * are used: `report.ts` builds `byRisk` and `render.ts` lists every level,
 * including the gray UNVERIFIED / AMBIGUOUS pair — the counts must add up to
 * `nativeCandidates`. Keeping a parallel SEVERITY/worstRisk/RISK_DISPLAY_ORDER
 * here would be dead code. */
