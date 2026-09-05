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

// fixtures/ 的绝对路径（本测试文件在 test/ 下，fixtures 在其同级）
const fixturesRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures')

/** 固定注入环境：linux-x64 + glibc + 齐全工具链。判定只依赖 A/B/C/D 的依赖边信号。 */
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

/** 递归收集所有含 expected.yaml 的 fixture 样本目录。 */
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

/** 极简 YAML 子集解析：`key: value`，支持 `#` 行内注释与行注释。够 expected.yaml 用。 */
function parseExpected(text: string): Expected {
  const e: Expected = { networkCalls: 0 }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0] ?? '' // 去掉注释
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

describe('fixture-runner（零网络回归）', () => {
  // 至少要有真实样本被加载，防止静默漏测（fixture 空跑 = 无回归保护）。
  it('收集到真实样本（防空跑）', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const dir of cases) {
    const label = relative(fixturesRoot, dir)
    const exp = parseExpected(readFileSync(join(dir, 'expected.yaml'), 'utf8'))

    it(`${label}`, async () => {
      const { report, unsupported } = await scan(dir, { mode: 'fast', env })

      // 零网络铁律：fast 恒 0 网络。
      expect(report.summary.networkCalls).toBe(exp.networkCalls)

      if (exp.unsupported) {
        // Fail Closed：不支持格式给出明确退出信息。
        expect(unsupported).toBeDefined()
        expect(unsupported?.detected).toBe(exp.detected)
        if (exp.reasonContains) expect(unsupported?.reason).toContain(exp.reasonContains)
        return
      }

      // 不支持格式不应混进来；否则视为误判。
      expect(unsupported).toBeUndefined()

      if (typeof exp.nativeCount === 'number') {
        // 对照组：断言候选总数。
        expect(report.summary.nativeCandidates).toBe(exp.nativeCount)
      }

      // 定位目标 finding：有 subject 用 subject 匹配；否则唯一 native 候选。
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
          `应找到 native 候选（dir=${label} subject=${exp.subject ?? '(单候选)'}）`,
        ).toBeDefined()
      }

      if (exp.pattern) expect(target?.pattern).toBe(exp.pattern)
      if (exp.strategy) expect(target?.strategy).toBe(exp.strategy)
      if (exp.risk) expect(target?.risk).toBe(exp.risk)

      // native:true 语义 = 存在被判定为 native 的候选；native:false = 无。
      if (exp.native === true) expect(targets.length).toBeGreaterThan(0)
      if (exp.native === false) expect(targets.length).toBe(0)
    })
  }
})
