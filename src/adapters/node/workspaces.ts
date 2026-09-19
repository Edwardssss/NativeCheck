/**
 * Workspace / monorepo attribution (Layer 0 signal enrichment).
 *
 * A monorepo lockfile is a single flat graph, but its *ownership* is not flat:
 * `sharp` sitting in the root `node_modules` may have been declared by
 * `apps/api`, not by the root package. Without that fact a finding says "your
 * project depends on sharp", which in a 40-package workspace is a sentence the
 * reader cannot act on.
 *
 * Three facts this module establishes, all offline:
 *
 * 1. **Who declares what.** Each member's `dependencies` / `devDependencies` /
 *    `optionalDependencies` / `peerDependencies` names are collected, so a
 *    package can be attributed to the members that asked for it.
 * 2. **Which nodes are members.** A workspace package is *your* source, not a
 *    third-party download. Its own `install` script is a build step you wrote,
 *    so Layer 1 must not report it as a supply-chain candidate (the toolchain
 *    requirement still shows up when you scan that member directly).
 * 3. **Which lockfile format declares members how.** npm symlinks members into
 *    `node_modules` (arborist exposes them as link nodes), pnpm and yarn write
 *    `link:` / `workspace:` specifiers that the parsers deliberately drop.
 *
 * Deliberately conservative: glob expansion covers literal directories and a
 * single `*` segment (`packages/*`, `apps/*`), which is what the ecosystem
 * overwhelmingly writes. Anything more exotic is ignored rather than guessed —
 * we would rather under-attribute than claim an ownership that is wrong.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import { load as parseYaml } from 'js-yaml'

/** Filesystem seam so workspace discovery is unit-testable without a real tree. */
export interface WorkspaceFs {
  readFile(path: string): string
  exists(path: string): boolean
  /** Immediate sub-directories of `path`, as bare names. */
  listDirs(path: string): readonly string[]
}

export const defaultWorkspaceFs: WorkspaceFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  exists: (path) => existsSync(path),
  listDirs: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  },
}

/** A discovered workspace member. */
export interface WorkspaceMember {
  /** The member's `package.json` name. */
  readonly name: string
  /** Directory relative to the project root, POSIX separators (`apps/api`). */
  readonly dir: string
  /** Every dependency name the member declares (all four dependency fields). */
  readonly declared: readonly string[]
}

/**
 * Attribution table for one project root.
 *
 * `members` is empty for an ordinary single-package project, and every consumer
 * is written so that an empty table changes nothing: no attribution, no
 * exclusions.
 */
export interface WorkspaceMap {
  /** Sorted by `dir` so the table is deterministic across runs. */
  readonly members: readonly WorkspaceMember[]
  /** Dependency name → member names that declare it (sorted, unique). */
  readonly declaredBy: Readonly<Record<string, readonly string[]>>
  /** Member package name → member, for recognising member nodes in the graph. */
  readonly byName: Readonly<Record<string, WorkspaceMember>>
  /** The globs as written in the manifests, for evidence text. */
  readonly globs: readonly string[]
}

