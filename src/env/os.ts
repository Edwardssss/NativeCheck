/**
 * Platform detection: os / arch / libc.
 *
 * libc is a key dimension for Pattern A / B matching — on Alpine (musl),
 * `@img/sharp-libvips-linux-x64` is unusable and only the `linuxmusl` variant works.
 */

import os from 'node:os'
import { familySync } from 'detect-libc'
import type { Arch, Libc, Platform } from '../core/model'

const KNOWN_PLATFORMS: readonly string[] = [
  'darwin',
  'linux',
  'win32',
  'freebsd',
  'openbsd',
  'aix',
  'sunos',
]

const KNOWN_ARCHES: readonly string[] = [
  'x64',
  'arm64',
  'arm',
  'ia32',
  'ppc64',
  's390x',
  'riscv64',
  'loong64',
]

export function detectPlatform(): Platform {
  const value = os.platform()
  return (KNOWN_PLATFORMS.includes(value) ? value : 'linux') as Platform
}

export function detectArch(): Arch {
  const value = os.arch()
  return (KNOWN_ARCHES.includes(value) ? value : 'x64') as Arch
}

/**
 * Only meaningful on Linux — macOS / Windows do not distinguish glibc from musl.
 * Returns `undefined` when detection fails, letting callers treat it as "unknown"
 * rather than guessing glibc.
 */
export function detectLibc(platform: Platform = detectPlatform()): Libc | undefined {
  if (platform !== 'linux') return undefined
  try {
    const family = familySync()
    if (family === 'musl') return 'musl'
    if (family === 'glibc') return 'glibc'
    return undefined
  } catch {
    return undefined
  }
}
