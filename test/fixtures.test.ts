/**
 * fixture-runner: scan every real sample under fixtures/ and assert against expected.yaml.
 *
 * Zero-network iron rule: every sample runs `scan(<dir>, { mode: 'fast' })` and
 * asserts `networkCalls === 0` (the hard premise of fixtures/README). The samples
 * are real `npm install --package-lock-only` output, readable directly by
 * arborist loadVirtual.
 *
 * A fixed injected environment is used instead of the real scanEnvironment():
 * pattern decisions for A/B/C do not depend on env, and for pattern D we
 * deliberately do not pin the risk (it is env-dependent), so a fixed env keeps
 * the tests deterministic and avoids the compiler-probe cost.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from '../src/adapters/node/pipeline'
import type { Environment } from '../src/core/model'

// Absolute path to fixtures/ (this test file lives in test/, fixtures is its sibling)
const fixturesRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures')

/** Fixed env: linux-x64 + glibc + full toolchain. Decisions rest on A/B/C/D edge signals. */
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
  unsupported?: boolean
  detected?: string
  reasonContains?: string
  native?: boolean
  nativeCount?: number
  pattern?: string
  strategy?: string
  risk?: string
  subject?: string
  networkCalls: number
}

/** Recursively collect every fixture sample directory that contains expected.yaml. */
function collectCases(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.name === 'expected.yaml') out.push(dir)
    }
  }
  walk(root)
  return out.sort()
}

/** Minimal YAML subset: `key: value` with `#` comments. Enough for expected.yaml. */
function parseExpected(text: string): Expected {
  const e: Expected = { networkCalls: 0 }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0] ?? '' // strip the comment
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
      case 'native_count':
        e.nativeCount = Number(raw)
        break
      case 'network_calls':
        e.networkCalls = Number(raw)
        break
      case 'unsupported':
        e.unsupported = raw === 'true'
        break
      case 'detected':
        e.detected = raw
        break
      case 'reason_contains':
        e.reasonContains = raw
        break
    }
  }
  return e
}

const cases = collectCases(fixturesRoot)

describe('fixture-runner (zero-network regression)', () => {
  // At least one real sample must load; an empty run would mean no regression cover at all.
  it('collects real samples (guards against an empty run)', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const dir of cases) {
    const label = relative(fixturesRoot, dir)
    const exp = parseExpected(readFileSync(join(dir, 'expected.yaml'), 'utf8'))

    it(`${label}`, async () => {
      const { report, unsupported } = await scan(dir, { mode: 'fast', env })

      // Zero-network iron rule: fast always reports 0 network calls.
      expect(report.summary.networkCalls).toBe(exp.networkCalls)

      if (exp.unsupported) {
        // Fail Closed: an unsupported format gives an explicit exit message.
        expect(unsupported).toBeDefined()
        expect(unsupported?.detected).toBe(exp.detected)
        if (exp.reasonContains) expect(unsupported?.reason).toContain(exp.reasonContains)
        return
      }

      // An unsupported format must not slip through here; if it does, this is a misjudgement.
      expect(unsupported).toBeUndefined()

      if (typeof exp.nativeCount === 'number') {
        // Control group: assert the total candidate count.
        expect(report.summary.nativeCandidates).toBe(exp.nativeCount)
      }

      // Locate the target finding: match by subject when given, else the single candidate.
      const targets = report.findings.filter(
        (f) => f.verdict === 'YES' || f.verdict === 'SUSPICIOUS',
      )
      const target = exp.subject
        ? targets.find((f) => f.pkg.name === exp.subject)
        : targets.length === 1
          ? targets[0]
          : undefined
      if (exp.pattern || exp.strategy || exp.risk) {
        expect(
          target,
          `expected a native candidate (dir=${label} subject=${exp.subject ?? '(single candidate)'})`,
        ).toBeDefined()
      }

      if (exp.pattern) expect(target?.pattern).toBe(exp.pattern)
      if (exp.strategy) expect(target?.strategy).toBe(exp.strategy)
      if (exp.risk) expect(target?.risk).toBe(exp.risk)

      // native:true means a candidate was judged native; native:false means there is none.
      if (exp.native === true) expect(targets.length).toBeGreaterThan(0)
      if (exp.native === false) expect(targets.length).toBe(0)
    })
  }
})
