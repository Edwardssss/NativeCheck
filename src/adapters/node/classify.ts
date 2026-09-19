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
 * 2. **A dependency edge on a build tool is enough.** A native package may declare
 *    no native trait at all, but it must depend on `node-gyp-build` /
 *    `prebuild-install` / `nan` / … so the S3 edge signal is the entry-point
 *    detector. "Who brought native into the project" is answered by the
 *    dependency path, not by promoting a grandparent to a candidate: an earlier
 *    "transitive closure reverse lookup" pass was removed because every
 *    `deps[tool]` it looked for is already classified here (a package with a
 *    tool edge can never reach that pass), so it never contributed a candidate.
 * 3. **SUSPICIOUS intermediate state:** never reduce to a native/not-native
 *    binary. When unsure, drop into SUSPICIOUS, rendered in neutral gray and
 *    excluded from risk statistics.
 */
import { DistributionPattern, NativeVerdict, type Environment } from '../../core/model'
import {
  LEGACY_NATIVE_DEPS_SET,
  NAPI_HEADERS_SET,
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
  /**
   * Workspace members skipped as candidates (monorepos only), sorted.
   *
   * A member is the user's own source, so its `install` script is a build step
   * they wrote rather than a third-party download. Reported as a transparency
   * note instead of silently disappearing: "we did not look at these" and "we
   * looked and found nothing" must not be distinguishable from the outside.
   */
  readonly workspaceMembers: readonly string[]
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
 * Run classification over the whole tree: apply the forward signals (dependency
 * edges are S3, and they cover every build tool in the rule table — see the
 * module header on why there is no separate reverse-lookup pass).
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

  // Workspace members are the user's own packages; see `workspaceMembers`.
  const members = all.filter((pkg) => pkg.isWorkspaceMember === true)
  const workspaceMembers = members.map(packageKey).sort()

  for (const pkg of all) {
    if (pkg.isRoot || pkg.isWorkspaceMember === true) continue
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

  return { candidates, platformExcluded, workspaceMembers, networkCalls: 0 }
}

/**
 * Reverse lookup has been removed on purpose (2026-09 review).
 *
 * It walked `deps[tool]` and promoted the consumer to a candidate, but every
 * package that has such an edge is already classified as B / C / D by
 * `classifyPackage` above, so no package could ever reach it — the pass was
 * unreachable code that three doc comments and one test claimed was the
 * "transitive closure reverse lookup". It also was not transitive: it walked a
 * single hop, so `A → B → prebuild-install` never surfaced `A`.
 *
 * The user-facing question behind it — "who brought this native dependency into
 * my project" — is answered by the dependency path on each finding
 * (`PackageRef.paths`, collected in ingest.ts).
 */
