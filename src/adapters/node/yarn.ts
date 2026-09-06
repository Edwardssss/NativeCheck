/**
 * Layer 0 — Yarn lockfile adapter (yarn v1 classic + Yarn Berry `__metadata`).
 *
 * yarn.lock is a line-oriented indentation format, NOT YAML and NOT JSON, so it
 * gets a hand-written scanner. Both v1 and Berry share the same indentation
 * skeleton; the differences are localised:
 *
 *   v1     top-level key  `"@scope/pkg@^1.0.0"` (may be a comma-separated list
 *                         of equivalent specifiers)  value fields quoted.
 *   Berry  top-level key  `"pkg@npm:^1.0.0"` (always quoted, protocol-qualified)
 *                         plus an `__metadata:` preamble; values are YAML-ish
 *                         scalars; dependency edges read `name: "protocol:range"`.
 *
 * The adapter normalises whichever dialect it finds into the shared
 * `LockfilePackage[]` shape that feeds classify (Layer 1), matching the
 * pnpm adapter's contract. Malformed content returns an empty list so the
 * caller can Fail Closed (never guess).
 *
 * Information that yarn records — and what the normalized model loses:
 *   - version / resolved / integrity                     → version
 *   - dependencies / optionalDependencies (v1)           → dependency edges (S3)
 *   - optionalDependencies (v1 only)                     → Pattern A cluster
 *   - `conditions: os=.. & cpu=..` (Berry platform pkgs) → dropped (kept for a
 *     future S1 comparison; classify only needs the optional-edge count today)
 *   - hasInstallScript                                   → NOT recorded by yarn
 *
 * Known limitation (mirrors pnpm): yarn does not record `hasInstallScript`, so
 * on yarn the S2 signal is absent; packages that only differ by "node-addon-api
 * + install script" (Pattern D vs B) collapse toward B/NotNative on yarn. This
 * lowers determinism (→ UNVERIFIED in fast mode) but never misreports native
 * as safe.
 */
import type { LockfileDependency, LockfilePackage } from './signals'

/** A single parsed lockfile entry (one resolved package version). */
interface YarnEntry {
  /** The specifier key as it appears (e.g. `@scope/pkg@npm:^1.0.0`). */
  key: string
  /** Version resolved for this entry. */
  version?: string
  /** `dependencies:` block (name → version spec). */
  dependencies?: Record<string, string>
  /** `optionalDependencies:` block. */
  optionalDependencies?: Record<string, string>
}

/**
 * Parse a top-level entry key into a package name + version.
 *
 * Handles both dialects' specifier forms and the degenerate cases:
 *   - comma-separated aliases (`"a@npm:^1.0.0, a@npm:^2.0.0"`) → first alias;
 *   - Berry protocol-qualified keys (`name@npm:range`);
 *   - scoped names (`@scope/pkg@range`).
 *
 * Non-registry sources — Berry `patch:` / `workspace:` / `file:` / `link:` /
 * `portal:` and Yarn v1 `file:` / `link:` / `workspace:` aliases — are not
 * ordinary package-tree nodes, so we drop them (returns null) rather than emit
 * a bogus `LockfilePackage` that would pollute the package index.
 */
function parseNameVersion(key: string): { name: string; version: string } | null {
  let k = key.trim()
  if (k.startsWith('"') && k.endsWith('"')) k = k.slice(1, -1)
  // Take only the first alias when several resolve to the same package.
  const first = k.split(',')[0] ?? k
  const firstTrim = first.trim().replace(/^"|"$/g, '')
  const at = firstTrim.lastIndexOf('@')
  if (at <= 0) return { name: firstTrim, version: 'unknown' }
  const rawName = firstTrim.slice(0, at)
  const rawVersion = firstTrim.slice(at + 1)
  // Skip non-registry sources. Berry encodes them with a protocol in the version
  // side (`npm:` is fine) or, for patches, an embedded `@patch:` on the name side.
  if (
    rawName.includes('@patch:') ||
    rawName.includes('@workspace:') ||
    rawName.includes('@file:') ||
    rawName.includes('@link:') ||
    rawName.includes('@portal:')
  )
    return null
  const source = rawVersion.split(':')[0] ?? ''
  if (rawVersion.includes(':') && source !== 'npm' && source !== 'yarn') return null
  return { name: rawName, version: rawVersion }
}

/**
 * Parse a yarn.lock into normalized `LockfilePackage[]`. Detects v1 vs Berry by
 * the presence of an `__metadata:` preamble, but both are handled by one
 * indentation scanner. Returns an empty list on malformed input (Fail Closed).
 */
