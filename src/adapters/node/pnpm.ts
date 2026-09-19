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
 * Install-script signal (S2). pnpm does not record npm's `hasInstallScript`,
 * but lockfile v9 does carry the *equivalent* fact for the packages pnpm decided
 * to build: `packages.<key>.requiresBuild: true`. So the signal is partly
 * recoverable rather than lost:
 *
 *   requiresBuild === true  → `hasInstallScript: true` (Replay-grade)
 *   anything else           → `undefined` — **not recorded**
 *
 * Absence is deliberately never read as `false`. `false` would assert "this
 * package has no install script", and pnpm does not promise to emit the flag for
 * every package that needs one (our own v9 fixture omits it for node-pty, which
 * has `node-gyp rebuild`). Asserting it would collapse Pattern D (compiles at
 * install time) into Pattern B (prebuilt ships in the tarball), and B in fast
 * mode reads as a benign result — a false negative presented as a safe one.
 */
import { load } from 'js-yaml'
import type { LockfileDependency, LockfilePackage } from './signals'

interface PnpmPackageMeta {
  resolution?: { integrity?: string; tarball?: string }
  os?: string[]
  cpu?: string[]
  libc?: string[]
  hasBin?: boolean
  /** pnpm v9+: whether pnpm will run this package's build scripts. */
  requiresBuild?: boolean
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

/**
 * Split a `name@version` / `@scope/name@version` key at the last `@`.
 *
 * Snapshot keys carry a **peer suffix** — `react-dom@18.2.0(react@18.2.0)` — and
 * since that suffix contains its own `@`, splitting first would yield
 * name `react-dom@18.2.0(react` / version `18.2.0)`. Every peer-resolved package
 * (i.e. most of a real pnpm project) came out with a corrupted name, which
 * poisons the report, `packageKey` de-duplication and the name→library hints.
 * The suffix is metadata about the resolution, not part of the identity.
 */
function parseNameVersion(key: string): { name: string; version: string } {
  const bare = key.replace(/\(.*\)$/, '')
  const at = bare.lastIndexOf('@')
  if (at <= 0) return { name: bare, version: 'unknown' }
  return { name: bare.slice(0, at), version: bare.slice(at + 1) }
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
      // See the module header: `true` is a recorded fact, absence is not a
      // recorded absence.
      ...(meta.requiresBuild === true ? { hasInstallScript: true } : {}),
      dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
      pathChains: [[name]],
    })
  }
  return list
}
