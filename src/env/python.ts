/**
 * Python detection.
 *
 * node-gyp needs Python — but npm reports C++ compile errors while the root
 * cause is often a missing Python. This is one of the scenarios where
 * NativeCheck helps the most.
 *
 * It only reports "present + version + path", and never installs anything.
 */

import { execFileSync } from 'node:child_process'

function tryCommand(command: string, args: readonly string[]): string | undefined {
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

/** `Python 3.12.4` → `3.12.4` */
function parseVersion(output: string | undefined): string | undefined {
  if (!output) return undefined
  const match = /Python\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output)
  return match?.[1]
}

function which(command: string): string | undefined {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    })
      .split(/\r?\n/)[0]
      ?.trim()
  } catch {
    return undefined
  }
}

export interface PythonInfo {
  readonly version?: string
  readonly path?: string
}

/**
 * Probe in priority order: `python3` → `python` → Windows' `py -3`.
 * Returning `undefined` means "not found" — that is an explicit blocker, not "unknown".
 */
export function detectPython(): PythonInfo | undefined {
  const candidates: ReadonlyArray<readonly string[]> = [
    ['python3', '--version'],
    ['python', '--version'],
    ...(process.platform === 'win32' ? ([['py', '-3', '--version']] as const) : []),
  ]

  for (const entry of candidates) {
    // Under `noUncheckedIndexedAccess` destructuring may yield undefined, so narrow first.
    const command = entry[0]
    if (!command) continue
    const args = entry.slice(1)
    const output = tryCommand(command, args)
    if (!output) continue
    const version = parseVersion(output)
    if (version) return { version, path: which(command) }
  }
  return undefined
}
