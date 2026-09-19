/**
 * Windows toolchain-environment discovery (`vcvars64.bat`) and the compiler
 * probe's fallback into it.
 *
 * The defect being locked down: on a Windows machine with Visual Studio
 * installed, `cl.exe` is on PATH but cannot compile from a plain shell (no
 * `INCLUDE` / `LIB`). The old probe reported "compiler present, probe failed",
 * and the report told the user to install a compiler they already had — a wrong
 * finding with a costly remedy.
 */
import { describe, expect, it, vi } from 'vitest'
import { detectCompiler, type CompilerProbeDeps } from '../src/env/compiler-probe'
import {
  captureToolchainEnv,
  findVcvarsScript,
  parseSetOutput,
  VSWHERE_RELATIVE_PATH,
} from '../src/env/msvc-env'

const VCVARS = 'D:\\VS2026\\VC\\Auxiliary\\Build\\vcvars64.bat'

describe('parseSetOutput', () => {
  it('splits KEY=VALUE, keeping everything after the first =', () => {
    const env = parseSetOutput('INCLUDE=C:\\a;C:\\b\r\nLIB=C:\\x=y;D:\\z\r\n')
    expect(env.INCLUDE).toBe('C:\\a;C:\\b')
    // `LIB` values legitimately contain `=`, so the split must be at the *first* one only.
    expect(env.LIB).toBe('C:\\x=y;D:\\z')
  })

  it('ignores blank lines and tolerates CRLF', () => {
    expect(parseSetOutput('\r\n\r\nA=1\r\n')).toEqual({ A: '1' })
  })

  it('appends a line without = to the previous value instead of inventing a key', () => {
    const env = parseSetOutput('A=1\r\ncontinuation\r\nB=2\r\n')
    expect(env.A).toBe('1\ncontinuation')
    expect(env.B).toBe('2')
  })

  it('ignores a leading line without a key to attach to', () => {
    expect(parseSetOutput('orphan\r\nA=1\r\n')).toEqual({ A: '1' })
  })
})

describe('findVcvarsScript', () => {
  const base = { platform: 'win32' as const }

  it('uses vswhere, and only when the asked-for component is present', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const found = findVcvarsScript({
      ...base,
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      exists: (p) => p.endsWith('vswhere.exe') || p === VCVARS,
      run: (command, args) => {
        calls.push({ command, args })
        return 'D:\\VS2026\r\n'
      },
    })
    expect(found).toBe(VCVARS)
    expect(calls[0]?.command).toContain('vswhere.exe')
    // Without the C++ toolset filter, an IDE-only installation would produce a
    // VC directory with no usable cl.exe.
    expect(calls[0]?.args).toContain('Microsoft.VisualStudio.Component.VC.Tools.x86.x64')
    expect(calls[0]?.args).toContain('-latest')
  })

  it('returns undefined when vswhere is not installed', () => {
    expect(
      findVcvarsScript({ ...base, env: {}, exists: () => false, run: () => VCVARS }),
    ).toBeUndefined()
  })

  it('returns undefined when vswhere reports no installation', () => {
    expect(
      findVcvarsScript({
        ...base,
        env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
        exists: (p) => p.endsWith('vswhere.exe'),
        run: () => '\r\n',
      }),
    ).toBeUndefined()
  })

  it('returns undefined when the toolset is installed but vcvars64.bat is missing', () => {
    expect(
      findVcvarsScript({
        ...base,
        env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
        exists: (p) => !p.endsWith('vcvars64.bat'),
        run: () => 'D:\\VS2026\r\n',
      }),
    ).toBeUndefined()
  })

  it('does nothing on non-Windows platforms', () => {
    expect(
      findVcvarsScript({ platform: 'linux', env: {}, exists: () => true, run: () => 'x' }),
    ).toBeUndefined()
  })

  it('looks for vswhere under Program Files as well as Program Files (x86)', () => {
    const seen: string[] = []
    findVcvarsScript({
      ...base,
      env: { ProgramFiles: 'C:\\PF' },
      exists: (p) => {
        seen.push(p)
        return false
      },
      run: () => undefined,
    })
    expect(seen.some((p) => p.includes(`C:\\PF\\${VSWHERE_RELATIVE_PATH}`))).toBe(true)
  })
})

