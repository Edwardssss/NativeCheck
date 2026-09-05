/**
 * Real online forensics for Layer 2 (--deep only).
 *
 * Design doc §10.3. Requests are issued only for Layer 1 B / C candidates:
 *   - Pattern B (prebuildify): stream the tarball and use `tar.Parser` to read
 *     only file names under `package/prebuilds/`, aborting as soon as the target
 *     platform is found — nothing is written to disk, nothing extracted, and the
 *     full tarball is never downloaded.
 *   - Pattern C (prebuild-install / node-pre-gyp): one HEAD against a remote URL
 *     derived from naming conventions.
 *
 * This file exists to keep "HTTP / tar noise" outside the door:
 *   - pure parsing (file name → platform, URL derivation, `os`/`cpu` reduction)
 *     is exported as unit-testable pure functions;
 *   - the IO functions that actually issue requests accept an injectable `fetch`
 *     (defaulting to global fetch) so tests can inject a mock and never touch the
 *     real network.
 *
 * Zero-network iron rule: this module is only called by `--deep`. The `--fast`
 * path never imports it (enforced by pipeline.ts).
 */
import { Parser, type ReadEntry } from 'tar'
import type { Environment } from '../../core/model'

/** npm registry default endpoint. */
const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'

/* ------------------------------------------------------------------ *
 * Pure parsing: file names / URLs / platform matching — testable, zero IO.
 * ------------------------------------------------------------------ */

/**
 * prebuildify artifacts come in **two naming generations**; both must be
 * supported (otherwise an absent verdict produces a false positive):
 *   - legacy flat: `prebuilds/{platform}-{arch}.node` (e.g. better-sqlite3@13's
 *     `linux-x64.node`; ABI-sensitive, but the name carries no ABI information)
 *   - modern sub-directory: `prebuilds/{platform}-{arch}/{name}.{napi|abiN|glibc|musl}.node`
 *     (e.g. bcrypt@6's `linux-x64/bcrypt.glibc.node`)
 * This function takes the full relative path after `package/prebuilds/` and
 * parses both shapes.
 */

/** Supported arch set (subset of Node `process.arch`, plus `armv7` used by older packages). */
const ARCH_ALT = 'x64|arm64|armv7|arm|ia32|ppc64|s390x|riscv64|loong64'
/** The `{platform}-{arch}` segment: platform has no hyphen and may carry a `musl` suffix (e.g. `linuxmusl`). */
const PLAT_ARCH_RE = new RegExp(`^([a-z0-9]+)-(${ARCH_ALT})$`)

/** Cap on collected binding.gyp content (normal binding.gyp is a few KB; the cap only guards against pathological packages). */
const BINDING_GYP_MAX_BYTES = 64 * 1024

/** Platform information parsed from one artifact entry under `prebuilds/`. */
export interface PrebuildTarget {
  /** Normalized platform name (musl suffix stripped): `linux`, `darwin`, `win32`… */
  readonly platform: string
  readonly arch: string
  /** libc the artifact targets; `none` = the file name carries no libc marker (legacy flat / non-linux). */
  readonly libc: 'glibc' | 'musl' | 'none'
  /** `napi` = N-API, stable across ABIs; a numeric string = bound to a specific Node ABI; `null` = not determinable from the file name. */
  readonly abi: 'napi' | string | null
}

/** Split the `{platform}` segment, recognizing a `linuxmusl`-style musl suffix. */
function splitPlatform(raw: string): { platform: string; libc: 'musl' | 'none' } {
  const lower = raw.toLowerCase()
  if (lower.endsWith('musl')) {
    return { platform: lower.slice(0, -'musl'.length), libc: 'musl' }
  }
  return { platform: lower, libc: 'none' }
}

/** Extract the libc variant and ABI semantics from a sub-directory file name `{name}[.{variant}]` (already stripped of `.node`). */
function parseFileVariant(file: string): {
  libc: 'glibc' | 'musl' | 'none'
  abi: 'napi' | string | null
} {
  const parts = file.toLowerCase().split('.')
  let abi: 'napi' | string | null = null
  let libc: 'glibc' | 'musl' | 'none' = 'none'
  for (const p of parts) {
    if (p === 'napi') abi = 'napi'
    else if (/^abi\d+$/.test(p)) abi = p.slice(3)
    else if (p === 'glibc') libc = 'glibc'
    else if (p === 'musl') libc = 'musl'
  }
  return { libc, abi }
}

