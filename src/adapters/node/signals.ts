/**
 * Layer 0 signal model.
 *
 * All five raw signal types come from the lockfile, with zero network:
 *
 * | Signal | Lockfile field | Reliability |
 * |---|---|---|
 * | S1 platform constraint | `os` / `cpu` / `libc` | Replay |
 * | S2 install script | `hasInstallScript` | Replay (misses Pattern B) |
 * | S3 build-tool dependency edge | `dependencies` hitting the allowlist | Replay |
 * | S4 build tool present in tree | package itself is `prebuild-install` etc. | Replay |
 * | S5 platform package cluster | `optionalDependencies` count ≥ threshold | Inferred (supporting) |
 *
 * To keep the Layer 1 classifier a **pure, unit-testable function** (fixtures
 * are the core asset), this module first defines a normalized package record
 * decoupled from any concrete parser. `ingest.ts` converts the arborist
 * virtual tree into an array of `LockfilePackage`; tests can feed hand-written
 * records directly without generating a real lockfile.
 */

/** A package normalized from the lockfile. Decoupled from the arborist `Node` so fixtures are easy to build. */
export interface LockfilePackage {
  readonly name: string
  readonly version: string
  /** Whether it is a dev dependency (hoisted root dev / workspace dev). */
  readonly dev?: boolean
  /** Whether the package itself is optional. */
  readonly optional?: boolean
  /** Platform constraints. Any of `os` / `cpu` / `libc` present hits S1. */
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
  /** Has an install / postinstall script. Hits S2. */
  readonly hasInstallScript?: boolean
  /** Its `dependencies` (including optionalDependencies). Hits S3. */
  readonly dependencies?: Readonly<Record<string, LockfileDependency>>
  /** Every full chain from project root to this package (one package may enter via several paths). */
  readonly pathChains: readonly (readonly string[])[]
  /** Whether it is the project root (the consumer). The root is never a native candidate. */
  readonly isRoot?: boolean
  /**
   * Workspace members that declare this package, sorted by member name.
   *
   * `undefined` in an ordinary single-package project, and also when the
   * dependency is declared by the root package only — see
   * `workspacesDeclaring()`. Populated only for monorepos, so consumers can
   * print it unconditionally.
   */
  readonly workspaces?: readonly string[]
  /**
   * Whether this node *is* a workspace member (the monorepo's own source).
   *
   * A member's own `install` script is a build step the user wrote, not a
   * third-party download, so Layer 1 must not report it as a supply-chain
   * candidate. Members are still walked: the packages they pull in are real.
   */
  readonly isWorkspaceMember?: boolean
}

/**
 * A dependency edge. `optional` identifies platform sub-package clusters (Pattern A).
 *
 * The platform fields describe the **target** package's own constraints, not the
 * parent's. They are what makes Pattern A answerable offline: a cluster is only
 * ``prebuilt-compatible` if one of its optional sub-packages is usable on the
 * current platform. Adapters that cannot see the target's constraints (yarn)
 * leave them undefined, which callers must treat as "unknown", never "absent".
 */
export interface LockfileDependency {
  readonly name: string
  /** The parent's `optionalDependencies` — NOT `edge.optional` in arborist terms; see ingest.ts. */
  readonly optional?: boolean
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
}

/** The result of normalizing a dependency tree at Layer 0. */
export interface IngestedGraph {
  /** Flat index of all nodes, keyed by `name@version`. */
  readonly packages: Readonly<Record<string, LockfilePackage>>
  /** Total package count (including versions), used for the total in reports. */
  readonly totalPackages: number
}

/** Build an index keyed by `name@version`. */
export function indexPackages(list: readonly LockfilePackage[]): IngestedGraph {
  const packages: Record<string, LockfilePackage> = {}
  for (const pkg of list) {
    packages[`${pkg.name}@${pkg.version}`] = pkg
  }
  return { packages, totalPackages: list.length }
}

/**
 * Normalized version of the `name@version` key. Falls back to the bare name
 * when the version is missing (edge case; the report can still render it).
 */
export function packageKey(pkg: LockfilePackage): string {
  return pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name
}