describe('captureToolchainEnv', () => {
  it('captures the environment and reports the script it came from', () => {
    const captured = captureToolchainEnv({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': 'C:\\PF86' },
      exists: (p) => p.endsWith('vswhere.exe') || p === VCVARS,
      run: () => 'D:\\VS2026\r\n',
      runShell: (line) => {
        expect(line).toContain('vcvars64.bat')
        return 'INCLUDE=D:\\VS2026\\include\r\nLIB=D:\\VS2026\\lib\r\nPATH=C:\\Windows\r\n'
      },
    })
    expect(captured?.script).toBe(VCVARS)
    expect(captured?.env.INCLUDE).toBe('D:\\VS2026\\include')
  })

  it('refuses a capture that did not actually set INCLUDE / LIB', () => {
    // A `set` dump without include paths means the batch file failed (wrong
    // host architecture, missing component). Treating that as "toolchain ready"
    // would just move the false negative one step further along.
    const captured = captureToolchainEnv({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': 'C:\\PF86' },
      exists: (p) => p.endsWith('vswhere.exe') || p === VCVARS,
      run: () => 'D:\\VS2026\r\n',
      runShell: () => 'PATH=C:\\Windows\r\n',
    })
    expect(captured).toBeUndefined()
  })
})

describe('detectCompiler · Windows toolchain fallback', () => {
  /** A machine whose cl.exe only works inside the developer environment. */
  function msvcDeps(overrides: Partial<CompilerProbeDeps> = {}): CompilerProbeDeps {
    const toolchainEnv = vi.fn(() => ({
      script: VCVARS,
      env: { INCLUDE: 'D:\\VS2026\\include', LIB: 'D:\\VS2026\\lib' },
    }))
    return {
      platform: 'win32',
      locate: (cmd) => (cmd === 'cl.exe' ? 'D:\\VS2026\\...\\cl.exe' : undefined),
      run: () => undefined,
      toolchainEnv,
      compile: (_cmd, _kind, _lang, env) => env?.INCLUDE !== undefined,
      ...overrides,
    }
  }

  it('re-probes inside vcvars and records how the compiler became usable', () => {
    const deps = msvcDeps()
    const info = detectCompiler(deps)
    expect(info?.cProbe).toBe(true)
    expect(info?.cxxProbe).toBe(true)
    expect(info?.viaToolchainEnv).toBe(VCVARS)
  })

  it('does not touch the toolchain environment when the compiler already works', () => {
    const toolchainEnv = vi.fn()
    const info = detectCompiler(msvcDeps({ toolchainEnv, compile: () => true }))
    expect(info?.cProbe).toBe(true)
    // A shell that is already a Developer Command Prompt must pay nothing.
    expect(toolchainEnv).not.toHaveBeenCalled()
    expect(info?.viaToolchainEnv).toBeUndefined()
  })

  it('stays honest when no toolchain environment can be found', () => {
    const info = detectCompiler(msvcDeps({ toolchainEnv: () => undefined, compile: () => false }))
    expect(info?.cProbe).toBe(false)
    expect(info?.cxxProbe).toBe(false)
    // The compiler is still *reported* — "present but unusable" is the finding.
    expect(info?.path).toContain('cl.exe')
    expect(info?.viaToolchainEnv).toBeUndefined()
  })

  it('keeps a partially working toolchain rather than filling the gaps in', () => {
    // C compiles inside vcvars, C++ does not: report exactly that.
    const info = detectCompiler(
      msvcDeps({ compile: (_cmd, _kind, lang, env) => env?.INCLUDE !== undefined && lang === 'c' }),
    )
    expect(info?.cProbe).toBe(true)
    expect(info?.cxxProbe).toBe(false)
    expect(info?.viaToolchainEnv).toBe(VCVARS)
  })

  it('never applies the fallback on Linux or macOS', () => {
    const toolchainEnv = vi.fn()
    const info = detectCompiler({
      platform: 'linux',
      locate: (cmd) => (cmd === 'cc' ? '/usr/bin/cc' : undefined),
      run: () => undefined,
      toolchainEnv,
      compile: () => false,
    })
    expect(info?.name).toBe('cc')
    expect(toolchainEnv).not.toHaveBeenCalled()
  })
})
