/**
 * System-library detection: curated `pkg-config` probe + the advisory
 * name→library mapping. The probe is zero-network and advisory — it must never
 * change risk or blockers, only attach a `systemLibs` note to SourceBuild
 * findings whose library was mapped but not detected.
 */
import { describe, expect, it } from 'vitest'
import { probeSystemLibs, SYSTEM_LIBS } from '../src/env/system-libs'
import { systemLibHint } from '../src/adapters/node/system-libs'
import { matchCandidate } from '../src/adapters/node/match'
import {
  DistributionPattern,
  InstallStrategy,
  NativeVerdict,
  type Environment,
} from '../src/core/model'
import type { LockfilePackage } from '../src/adapters/node/signals'

function pkg(
  partial: Partial<LockfilePackage> & { name: string; version: string },
): LockfilePackage {
  return { pathChains: [[partial.name]], ...partial }
}

function envWith(systemLibs: Environment['systemLibs']): Environment {
  return {
    os: 'linux',
    arch: 'x64',
    libc: 'glibc',
    nodeVersion: '22.22.2',
    nodeAbi: '127',
    python: { version: '3.12.4' },
    compiler: { name: 'gcc', cProbe: true, cxxProbe: true },
    sdks: [],
    ...(systemLibs ? { systemLibs } : {}),
  }
}

describe('probeSystemLibs', () => {
  it('non-Linux platform → no probing, available=false', () => {
    expect(probeSystemLibs('win32')).toEqual({ available: false, present: [] })
    expect(probeSystemLibs('darwin')).toEqual({ available: false, present: [] })
  })

  it('SYSTEM_LIBS metadata is self-consistent (pkgConfig is unique)', () => {
    const keys = SYSTEM_LIBS.map((l) => l.pkgConfig)
    expect(new Set(keys).size).toBe(keys.length)
    for (const lib of SYSTEM_LIBS) {
      expect(lib.pkgConfig).toMatch(/^[a-z0-9._+-]+$/)
      expect(lib.display.length).toBeGreaterThan(0)
      expect(lib.devPkg).toMatch(/-dev$/)
    }
  })
})

describe('systemLibHint', () => {
  it('mapping hit → returns the library metadata', () => {
    expect(systemLibHint('pcap')?.pkgConfig).toBe('libpcap')
    expect(systemLibHint('cap')?.pkgConfig).toBe('libpcap')
    expect(systemLibHint('libpq')?.pkgConfig).toBe('libpq')
    expect(systemLibHint('speaker')?.pkgConfig).toBe('alsa')
  })

  it('no hit → undefined', () => {
    expect(systemLibHint('no-such-package')).toBeUndefined()
    expect(systemLibHint('lodash')).toBeUndefined()
  })
})

describe('matchCandidate system-library advisory', () => {
  const srcBuild = (name: string) =>
    matchCandidate({
      candidate: {
        pkg: pkg({ name, version: '1.0.0', dependencies: { nan: { name: 'nan' } } }),
        pattern: DistributionPattern.SourceOnly,
        verdict: NativeVerdict.Yes,
      },
      env: envWith({ available: true, present: [] }),
    })

  it('SourceBuild + mapping hit + not detected → adds systemLibs advisory, risk unchanged', () => {
    const finding = srcBuild('pcap')
    expect(finding.strategy).toBe(InstallStrategy.SourceBuild)
    expect(finding.systemLibs).toBeDefined()
    expect(finding.systemLibs?.libs).toEqual(['libpcap'])
    expect(finding.systemLibs?.remedy).toContain('libpcap-dev')
    // Advisory must NOT escalate risk: complete toolchain → MEDIUM, no blockers.
    expect(finding.blockers).toHaveLength(0)
  })

  it('library already detected → no advisory', () => {
    const finding = matchCandidate({
      candidate: {
        pkg: pkg({ name: 'pcap', version: '1.0.0', dependencies: { nan: { name: 'nan' } } }),
        pattern: DistributionPattern.SourceOnly,
        verdict: NativeVerdict.Yes,
      },
      env: envWith({ available: true, present: ['libpcap'] }),
    })
    expect(finding.systemLibs).toBeUndefined()
  })

  it('env without systemLibs (old tests / non-Linux) → no advisory, behaviour intact', () => {
    const finding = matchCandidate({
      candidate: {
        pkg: pkg({ name: 'pcap', version: '1.0.0', dependencies: { nan: { name: 'nan' } } }),
        pattern: DistributionPattern.SourceOnly,
        verdict: NativeVerdict.Yes,
      },
      env: envWith(undefined),
    })
    expect(finding.systemLibs).toBeUndefined()
    expect(finding.strategy).toBe(InstallStrategy.SourceBuild)
  })

  it('prebuilt strategy (pattern A) never adds systemLibs, even on a name hit (no compile)', () => {
    const esbuild = pkg({
      name: 'pcap',
      version: '1.0.0',
      dependencies: { '@x/linux-x64': { name: '@x/linux-x64', optional: true } },
    })
    const finding = matchCandidate({
      candidate: {
        pkg: esbuild,
        pattern: DistributionPattern.PlatformOptionalDeps,
        verdict: NativeVerdict.Yes,
      },
      env: envWith({ available: true, present: [] }),
    })
    expect(finding.strategy).toBe(InstallStrategy.Prebuilt)
    expect(finding.systemLibs).toBeUndefined()
  })
})
