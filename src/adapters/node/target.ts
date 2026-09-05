/**
 * `--target` single-package debug mode.
 *
 * Diagnose one package by name (optionally pinned to a version) without a
 * lockfile and without Docker: fetch the registry manifest → build a standalone
 * `LockfilePackage` → run the same L1 classify / L2 verify / L3 match funnel as a
 * full scan, but for exactly one package.
 *
 * This is NOT the default scan and does not carry the "fast = zero network" iron
 * rule: by definition it must contact the registry to learn the package's
 * dependencies. The fast/deep distinction here is the same as in a scan — fast
 * stops after L1 classify (one manifest GET), deep additionally runs L2 forensics
 * (B/C prebuild / remote-artifact probes).
 */
import { scanEnvironment } from '../../env'
import { summarize, type ScanReport } from '../../core/report'
import type { Environment } from '../../core/model'
import { classifyPackage, verdictFor, type NativeCandidate } from './classify'
import { matchCandidate } from './match'
import { candidateNeedsNetwork, verifyCandidate, type VerifyOutcome } from './verify'
import { defaultFetch, fetchManifest, type HttpLike, type PackageProfile } from './network'
import type { LockfileDependency, LockfilePackage } from './signals'

export interface TargetOptions {
  /** Run L2 online forensics (B / C prebuild / remote-artifact probes). */
  readonly deep?: boolean
  /** Inject an environment snapshot for tests; otherwise scan the live environment. */
  readonly env?: Environment
  /** Inject the HTTP transport (for tests); defaults to global fetch. */
  readonly fetchImpl?: HttpLike
}

/** A parsed `<name>[@version]` spec. Scoped packages (`@scope/name[@version]`) are supported. */
export interface ParsedSpec {
  readonly name: string
  readonly version?: string
}

/**
 * Parse `name`, `name@version`, `@scope/name`, `@scope/name@version` into name +
 * optional version. The version is split on the **last** `@`, so scoped names keep
 * their leading `@scope/` intact.
 */
export function parsePackageSpec(spec: string): ParsedSpec {
  const trimmed = spec.trim()
  if (!trimmed) throw new Error('包名不能为空')
  const atIndex = trimmed.lastIndexOf('@')
  if (atIndex > 0) {
    const name = trimmed.slice(0, atIndex)
    const version = trimmed.slice(atIndex + 1)
    if (name && version) return { name, version }
    if (name) return { name } // `@scope/name@` → no version
  }
  return { name: trimmed }
}

/** Promote a registry manifest profile into a standalone `LockfilePackage`. */
function profileToPackage(profile: PackageProfile): LockfilePackage {
  const dependencies: Record<string, LockfileDependency> = {}
  for (const dep of Object.keys(profile.dependencies)) {
    dependencies[dep] = { name: dep, optional: false }
  }
  for (const dep of Object.keys(profile.optionalDependencies)) {
    dependencies[dep] = { name: dep, optional: true }
  }
  return {
    name: profile.name,
    version: profile.version,
    os: profile.os,
    cpu: profile.cpu,
    libc: profile.libc,
    hasInstallScript: profile.hasInstallScript,
    dependencies,
    pathChains: [],
    isRoot: false,
  }
}

/**
 * Diagnose a single package by `<name>[@version]`. Missing version resolves to
 * `latest`. Returns a full `ScanReport` with exactly one finding, so the CLI can
 * reuse the same renderer / JSON schema as a scan.
 *
 * @throws when the package does not exist / the registry is unreachable (surfaced by the CLI).
 */
export async function scanTarget(spec: string, options: TargetOptions = {}): Promise<ScanReport> {
  const started = Date.now()
  const env = options.env ?? scanEnvironment()
  const fetchImpl = options.fetchImpl ?? defaultFetch()
  const mode = options.deep ? 'deep' : 'fast'
  const { name, version = 'latest' } = parsePackageSpec(spec)

  const manifest = await fetchManifest(name, version, fetchImpl)
  const actualVersion = manifest.profile.version

  const pkg = profileToPackage(manifest.profile)
  const pattern = classifyPackage(pkg)
  const verdict = verdictFor(pkg, pattern)
  const candidate: NativeCandidate = { pkg, pattern, verdict }

  let networkCalls = 1 // the manifest GET above
  let verify: VerifyOutcome | undefined
  if (mode === 'deep' && candidateNeedsNetwork(candidate)) {
    const outcome = await verifyCandidate(candidate, env, fetchImpl)
    networkCalls += outcome.networkCalls
    verify = outcome
  }

  const finding = matchCandidate({ candidate, env, verify })
  const report: ScanReport = {
    target: `${name}@${actualVersion}`,
    generatedAt: new Date().toISOString(),
    environment: env,
    mode,
    durationMs: Date.now() - started,
    findings: [finding],
    summary: summarize([finding], 1, networkCalls),
  }
  return report
}
