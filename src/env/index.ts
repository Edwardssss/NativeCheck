/**
 * Environment scan aggregation entry point.
 *
 * Maps to design doc §10.4 "Environment scanning and compiler probes".
 */

import type { Environment } from '../core/model'
import { detectArch, detectLibc, detectPlatform } from './os'
import { detectNodeRuntime } from './node'
import { detectPython } from './python'
import { detectCompiler, detectSdks } from './compiler-probe'
import { probeSystemLibs } from './system-libs'

export { detectArch, detectLibc, detectPlatform } from './os'
export { detectNodeRuntime, resolveAbi } from './node'
export { detectPython } from './python'
export { detectCompiler, detectSdks } from './compiler-probe'
export { probeSystemLibs, SYSTEM_LIBS } from './system-libs'
export type { SystemLibEntry } from './system-libs'

/**
 * Take one complete environment snapshot. Everything is probed locally, zero network.
 *
 * Note: the compiler probe is expensive (it really compiles one C and one C++
 * file each time), so `detectCompiler()` is called once and its result reused.
 */
export function scanEnvironment(): Environment {
  const os = detectPlatform()
  const arch = detectArch()
  const libc = detectLibc(os)
  const node = detectNodeRuntime()
  const python = detectPython()
  const compiler = detectCompiler()

  return {
    os,
    arch,
    ...(libc ? { libc } : {}),
    nodeVersion: node.version,
    ...(node.abi ? { nodeAbi: node.abi } : {}),
    ...(node.napi ? { napiVersion: node.napi } : {}),
    ...(node.npmVersion ? { npmVersion: node.npmVersion } : {}),
    ...(python ? { python } : {}),
    ...(compiler ? { compiler } : {}),
    sdks: detectSdks(os),
    systemLibs: probeSystemLibs(os),
  }
}
