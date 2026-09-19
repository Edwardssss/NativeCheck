/**
 * Windows toolchain environment discovery (`vcvars64.bat`).
 *
 * Why this exists: on Windows, `cl.exe` sits on disk but does **not** work from a
 * plain shell — it needs `INCLUDE` (CRT / Windows SDK headers), `LIB` and the
 * right `PATH` entries, which are only set up by a "Developer Command Prompt" or
 * by calling `vcvars64.bat`. Without that, the compile probe fails while the
 * toolchain is perfectly installed, and the report tells the user to install a
 * compiler they already have. That is a wrong finding with a costly remedy: it
 * is the exact opposite of what this tool promises.
 *
 * So: when the plain probe fails on Windows, ask Visual Studio's own installer
 * where it lives (`vswhere.exe`, which ships with VS and is the documented way to
 * find an installation), capture the environment `vcvars64.bat` produces, and
 * re-probe inside it.
 *
 * Deliberately *not* done here:
 *
 * - **No installation.** We never modify the machine; we only read an
 *   environment a `cmd` child process computes for itself.
 * - **No guessing at install paths.** `vswhere` is authoritative; a hard-coded
 *   `C:\Program Files\...` scan would miss exactly the installations (other
 *   drive, Build Tools only, multiple VS versions) that need this feature most.
 * - **No silent fallback.** If no toolchain environment can be found, the probe
 *   result stays honest: "the compiler is present but cannot compile".
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Where `vswhere.exe` lives on a machine that has any Visual Studio or Build Tools installed. */
export const VSWHERE_RELATIVE_PATH = join('Microsoft Visual Studio', 'Installer', 'vswhere.exe')

/** The MSVC x64 toolset component; without it vcvars64.bat is not installed either. */
export const MSVC_X64_COMPONENT = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'

/** A captured toolchain environment, plus the script it came from (for evidence text). */
export interface ToolchainEnv {
  /** Absolute path of the `vcvars*.bat` that produced `env`. */
  readonly script: string
  /** Environment variables to merge over `process.env` when probing. */
  readonly env: Readonly<Record<string, string>>
}

/** Injection seam, so discovery and parsing are testable without a real VS install. */
export interface MsvcEnvDeps {
  readonly platform?: NodeJS.Platform
  /** `undefined` when the file does not exist on this machine. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly exists?: (path: string) => boolean
  /** Runs a command and returns stdout; `undefined` on failure. */
  readonly run?: (command: string, args: readonly string[]) => string | undefined
  /**
   * Runs a command line through the platform shell. Separate from `run` because
   * the env capture needs `&` / `>` redirection, which only a shell interprets.
   */
  readonly runShell?: (commandLine: string) => string | undefined
}

/**
 * Parse `cmd /c set` output into an environment map.
 *
 * `set` prints `KEY=VALUE` one per line, and a variable's value may itself
 * contain `=` (`LIB=C:\a;D:\b=x`) — hence splitting at the *first* `=` only.
 * Some values are multi-line (rare, but `set` will happily print them); such
 * continuations are appended to the previous key rather than invented as a key.
 */
export function parseSetOutput(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  let lastKey: string | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') continue
    const eq = rawLine.indexOf('=')
    if (eq <= 0) {
      // No `=` (or an `=C:` style pseudo-variable): treat it as a continuation
      // of the previous value if there is one, otherwise ignore it.
      if (lastKey !== undefined) env[lastKey] = `${env[lastKey]}\n${rawLine}`
      continue
    }
    const key = rawLine.slice(0, eq)
    env[key] = rawLine.slice(eq + 1)
    lastKey = key
  }
  return env
}

/**
 * Locate the `vcvars64.bat` that matches the default (x64) toolchain.
 *
 * `vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` filters
 * out installations that have the IDE but not the C++ toolset, which would give
 * us a `VC` directory with no working `cl.exe`.
 */
export function findVcvarsScript(deps: MsvcEnvDeps = {}): string | undefined {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return undefined
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync

  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  )
  const vswhere = roots
    .map((root) => join(root, VSWHERE_RELATIVE_PATH))
    .find((candidate) => exists(candidate))
  if (!vswhere) return undefined

  const run =
    deps.run ??
    ((command: string, args: readonly string[]): string | undefined => runCapture(command, args))
  const out = run(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    MSVC_X64_COMPONENT,
    '-property',
    'installationPath',
  ])
  const installPath = out
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!installPath) return undefined

  const script = join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  return exists(script) ? script : undefined
}

function runCapture(command: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    })
  } catch {
    return undefined
  }
}

/**
 * `cmd.exe /c "<line>"` through a shell.
 *
 * `execSync` (not `execFileSync`) is required: `&&` and `>nul` are shell
 * syntax, so the line has to be handed to the shell as a *command line* rather
 * than as an argv element (which Node would quote, breaking the redirection).
 */
function runShellCapture(commandLine: string): string | undefined {
  try {
    return execSync(commandLine, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      windowsHide: true,
    })
  } catch {
    return undefined
  }
}

/**
 * Capture the environment `vcvars64.bat` sets up, by asking `cmd.exe` to run it
 * and then dump its own variables.
 *
 * `call <script> && set` is the only reliable way to see this environment:
 * `vcvars64.bat` calls other batch files and mutates the *shell's* environment,
 * which a child process cannot observe from the outside.
 */
export function captureToolchainEnv(deps: MsvcEnvDeps = {}): ToolchainEnv | undefined {
  const script = findVcvarsScript(deps)
  if (!script) return undefined
  const runShell = deps.runShell ?? runShellCapture
  const out = runShell(`call "${script}" >nul 2>&1 && set`)
  if (!out) return undefined
  const env = parseSetOutput(out)
  // A capture that produced no INCLUDE did not really enter the toolchain
  // environment; reporting it as one would just move the false negative around.
  if (!env.INCLUDE || !env.LIB) return undefined
  return { script, env }
}

let cached: ToolchainEnv | undefined | null = null

/** Memoized {@link captureToolchainEnv}: the capture costs a `cmd.exe` spawn. */
export function toolchainEnv(): ToolchainEnv | undefined {
  if (cached === null) cached = captureToolchainEnv()
  return cached ?? undefined
}
