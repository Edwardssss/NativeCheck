/**
 * Compiler detection and real compile probes.
 *
 * "Command exists" ≠ "can actually compile". Having `cc` on PATH while the SDK
 * headers are missing, or not having run vcvarsall on Windows, makes `node-gyp`
 * fail at the compile stage. So besides `which`, we really compile an
 * `int main() { return 0; }`.
 *
 * **But the probe can only verify "the compiler runs", not "this package will
 * build"** — the latter requires actually building it, which is out of scope for
 * this tool (design doc §19.3).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompilerInfo, Sdk } from '../core/model'

const PROBE_SOURCE = 'int main() { return 0; }\n'

interface Candidate {
  readonly command: string
  readonly kind: 'gcc-like' | 'msvc'
}

function run(command: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      windowsHide: true,
    }).trim()
  } catch {
    return undefined
  }
}

/**
 * Resolve a command to its absolute path (`where` on Windows, `command -v`
 * elsewhere). The path is what tells two installed compilers apart — "the
 * command exists" is not something a user can act on.
 */
function locate(command: string): string | undefined {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'command'
    const args = process.platform === 'win32' ? [command] : ['-v', command]
    const out = execFileSync(probe, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    })
    return out.split(/\r?\n/)[0]?.trim() || undefined
  } catch {
    return undefined
  }
}

/** Candidate compilers per platform; the order is the priority order. */
export function compilerCandidates(platform = process.platform): readonly Candidate[] {
  if (platform === 'win32') {
    return [
      { command: 'cl.exe', kind: 'msvc' },
      { command: 'clang', kind: 'gcc-like' },
      { command: 'gcc', kind: 'gcc-like' },
    ]
  }
  if (platform === 'darwin') {
    return [
      { command: 'clang', kind: 'gcc-like' },
      { command: 'gcc', kind: 'gcc-like' },
      { command: 'cc', kind: 'gcc-like' },
    ]
  }
  return [
    { command: 'cc', kind: 'gcc-like' },
    { command: 'gcc', kind: 'gcc-like' },
    { command: 'clang', kind: 'gcc-like' },
  ]
}

function parseVersion(output: string | undefined): string | undefined {
  if (!output) return undefined
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(output)
  return match?.[1]
}

/** Really compile once. Any successful invocation proves "the compiler runs". */
function compileProbe(command: string, kind: Candidate['kind'], lang: 'c' | 'cxx'): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'nativecheck-probe-'))
  const ext = lang === 'c' ? 'c' : 'cpp'
  const source = join(dir, `probe.${ext}`)
  const output = join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe.out')

  try {
    writeFileSync(source, PROBE_SOURCE, 'utf8')
    const args =
      kind === 'msvc'
        ? ['/nologo', `/Fe:${output}`, source]
        : [source, '-o', output, ...(lang === 'cxx' ? ['-x', 'c++'] : [])]
    execFileSync(command, args, {
      stdio: 'ignore',
      timeout: 30_000,
      windowsHide: true,
      cwd: dir,
    })
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Failing to clean the temp dir is harmless; the OS reclaims it
    }
  }
}

export function detectCompiler(): CompilerInfo | undefined {
  for (const candidate of compilerCandidates()) {
    const path = locate(candidate.command)
    if (!path) continue

    const version = parseVersion(
      candidate.kind === 'msvc' ? undefined : run(candidate.command, ['--version']),
    )

    return {
      name: candidate.command,
      ...(version ? { version } : {}),
      path,
      // One command covers both C and C++: clang/gcc switch with -x, MSVC switches by extension
      cProbe: compileProbe(candidate.command, candidate.kind, 'c'),
      cxxProbe: compileProbe(candidate.command, candidate.kind, 'cxx'),
    }
  }
  return undefined
}

/**
 * SDK / heavyweight toolchain detection.
 *
 * Covers only the two most common blocker sources: Xcode Command Line Tools on
 * macOS and the MSVC build tools on Windows. System libraries (libcairo etc.) are
 * out of scope — see design doc §19.2: package names differ per distribution, so
 * static enumeration is unrealistic.
 */
export function detectSdks(platform = process.platform): readonly Sdk[] {
  const sdks: Sdk[] = []

  if (platform === 'darwin') {
    const path = run('xcode-select', ['-p'])
    if (path) {
      const version = parseVersion(run('xcode-select', ['--version']))
      sdks.push({
        name: 'Xcode Command Line Tools',
        ...(version ? { version } : {}),
        path,
      })
    }
  }

  if (platform === 'win32') {
    // MSVC is already covered as the compiler by detectCompiler; record the build toolchain here too
    if (locate('cl.exe')) {
      sdks.push({ name: 'MSVC Build Tools' })
    }
  }

  return sdks
}
