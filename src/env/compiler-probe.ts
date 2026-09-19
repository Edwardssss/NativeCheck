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
 * this tool.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompilerInfo, Sdk } from '../core/model'
import { toolchainEnv, type ToolchainEnv } from './msvc-env'

const PROBE_SOURCE = 'int main() { return 0; }\n'

interface Candidate {
  readonly command: string
  readonly kind: 'gcc-like' | 'msvc'
}

/**
 * Injection seam for `detectCompiler`.
 *
 * The Windows fallback (see below) is the part most worth testing and the part
 * hardest to arrange on a real machine, so it is expressed as dependencies
 * rather than reached directly.
 */
export interface CompilerProbeDeps {
  readonly platform?: NodeJS.Platform
  readonly locate?: (command: string) => string | undefined
  readonly run?: (command: string, args: readonly string[]) => string | undefined
  readonly compile?: (
    command: string,
    kind: Candidate['kind'],
    lang: 'c' | 'cxx',
    env?: Readonly<Record<string, string>>,
  ) => boolean
  readonly toolchainEnv?: () => ToolchainEnv | undefined
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
function locateCommand(command: string): string | undefined {
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
function compileProbe(
  command: string,
  kind: Candidate['kind'],
  lang: 'c' | 'cxx',
  env?: Readonly<Record<string, string>>,
): boolean {
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
      // `undefined` inherits the parent environment, which is what we want when
      // the compiler already works from the current shell.
      ...(env ? { env: { ...process.env, ...env } } : {}),
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

export function detectCompiler(deps: CompilerProbeDeps = {}): CompilerInfo | undefined {
  const platform = deps.platform ?? process.platform
  const locate = deps.locate ?? locateCommand
  const runCommand = deps.run ?? run
  const compile = deps.compile ?? compileProbe
  const getToolchainEnv = deps.toolchainEnv ?? toolchainEnv

  for (const candidate of compilerCandidates(platform)) {
    const path = locate(candidate.command)
    if (!path) continue

    const version = parseVersion(
      candidate.kind === 'msvc' ? undefined : runCommand(candidate.command, ['--version']),
    )

    let cProbe = compile(candidate.command, candidate.kind, 'c')
    let cxxProbe = compile(candidate.command, candidate.kind, 'cxx')
    let viaToolchainEnv: string | undefined

    // Windows-only rescue: `cl.exe` is on PATH but unusable, because a plain
    // shell has no `INCLUDE` / `LIB`. Ask Visual Studio for its developer
    // environment and re-probe inside it — otherwise the report tells the user
    // to install a compiler that is already installed.
    //
    // Only triggered on failure, so a machine that already runs inside a
    // Developer Command Prompt pays nothing.
    if (platform === 'win32' && candidate.kind === 'msvc' && !(cProbe && cxxProbe)) {
      const dev = getToolchainEnv()
      if (dev) {
        const env = { ...dev.env }
        // `PATH` from `set` arrives as one string; keep it intact, but make sure
        // the toolchain directories come first. Spread order does that: the
        // captured value replaces the inherited one wholesale.
        const cRetry = compile(candidate.command, candidate.kind, 'c', env)
        const cxxRetry = compile(candidate.command, candidate.kind, 'cxx', env)
        if (cRetry || cxxRetry) {
          cProbe = cRetry
          cxxProbe = cxxRetry
          viaToolchainEnv = dev.script
        }
      }
    }

    return {
      name: candidate.command,
      ...(version ? { version } : {}),
      path,
      // One command covers both C and C++: clang/gcc switch with -x, MSVC switches by extension
      cProbe,
      cxxProbe,
      ...(viaToolchainEnv ? { viaToolchainEnv } : {}),
    }
  }
  return undefined
}

/**
 * SDK / heavyweight toolchain detection.
 *
 * Covers only the two most common blocker sources: Xcode Command Line Tools on
 * macOS and the MSVC build tools on Windows. System libraries (libcairo etc.) are
 * out of scope: package names differ per distribution, so
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
    if (locateCommand('cl.exe')) {
      sdks.push({ name: 'MSVC Build Tools' })
    }
  }

  return sdks
}
