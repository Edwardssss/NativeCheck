/**
 * System library detection (Linux-first, zero network).
 *
 * The design doc §19.2 originally declared system-library enumeration
 * unrealistic because `-dev` package names differ per distribution. This module
 * is the pragmatic middle ground: a **curated** list of high-frequency
 * libraries probed with a single `pkg-config --list-all` subprocess call.
 *
 * It answers the single most common Linux install failure — "you're missing
 * `libpq-dev` / `libpcap-dev`" — WITHOUT trying to enumerate everything. The
 * result is **advisory**: `pkg-config` absence is weak evidence (a library may
 * be present without a `.pc` file, or the package may bundle it), so it never
 * turns into a blocker or a HIGH risk level (ADR-001: do not predict install
 * success).
 */

import { execFileSync } from 'node:child_process'
import type { Platform, SystemLibProbe } from '../core/model'
import { detectPlatform } from './os'

/** One curated, high-frequency system library. */
export interface SystemLibEntry {
  /** `pkg-config` module name (also the probe key). */
  readonly pkgConfig: string
  /** Human-readable display name. */
  readonly display: string
  /** Debian/Ubuntu `-dev` package, used in the remedy text (Alpine differs; shown as a hint). */
  readonly devPkg: string
}

/** Curated high-frequency system libraries for native npm packages. Advisory only. */
export const SYSTEM_LIBS: readonly SystemLibEntry[] = [
  { pkgConfig: 'libpq', display: 'PostgreSQL client (libpq)', devPkg: 'libpq-dev' },
  { pkgConfig: 'libpcap', display: 'libpcap', devPkg: 'libpcap-dev' },
  { pkgConfig: 'alsa', display: 'ALSA', devPkg: 'libasound2-dev' },
  { pkgConfig: 'opus', display: 'Opus codec', devPkg: 'libopus-dev' },
  { pkgConfig: 'libmagic', display: 'libmagic', devPkg: 'libmagic-dev' },
  { pkgConfig: 'libnanomsg', display: 'nanomsg', devPkg: 'libnanomsg-dev' },
  { pkgConfig: 'libzmq', display: 'ZeroMQ (libzmq)', devPkg: 'libzmq3-dev' },
  { pkgConfig: 'cairo', display: 'Cairo', devPkg: 'libcairo2-dev' },
  { pkgConfig: 'libxml-2.0', display: 'libxml2', devPkg: 'libxml2-dev' },
  { pkgConfig: 'expat', display: 'Expat XML parser', devPkg: 'libexpat1-dev' },
  { pkgConfig: 'openssl', display: 'OpenSSL', devPkg: 'libssl-dev' },
  { pkgConfig: 'sqlite3', display: 'SQLite3', devPkg: 'libsqlite3-dev' },
  { pkgConfig: 'zlib', display: 'zlib', devPkg: 'zlib1g-dev' },
  { pkgConfig: 'libpng', display: 'libpng', devPkg: 'libpng-dev' },
  { pkgConfig: 'libjpeg', display: 'libjpeg', devPkg: 'libjpeg-dev' },
  { pkgConfig: 'libcurl', display: 'libcurl', devPkg: 'libcurl4-openssl-dev' },
  { pkgConfig: 'gobject-2.0', display: 'GLib', devPkg: 'libglib2.0-dev' },
  { pkgConfig: 'dbus-1', display: 'D-Bus', devPkg: 'libdbus-1-dev' },
  { pkgConfig: 'libudev', display: 'libudev', devPkg: 'libudev-dev' },
]

/**
 * Probe the curated system libraries.
 *
 * Linux-only for now: macOS brew-managed `.pc` files live off `pkg-config`'s
 * default search path, out of the Linux-first scope (see README, supported scope).
 * A single subprocess call, zero network, never throws.
 */
export function probeSystemLibs(platform: Platform = detectPlatform()): SystemLibProbe {
  if (platform !== 'linux') return { available: false, present: [] }
  let listing: string
  try {
    listing = execFileSync('pkg-config', ['--list-all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      windowsHide: true,
    })
  } catch {
    // pkg-config itself missing (no dev packages installed at all) → cannot probe.
    return { available: false, present: [] }
  }

  // `pkg-config --list-all` prints `module-name description` one per line.
  const available = new Set<string>()
  for (const line of listing.split('\n')) {
    const name = line.trim().split(/\s+/)[0]
    if (name) available.add(name)
  }
  const present = SYSTEM_LIBS.map((l) => l.pkgConfig).filter((name) => available.has(name))
  return { available: true, present }
}
