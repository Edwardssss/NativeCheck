/**
 * Install script semantic parsing — the core of false-positive control.
 *
 * Observed samples:
 *   esbuild  `node install.js`                              → select (no compile)
 *   bcrypt   `node-gyp-build`                               → select (no compile)
 *   canvas   `prebuild-install -r napi || node-gyp rebuild` → download_then_compile
 *   fsevents `node-gyp rebuild`                             → compile
 */
import { describe, expect, it } from 'vitest'
import {
  describeIntent,
  inspectScript,
  mergeHookIntents,
  parseInstallScript,
} from '../src/adapters/node/install-script'

describe('parseInstallScript', () => {
  it('esbuild: node install.js → select (picks an artifact, does not compile)', () => {
    expect(parseInstallScript('node install.js')).toBe('select')
  })

  it('bcrypt: node-gyp-build → select (a picker, not node-gyp)', () => {
    // The key trap: node-gyp-build ≠ node-gyp. The former is a picker.
    expect(parseInstallScript('node-gyp-build')).toBe('select')
  })

  it('fsevents: node-gyp rebuild → compile (a real compile)', () => {
    expect(parseInstallScript('node-gyp rebuild')).toBe('compile')
  })

  it('canvas: A || B → download_then_compile (download first, compile only on failure)', () => {
    expect(parseInstallScript('prebuild-install -r napi || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
  })

  it('empty / undefined script → unknown', () => {
    expect(parseInstallScript(undefined)).toBe('unknown')
    expect(parseInstallScript('')).toBe('unknown')
    expect(parseInstallScript('   ')).toBe('unknown')
  })

  it('pure download → download', () => {
    expect(parseInstallScript('prebuild-install || exit 1')).toBe('download')
  })

  it('core-js: inline node -e eval (funding notice, no compile signal) → select (no compile)', () => {
    // This is exactly core-js@3.40.0's postinstall: `require('./postinstall')` only prints funding.
    expect(parseInstallScript(`node -e "try{require('./postinstall')}catch(e){}"`)).toBe('select')
  })

  it('node --eval with no compile signal → select', () => {
    expect(parseInstallScript('node --eval "console.log(1)"')).toBe('select')
  })

  it('node-gyp rebuild hidden in inline node -e → still compile (regex scans the whole string)', () => {
    expect(
      parseInstallScript(`node -e "require('child_process').execSync('node-gyp rebuild')"`),
    ).toBe('compile')
  })

  it('node-pty style: node scripts/prebuild.js || node-gyp rebuild → download_then_compile (§1.2)', () => {
    // Custom JS downloader + node-gyp fallback: download the prebuilt first, compile only on
    // failure. It used to be judged compile by the weak heuristic (misread as a pure compile).
    expect(parseInstallScript('node scripts/prebuild.js || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
  })

  it('only downloader-looking script names upgrade; plain names stay compile (no guessing)', () => {
    expect(parseInstallScript('node scripts/download.js || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
    expect(parseInstallScript('node scripts/install.js || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
    // No download hint in the script name → compile, conservatively (may miss a download, not a compile)
    expect(parseInstallScript('node scripts/foo.js || node-gyp rebuild')).toBe('compile')
  })
})

describe('mergeHookIntents', () => {
  it('install download + postinstall compile → compile (both run; compile is the end state, §1.4)', () => {
    expect(mergeHookIntents('download', 'compile')).toBe('compile')
    expect(mergeHookIntents('compile', 'download')).toBe('compile')
  })

  it('compile outranks download_then_compile', () => {
    expect(mergeHookIntents('download_then_compile', 'compile')).toBe('compile')
  })

  it('download_then_compile + select → select does not remove the possible compile', () => {
    expect(mergeHookIntents('download_then_compile', 'select')).toBe('download_then_compile')
  })

  it('two unknowns → unknown', () => {
    expect(mergeHookIntents('unknown', 'unknown')).toBe('unknown')
  })
})

describe('parseInstallScript · generalization spot-check (real scripts of non-benchmark packages)', () => {
  // 2026-09-04 self-review: packages outside the Docker GT matrix prove the rules are not a
  // pure lookup table. Script strings come from real registry manifests; assertions are offline.
  it('sqlite3@6: prebuild-install || node-gyp rebuild → download_then_compile', () => {
    expect(parseInstallScript('prebuild-install -r napi || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
  })

  it('fsevents@2: node-gyp rebuild → compile', () => {
    expect(parseInstallScript('node-gyp rebuild')).toBe('compile')
  })

  it('grpc@1.24: node-pre-gyp install --fallback-to-build → download', () => {
    // Note: --fallback-to-build is a flag, not a `||` fallback chain, so the semantics are a bit
    // conservative (the fallback compile is missed), but the direction is right: not benign.
    expect(
      parseInstallScript('node-pre-gyp install --fallback-to-build --library=static_library'),
    ).toBe('download')
  })

  it('core-js-pure@3.50 / es5-ext@0.10.64: isomorphic benign node -e script → select', () => {
    expect(parseInstallScript(`node -e "try{require('./postinstall')}catch(e){}"`)).toBe('select')
    expect(parseInstallScript(`node -e "try{require('./_postinstall')}catch(e){}" || exit 0`)).toBe(
      'select',
    )
  })

  it('known blind spot (documented, not fixed): cypress-style custom JS downloader → read as select', () => {
    // cypress@16's postinstall really downloads a standalone binary, but the script is
    // `node dist/index.js …` → weak heuristic select. That is the FAIL-OPEN blind spot of the
    // `node xxx.js` rule (pre-existing): custom download logic outside the vocabulary is invisible.
    // cypress downloads a standalone binary (not a Node ABI addon): harmless to the threat model.
    expect(parseInstallScript('node dist/index.js --exec install')).toBe('select')
  })

  it('node-sass@9: custom install.js download, but L1 dependency edges (nan/node-gyp) catch it', () => {
    // parseInstallScript misreads this as select, but the funnel does not rely on it: node-sass
    // has nan + node-gyp on its dependency edges, so L1 classify hits pattern D first.
    expect(parseInstallScript('node scripts/install.js || node scripts/build.js')).toBe('select')
  })
})

describe('inspectScript', () => {
  it('canvas fallback chain is split into its segments', () => {
    const segments = inspectScript('prebuild-install -r napi || node-gyp rebuild')
    expect(segments.map((s) => s.intent)).toEqual(['download', 'compile'])
  })
})

describe('describeIntent', () => {
  it('every intent gets a readable label', () => {
    expect(describeIntent('compile')).toContain('compiles')
    expect(describeIntent('select')).toContain('picks')
  })
})
