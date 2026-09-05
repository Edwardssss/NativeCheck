/**
 * npm's install-script policy (allowScripts) — the "package manager version" dimension.
 *
 * An easily overlooked trap in native compatibility: even with a complete
 * toolchain, npm may **never run** the compile/download script at all.
 *
 * Timeline (as of 2026-09):
 *   - npm < 11.16.0: install scripts run by default (traditional behaviour).
 *   - npm 11.16.0+ (2026-05): introduces the `allowScripts` field in
 *     package.json plus `approve-scripts` / `deny-scripts`. In this line it is
 *     **advisory** — scripts still run, unapproved ones are just listed at the
 *     end of the install.
 *   - npm 12 (released 2026-07): `allowScripts` defaults to **off** —
 *     preinstall/install/postinstall (including the implicit node-gyp rebuild
 *     triggered by binding.gyp) are skipped unless explicitly approved. The
 *     install "succeeds" but the native artifact is missing and blows up at
 *     runtime.
 */

/** How install scripts behave under the current npm version. */
export type AllowScriptsPolicy = 'scripts-run' | 'advisory' | 'blocked'

/** Parse `major.minor` (tolerates a leading `v` and `x.y.z`). Returns null on failure. */
function parseMajorMinor(version: string | undefined): { major: number; minor: number } | null {
  if (!version) return null
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]) }
}

/** Decide the install-script policy for a given npm version. */
export function allowScriptsPolicy(npmVersion: string | undefined): AllowScriptsPolicy {
  const v = parseMajorMinor(npmVersion)
  // Unknown version → conservatively assume traditional behaviour (scripts run), so we never add noise.
  if (!v) return 'scripts-run'
  if (v.major >= 12) return 'blocked'
  if (v.major === 11 && v.minor >= 16) return 'advisory'
  return 'scripts-run'
}
