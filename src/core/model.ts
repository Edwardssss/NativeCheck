/**
 * Ecosystem-agnostic unified data model.
 *
 * Core knows nothing about npm / pip / Cargo internals — it only understands
 * the model defined here; ecosystems are just Adapters (see `src/adapters/node`).
 *
 * Maps to design doc §9
 */

/** Supported ecosystems. V0.1 implements node only. */
export type Ecosystem = 'node' | 'python' | 'rust' | 'cpp'

/** Subset of Node `process.platform`; also compared against lockfile `os` fields. */
export type Platform = 'darwin' | 'linux' | 'win32' | 'freebsd' | 'openbsd' | 'aix' | 'sunos'

/** Subset of Node `process.arch`; also compared against lockfile `cpu` fields. */
export type Arch = 'x64' | 'arm64' | 'arm' | 'ia32' | 'ppc64' | 's390x' | 'riscv64' | 'loong64'

/** C runtime library. musl on Alpine etc.; a key dimension for Pattern A / B matching. */
export type Libc = 'glibc' | 'musl'

/**
 * Dependency path: the full chain from project root to the target package.
 *
 * The full path must be preserved, not just the direct consumer — in
 * `A → B → prebuild-install`, what the user cares about is "who brought
 * native into the project", i.e. `A`.
 */
export interface DependencyPath {
  /** e.g. `['my-app', 'framework-x', 'database-y', 'legacy-addon']` */
  readonly chain: readonly string[]
  /** Whether every package on the chain is a prod dependency; dev/optional changes risk semantics. */
  readonly dev: boolean
  readonly optional: boolean
}

/** A package identified as a native candidate. */
export interface PackageRef {
  readonly name: string
  readonly version: string
  readonly ecosystem: Ecosystem
  /** A package can enter the tree via multiple paths; keep them all. */
  readonly paths: readonly DependencyPath[]
  /** Raw lockfile fields, for evidence chain references and debugging. */
  readonly raw: Readonly<Record<string, unknown>>
  /**
   * Workspace members that declare this package, sorted (monorepos only).
   *
   * Absent in a single-package project, and absent when the root package is the
   * declarer — "declared by the root" is the default and printing it on every
   * finding would be noise. Absent therefore means "not attributable to a
   * workspace", never "no one depends on it".
   */
  readonly workspaces?: readonly string[]
}

/**
 * Distribution pattern — the key abstraction missing from the v1 design.
 *
 * See design doc §5, §9.1
 */
export enum DistributionPattern {
  /** A: main package + N `os`/`cpu` constrained binary sub-packages (esbuild, sharp, swc…). 100% detectable with zero network. */
  PlatformOptionalDeps = 'PlatformOptionalDeps',
  /** B: prebuildify — prebuilt artifacts shipped inside the package's own tarball under `prebuilds/`. */
  Prebuildify = 'Prebuildify',
  /** C: downloaded from a remote host at install time (prebuild-install / node-pre-gyp). */
  RemoteDownload = 'RemoteDownload',
  /** D: source only — always requires a local build. */
  SourceOnly = 'SourceOnly',
  /** Not native. */
  NotNative = 'NotNative',
}

/**
 * Native verdict — do NOT reduce this to a binary "native / not native".
 *
 * `SUSPICIOUS` is produced for: has an install script whose content cannot be
 * parsed statically (the lockfile records only `hasInstallScript`, not the
 * script body — see `verdictFor`). Rendered as neutral gray in reports and
 * **excluded from risk statistics** — neither missed nor noisy.
 *
 * Note: `detect-libc` / `node-abi` are deliberately NOT SUSPICIOUS triggers —
 * they are far too common among pure-JS packages and would flood the report
 * with gray noise (see rules.ts).
 */
export enum NativeVerdict {
  Yes = 'YES',
  No = 'NO',
  Suspicious = 'SUSPICIOUS',
  Unknown = 'UNKNOWN',
}

/** Source of a prebuilt artifact. */
export type ArtifactSource =
  'optional-dependency' | 'prebuildify' | 'remote-download' | 'source-build'

/** A (potentially unusable) native artifact. */
export interface Artifact {
  readonly source: ArtifactSource
  readonly platform?: Platform
  readonly arch?: Arch
  readonly runtime?: string
  /** Node ABI, e.g. `127` (Node 22). Provided by `node-abi`; we keep no table of our own. */
  readonly abi?: string
  /** N-API version, e.g. `8`. */
  readonly napi?: string
  readonly libc?: Libc
}

/** One toolchain requirement for a source build / prebuilt strategy. */
export interface BuildRequirement {
  readonly name: string
  readonly versionRequirement?: string
  /** Which evidence this requirement was derived from. */
  readonly source: string
}

/** Install strategy. */
export enum InstallStrategy {
  Prebuilt = 'PREBUILT',
  SourceBuild = 'SOURCE_BUILD',
  Unsupported = 'UNSUPPORTED',
  Unknown = 'UNKNOWN',
}

/** Blocker: an explicit condition missing in the current environment. */
export interface Blocker {
  readonly name: string
  readonly detail: string
  /** How to resolve this blocker; absent when there is no deterministic remedy. */
  readonly remedy?: string
}

/** Detected SDK / heavyweight toolchain (Xcode CLT, MSVC, Android NDK…). */
export interface Sdk {
  readonly name: string
  readonly version?: string
  readonly path?: string
}

/** Compiler probe result. "Command exists" ≠ "can actually compile", hence the separate probe results. */
export interface CompilerInfo {
  readonly name: string
  readonly version?: string
  readonly path?: string
  /** C compiler probe: passes only if `int main(){return 0;}` was truly compiled. */
  readonly cProbe: boolean
  /** C++ compiler probe. */
  readonly cxxProbe: boolean
}

/**
 * System-library probe result (Linux `pkg-config` based; advisory, not a blocker).
 *
 * `available` is false when `pkg-config` itself is missing or the platform is
 * unsupported — in that case `present` is empty and callers must NOT interpret
 * "empty" as "every library is absent".
 */
export interface SystemLibProbe {
  readonly available: boolean
  /** `pkg-config` module names detected as present. */
  readonly present: readonly string[]
}

/** Runtime environment snapshot. */
export interface Environment {
  readonly os: Platform
  readonly arch: Arch
  readonly libc?: Libc
  readonly nodeVersion?: string
  readonly nodeAbi?: string
  /** Node's N-API version (`process.versions.napi`), used to derive napi-runtime artifacts. */
  readonly napiVersion?: string
  readonly npmVersion?: string
  readonly python?: {
    readonly version?: string
    readonly path?: string
  }
  readonly compiler?: CompilerInfo
  readonly sdks: readonly Sdk[]
  /** Curated system-library probe (Linux). Advisory; absent in tests / non-Linux. */
  readonly systemLibs?: SystemLibProbe
}
