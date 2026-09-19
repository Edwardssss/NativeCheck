/**
 * The root entry is a *promise*: everything exported from `nativecheck` is meant
 * to keep working across minor releases. The `nativecheck/experimental` sub-path
 * is the opposite — real, tested code with no compatibility promise.
 *
 * These tests exist so the promise cannot drift silently: promoting a symbol out
 * of `experimental`, or accidentally leaking an internal one into the root,
 * fails here and forces a deliberate decision.
 */
import { describe, expect, it } from 'vitest'

import * as experimental from '../src/experimental'
import * as stable from '../src/index'

describe('stable root entry', () => {
  it('exposes the four-layer public verbs and nothing else that moves', () => {
    expect(typeof stable.scan).toBe('function')
    expect(typeof stable.scanTarget).toBe('function')
    expect(typeof stable.parsePackageSpec).toBe('function')
    expect(typeof stable.scanEnvironment).toBe('function')
    expect(Array.isArray(stable.SYSTEM_LIBS)).toBe(true)
  })

  it('does not leak internals', () => {
    // A sample of symbols that embedders keep asking for and that we are not
    // ready to freeze. If one of these is promoted on purpose, move it to the
    // list above and delete it from here.
    for (const internal of [
      'parseInstallScript',
      'classifyGraph',
      'verifyCandidate',
      'fetchManifest',
      'ingest',
      'allowScriptsPolicy',
      'saveVerifyCache',
    ]) {
      expect(internal in stable).toBe(false)
    }
  })
})

describe('experimental sub-path', () => {
  it('carries the layer-by-layer internals', () => {
    for (const symbol of [
      'ingest',
      'probeLockfile',
      'SUPPORTED_LOCKFILES',
      'parsePnpmLockfile',
      'parseYarnLockfile',
      'parseBunLockfile',
      'classifyGraph',
      'classifyPackage',
      'matchesPlatform',
      'verdictFor',
      'buildFindings',
      'verifyCandidate',
      'fetchManifest',
      'probePrebuilds',
      'parseInstallScript',
      'inspectScript',
      'matchCandidate',
      'allowScriptsPolicy',
      'systemLibHint',
      'saveVerifyCache',
      'pruneVerifyCache',
    ]) {
      expect(symbol in experimental).toBe(true)
    }
  })

  it('keeps the root entry small enough to review by eye', () => {
    // The point is not the exact number — it is that *someone* decides when the
    // frozen surface grows. Today it is ~39 runtime values (core report/match
    // helpers plus the three verbs); if this trips, you are expanding the
    // compatibility promise and should do so knowingly.
    const valueExports = Object.values(stable)
    expect(valueExports.length).toBeLessThanOrEqual(50)
  })
})
