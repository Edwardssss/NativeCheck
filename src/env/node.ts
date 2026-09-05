/**
 * Node / npm version and ABI detection.
 *
 * **Do not maintain the Node ABI table ourselves** — use the `node-abi` library,
 * which is the authoritative data source. `FALLBACK_ABI` only kicks in when
 * `node-abi` does not recognize a version.
 */

import { execFileSync } from 'node:child_process'
import { getAbi } from 'node-abi'
import { FALLBACK_ABI } from '../adapters/node/rules'

export interface NodeRuntimeInfo {
  readonly version: string
  readonly abi?: string
  /** Node's N-API version (`process.versions.napi`). */
  readonly napi?: string
  readonly npmVersion?: string
}

function run(command: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    }).trim()
  } catch {
    return undefined
  }
}

/** Node version → ABI. `node-abi` throws on future versions, so fall back to the table. */
export function resolveAbi(version: string): string | undefined {
  const normalized = version.replace(/^v/, '')
  try {
    const abi = getAbi(normalized, 'node')
    if (abi) return abi
  } catch {
    // fall through to the fallback table
  }
  const major = normalized.split('.')[0]
  return major ? FALLBACK_ABI[major] : undefined
}

export function detectNodeRuntime(): NodeRuntimeInfo {
  const version = process.version.replace(/^v/, '')
  const napi = (process.versions as Record<string, string | undefined>).napi
  return {
    version,
    abi: resolveAbi(version),
    napi,
    npmVersion: run('npm', ['--version']),
  }
}
