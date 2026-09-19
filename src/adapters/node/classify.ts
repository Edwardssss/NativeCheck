/**
 * Layer 1 — Classify (purely local, zero network).
 *
 * Design doc §10.2. Responsibility: for the packages collected at Layer 0,
 * decide the distribution pattern A/B/C/D by priority, and find the "real
 * native entry points" — including packages that declare no native trait of
 * their own and merely depend on a build tool transitively.
 *
 * Key design points:
 * 1. **Strong signals use OR logic: prefer over-detection to under-detection.**
 *    At L1 a false negative costs far more than a false positive — a false
 *    positive at least shows up in the report, a false negative is total silence.
 * 2. **Transitive closure reverse lookup:** a native package may declare no
 *    native trait, but it **must depend on a build tool**. So when
 *    `prebuild-install` / `node-gyp-build` appears in the lockfile, looking
 *    backwards for "who depends on it" finds the native entry point while
 *    preserving the full dependency path.
 * 3. **SUSPICIOUS intermediate state:** never reduce to a native/not-native
 *    binary. When unsure, drop into SUSPICIOUS, rendered in neutral gray and
 *    excluded from risk statistics.
 */
import { DistributionPattern, NativeVerdict, type Environment } from '../../core/model'
import {
  AUXILIARY_NATIVE_DEPS_SET,
  LEGACY_NATIVE_DEPS_SET,
  NAPI_HEADERS_SET,
  NATIVE_BUILD_TOOLS_SET,
  PLATFORM_CLUSTER_THRESHOLD,
  PREBUILDIFY_LOADERS_SET,
  REMOTE_DOWNLOADERS_SET,
} from './rules'
import type { IngestedGraph, LockfilePackage } from './signals'
import { packageKey } from './signals'

/** A native candidate: entry package + the distribution pattern it matched. */
export interface NativeCandidate {
  readonly pkg: LockfilePackage
  readonly pattern: DistributionPattern
  readonly verdict: NativeVerdict
}

/** Options for `classifyGraph`. */
export interface ClassifyOptions {
  /**
   * Environment snapshot. When given, packages the current platform excludes are
   * filtered (see `platformExcluded`); omit it to stay purely graph-driven.
   */
  readonly env?: Environment
}

/** Every candidate in the tree judged native (or suspicious). */
export interface ClassificationResult {
  readonly candidates: readonly NativeCandidate[]
  /**
   * Optional-only packages the current platform excludes (`os` / `cpu` / `libc`
   * mismatch) **that would otherwise have been reported** — npm simply does not
   * install them, so they are not native-build risks here; fsevents on Windows
   * is the canonical case. Plain platform sub-packages (esbuild's 26 variants)
   * are not counted: they are never candidates to begin with. Only populated
   * when an `env` was passed, and adapter formats that do not record
   * "optional-only" (pnpm / yarn) can never end up in here.
   */
  readonly platformExcluded: readonly string[]
  /** `--fast` must be zero-network; L1 must never touch a remote. */
  readonly networkCalls: 0
}

/**
 * Replay npm's own os / cpu / libc gate (`npm-install-checks` → `checkPlatform`).
 *
 * Positive entries are an allowlist and `!x` entries deny, so `os: ['darwin']`
 * on linux means "not installed here" — a fact taken from npm's decision logic,
 * not a heuristic. An absent constraint matches everything.
 */
export function matchesPlatform(
  pkg: Pick<LockfilePackage, 'os' | 'cpu' | 'libc'>,
  env: Environment,
): boolean {
  if (!matchesConstraint(pkg.os, env.os)) return false
  if (!matchesConstraint(pkg.cpu, env.arch)) return false
  // libc is only a dimension on Linux (npm skips the check on darwin / win32).
  if (env.os === 'linux' && pkg.libc && pkg.libc.length > 0) {
    // Host libc undetectable (e.g. `detect-libc` failed) → cannot deny, and we
    // deliberately do not claim a match either; treat it as "no constraint seen".
    if (env.libc && !matchesConstraint(pkg.libc, env.libc)) return false
  }
  return true
}

/** Allowlist + `!` denial semantics, shared by the os / cpu / libc dimensions. */
function matchesConstraint(list: readonly string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true
  if (list.includes(`!${value}`)) return false
  const positives = list.filter((entry) => !entry.startsWith('!'))
  if (positives.length === 0) return true
  return positives.includes(value)
}