export const EMPTY_WORKSPACE_MAP: WorkspaceMap = {
  members: [],
  declaredBy: {},
  byName: {},
  globs: [],
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

/**
 * Glob patterns from `package.json` (`workspaces`) and `pnpm-workspace.yaml`
 * (`packages`). Ordering is preserved; negations are kept verbatim so the
 * expander can apply them in order.
 */
export function readWorkspaceGlobs(
  rootPkg: unknown,
  pnpmWorkspaceYaml?: string,
): readonly string[] {
  const globs: string[] = []
  const manifest = rootPkg as { workspaces?: unknown } | undefined
  const declared = manifest?.workspaces
  // npm accepts both `"workspaces": ["a/*"]` and the yarn-style object form.
  if (Array.isArray(declared)) {
    globs.push(...declared.filter((g): g is string => typeof g === 'string'))
  } else if (declared && typeof declared === 'object') {
    const nested = (declared as { packages?: unknown }).packages
    if (Array.isArray(nested)) {
      globs.push(...nested.filter((g): g is string => typeof g === 'string'))
    }
  }
  if (pnpmWorkspaceYaml) {
    try {
      const parsed = parseYaml(pnpmWorkspaceYaml) as { packages?: unknown } | undefined
      if (Array.isArray(parsed?.packages)) {
        globs.push(...parsed.packages.filter((g): g is string => typeof g === 'string'))
      }
    } catch {
      // A malformed pnpm-workspace.yaml must not take ingest down.
    }
  }
  return globs
}

/** POSIX-normalize a path that came from the local filesystem. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join(posix.sep)
}

/**
 * Expand workspace globs to member directories.
 *
 * Supported: `packages/*`, `apps/*`, literal `tooling/release`, and negations
 * (`!packages/experimental`). Multi-level globs (`**`) are treated as
 * single-level; we do not recurse arbitrarily deep, because a wrong guess here
 * silently mis-attributes findings.
 */
export function expandWorkspaceGlobs(
  projectRoot: string,
  globs: readonly string[],
  fs: WorkspaceFs = defaultWorkspaceFs,
): readonly string[] {
  const found = new Set<string>()
  const negated = new Set<string>()
  for (const raw of globs) {
    const isNegation = raw.startsWith('!')
    const pattern = toPosix(isNegation ? raw.slice(1) : raw).replace(/\/+$/, '')
    if (!pattern) continue
    const targets = new Set<string>()

    const starIndex = pattern.indexOf('*')
    if (starIndex === -1) {
      targets.add(pattern)
    } else {
      const prefix = pattern.slice(0, starIndex).replace(/\/+$/, '')
      const suffix = pattern.slice(starIndex).replace(/^\*+/, '').replace(/^\/+/, '')
      const base = prefix ? join(projectRoot, prefix) : projectRoot
      for (const dir of fs.listDirs(base)) {
        if (dir.startsWith('.')) continue
        const candidate = suffix
          ? `${prefix ? `${prefix}/` : ''}${dir}/${suffix}`
          : `${prefix ? `${prefix}/` : ''}${dir}`
        if (fs.exists(join(projectRoot, candidate))) targets.add(candidate)
      }
    }
    for (const target of targets) {
      if (isNegation) negated.add(target)
      else found.add(target)
    }
  }
  for (const excluded of negated) found.delete(excluded)
  return [...found].sort()
}

/** Read one workspace member directory. Returns null when it is not a package. */
function readMember(projectRoot: string, dir: string, fs: WorkspaceFs): WorkspaceMember | null {
  const manifestPath = join(projectRoot, dir, 'package.json')
  if (!fs.exists(manifestPath)) return null
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(fs.readFile(manifestPath)) as Record<string, unknown>
  } catch {
    return null
  }
  const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : dir
  const declared = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const block = pkg[field]
    if (block && typeof block === 'object') {
      for (const dep of Object.keys(block)) declared.add(dep)
    }
  }
  return { name, dir: toPosix(dir), declared: [...declared].sort() }
}

/**
 * Discover workspace members and build the attribution table.
 *
 * Never throws: a broken member manifest is skipped, because attribution is an
 * enrichment — losing it must degrade the report, not the scan.
 */
export function discoverWorkspaces(
  projectRoot: string,
  fs: WorkspaceFs = defaultWorkspaceFs,
): WorkspaceMap {
  const rootManifestPath = join(projectRoot, 'package.json')
  let rootPkg: unknown
  if (fs.exists(rootManifestPath)) {
    try {
      rootPkg = JSON.parse(fs.readFile(rootManifestPath))
    } catch {
      rootPkg = undefined
    }
  }
  const pnpmWorkspacePath = join(projectRoot, 'pnpm-workspace.yaml')
  const globs = readWorkspaceGlobs(
    rootPkg,
    fs.exists(pnpmWorkspacePath) ? fs.readFile(pnpmWorkspacePath) : undefined,
  )
  if (globs.length === 0) return EMPTY_WORKSPACE_MAP

  const members: WorkspaceMember[] = []
  const seenDirs = new Set<string>()
  for (const dir of expandWorkspaceGlobs(projectRoot, globs, fs)) {
    if (seenDirs.has(dir)) continue
    seenDirs.add(dir)
    const member = readMember(projectRoot, dir, fs)
    if (member) members.push(member)
  }
  if (members.length === 0) return { ...EMPTY_WORKSPACE_MAP, globs }

  members.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))

  const byName: Record<string, WorkspaceMember> = {}
  const declaredBy: Record<string, string[]> = {}
  for (const member of members) {
    // First member wins on duplicate names (npm forbids them anyway; a
    // duplicate here means a symlinked/aliased dir we should not double count).
    if (!Object.hasOwn(byName, member.name)) byName[member.name] = member
    for (const dep of member.declared) {
      const list = declaredBy[dep] ?? []
      if (!list.includes(member.name)) list.push(member.name)
      declaredBy[dep] = list
    }
  }
  for (const list of Object.values(declaredBy)) list.sort()

  return { members, declaredBy, byName, globs }
}

/**
 * Workspace attribution for one dependency name.
 *
 * Returns the declaring members (sorted). A name declared by the root package
 * is intentionally *not* attributed: "declared by the root" is the implicit
 * default, and printing it on every finding would be noise. `undefined` means
 * "no member declaration found", which is not the same as "not a dependency".
 */
export function workspacesDeclaring(
  map: WorkspaceMap,
  dependencyName: string,
): readonly string[] | undefined {
  const declared = map.declaredBy[dependencyName]
  return declared && declared.length > 0 ? declared : undefined
}