/**
 * Parse the full relative path `package/prebuilds/<relPath>` into a platform structure.
 * Returns null when it does not match (README, non-.node, etc.).
 */
export function parsePrebuildEntry(relPath: string): PrebuildTarget | null {
  const path = relPath.replace(/\/+$/, '')
  if (!path.endsWith('.node')) return null

  const slash = path.indexOf('/')
  if (slash === -1) {
    // Legacy flat: `{platform}-{arch}.node`
    const base = path.slice(0, -'.node'.length)
    const m = PLAT_ARCH_RE.exec(base)
    if (!m) return null
    const { platform, libc } = splitPlatform(m[1] ?? '')
    return { platform, arch: m[2] ?? '', libc, abi: null }
  }

  // Modern sub-directory: `{platform}-{arch}/{file}.node`
  const dir = path.slice(0, slash)
  const file = path.slice(slash + 1, -'.node'.length)
  const m = PLAT_ARCH_RE.exec(dir)
  if (!m) return null
  const { platform, libc: platformLibc } = splitPlatform(m[1] ?? '')
  const v = parseFileVariant(file)
  // The libc variant in the sub-directory file name wins over the platform-name
  // suffix (`linux-x64/bcrypt.musl.node` carries musl in the file name).
  const libc = v.libc !== 'none' ? v.libc : platformLibc
  return { platform, arch: m[2] ?? '', libc, abi: v.abi }
}

/** Whether env's os/arch/libc matches a prebuild target. */
export function prebuildMatchesEnv(target: PrebuildTarget, env: Environment): boolean {
  if (target.platform !== env.os) return false
  if (target.arch !== env.arch) return false
  // libc dimension: when the artifact explicitly states a libc, the host must match;
  // `none` (legacy flat) tells us nothing, so it is not rejected here.
  if (target.libc === 'glibc' && env.libc !== 'glibc') return false
  if (target.libc === 'musl' && env.libc !== 'musl') return false
  return true
}

/**
 * Tri-state ABI match for an artifact whose platform/arch/libc already matched.
 *
 * Whether a prebuildify artifact can really load in the current Node depends on the ABI:
 *   - `napi`: N-API, stable across ABIs → definite match;
 *   - `abiN`: bound to a specific Node ABI, matches only when N == current ABI;
 *   - `null` (legacy flat `linux-x64.node` / custom names like `bcrypt.glibc.node`):
 *     no ABI marker in the file name. By default **not determinable** — a flat
 *     artifact may be V8/NAN-ABI-bound (degrades to a source compile on ABI
 *     mismatch) or N-API (stable across ABIs). The decision comes from two
 *     complementary signals:
 *       · `napiBuild`: the build script explicitly says `prebuildify --napi` (bcrypt@6's `bcrypt.glibc.node`);
 *       · the `NAPI_VERSION` macro in binding.gyp (better-sqlite3 v13's flat
 *         `linux-x64.node`, folded in by `probePrebuilds` after reading
 *         binding.gyp — see `isNapiBindingGyp`).
 *     Either one → treat as stable across ABIs → definite match.
 */
export function abiMatchFor(
  target: PrebuildTarget,
  env: Environment,
  napiBuild = false,
): 'match' | 'no-match' | 'unknown' {
  if (target.abi === 'napi') return 'match'
  if (target.abi !== null) return target.abi === env.nodeAbi ? 'match' : 'no-match'
  // No ABI marker in the file name: if the build script says `--napi`, the
  // artifact is N-API (cross-ABI) → match; otherwise not determinable (legacy
  // flat, possibly V8-ABI-bound).
  return napiBuild ? 'match' : 'unknown'
}

/**
 * Metadata read from a registry single-version manifest, used to derive the remote artifact URL.
 *
 * Faithfully replays prebuild-install (the download conventions of
 * prebuild-install / node-pre-gyp):
 *   - `binary.host` / `binary.remote_path` / `binary.package_name`: explicit overrides for the download address and template;
 *   - `binary.napi_versions`: the N-API versions supported by napi-runtime artifacts;
 *   - `config.runtime` / `config.target`: source of rc defaults (keytar is `runtime=napi,target=3`);
 *   - `repository.url`: host source for github-from-package;
 *   - `install`: detects the `-r napi` runtime.
 */
