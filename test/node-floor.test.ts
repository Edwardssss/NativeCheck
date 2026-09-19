/**
 * The Node floor in `package.json#engines` is a promise: a global install on that
 * version has to work, and CI installs the whole tree on it too.
 *
 * `.npmrc` sets `engine-strict=true`, so npm turns one dependency that wants a
 * newer Node into a hard install failure instead of a warning. That is how
 * `undici@8` (Node >= 22.19) broke the Node 20 CI job while every test passed:
 * `npm ci` never got past its first step, so no test ever ran.
 *
 * The check covers declared dependencies, because those are what we choose.
 * Transitive tooling pins its own floor and CI installs the latest 20.x anyway;
 * optional dependencies are exempt, since npm skips a platform binding it cannot
 * use instead of failing on it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minVersion, satisfies } from 'semver'
import { describe, expect, it } from 'vitest'

interface Manifest {
  readonly engines?: { readonly node?: string }
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

interface LockEntry {
  readonly engines?: { readonly node?: string }
  readonly optional?: boolean
}

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
  readonly packages: Record<string, LockEntry>
}

const declared = { ...manifest.dependencies, ...manifest.devDependencies }

describe('dependency Node floor', () => {
  it('mirrors every declared dependency in the lockfile', () => {
    const missing = Object.keys(declared).filter(
      (name) => lock.packages[`node_modules/${name}`] === undefined,
    )
    expect(missing).toEqual([])
  })

  it('admits the declared minimum Node version', () => {
    const declaredRange = manifest.engines?.node
    const floor = declaredRange === undefined ? null : minVersion(declaredRange)
    if (floor === null) throw new Error(`unusable engines.node: ${String(declaredRange)}`)

    const offenders: string[] = []
    for (const name of Object.keys(declared)) {
      const entry = lock.packages[`node_modules/${name}`]
      const required = entry?.engines?.node
      if (entry === undefined || required === undefined || entry.optional === true) continue
      if (!satisfies(floor, required)) {
        offenders.push(`${name} requires Node ${required}, but the floor is ${floor.version}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
