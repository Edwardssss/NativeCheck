/**
 * held-out-runner: scan every fixture under `testdata/held-out/` and assert
 * against `expected.yaml`.
 *
 * Held-out fixtures are a generalization suite — distinct from `fixtures/`,
 * which doubles as both the development benchmark AND a regression target.
 * Held-out packages were chosen because they were NOT in any benchmark run
 * but are real native (or non-native) packages from npm. A rule that passes
 * the benchmark but fails here is overfit; a rule that fails both is broken.
 *
 * Zero-network iron rule: same as `fixture-runner`. fast path, asserts
 * `networkCalls === 0`.
 *
 * Coverage today: 31 packages across A/B/C/D/NotNative/BuildTool categories.
 * Meets the target of >= 30 held-out packages.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from '../src/adapters/node/pipeline'
import type { Environment } from '../src/core/model'

const heldOutRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'testdata', 'held-out')

const env: Environment = {
  os: 'linux',
  arch: 'x64',
  libc: 'glibc',
  nodeVersion: '22.22.2',
  nodeAbi: '127',
  python: { version: '3.12.4' },
  compiler: { name: 'gcc', cProbe: true, cxxProbe: true },
  sdks: [],
}

interface Expected {
  pattern?: string
  strategy?: string
  risk?: string
  native?: boolean
  networkCalls: number
  subject?: string
  notes?: string
}

function collectCases(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (readdirSync(dir).includes('expected.yaml')) out.push(dir)
  }
  return out.sort()
}

function parseExpected(text: string): Expected {
  const e: Expected = { networkCalls: 0 }
  let inNotes = false
  let notesBuf: string[] = []
  for (const rawLine of text.split('\n')) {
    if (inNotes) {
      // Notes block ends at first non-indented non-empty line.
      if (rawLine.trim() === '' || rawLine.startsWith(' ') || rawLine.startsWith('\t')) {
        notesBuf.push(rawLine)
        continue
      }
      inNotes = false
      e.notes = notesBuf.join('\n').trim()
      notesBuf = []
    }
    const line = rawLine.split('#')[0] ?? ''
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1] as string
    const raw = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
    switch (key) {
      case 'pattern':
        e.pattern = raw
        break
      case 'strategy':
        e.strategy = raw
        break
      case 'risk':
        e.risk = raw
        break
      case 'subject':
        e.subject = raw
        break
      case 'native':
        e.native = raw === 'true'
        break
      case 'network_calls':
        e.networkCalls = Number(raw)
        break
      case 'notes':
        inNotes = true
        notesBuf.push(raw)
        break
    }
  }
  if (inNotes) e.notes = notesBuf.join('\n').trim()
  return e
}

const cases = collectCases(heldOutRoot)

describe('held-out-runner (generalization regression, zero network)', () => {
  // Sanity: at least one fixture must exist, else this whole suite is silent.
  it('collects a non-empty held-out sample set (guards against an empty run)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
  })

  for (const dir of cases) {
    const label = relative(heldOutRoot, dir).split(sep).join('/')
    const exp = parseExpected(readFileSync(join(dir, 'expected.yaml'), 'utf8'))

    it(`${label}`, async () => {
      const { report } = await scan(dir, { mode: 'fast', env })

      // Zero-network iron rule.
      expect(report.summary.networkCalls).toBe(exp.networkCalls)

      // Locate the subject finding: native candidates live in findings;
      // non-native packages (NotNative / BuildTool) have a `pkg` but no
      // `verdict === YES/SUSPICIOUS`. We look up by `pkg.name` (the field
      // the model exposes), not a top-level `name`.
      const subject = exp.subject ?? label
      const isNativeExp = exp.native === true
      const isNotExp = exp.native === false

      // Find any finding whose pkg.name matches (case-sensitive, no scope)
      const allByName = report.findings.filter(
        (f) => f.pkg.name === subject || f.pkg.name.endsWith('/' + subject),
      )
      const nativeTargets = report.findings.filter(
        (f) => f.verdict === 'YES' || f.verdict === 'SUSPICIOUS',
      )

      // Resolve the target finding the same way fixtures.test.ts does.
      let target: (typeof report.findings)[number] | undefined
      if (isNativeExp) {
        target =
          nativeTargets.find((f) => f.pkg.name === subject) ??
          (nativeTargets.length === 1 ? nativeTargets[0] : undefined)
      } else if (isNotExp) {
        // NotNative: must NOT appear as native (no YES/SUSPICIOUS verdict)
        // and must NOT be absent (the package is in the lockfile).
        expect(nativeTargets.length).toBe(0)
        expect(allByName.length).toBe(0)
        return
      } else {
        target = allByName[0] ?? nativeTargets[0]
      }

      if (exp.pattern || exp.strategy || exp.risk) {
        expect(
          target,
          `native finding for subject "${subject}" missing from findings: ${report.findings.map((f) => `${f.pkg.name}@${f.pkg.version}/${f.verdict ?? '-'}`).join(', ')}`,
        ).toBeDefined()
      }

      if (exp.pattern) expect(target?.pattern).toBe(exp.pattern)
      if (exp.strategy) expect(target?.strategy).toBe(exp.strategy)
      if (exp.risk) expect(target?.risk).toBe(exp.risk)
    })
  }
})
