/**
 * Layer 0 — Ingest (purely local, <50 ms, zero network).
 *
 * Design doc §10.1. Uses npm's official `@npmcli/arborist` to read the virtual
 * dependency tree from the lockfile (`loadVirtual` — does not depend on
 * node_modules and makes no network calls), normalizes it into
 * `LockfilePackage[]`, and hands it to Layer 1 for classification.
 *
 * Read-only over the lockfile. On unsupported formats (pnpm / yarn / bun /
 * lockfile v1) it explicitly returns `unsupported` — **exit rather than guess**
 * (Fail Closed).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Arborist, type Node } from '@npmcli/arborist'
import type { IngestedGraph, LockfilePackage } from './signals'
import { indexPackages } from './signals'
import { parsePnpmLockfile } from './pnpm'

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

/** Lockfile name → whether supported. */
const LOCKFILES: readonly { file: string; label: string }[] = [
  { file: 'package-lock.json', label: 'npm (package-lock.json)' },
  { file: 'pnpm-lock.yaml', label: 'pnpm (pnpm-lock.yaml)' },
]

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
 * Probe whether the project root is supported.
 *
 * Supported: npm package-lock.json with lockfileVersion 2 / 3 (v2 is a superset of v3).
 * Unsupported: pnpm-lock.yaml / yarn.lock / bun.lockb / lockfileVersion 1.
 * When no npm lockfile is found we also return an explicit `detected` so the
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
    return { supported: false, detected: 'yarn.lock', reason: 'yarn 不在 V0.1 支持范围' }
  }
  if (existsSync(join(projectRoot, 'bun.lockb'))) {
    return { supported: false, detected: 'bun.lockb', reason: 'bun 不在 V0.1 支持范围' }
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
  return { supported: true, detected: LOCKFILES[0]?.label ?? 'npm', version }
}

/** Extract one lockfile package record from an arborist node. */
function fromArboristNode(node: Node): LockfilePackage | null {
  if (!node.name) return null
  const edges = node.edgesOut ?? new Map()
  const dependencies: Record<string, { name: string; optional?: boolean }> = {}
  for (const [, edge] of edges) {
    const name = edge.name || edge.to?.name
    if (!name) continue
    // `optional` comes only from edge.optional: dev/peer edges do not count,
    // otherwise the project root's ordinary devDeps look like a platform
    // sub-package cluster (see the cluster criterion in classify).
    dependencies[name] = {
      name,
      optional: Boolean(edge.optional),
    }
  }
  return {
    name: node.name,
    version: node.version ?? 'unknown',
    dev: node.dev || node.devOptional,
    optional: node.optional || node.peer,
    os: (node as unknown as { os?: string[] }).os,
    cpu: (node as unknown as { cpu?: string[] }).cpu,
    libc: (node as unknown as { libc?: string[] }).libc,
    hasInstallScript: (node as unknown as { hasInstallScript?: boolean }).hasInstallScript,
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
