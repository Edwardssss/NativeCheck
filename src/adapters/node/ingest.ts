/**
 * Layer 0 — Ingest (purely local, <50 ms, zero network).
 *
 * Design doc §10.1. Uses npm's official `@npmcli/arborist` to read the virtual
 * dependency tree from the lockfile (`loadVirtual` — does not depend on
 * node_modules and makes no network calls), normalizes it into
 * `LockfilePackage[]`, and hands it to Layer 1 for classification.
 *
 * Read-only over the lockfile. On truly unsupported formats (yarn/lockfile v1
 * and bun text `bun.lock` stay as they were) it explicitly returns
 * `unsupported` — **exit rather than guess** (Fail Closed). Supported adapters:
 * npm package-lock.json (arborist), pnpm-lock.yaml, yarn.lock (v1 + Berry) and
 * binary bun.lockb — each normalized into the same `LockfilePackage[]` shape.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Arborist, type Node } from '@npmcli/arborist'
import type { IngestedGraph, LockfilePackage } from './signals'
import { indexPackages } from './signals'
import { parsePnpmLockfile } from './pnpm'
import { parseYarnLockfile } from './yarn'
import { parseBunLockfile } from './bun'

export interface IngestResult {
  readonly ok: true
  readonly graph: IngestedGraph
  readonly format: string
}
export interface IngestUnsupported {
  readonly ok: false
  readonly detected: string
  readonly reason: string
}
export type IngestOutcome = IngestResult | IngestUnsupported

/** Read the lockfileVersion of package-lock.json. Returns 1/2/3 or undefined. */
function lockfileVersion(projectRoot: string): number | undefined {
  const file = join(projectRoot, 'package-lock.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { lockfileVersion?: number }
    return parsed.lockfileVersion
  } catch {
    return undefined
  }
}

/**
 * Lockfile formats ingest can read, in probe priority order. Reported verbatim
 * when a project is unsupported, so the message cannot drift from reality (it
 * used to hard-code npm even when pnpm / yarn / bun was the thing that failed).
 */
export const SUPPORTED_LOCKFILES: readonly string[] = [
  'package-lock.json (lockfileVersion 2 / 3)',
  'pnpm-lock.yaml (packages + snapshots)',
  'yarn.lock (v1 classic / Berry)',
  'bun.lockb (binary)',
]

/**
 * Probe whether the project root is supported.
 *
 * Supported: npm package-lock.json (lockfileVersion 2 / 3), pnpm-lock.yaml,
 * yarn.lock (v1 + Berry), binary bun.lockb. Detection is by lockfile presence;
 * the adapters that read them decide whether the content is well-formed.
 * Unsupported: lockfileVersion 1 (different schema) and bun's text `bun.lock`.
 * When no lockfile is found we also return an explicit `detected` so the
 * caller can exit.
 */
export function probeLockfile(projectRoot: string): {
  supported: boolean
  detected: string
  version?: number
  reason?: string
} {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) {
    return { supported: true, detected: 'pnpm-lock.yaml' }
  }
  if (existsSync(join(projectRoot, 'yarn.lock'))) {
    return { supported: true, detected: 'yarn.lock' }
  }
  if (existsSync(join(projectRoot, 'bun.lockb'))) {
    return { supported: true, detected: 'bun.lockb' }
  }
  // Bun 1.2+ writes a JSONC **text** lockfile by default. It is a different
  // format (not the binary blob), so say so explicitly instead of falling
  // through to "no parseable package-lock.json found", which reads like a bug.
  if (existsSync(join(projectRoot, 'bun.lock'))) {
    return {
      supported: false,
      detected: 'bun.lock (text)',
      reason:
        'the text bun.lock has a different structure and needs its own adapter (only the binary bun.lockb is supported today)',
    }
  }
  const version = lockfileVersion(projectRoot)
  if (version === undefined) {
    return { supported: false, detected: 'unknown', reason: 'no parseable package-lock.json found' }
  }
  if (version === 1) {
    return {
      supported: false,
      detected: `package-lock.json v1`,
      version,
      reason: 'lockfile v1 has a different structure and needs its own adapter',
    }
  }
  return { supported: true, detected: 'npm (package-lock.json)', version }
}

/** Max chains kept per package: enough to show the real entry points, not every path. */
const MAX_PATHS_PER_PACKAGE = 3
/** Depth cap — dependency trees are shallow, but hostile/huge lockfiles are not. */
const MAX_PATH_DEPTH = 12