export interface RemoteBinaryMeta {
  readonly binary?: {
    host?: string
    remote_path?: string
    package_name?: string
    module_name?: string
    napi_versions?: number[]
  } | null
  readonly config?: { runtime?: string; target?: number | string } | null
  readonly repository?: { url?: string; type?: string } | null
  readonly install?: string | null
  /** `scripts.postinstall`: forensics source for SUSPICIOUS candidates' install-script semantics (core-js's funding notice lives in postinstall). */
  readonly postinstall?: string | null
  /** `scripts.build` / `scripts.prebuild`: source of the prebuildify `--napi` signal (Pattern B ABI decision). */
  readonly build?: string | null
  readonly prebuild?: string | null
}

/**
 * Parse GitHub repo coordinates out of repository.url (replays `github-from-package`).
 * Handles `git://`, `git+https://`, `https://`, SSH `git@github.com:` and similar,
 * returning `https://github.com/{owner}/{repo}`; returns null when unparseable.
 */
export function parseGithubRepo(repositoryUrl: string | undefined): string | null {
  if (!repositoryUrl) return null
  const m = /\bgithub\.com[:/]([^/"'\s]+)\/([^/"'\s]+)/.exec(repositoryUrl)
  if (!m) return null
  // Strip the `.git` suffix and a `#semver:` fragment (e.g. `repo.git#semver:^1.0.0`)
  const repo = (m[2] ?? '').replace(/#.*$/, '').replace(/\.git$/, '')
  return `https://github.com/${m[1] ?? ''}/${repo}`
}

/** Detect the download runtime: napi (cross-ABI) or node (bound to a specific ABI). */
export function detectDownloadRuntime(meta: RemoteBinaryMeta): 'napi' | 'node' {
  // 1. explicit config.runtime declaration (keytar: `{ runtime: 'napi', target: 3 }`)
  if (meta.config?.runtime === 'napi') return 'napi'
  // 2. `-r napi` / `--runtime=napi` in the install script (canvas: `prebuild-install -r napi`)
  const inst = meta.install ?? ''
  if (/(?:^|\s)-r\s+napi\b/.test(inst)) return 'napi'
  if (/--runtime[=\s]+napi\b/.test(inst)) return 'napi'
  return 'node'
}

/**
 * Detect the downloader: node-pre-gyp or prebuild-install.
 *
 * Their **template variables and default artifact names differ**, so they must be
 * told apart first:
 *   - node-pre-gyp: default `{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz`,
 *     `{node_abi}` = `node-v{N}` (with prefix), `{libc}` = glibc/musl (never empty),
 *     supports `{napi_build_version}`/`{toolset}`, napi decided by `binary.napi_versions`;
 *   - prebuild-install: default `{name}-v{version}-{runtime}-v{abi}-{platform}{libc}-{arch}.tar.gz`,
 *     `{abi}` = bare number, `{libc}` empty under glibc, napi decided by config.runtime / `-r napi`.
 *
 * Discrimination relies on the command name in the install script (node-pre-gyp is
 * always invoked explicitly from its install script).
 */
export function detectDownloader(meta: RemoteBinaryMeta): 'node-pre-gyp' | 'prebuild-install' {
  const inst = meta.install ?? ''
  // `\bnode-pre-gyp\b` matches both `node-pre-gyp` and `@mapbox/node-pre-gyp`
  if (/\bnode-pre-gyp\b/.test(inst)) return 'node-pre-gyp'
  return 'prebuild-install'
}

/** Take the largest napi build version ≤ the host's N-API version (node-pre-gyp's `get_best_napi_build_version`). */
export function getBestNapiBuildVersion(
  napiVersions: readonly number[] | undefined,
  env: Environment,
): number | null {
  if (!napiVersions || napiVersions.length === 0) return null
  const nodeNapi = env.napiVersion !== undefined ? Number(env.napiVersion) : undefined
  const candidates = napiVersions
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && (nodeNapi === undefined || v <= nodeNapi))
  if (candidates.length === 0) return null
  return Math.max(...candidates)
}

/**
 * Whether the package builds with prebuildify `--napi` (or the alias `--n-api`) —
 * decides if `prebuilds/` artifacts without an ABI marker may be treated as
 * N-API (cross-ABI).
 *
 * Unlike the unreliable "depends on node-addon-api" signal, `--napi` is an
 * explicit fact in the build command: the artifact is necessarily N-API
 * (`--tag-libc` only changes the file name, not the ABI nature — e.g. bcrypt's
 * `bcrypt.glibc.node`).
 */
export function isNapiBuild(meta: RemoteBinaryMeta): boolean {
  const script = `${meta.build ?? ''} ${meta.prebuild ?? ''}`
  return /(?:^|\s)--napi\b/.test(script) || /(?:^|\s)--n-api\b/.test(script)
}

/**
 * Whether binding.gyp declares an N-API build (`NAPI_VERSION` macro / `NODE_API_MODULE`).
 *
 * Complementary to `isNapiBuild` (a `--napi` in the script): `prebuildify --napi`
 * is a script signal, while packages like better-sqlite3 v13 build N-API artifacts
 * directly with node-gyp — no `--napi` in the script, but binding.gyp necessarily
 * contains `defines: ['NAPI_VERSION=10']` (or a `NAPI_VERSION%` variable default).
 * If either hits, flat `prebuilds/` artifacts can be treated as stable across
 * ABIs, converging UNVERIFIED.
 */
export function isNapiBindingGyp(content: string): boolean {
  if (!content) return false
  // `NAPI_VERSION` (defines: ['NAPI_VERSION=10'] / variables: {'NAPI_VERSION%': 8}) and
  // `NODE_API_MODULE` (node-addon-api's N-API registration macro) — either one means
  // the artifact is N-API (cross-ABI).
  return /\bNAPI_VERSION\b/.test(content) || /\bNODE_API_MODULE\b/.test(content)
}

/**
 * Resolve the download ABI version:
 *   - node runtime → the current Node ABI (`env.nodeAbi`);
 *   - napi runtime → `config.target` (a number) if present; otherwise the largest
 *     value in `binary.napi_versions` that is ≤ the host N-API version
 *     (`getBestNapiBuildVersion`). Returns null when it cannot be determined.
 */
export function resolveDownloadAbi(
  meta: RemoteBinaryMeta,
  env: Environment,
  runtime: 'napi' | 'node',
): string | null {
  if (runtime === 'node') return env.nodeAbi ?? null
  const target = meta.config?.target
  if (typeof target === 'number') return String(target)
  if (typeof target === 'string' && /^\d+$/.test(target)) return target
  const best = getBestNapiBuildVersion(meta.binary?.napi_versions, env)
  return best === null ? null : String(best)
}

/** Expand `{var}` templates; unknown variables become empty (matching `expand-template`'s lenient semantics). */
function expandRemoteTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_whole, key: string) => vars[key] ?? '')
}

