/**
 * npm-policy.ts — the allowScripts policy (the "package manager version" dimension).
 *
 * Timeline (as of 2026-09):
 *   - npm < 11.16.0: scripts run as usual;
 *   - npm 11.16.0+: advisory (scripts still run, unapproved ones are listed);
 *   - npm 12+: allowScripts defaults to off, scripts are blocked.
 */
import { describe, expect, it } from 'vitest'
import { allowScriptsPolicy } from '../src/adapters/node/npm-policy'

describe('allowScriptsPolicy', () => {
  it('npm < 11.16.0 → scripts-run', () => {
    expect(allowScriptsPolicy('10.9.0')).toBe('scripts-run')
    expect(allowScriptsPolicy('11.15.0')).toBe('scripts-run')
    expect(allowScriptsPolicy('9.8.1')).toBe('scripts-run')
  })

  it('npm 11.16.0+ → advisory (warns, scripts still run)', () => {
    expect(allowScriptsPolicy('11.16.0')).toBe('advisory')
    expect(allowScriptsPolicy('11.20.1')).toBe('advisory')
  })

  it('npm 12+ → blocked (allowScripts is off by default)', () => {
    expect(allowScriptsPolicy('12.0.0')).toBe('blocked')
    expect(allowScriptsPolicy('12.3.1')).toBe('blocked')
  })

  it('unknown / missing version → scripts-run (conservative, no noise)', () => {
    expect(allowScriptsPolicy(undefined)).toBe('scripts-run')
    expect(allowScriptsPolicy('')).toBe('scripts-run')
    expect(allowScriptsPolicy('garbage')).toBe('scripts-run')
  })

  it('tolerates a leading v', () => {
    expect(allowScriptsPolicy('v12.0.0')).toBe('blocked')
  })
})
