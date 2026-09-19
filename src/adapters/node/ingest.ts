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
      reason: 'bun 文本 lockfile 结构不同，需单独适配（当前仅支持二进制 bun.lockb）',
    }
  }
  const version = lockfileVersion(projectRoot)
  if (version === undefined) {
    return { supported: false, detected: 'unknown', reason: '未找到可解析的 package-lock.json' }
  }
  if (version === 1) {
    return {
      supported: false,
      detected: `package-lock.json v1`,
      version,
      reason: 'lockfile v1 结构不同，需单独适配',
    }
  }
  return { supported: true, detected: 'npm (package-lock.json)', version }
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
      reason: probe.reason ?? '不支持的 lockfile 格式',
    }
  }

  // pnpm：无 arborist，直接解析 pnpm-lock.yaml（packages + snapshots）。
  if (probe.detected === 'pnpm-lock.yaml') {
    try {
      const content = readFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')
      const list = parsePnpmLockfile(content)
      if (list.length === 0) {
        return { ok: false, detected: 'pnpm-lock.yaml', reason: 'pnpm-lock.yaml 解析失败或为空' }
      }
      return { ok: true, graph: indexPackages(list), format: 'pnpm (pnpm-lock.yaml)' }
    } catch (error) {
      return {
        ok: false,
        detected: 'pnpm-lock.yaml',
        reason: `pnpm-lock.yaml 解析失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // yarn.lock（v1 classic + Berry）：行式缩进格式，非 YAML/JSON。
  if (probe.detected === 'yarn.lock') {
    try {
      const content = readFileSync(join(projectRoot, 'yarn.lock'), 'utf8')
      const list = parseYarnLockfile(content)
      if (list.length === 0) {
        return { ok: false, detected: 'yarn.lock', reason: 'yarn.lock 解析失败或为空' }
      }
      return { ok: true, graph: indexPackages(list), format: 'yarn (yarn.lock)' }
    } catch (error) {
      return {
        ok: false,
        detected: 'yarn.lock',
        reason: `yarn.lock 解析失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // bun.lockb：二进制，经 @hyrious/bun.lockb 解码为 yarn v1 文本再解析。
  if (probe.detected === 'bun.lockb') {
    try {
      const buf = readFileSync(join(projectRoot, 'bun.lockb'))
      const list = parseBunLockfile(buf)
      if (list.length === 0) {
        return { ok: false, detected: 'bun.lockb', reason: 'bun.lockb 解析失败或为空' }
      }
      return { ok: true, graph: indexPackages(list), format: 'bun (bun.lockb)' }
    } catch (error) {
      return {
        ok: false,
        detected: 'bun.lockb',
        reason: `bun.lockb 解析失败：${error instanceof Error ? error.message : String(error)}`,
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
      reason: `lockfile 解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const list: LockfilePackage[] = []
  const seen = new Set<string>()
  const visit = (node: Node, isRoot: boolean): void => {
    if (!node.name) return
    const key = `${node.name}@${node.version ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    const record = fromArboristNode(node)
    if (record) list.push({ ...record, ...(isRoot ? { isRoot: true } : {}) })
    for (const [, edge] of node.edgesOut ?? new Map()) {
      if (edge.to) visit(edge.to, false)
    }
  }
  visit(tree, true)

  return { ok: true, graph: indexPackages(list), format: probe.detected }
}