/** Append a chain for a package, de-duplicating and capping the list. */
function recordChain(chains: Map<string, string[][]>, key: string, path: readonly string[]): void {
  const existing = chains.get(key)
  if (!existing) {
    chains.set(key, [[...path]])
    return
  }
  if (existing.length >= MAX_PATHS_PER_PACKAGE) return
  if (
    existing.some((chain) => chain.length === path.length && chain.every((n, i) => n === path[i]))
  )
    return
  existing.push([...path])
}

/**
 * Whether npm would treat this node as an *optional* dependency: every incoming
 * edge is declared in the parent's `optionalDependencies`.
 *
 * Deliberately NOT `node.optional`: arborist also sets that flag for
 * platform-mismatched nodes (a required `fsevents` on linux turns "optional" in
 * the virtual tree), which conflates "the author declared it optional" with
 * "npm will skip it on this machine". The two produce opposite verdicts — skip
 * vs `EBADPLATFORM` — so the declaration is the field to read.
 *
 * `undefined` when the node has no incoming edge (the root): "unknown", not
 * "optional".
 */
function declaredOptionalOnly(node: Node): boolean | undefined {
  const edgesIn = node.edgesIn
  if (!edgesIn || edgesIn.size === 0) return undefined
  let every = true
  for (const edge of edgesIn) {
    const declared = edge.from?.package?.optionalDependencies
    if (!declared || !Object.hasOwn(declared, edge.name ?? '')) every = false
  }
  return every
}

/**
 * Extract one lockfile package record from an arborist node.
 *
 * Two fields must be read off `node.package` rather than off the node itself:
 *
 * 1. **Platform constraints (S1).** arborist's `Node` has no `os` / `cpu` /
 *    `libc` getters — only `package` — so `node.os` was always `undefined` and
 *    the whole S1 signal (plus the `raw` fields in `--json`) was silently empty.
 * 2. **Genuinely optional dependencies (S5).** `edge.optional` is arborist's
 *    `type === 'optional' || type === 'peerOptional'`, i.e. an *optional peer*
 *    (`peerDependenciesMeta[x].optional`) counts too. That made ordinary
 *    tooling packages look like a platform-sub-package cluster: vite@8
 *    declares one optionalDependency (fsevents) but 13 optional edges
 *    (less / sass / terser / tsx / …), so it was classified as Pattern A and
 *    reported as `PREBUILT` / `LOW`. Membership in the package's own
 *    `optionalDependencies` is the signal S5 actually wants.
 */
function fromArboristNode(node: Node): LockfilePackage | null {
  if (!node.name) return null
  const pkg = node.package ?? {}
  const optionalNames = new Set(Object.keys(pkg.optionalDependencies ?? {}))
  const edges = node.edgesOut ?? new Map()
  const dependencies: Record<string, { name: string; optional?: boolean }> = {}
  for (const [, edge] of edges) {
    const name = edge.name || edge.to?.name
    if (!name) continue
    // Dev/peer edges are kept as edges (build-tool detection wants them) but
    // they are NOT optional: the cluster criterion must only count the
    // package's own optionalDependencies (see the node doc above).
    // The target's platform constraints ride along so Layer 3 can answer
    // "is there a sub-package for *my* platform" without a second graph walk.
    const target = edge.to?.package
    dependencies[name] = {
      name,
      optional: optionalNames.has(name),
      ...(target?.os ? { os: target.os } : {}),
      ...(target?.cpu ? { cpu: target.cpu } : {}),
      ...(target?.libc ? { libc: target.libc } : {}),
    }
  }
  return {
    name: node.name,
    version: node.version ?? 'unknown',
    dev: node.dev || node.devOptional,
    optional: declaredOptionalOnly(node),
    os: pkg.os,
    cpu: pkg.cpu,
    libc: pkg.libc,
    hasInstallScript: node.hasInstallScript,
    dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
    pathChains: [[node.name]],
  }
}

/**
 * Resolve the lockfile from a project root.
 * `arborist.loadVirtual` throws when the lockfile is missing or corrupt; all
 * such errors are converted into IngestUnsupported.
 */