/** Classify a single package by priority. Stops at the first hit; falls through to NotNative. */
export function classifyPackage(pkg: LockfilePackage): DistributionPattern {
  // A: platform-constrained optional dependency cluster — esbuild / sharp / swc style "main package + N os/cpu sub-packages"
  if (hasPlatformCluster(pkg)) return DistributionPattern.PlatformOptionalDeps

  const deps = pkg.dependencies ?? {}
  const depNames = new Set(Object.keys(deps))

  // B: prebuildify — prebuilt artifacts shipped inside the package's own tarball under prebuilds/
  if (hitsAny(depNames, PREBUILDIFY_LOADERS_SET)) return DistributionPattern.Prebuildify

  // C: remote download at install time — prebuild-install / node-pre-gyp / @mapbox/node-pre-gyp.
  // Must be evaluated before the node-addon-api heuristic: bcrypt@5 depends on
  // both node-addon-api and @mapbox/node-pre-gyp and is a remote download (C);
  // letting node-addon-api hit first would misclassify it as B (prebuilds shipped in the tarball).
  if (hitsAny(depNames, REMOTE_DOWNLOADERS_SET)) return DistributionPattern.RemoteDownload

  // D: legacy local source build — nan/bindings, or "node-addon-api + install script".
  // Key point: node-addon-api is only an N-API header dependency; by itself it
  // does not distinguish B from D. The real discriminator is the install script:
  //   - no install script → prebuilds shipped in the tarball (B, e.g. better-sqlite3@13);
  //   - has an install script (`node-gyp rebuild`) → compiles at install time (D, e.g. node-pty@1.1.0).
  if (hitsAny(depNames, LEGACY_NATIVE_DEPS_SET)) return DistributionPattern.SourceOnly
  if (hitsAny(depNames, NAPI_HEADERS_SET) && pkg.hasInstallScript)
    return DistributionPattern.SourceOnly

  // B heuristic: only the N-API header dependency (no downloader, no install script) → prebuilds ship with the tarball
  if (hitsAny(depNames, NAPI_HEADERS_SET)) return DistributionPattern.Prebuildify

  return DistributionPattern.NotNative
}

/** Whether any dependency name hits a rule table (e.g. a remote downloader or a legacy native dep). */
function hitsAny(depNames: ReadonlySet<string>, candidates: ReadonlySet<string>): boolean {
  for (const n of depNames) if (candidates.has(n)) return true
  return false
}

/**
 * Platform optional dependency cluster (S5, inferred supporting signal).
 * sharp has 25 `@img/sharp-*` sub-packages, esbuild has 26 `@esbuild/*`, all of
 * them **genuinely optional** dependencies.
 *
 * Criterion = enough genuinely-optional dependencies. dev/peer edges must not
 * count — otherwise the project root's pile of devDeps looks like a platform
 * sub-package cluster (observed: caused self-scan false positives).
 *
 * Note: the arborist virtual tree usually does not fill os/cpu for sub-packages,
 * so this does not rely on the `platform` flag — it only uses the optional count
 * plus the install script (for reference). Once a real lockfile provides
 * sub-package os/cpu, Layer 3 can compare them against the current platform
 * precisely using Layer 2 data.
 */
function hasPlatformCluster(pkg: LockfilePackage): boolean {
  const deps = pkg.dependencies ?? {}
  const genuinelyOptional = Object.values(deps).filter((dep) => dep.optional)
  return genuinelyOptional.length >= PLATFORM_CLUSTER_THRESHOLD
}

/** Whether a package hits the strong "build-tool dependency edge" signal (S3). */
export function dependsOnBuildTool(pkg: LockfilePackage): boolean {
  const deps = pkg.dependencies ?? {}
  return Object.keys(deps).some((name) => NATIVE_BUILD_TOOLS_SET.has(name))
}

/** Native verdict for a single package, including the SUSPICIOUS intermediate state. */
export function verdictFor(pkg: LockfilePackage, pattern: DistributionPattern): NativeVerdict {
  if (pattern !== DistributionPattern.NotNative) return NativeVerdict.Yes

  // SUSPICIOUS cases: has an install script whose semantics cannot be parsed
  // statically (the lockfile records only `hasInstallScript`, not the body).
  // Rendered in neutral gray and excluded from risk statistics. Note: we do
  // NOT treat weak signals like `detect-libc` as SUSPICIOUS — too common among
  // pure-JS packages (see rules.ts).
  if (pkg.hasInstallScript) return NativeVerdict.Suspicious
  return NativeVerdict.No
}

