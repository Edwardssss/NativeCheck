/**
 * The accuracy gate is a contract, so it is tested like one.
 *
 * `collect.py --gate` decides whether the ground-truth matrix passed, and its
 * verdict used to be produced by scraping the printed table with `sed` in the
 * workflow — the kind of check that rots silently. These cases pin the exit-code
 * contract: a false negative fails, an FP above the cap fails, and a table too
 * small to mean anything fails instead of reporting a perfect rate.
 *
 * Synthetic trees only: the real matrix needs Docker and does 68 installs, which
 * is the workflow's job, not the unit suite's.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const collector = join(repoRoot, 'testdata', 'ground-truth', 'collect.py')

/** `python3` on POSIX, `python` on Windows; `undefined` when neither works (the suite then skips). */
function findPython(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'pass'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return undefined
}

const python = findPython()
const workRoots: string[] = []

afterAll(() => {
  for (const root of workRoots) rmSync(root, { recursive: true, force: true })
})

/** Predicted a local compile? Actually compiled? Determinate verdict? */
interface Row {
  readonly sourceBuild: boolean
  readonly compiled: boolean
  readonly determinate?: boolean
}

const repeat = (count: number, row: Partial<Row>): Row[] =>
  Array.from({ length: count }, () => ({ sourceBuild: false, compiled: false, ...row }))

/** One cell of `out/`: `compiled` is the physical fact, `sourceBuild` what the tool predicted. */
function makeOut(cell: string, samples: readonly Row[]): string {
  const root = mkdtempSync(join(tmpdir(), 'nativecheck-gate-'))
  workRoots.push(root)
  const dir = join(root, 'out', cell)
  mkdirSync(dir, { recursive: true })
  samples.forEach((sample, index) => {
    const fixture = `f${index}`
    mkdirSync(join(dir, fixture), { recursive: true })
    writeFileSync(
      join(dir, fixture, 'result.properties'),
      `project=${fixture}\ninstall=ok\ncompiled=${sample.compiled ? 'yes' : 'no'}\n`,
    )
    writeFileSync(
      join(dir, `${fixture}.prediction.json`),
      JSON.stringify({
        fixture,
        strategy: sample.sourceBuild ? 'SOURCE_BUILD' : 'PREBUILT',
        risk: sample.determinate === false ? 'UNVERIFIED' : 'LOW',
        blockers: 0,
      }),
    )
  })
  return root
}

function gate(root: string, ...extra: readonly string[]): number {
  const result = spawnSync(python as string, [collector, join(root, 'out'), '--gate', ...extra], {
    encoding: 'utf8',
  })
  return result.status ?? -1
}

/** 40 samples: `correct` true positives, `missed` false negatives, `alarm` false alarms, rest true negatives. */
const table = (correct: number, missed: number, alarm: number): Row[] => [
  ...repeat(correct, { sourceBuild: true, compiled: true }),
  ...repeat(missed, { sourceBuild: false, compiled: true }),
  ...repeat(alarm, { sourceBuild: true, compiled: false }),
  ...repeat(40 - correct - missed - alarm, { sourceBuild: false, compiled: false }),
]

describe.skipIf(python === undefined)('collect.py accuracy gate', () => {
  it('passes a table that matches the published claims', () => {
    expect(gate(makeOut('00-glibc', table(10, 0, 0)))).toBe(0)
  })

  it('fails on a single false negative, because the published FN claim is 0%', () => {
    expect(gate(makeOut('01-glibc', table(10, 1, 0)))).toBe(1)
  })

  it('fails above the 5% false-alarm cap, and passes when the cap is widened', () => {
    const root = makeOut('02-glibc', table(0, 0, 3)) // 3/40 = 7.5%
    expect(gate(root)).toBe(1)
    expect(gate(root, '--max-fp-pct', '10')).toBe(0)
  })

  it('fails when the table is too small to mean anything', () => {
    expect(gate(makeOut('03-glibc', table(1, 0, 0).slice(0, 4)))).toBe(1)
  })

  it('fails when every prediction was undetermined', () => {
    expect(gate(makeOut('04-glibc', repeat(30, { determinate: false })))).toBe(1)
  })

  it('passes a table with no source builds at all, where the FN rate is undefined', () => {
    expect(gate(makeOut('05-glibc', repeat(30, { sourceBuild: false })))).toBe(0)
  })
})