export async function ingest(projectRoot: string): Promise<IngestOutcome> {
  const probe = probeLockfile(projectRoot)
  if (!probe.supported) {
    return {
      ok: false,
      detected: probe.detected,
      reason: probe.reason ?? 'unsupported lockfile format',
    }
  }

  // pnpm：无 arborist，直接解析 pnpm-lock.yaml（packages + snapshots）。
  if (probe.detected === 'pnpm-lock.yaml') {
    try {
      const content = readFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')
      const list = parsePnpmLockfile(content)
      if (list.length === 0) {
        return {
          ok: false,
          detected: 'pnpm-lock.yaml',
          reason: 'pnpm-lock.yaml could not be parsed, or is empty',
        }
      }
      return { ok: true, graph: indexPackages(list), format: 'pnpm (pnpm-lock.yaml)' }
    } catch (error) {
      return {
        ok: false,
        detected: 'pnpm-lock.yaml',
        reason: `pnpm-lock.yaml parse failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // yarn.lock（v1 classic + Berry）：行式缩进格式，非 YAML/JSON。
  if (probe.detected === 'yarn.lock') {
    try {
      const content = readFileSync(join(projectRoot, 'yarn.lock'), 'utf8')
      const list = parseYarnLockfile(content)
      if (list.length === 0) {
        return {
          ok: false,
          detected: 'yarn.lock',
          reason: 'yarn.lock could not be parsed, or is empty',
        }
      }
      return { ok: true, graph: indexPackages(list), format: 'yarn (yarn.lock)' }
    } catch (error) {
      return {
        ok: false,
        detected: 'yarn.lock',
        reason: `yarn.lock parse failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // bun.lockb：二进制，经 @hyrious/bun.lockb 解码为 yarn v1 文本再解析。
  if (probe.detected === 'bun.lockb') {
    try {
      const buf = readFileSync(join(projectRoot, 'bun.lockb'))
      const list = parseBunLockfile(buf)
      if (list.length === 0) {
        return {
          ok: false,
          detected: 'bun.lockb',
          reason: 'bun.lockb could not be parsed, or is empty',
        }
      }
      return { ok: true, graph: indexPackages(list), format: 'bun (bun.lockb)' }
    } catch (error) {
      return {
        ok: false,
        detected: 'bun.lockb',
        reason: `bun.lockb parse failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const arb = new Arborist({ path: projectRoot })
  let tree: Node
  try {
    tree = await arb.loadVirtual()
  } catch (error) {
    return {
      ok: false,
      detected: probe.detected,
      reason: `lockfile parse failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const records = new Map<string, { record: LockfilePackage; isRoot: boolean }>()
  // Real root → target chains, keyed by `name@version`. The normalized record
  // used to carry `[[own name]]`, which made the report's "Dependency path" block
  // echo the package name instead of answering "who brought native in".
  const chains = new Map<string, string[][]>()
  /**
   * Depth-first walk from the tree root, carrying the ancestor chain.
   *
   * A node reached twice keeps the first chain for its own expansion and just
   * records the additional path (dependency chains grow combinatorially; keeping
   * every path to every node would blow up on large lockfiles). Re-entering a
   * name already on the current chain is a cycle — stop, don't recurse.
   */
  const visit = (
    node: Node,
    isRoot: boolean,
    chain: readonly string[],
    visitedKeys: readonly string[],
  ): void => {
    if (!node.name) return
    const key = `${node.name}@${node.version ?? ''}`
    const path = [...chain, node.name]
    const pathKeys = [...visitedKeys, key]
    const record = records.get(key)
    if (record) {
      recordChain(chains, key, path)
      return
    }
    chains.set(key, [path])
    const parsed = fromArboristNode(node)
    if (parsed) records.set(key, { record: parsed, isRoot })
    if (path.length >= MAX_PATH_DEPTH) return
    for (const [, edge] of node.edgesOut ?? new Map()) {
      const child = edge.to
      if (!child?.name) continue
      // Cycle guard on `name@version`, NOT on the bare name: the root node is
      // named after the project folder (arborist uses @npmcli/name-from-folder),
      // so a name-based guard silently drops every dependency that shares the
      // project's name — e.g. a fixture directory called `zlib-sync`.
      const childKey = `${child.name}@${child.version ?? ''}`
      if (pathKeys.includes(childKey)) continue
      visit(child, false, path, pathKeys)
    }
  }
  visit(tree, true, [], [])

  const list: LockfilePackage[] = [...records].map(([key, entry]) => ({
    ...entry.record,
    pathChains: chains.get(key) ?? [[entry.record.name]],
    ...(entry.isRoot ? { isRoot: true } : {}),
  }))

  return { ok: true, graph: indexPackages(list), format: probe.detected }
}
