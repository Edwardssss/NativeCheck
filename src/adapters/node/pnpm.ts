/**
 * Layer 0 — pnpm lockfile adapter.
 *
 * pnpm-lock.yaml (v6/v9) has two top-level maps that together carry the signal
 * NativeCheck needs:
 *
 *   packages:  `name@version` → metadata (resolution integrity, os/cpu/libc)
 *   snapshots: `name@version` → resolved dependency graph (dependencies /
 *              optionalDependencies with exact versions)
 *
 * Known limitation (documented in temp/known-blindspots.md §5): pnpm's lockfile
 * does NOT record `hasInstallScript` (unlike npm's package-lock.json). The
 * S2 "install script" signal is therefore absent on pnpm — packages that only
 * differ by "node-addon-api + install script" (Pattern D vs B) collapse to
 * Pattern B on pnpm. This lowers determinism (→ UNVERIFIED in fast mode) but
 * does NOT misreport native as safe: `--deep` still forensically probes the
 * tarball for B candidates.
 */
import { load } from 'js-yaml'
import type { LockfileDependency, LockfilePackage } from './signals'

interface PnpmPackageMeta {
  resolution?: { integrity?: string; tarball?: string }
  os?: string[]
  cpu?: string[]
  libc?: string[]
  hasBin?: boolean
}

interface PnpmSnapshot {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface PnpmLock {
  lockfileVersion?: string | number
  packages?: Record<string, PnpmPackageMeta>
  snapshots?: Record<string, PnpmSnapshot>
}

/** Split a `name@version` / `@scope/name@version` key at the last `@`. */
function parseNameVersion(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@')
  if (at <= 0) return { name: key, version: 'unknown' }
  return { name: key.slice(0, at), version: key.slice(at + 1) }
}

/**
 * Platform constraints of the edge's **target**, resolved through the `packages`
 * map (Pattern A's platform matching needs them, and a dependency's own entry is
 * where pnpm keeps `os` / `cpu` / `libc`).
 *
 * Specs are exact versions, optionally peer-suffixed (`1.2.3(react@18.2.0)`) or
 * protocol-qualified (`npm:other@1.2.3`). `link:` / `workspace:` / `file:` refs
 * have no package entry, so they simply contribute nothing.
 */
function edgePlatform(
  packages: Record<string, PnpmPackageMeta>,
  name: string,
  spec: string | undefined,
): Pick<LockfileDependency, 'os' | 'cpu' | 'libc'> {
  if (!spec) return {}
  let lookupName = name
  let version = spec
  if (spec.startsWith('npm:')) {
    const rest = spec.slice('npm:'.length)
    const at = rest.lastIndexOf('@')
    if (at <= 0) return {}
    lookupName = rest.slice(0, at)
    version = rest.slice(at + 1)
  } else if (!/^\d/.test(spec)) {
    return {} // link: / workspace: / file: / portal: — not a registry package
  }
  const meta = packages[`${lookupName}@${version.replace(/\(.*\)$/, '')}`]
  if (!meta) return {}
  return {
    ...(meta.os ? { os: meta.os } : {}),
    ...(meta.cpu ? { cpu: meta.cpu } : {}),
    ...(meta.libc ? { libc: meta.libc } : {}),
  }
}

/**
 * Parse a pnpm-lock.yaml into normalized `LockfilePackage[]`.
 * Returns an empty list on malformed YAML (caller falls through to Fail Closed).
 */
export function parsePnpmLockfile(content: string): LockfilePackage[] {
  let doc: PnpmLock | null
  try {
    doc = load(content) as PnpmLock | null
  } catch {
    return [] // malformed YAML → Fail Closed (empty, caller treats as unsupported)
  }
  const snapshots = doc?.snapshots ?? {}
  const packages = doc?.packages ?? {}

  const list: LockfilePackage[] = []
  for (const [key, snapshot] of Object.entries(snapshots)) {
    const { name, version } = parseNameVersion(key)
    const meta = packages[key] ?? {}
    const dependencies: Record<string, LockfileDependency> = {}
    for (const [depName, spec] of Object.entries(snapshot.dependencies ?? {})) {
      dependencies[depName] = { name: depName, ...edgePlatform(packages, depName, spec) }
    }
    for (const [depName, spec] of Object.entries(snapshot.optionalDependencies ?? {})) {
      dependencies[depName] = {
        name: depName,
        optional: true,
        ...edgePlatform(packages, depName, spec),
      }
    }
    list.push({
      name,
      version,
      os: meta.os,
      cpu: meta.cpu,
      libc: meta.libc,
      // pnpm lockfile has no hasInstallScript field — see the module header.
      hasInstallScript: false,
      dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
      pathChains: [[name]],
    })
  }
  return list
}
