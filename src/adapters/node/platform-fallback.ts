/**
 * What actually happens when a Pattern-A cluster has no sub-package for the
 * current platform.
 *
 * Pattern A means "the main package + N platform-constrained binary
 * sub-packages", and the CLI used to answer that case with a blanket UNVERIFIED:
 * honest, but not actionable — the user asked "will my install work?" and got
 * "I cannot check this offline", even though the failure mode is a property of the
 * package family and is therefore knowable.
 *
 * The table is **curated**, not derived, so conclusions drawn from it are
 * `Inferred`, never `Replay`. Families are only listed when the behaviour is
 * well known:
 *
 * - `install-fails`: a postinstall script validates the platform sub-package and
 *   exits non-zero, so `npm install` itself fails (esbuild).
 * - `runtime-fails`: nothing runs at install time; the binding is loaded when the
 *   package is required, so the install succeeds and the app breaks later
 *   (sharp / rollup / lightningcss / rolldown and friends — they ship no install
 *   script at all, and hand out a native binding from a platform sub-package).
 *
 * Anything not listed stays `unknown`, which keeps UNVERIFIED for the families
 * nobody has verified. Guessing here would be exactly the "confident LOW/HIGH
 * from no evidence" failure mode this tool exists to avoid.
 */

export type MissingSubpackageMode = 'install-fails' | 'runtime-fails'

export interface PlatformFallbackEntry {
  readonly mode: MissingSubpackageMode
  /** Why this family behaves that way — the sentence is quoted into the evidence. */
  readonly reason: string
}

const TABLE: Readonly<Record<string, PlatformFallbackEntry>> = {
  esbuild: {
    mode: 'install-fails',
    reason:
      "esbuild's postinstall (node install.js) validates the platform sub-package and exits non-zero when it is missing",
  },
  sharp: {
    mode: 'runtime-fails',
    reason:
      'sharp has no install script; the native library is loaded on require, so a missing sub-package installs fine and fails at runtime',
  },
  rollup: {
    mode: 'runtime-fails',
    reason:
      'rollup resolves its native binding on require (native.js), so a missing sub-package installs fine and throws at build time',
  },
  lightningcss: {
    mode: 'runtime-fails',
    reason:
      'lightningcss resolves its native binding on require, so a missing sub-package installs fine and throws at build time',
  },
  rolldown: {
    mode: 'runtime-fails',
    reason:
      'rolldown resolves its native binding on require, so a missing sub-package installs fine and throws at build time',
  },
}

/** Curated fallback behaviour for a package family; `undefined` = nobody verified it. */
export function missingSubpackageMode(name: string): PlatformFallbackEntry | undefined {
  return TABLE[name]
}

/** Package names the table covers (used by tests to keep the list reviewable). */
export function knownPlatformFallbackNames(): string[] {
  return Object.keys(TABLE).sort()
}