/**
 * Run classification over the whole tree:
 * 1. walk every package and apply forward signals first (strong signals, OR logic);
 * 2. then run the transitive closure reverse lookup: walk dependency edges, find
 *    packages that depend on a build tool, and record the consumer closest to
 *    the project root on its **ancestor chain** as the native entry point.
 *
 * When `options.env` is given, packages the current platform cannot install and
 * that are *only* reachable through optional dependencies are left out entirely
 * (npm skips them silently — reporting fsevents as an ambiguous native package
 * on Windows is noise, not a finding). Packages that are required stay in: those
 * are genuine `EBADPLATFORM` blockers, so they go to Layer 3 which can say so.
 */
export function classifyGraph(
  graph: IngestedGraph,
  options: ClassifyOptions = {},
): ClassificationResult {
  const candidates: NativeCandidate[] = []
  const platformExcluded: string[] = []
  const seen = new Set<string>()
  const env = options.env

  const all = Object.values(graph.packages)

  // Forward pass: packages hitting a strong signal qualify directly (excluding
  // the project root — its platform dependencies describe "what it publishes",
  // not "what compiling it requires"; see the note above classifyGraph).
  for (const pkg of all) {
    if (pkg.isRoot) continue
    const pattern = classifyPackage(pkg)
    const verdict = verdictFor(pkg, pattern)
    if (pattern === DistributionPattern.NotNative && verdict === NativeVerdict.No) continue
    // Platform gate, applied only to packages that would otherwise be reported:
    // counting every platform sub-package (esbuild ships 26, 25 of them useless
    // here) would turn the transparency note into noise.
    if (env && pkg.optional === true && !matchesPlatform(pkg, env)) {
      platformExcluded.push(packageKey(pkg))
      continue
    }
    const key = packageKey(pkg)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ pkg, pattern, verdict })
  }

  // Reverse lookup: find build tools present in the tree, then look back for
  // "who depends on them (directly or transitively)".
  // Only packages not yet classified in the forward pass are handled, to avoid duplicates.
  const reverseRoots = reverseLookupRoots(all)
  for (const root of reverseRoots) {
    if (root.pkg.isRoot) continue
    const key = packageKey(root.pkg)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ pkg: root.pkg, pattern: root.pattern, verdict: NativeVerdict.Yes })
  }

  return { candidates, platformExcluded, networkCalls: 0 }
}

/** Locate native entry points backwards from build tools and infer their distribution pattern. */
function reverseLookupRoots(all: readonly LockfilePackage[]): readonly NativeCandidate[] {
  const roots: NativeCandidate[] = []
  // First collect "build tool package names present in this tree" (S4).
  // Auxiliary signals (node-abi / napi-build-utils) are deliberately excluded:
  // they are pure-JS helper libraries consumed by downloaders/build scripts, so
  // "depends on node-abi" must NOT flip a package to native — prebuild-install
  // itself depends on node-abi and would otherwise be misreported as a native
  // candidate (regression caught by the held-out buildtool-prebuild-install case).
  const toolNames = new Set<string>()
  for (const pkg of all) {
    if (NATIVE_BUILD_TOOLS_SET.has(pkg.name) && !AUXILIARY_NATIVE_DEPS_SET.has(pkg.name)) {
      toolNames.add(pkg.name)
    }
  }
  // The tools themselves are not the entry points users care about; they are the reverse index
  for (const tool of toolNames) {
    for (const pkg of all) {
      if (pkg.name === tool) continue
      const deps = pkg.dependencies ?? {}
      if (deps[tool]) {
        // Infer the pattern from the tool
        let pattern = DistributionPattern.NotNative
        if (REMOTE_DOWNLOADERS_SET.has(tool)) {
          pattern = DistributionPattern.RemoteDownload
        } else if (tool === 'node-gyp-build') {
          pattern = DistributionPattern.Prebuildify
        } else if (tool === 'node-addon-api') {
          pattern = DistributionPattern.Prebuildify
        }
        roots.push({ pkg, pattern, verdict: NativeVerdict.Yes })
      }
    }
  }
  return roots
}