/**
 * Faithfully replay the remote artifact URL derivation of prebuild-install / node-pre-gyp.
 *
 * The two downloaders use different template variables and default artifact
 * names, so branch on `detectDownloader` first:
 *   - prebuild-install: `binary.host` (+ remote_path + package_name) → GitHub repo fallback;
 *     artifact name `{name}-v{version}-{runtime}-v{abi}-{platform}{libc}-{arch}.tar.gz`.
 *   - node-pre-gyp: `binary.host` is required; default artifact name
 *     `{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz` (`{node_abi}` = `node-v{N}`).
 *
 * When it cannot be determined → return null so the caller degrades to
 * UNVERIFIED; never fall back to guessing "github.com/{name}".
 */
export function deriveRemoteUrlFromMeta(
  name: string,
  version: string,
  env: Environment,
  meta: RemoteBinaryMeta,
): string | null {
  return detectDownloader(meta) === 'node-pre-gyp'
    ? deriveNodePreGypUrl(name, version, env, meta)
    : derivePrebuildInstallUrl(name, version, env, meta)
}

/** prebuild-install URL derivation (default path + binary.host override). */
function derivePrebuildInstallUrl(
  name: string,
  version: string,
  env: Environment,
  meta: RemoteBinaryMeta,
): string | null {
  const runtime = detectDownloadRuntime(meta)
  const abi = resolveDownloadAbi(meta, env, runtime)
  if (abi === null) return null

  const pkgName = name.replace(/^@[a-zA-Z0-9_\-.~]+\//, '')
  const vars: Record<string, string> = {
    name: pkgName,
    package_name: pkgName,
    module_name: meta.binary?.module_name ?? pkgName,
    version,
    major: version.split('.')[0] ?? '',
    minor: version.split('.')[1] ?? '',
    patch: version.split('.')[2] ?? '',
    abi,
    node_abi: env.nodeAbi ?? '',
    runtime,
    platform: env.os,
    arch: env.arch,
    libc: env.os === 'linux' && env.libc === 'musl' ? 'musl' : '',
    configuration: 'Release',
    tag_prefix: 'v',
  }
  const defaultAsset = expandRemoteTemplate(
    '{name}-v{version}-{runtime}-v{abi}-{platform}{libc}-{arch}.tar.gz',
    vars,
  )

  // 1. binary.host explicitly set (common for node-pre-gyp)
  const host = meta.binary?.host
  if (host) {
    const parts = [
      expandRemoteTemplate(host, vars),
      expandRemoteTemplate(meta.binary?.remote_path ?? '', vars),
      expandRemoteTemplate(meta.binary?.package_name ?? defaultAsset, vars),
    ]
      .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
    return parts.join('/')
  }

  // 2. GitHub repo fallback (prebuild-install's default path)
  const github = parseGithubRepo(meta.repository?.url)
  if (!github) return null
  return `${github}/releases/download/v${version}/${defaultAsset}`
}

/**
 * node-pre-gyp URL derivation (replays @mapbox/node-pre-gyp's versioning.js).
 *
 * Key differences versus prebuild-install:
 *   - `binary.host` is **required** (enforced by validate_config); no GitHub repo fallback;
 *   - `{node_abi}` = `node-v{N}` (with prefix), not a bare number;
 *   - `{libc}` is always `glibc`/`musl` (linux) or `unknown` (non-linux), never empty;
 *   - napi comes from `binary.napi_versions` (largest value ≤ the host napi) into `{napi_build_version}`;
 *   - default artifact name `{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz`;
 *   - `{toolset}` is Windows-only (always empty on linux).
 */
export function deriveNodePreGypUrl(
  name: string,
  version: string,
  env: Environment,
  meta: RemoteBinaryMeta,
): string | null {
  const host = meta.binary?.host
  if (!host) return null // node-pre-gyp must declare binary.host, otherwise the URL cannot be derived

  const pkgName = name.replace(/^@[a-zA-Z0-9_\-.~]+\//, '')
  const moduleName = meta.binary?.module_name ?? pkgName
  const napiBuildVersion = getBestNapiBuildVersion(meta.binary?.napi_versions, env)
  const nodeAbi = `node-v${env.nodeAbi ?? '?'}`
  const vars: Record<string, string> = {
    name: pkgName,
    module_name: moduleName,
    version,
    major: version.split('.')[0] ?? '',
    minor: version.split('.')[1] ?? '',
    patch: version.split('.')[2] ?? '',
    node_abi: nodeAbi,
    napi_build_version: napiBuildVersion === null ? '' : String(napiBuildVersion),
    napi_version: napiBuildVersion === null ? '' : String(napiBuildVersion),
    node_napi_label: napiBuildVersion === null ? nodeAbi : `napi-v${napiBuildVersion}`,
    platform: env.os,
    arch: env.arch,
    libc: env.os === 'linux' ? (env.libc ?? 'glibc') : 'unknown',
    toolset: '',
    configuration: 'Release',
    target: '',
  }
  const defaultPackageName = '{module_name}-v{version}-{node_abi}-{platform}-{arch}.tar.gz'
  const packageName = meta.binary?.package_name ?? defaultPackageName
  // Replay the joining semantics of url.resolve(host, remote_path) +
  // url.resolve(hosted_path, package_name):
  //   - host: strip trailing slashes only (must keep the `//` of `https://`, not
  //     collapse it as a duplicate slash);
  //   - remote_path: collapse `//` (produced when `{toolset}` is empty), drop a
  //     leading `./`, strip leading/trailing slashes;
  //   - package_name: strip leading/trailing slashes only.
  const hostClean = host.replace(/\/+$/, '')
  const remoteClean = expandRemoteTemplate(meta.binary?.remote_path ?? '', vars)
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
  const pkgClean = expandRemoteTemplate(packageName, vars).replace(/^\/+|\/+$/g, '')
  return [hostClean, remoteClean, pkgClean].filter(Boolean).join('/')
}

/* ------------------------------------------------------------------ *
 * IO: forensics functions with an injectable fetch.
 * ------------------------------------------------------------------ */

/** Minimal injectable HTTP interface (defaults to global fetch). */
export interface HttpLike {
  (
    input: string,
    init?: { signal?: AbortSignal; method?: string },
  ): Promise<{
    readonly status: number
    readonly ok: boolean
    /** Web stream body; null for HEAD. */
    readonly body: ReadableStream<Uint8Array> | null
    readonly url?: string
    readonly headers?: { get(name: string): string | null }
  }>
}

function defaultFetch(): HttpLike {
  const f = globalThis.fetch.bind(globalThis)
  return (input, init) => f(input, init as RequestInit)
}

/** Lets callers get the default transport (global fetch when nothing is injected). */
export { defaultFetch }

/** Manifest for a single registry version (including `dist.tarball` and the metadata needed to derive URLs). */
export interface RegistryManifest {
  readonly tarballUrl: string
  /** Metadata required to derive the remote artifact URL (`binary`/`config`/`repository`/`install`). */
  readonly meta: RemoteBinaryMeta
  /** Full package.json fields used to classify a single package without a lockfile (target mode). */
  readonly profile: PackageProfile
}

/**
 * The package.json fields needed to classify a single package standalone
 * (no lockfile / dependency graph). This is the `--target` single-package
 * mode's input: enough to build a `LockfilePackage` and run L1 classify.
 */
export interface PackageProfile {
  readonly name: string
  readonly version: string
  /** Regular runtime dependencies (name → semver range). */
  readonly dependencies: Readonly<Record<string, string>>
  /** Genuinely-optional dependencies — the Pattern A platform-sub-package cluster signal. */
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
  /** Has an install / preinstall / postinstall script (the S2 signal). */
  readonly hasInstallScript: boolean
  readonly scripts: Readonly<{
    install?: string
    preinstall?: string
    postinstall?: string
    build?: string
    prebuild?: string
  }>
}

/** Read the manifest for one registry version (including `dist.tarball`). Issues 1 GET per candidate. */
export async function fetchManifest(
  name: string,
  version: string,
  fetchImpl: HttpLike = defaultFetch(),
): Promise<RegistryManifest> {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  const res = await fetchImpl(url, {})
  if (!res.ok) throw new Error(`registry manifest ${name}@${version}: HTTP ${res.status}`)
  const json = (await (res.body ? jsonFromStream(res.body) : null)) as {
    name?: string
    version?: string
    dist?: { tarball?: string }
    binary?: RemoteBinaryMeta['binary']
    config?: RemoteBinaryMeta['config']
    repository?: RemoteBinaryMeta['repository']
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    os?: string[]
    cpu?: string[]
    libc?: string[]
    scripts?: {
      install?: string
      preinstall?: string
      postinstall?: string
      build?: string
      prebuild?: string
    }
  }
  const tarball = json?.dist?.tarball
  if (!tarball) throw new Error(`registry manifest ${name}@${version}: 缺 dist.tarball`)
  const scripts = json?.scripts ?? {}
  const hasInstallScript = Boolean(
    scripts.install?.trim() || scripts.preinstall?.trim() || scripts.postinstall?.trim(),
  )
  return {
    tarballUrl: tarball,
    meta: {
      binary: json?.binary ?? null,
      config: json?.config ?? null,
      repository: json?.repository ?? null,
      install: scripts.install ?? null,
      postinstall: scripts.postinstall ?? null,
      build: scripts.build ?? null,
      prebuild: scripts.prebuild ?? null,
    },
    profile: {
      name: json?.name ?? name,
      version: json?.version ?? version,
      dependencies: json?.dependencies ?? {},
      optionalDependencies: json?.optionalDependencies ?? {},
      os: json?.os,
      cpu: json?.cpu,
      libc: json?.libc,
      hasInstallScript,
      scripts,
    },
  }
}

async function jsonFromStream(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const text = await new Response(body).text()
  return JSON.parse(text)
}

/**
 * Pattern B forensics: stream-scan the tarball's `package/prebuilds/` to decide
 * whether a prebuilt exists for this platform.
 *
 * Uses `tar.Parser` + `onReadEntry`. **`entry.resume()` must be called for every
 * entry**, otherwise the parser stalls on backpressure (this was the root cause of
 * an early implementation hanging). On a platform hit we `abort()` — no need to
 * pull the rest of the package.
 *
 * The result must be tri-state; "didn't finish reading" must never become "not there":
 *   - `matched`: found an artifact for this platform with a definite ABI match
 *     (napi, or abiN == current ABI) → definitely present.
 *   - `absent`: read the **whole package** and still no artifact for this
 *     platform → definitely absent (degrade to a source compile).
 *   - `unknown`: two kinds of indeterminacy — hit the `maxBytes` safety cap before
 *     finishing the package; or finished the package with an artifact for this
 *     platform whose ABI carries no marker (legacy flat / custom naming) → stay unverified.
 *
 * Counter-example: better-sqlite3's prebuilds entries are spread across the whole
 * package (after the source files); cutting early on a byte budget and treating it
 * as "missing" would misjudge a package that does ship a win32 artifact as HIGH —
 * this must not happen.
 */
export type PrebuildScan =
  | { status: 'matched'; observed: readonly string[]; bytes: number; hasBindingGyp: boolean }
  | { status: 'absent'; observed: readonly string[]; bytes: number; hasBindingGyp: boolean }
  | { status: 'unknown'; observed: readonly string[]; bytes: number; hasBindingGyp: boolean }

/**
 * Pattern B forensics: stream-scan the tarball's `package/prebuilds/` to decide
 * whether a prebuilt exists for this platform.
 * @param maxBytes Safety cap (default 64 MB). When reached without seeing this
 *   platform, return `unknown` — never treat it as "missing" and escalate to a
 *   compile, so huge/abnormal packages cannot hang us and cannot produce false HIGH.
 */
export async function probePrebuilds(
  tarballUrl: string,
  env: Environment,
  opts: { maxBytes?: number; fetchImpl?: HttpLike; napiBuild?: boolean } = {},
): Promise<PrebuildScan> {
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024
  const fetchImpl = opts.fetchImpl ?? defaultFetch()
  const napiBuild = opts.napiBuild ?? false
  const ac = new AbortController()

  const res = await fetchImpl(tarballUrl, { signal: ac.signal })
  if (!res.ok || !res.body) {
    throw new Error(`tarball HEAD: HTTP ${res.status}`)
  }

  const observed: string[] = []
  let matched = false
  // Set when the package was fully read without a definite match, but an artifact
  // for this platform exists whose ABI cannot be determined. In that case we can
  // neither assert "no compile needed" (the ABI may mismatch → degrade to compile)
  // nor "must compile" → stay unknown.
  let sawUnknownAbi = false
  // binding.gyp content (if read). Used to identify "N-API built directly by
  // node-gyp" flat prebuilds/ (e.g. better-sqlite3 v13's `defines: ['NAPI_VERSION=10']`)
  // — the file name carries no ABI marker, but the artifact is stable across ABIs,
  // so it can be matched definitively. binding.gyp is a few KB of text; collecting it is negligible.
  let bindingGyp: string | null = null
  const reader = res.body.getReader()
  const parser = new Parser({
    onReadEntry(entry: ReadEntry) {
      const name = entry.path
      if (name === 'package/binding.gyp' && bindingGyp === null) {
        const chunks: Buffer[] = []
        let total = 0
        entry.on('data', (chunk: Buffer) => {
          if (total < BINDING_GYP_MAX_BYTES) {
            chunks.push(chunk)
            total += chunk.length
          }
        })
        entry.on('end', () => {
          bindingGyp = Buffer.concat(chunks).toString('utf8')
        })
        entry.on('error', () => undefined)
        return // the data listener already put this entry into flowing mode; no resume needed
      }
      if (name.startsWith('package/prebuilds/')) {
        const base = name.slice('package/prebuilds/'.length)
        // Record only entries with a non-empty basename; parent-directory entries end with `/` and are excluded naturally
        if (base && !base.endsWith('/')) observed.push(base)
        const target = parsePrebuildEntry(base)
        if (target && prebuildMatchesEnv(target, env)) {
          const abi = abiMatchFor(target, env, napiBuild)
          if (abi === 'match') {
            matched = true
            ac.abort() // stop on hit; no need to pull the rest of the package
          } else if (abi === 'unknown') {
            sawUnknownAbi = true // an artifact for this platform exists but has no ABI marker; not determinable
          }
          // abi === 'no-match': an artifact for this platform but wrong ABI; skip and keep looking
        }
      }
      // Critical: every entry must be drained, otherwise the Parser stalls on backpressure (see the module header).
      entry.resume()
    },
  })
  // After abort, zlib throws "unexpected end of file" — expected, ignore it (does not affect the result).
  parser.on('error', () => undefined)
  // Whether the Parser has consumed all input.
  const parserDone = new Promise<void>((resolve) => {
    parser.on('end', () => resolve())
    parser.on('close', () => resolve())
  })

  // The Parser dispatches entry callbacks asynchronously: you cannot write a chunk
  // and immediately check `matched`. The reliable approach is to pump the input,
  // flush (end) once done, then wait for the Parser to converge before reading the
  // final `matched`.
  let bytes = 0
  let reachedEnd = false
  try {
    for (;;) {
      let chunk: { value?: Uint8Array; done: boolean }
      try {
        chunk = await reader.read()
      } catch {
        // After a platform hit, ac.abort() makes the in-flight read() throw
        // AbortError — expected, just stop.
        if (matched) break
        throw new Error('tarball 流读取中断')
      }
      if (chunk.done) {
        reachedEnd = true
        break
      }
      const value = chunk.value
      if (!value) break
      bytes += value.length
      // tar.Parser.write only accepts Buffer — network streams hand us Uint8Array, so
      // wrap it zero-copy. (Feeding a Uint8Array directly is silently ignored; that
      // was the root cause of early matches never happening.)
      try {
        parser.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      } catch {
        // Corrupt / hostile tar stream: the Parser rejects the input. This is not a
        // match and not a crash — stop pumping and degrade to `unknown` below.
        break
      }
      if (bytes >= maxBytes) break // safety cap: stop pulling and fall back to unknown
    }
    parser.end()
    // Let the asynchronously dispatched entry callbacks finish (a hit sets matched), waiting at most a short while.
    await Promise.race([parserDone, new Promise((r) => setTimeout(r, 1_000))])
  } finally {
    ac.abort()
    // Never hang: release the reader even on early abort, to avoid a dangling connection.
    reader.cancel().catch(() => undefined)
  }

  // `hasBindingGyp`: does the tarball contain binding.gyp (the implicit node-gyp rebuild signal).
  // Used by the allowScripts dimension — from npm 12 on, the implicit rebuild
  // triggered by binding.gyp is blocked too, even for packages without an explicit
  // install script (see npm-policy.ts).
  const hasBindingGyp = bindingGyp !== null
  if (matched) return { status: 'matched', observed, bytes, hasBindingGyp }
  // binding.gyp explicitly N-API (e.g. better-sqlite3 v13's NAPI_VERSION=10) → the
  // flat artifact is stable across ABIs, so it matches definitively even without an
  // ABI marker in the file name (node-gyp's empty-target rebuild is a no-op, no compile).
  const gypNapi = bindingGyp !== null && isNapiBindingGyp(bindingGyp)
  if (reachedEnd && sawUnknownAbi && gypNapi)
    return { status: 'matched', observed, bytes, hasBindingGyp }
  // Finished the package with no definite match, and never saw an artifact for this
  // platform with an unknown ABI → definitely absent.
  if (reachedEnd && !sawUnknownAbi) return { status: 'absent', observed, bytes, hasBindingGyp }
  return { status: 'unknown', observed, bytes, hasBindingGyp }
}

/** Pattern C forensics: a single HEAD. 200→prebuilt, 404→source-build, anything else→unverified. */
export async function probeRemoteHead(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: HttpLike } = {},
): Promise<'prebuilt' | 'source-build' | 'unverified'> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const fetchImpl = opts.fetchImpl ?? defaultFetch()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ac.signal, method: 'HEAD' })
    if (res.status === 200) return 'prebuilt'
    if (res.status === 404) return 'source-build'
    // 429 / 5xx / others → not determinable
    return 'unverified'
  } catch {
    return 'unverified' // timeout / network error → never assert
  } finally {
    clearTimeout(timer)
  }
}
