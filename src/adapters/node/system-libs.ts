/**
 * Advisory mapping: native package name → the system library it likely links.
 *
 * Best-effort, name-based heuristic. The library dependency lives in the C
 * source / binding.gyp, invisible to a zero-network lockfile scan, so a
 * name lookup is the only offline signal available. It is used ONLY to emit a
 * "possibly missing <lib>" advisory for SourceBuild findings — it never changes risk or
 * blockers (never predict install success: the package may bundle the
 * library, or the name association may be wrong).
 */

import { SYSTEM_LIBS, type SystemLibEntry } from '../../env/system-libs'

/**
 * Package name → `pkg-config` module name. Keep the `SYSTEM_LIBS` list in
 * `env/system-libs.ts` the single source of library metadata; this table only
 * maps package names onto that list by module name.
 *
 * Membership rule — only map a package when it is *known* to link the system
 * library rather than vendor it. Two sources of truth:
 *   1. Docker screening ground truth: pcap / cap / speaker / libpq were
 *      `install-failed` on the bare build-essential image and only compiled
 *      after installing the matching `-dev` package (i.e. they do NOT vendor).
 *   2. Reputable large native stacks that never vendor: canvas (cairo), libxmljs
 *      (libxml2), zeromq (libzmq).
 *
 * Explicitly EXCLUDED (they vendor their library — compiled fine on the bare
 * image, or bundle SQLite's amalgamation): node-opus (opus), mmmagic (libmagic),
 * nanomsg, node-expat (expat), sqlite3 / node-sqlite3 (SQLite). Mapping them
 * would emit a false "possibly missing X" hint.
 */
const SYSTEM_LIB_HINTS: Readonly<Record<string, string>> = {
  // Docker-verified: failed on bare image, needs the -dev package
  libpq: 'libpq',
  pcap: 'libpcap',
  cap: 'libpcap',
  speaker: 'alsa',
  // Large native stacks that never vendor
  'pg-native': 'libpq',
  canvas: 'cairo',
  libxmljs: 'libxml-2.0',
  zeromq: 'libzmq',
  zmq: 'libzmq',
}

/** Look up the likely system library for a package name; undefined when unknown. */
export function systemLibHint(name: string): SystemLibEntry | undefined {
  const pkgConfig = SYSTEM_LIB_HINTS[name]
  if (!pkgConfig) return undefined
  return SYSTEM_LIBS.find((l) => l.pkgConfig === pkgConfig)
}