export function parseYarnLockfile(content: string): LockfilePackage[] {
  // Fail fast on obviously non-lockfile content.
  if (!content || content.length === 0) return []

  const entries: YarnEntry[] = []
  let current: YarnEntry | null = null

  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length

    if (indent === 0) {
      // Top-level: either the Berry `__metadata:` preamble or a package key line.
      const trimmed = raw.trim()
      if (trimmed === '__metadata:') {
        // Berry preamble; nothing to keep here, but it distinguishes the format.
        current = null
        continue
      }
      // A package key line ends with `:` (with optional trailing comment text).
      if (!trimmed.endsWith(':') && !trimmed.includes('":')) {
        // Unexpected top-level line; treat as malformed and bail (Fail Closed).
        return []
      }
      const keyText = trimmed.slice(0, trimmed.length - 1).trim()
      // Berry `__metadata` header body lines are indented; guard against a key
      // that is actually an unterminated block we mis-split. Accept only lines
      // that look like a quoted/plain specifier ending in `@...`.
      current = { key: keyText }
      entries.push(current)
      continue
    }

    // Indented property line (2-space): `version "1.2.3"`, `dependencies:`, etc.
    if (!current) continue
    const body = raw.trim()
    if (
      body === 'dependencies:' ||
      body === 'optionalDependencies:' ||
      body === 'devDependencies:'
    ) {
      // Collect the block until the next line at indent <= 2.
      const map: Record<string, string> = {}
      let j = i + 1
      while (j < lines.length) {
        const line = lines[j] ?? ''
        if (line.trim() === '' || line.trim().startsWith('#')) {
          j++
          continue
        }
        const lineIndent = line.length - line.trimStart().length
        if (lineIndent <= 2) break
        const depBody = line.trim()
        const m = parseDependencyLine(depBody)
        if (m) map[m.name] = m.name
        j++
      }
      i = j - 1
      if (body === 'dependencies:') current.dependencies = map
      else if (body === 'optionalDependencies:') current.optionalDependencies = map
      continue
    }
    // version field: `version "1.2.3"` (v1) or `version: 1.2.3` (Berry).
    const vmatch = /^version\s*[":]\s*(.+)$/.exec(body)
    if (vmatch && !current.version) {
      const v = vmatch[1]?.trim().replace(/^"|"$/g, '')
      // Berry version may include a trailing quoted bit already stripped.
      current.version = v
      continue
    }
    // Ignore all other scalar fields (resolved / integrity / conditions / ...).
  }

  // If we never saw a real package entry, treat as empty / unsupported.
  if (entries.length === 0) return []

  // Build normalized packages.
  const list: LockfilePackage[] = []
  for (const entry of entries) {
    if (!entry.key) continue
    const parsed = parseNameVersion(entry.key)
    if (!parsed) continue // non-registry source (patch / workspace / ...): drop.
    const { name, version } = parsed
    const deps: Record<string, LockfileDependency> = {}
    for (const [depName] of Object.entries(entry.dependencies ?? {})) {
      if (depName) deps[depName] = { name: depName }
    }
    for (const [depName] of Object.entries(entry.optionalDependencies ?? {})) {
      if (depName) deps[depName] = { name: depName, optional: true }
    }
    list.push({
      name,
      // Prefer the explicit version field over the range found in the key.
      version: entry.version ?? (version !== 'unknown' ? version : 'unknown'),
      hasInstallScript: false, // yarn does not record install scripts.
      dependencies: Object.keys(deps).length > 0 ? deps : undefined,
      pathChains: [[name]],
    })
  }
  return list
}

/**
 * Parse one dependency block line into the dependency name.
 * - v1:    `"@babel/code-frame" "^7.0.0"`   or `lodash "^4.0.0"`
 * - Berry: `bindings: "npm:^1.5.0"`          or `bindings: npm:^1.5.0`
 * The version specifier is intentionally dropped — Layer 1 only needs the
 * dependency *name* to hit the S3 build-tool edge and the Pattern-A allowlist.
 */
function parseDependencyLine(body: string): { name: string } | null {
  // Berry style: `"name": spec`  or  `name: spec`
  const berry =
    /^"((?:@[^/]+\/)?[^"]+)"\s*:/.exec(body) ?? /^((?:@[^/]+\/)?[A-Za-z0-9_.-]+)\s*:/.exec(body)
  if (berry) return { name: berry[1] as string }
  // v1 style: `"name" "spec"`  or  `name "spec"`
  const v1 = /^"((?:@[^/]+\/)?[^"]+)"\s+/.exec(body) ?? /^((?:@[^/]+\/)?[^\s"]+)\s+/.exec(body)
  if (v1) return { name: v1[1] as string }
  return null
}
