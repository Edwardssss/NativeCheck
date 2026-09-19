#!/usr/bin/env node
/**
 * NativeCheck CLI entry point.
 *
 * Command contract (V0.1 ships scan (default) / env / explain / target):
 *   nativecheck                 # equivalent to `scan .`, --fast: 0 network calls
 *   nativecheck .               # scan a project root (default command; a directory as first arg works)
 *   nativecheck <dir> --deep    # online forensics for B/C prebuilt artifacts (1–3s, results cached)
 *   nativecheck <dir> --json    # machine-readable JSON (constrained by a zod schema)
 *   nativecheck <dir> --ci      # CI: non-zero exit when a blocker / HIGH risk exists
 *   nativecheck env             # environment check-up
 *   nativecheck explain <pkg>   # evidence chain for a single package
 *   nativecheck target <pkg>[@version] [--deep] [--json]  # single-package diagnostic
 *
 * Lazy loading: `@npmcli/arborist` (the dominant ~1.6s cold-start cost) and `zod`
 * are pulled only by the scan/explain/target paths. This entry therefore keeps its
 * imports light and loads those heavy modules on demand per sub-command, so `env`,
 * `--help`, and argument errors start fast. The library entry (`src/index.ts`) stays
 * fully eager for programmatic consumers; only the CLI defers.
 *
 * Why manual dispatch: citty's `findSubCommandIndex` treats the first non-flag
 * token (e.g. `.`) as a sub-command name and cannot express "scan by default with
 * a directory as the positional". So we use citty's `parseArgs` for type-safe flag
 * parsing and do the outermost sub-command routing here.
 */
import pc from 'picocolors'
import { resolve } from 'node:path'
import { parseArgs } from 'citty'
import { scanEnvironment } from '../env'
import { renderEnvironment, renderReport } from './render'
import { summarize, type ScanReport } from '../core/report'

/** Flag definitions for scan (citty, type-safe). */
const SCAN_ARGS = {
  dir: { type: 'positional' as const, description: '项目根目录（默认 .）' },
  deep: { type: 'boolean' as const, description: '联网取证 B/C 模式预编译产物' },
  json: { type: 'boolean' as const, description: '输出机器可读 JSON' },
  ci: { type: 'boolean' as const, description: 'CI 模式：有阻塞/HIGH 风险时非零退出' },
  cache: {
    type: 'boolean' as const,
    default: true,
    description: '--deep 取证磁盘缓存（--no-cache 关闭；命中零网络）',
  },
}

const HELP = `${pc.bold('nativecheck')} — ${pc.dim('本地优先的 native 依赖兼容性诊断工具')}

用法:
  nativecheck [dir] [--deep] [--json] [--ci]           扫描项目（默认 .）
  nativecheck [dir] --deep --no-cache                  深扫但不写/不读取证缓存
  nativecheck env                                      环境体检
  nativecheck explain <pkg>                            单个 native 候选的证据链
  nativecheck target <pkg>[@version] [--deep] [--json] 单包诊断（无需 lockfile / Docker）
  nativecheck --help                                   显示帮助`

async function runScan(
  dir: string,
  flags: { deep?: boolean; json?: boolean; ci?: boolean; cache?: boolean },
): Promise<void> {
  const projectRoot = resolve(dir || '.')
  const { scan } = await import('../adapters/node/pipeline')
  const { report } = await scan(projectRoot, {
    mode: flags.deep ? 'deep' : 'fast',
    // --no-cache → cache:false → explicitly disable the disk cache; fast mode never writes anyway.
    cachePath: flags.cache === false ? null : undefined,
  })

  if (flags.json) {
    // The zod validation guarantees the JSON contract; it is also dogfooding of the schema.
    const { scanReportSchema } = await import('../core/schema')
    console.log(JSON.stringify(scanReportSchema.parse(report), null, 2))
  } else {
    console.log(renderReport(report))
  }

  // --ci: any blocker or HIGH risk → non-zero exit; unsupported format → 2
  if (flags.ci) {
    const hasBlocker = report.findings.some((f) => f.blockers.length > 0)
    if (hasBlocker || report.summary.byRisk.HIGH > 0) process.exitCode = 1
  }
  if (report.unsupported) process.exitCode = 2
}

async function runEnv(): Promise<void> {
  console.log(renderEnvironment(scanEnvironment()))
}

async function runExplain(query: string): Promise<void> {
  const projectRoot = resolve('.')
  const { scan } = await import('../adapters/node/pipeline')
  const { report } = await scan(projectRoot, { mode: 'fast' })
  const bareName = query.split('@')[0]
  const hit = report.findings.find((f) => f.pkg.name === query || f.pkg.name === bareName)
  if (!hit) {
    console.log(pc.yellow(`nativecheck explain: 在 ${projectRoot} 未找到 native 候选「${query}」`))
    process.exitCode = 1
    return
  }
  const single: ScanReport = {
    ...report,
    findings: [hit],
    // Keep the project's real package total: reporting "1 packages" for a project
    // with hundreds of dependencies is just wrong at the top of the block.
    summary: summarize([hit], report.summary.totalPackages, 0),
  }
  console.log(renderReport(single))
}

/** Single-package debug mode: no lockfile / Docker needed, classifies one package live. */
async function runTarget(
  query: string | undefined,
  flags: { deep?: boolean; json?: boolean },
): Promise<void> {
  if (!query) {
    console.log(`${pc.yellow('用法:')} nativecheck target <pkg>[@version] [--deep] [--json]`)
    process.exitCode = 1
    return
  }
  const { scanTarget } = await import('../adapters/node/target')
  const report = await scanTarget(query, { deep: flags.deep })
  if (flags.json) {
    const { scanReportSchema } = await import('../core/schema')
    console.log(JSON.stringify(scanReportSchema.parse(report), null, 2))
  } else {
    console.log(renderReport(report))
  }
}

/** Top-level dispatch. Returns true when handled; false means "show help". */
async function dispatch(argv: readonly string[]): Promise<boolean> {
  const first = argv[0]
  if (first === 'env') {
    await runEnv()
    return true
  }
  if (first === 'explain') {
    const query = argv[1]
    if (!query) {
      console.log(`${pc.yellow('用法:')} nativecheck explain <pkg>`)
      process.exitCode = 1
      return true
    }
    await runExplain(query)
    return true
  }
  if (first === 'target') {
    const query = argv[1]
    const rest = argv.slice(2)
    await runTarget(query, {
      deep: rest.includes('--deep'),
      json: rest.includes('--json'),
    })
    return true
  }
  // Anything else (`.`, a directory, or a bare --flag) is treated as scan.
  const parsed = parseArgs([...argv], SCAN_ARGS)
  // citty puts positionals into `dir`; fall back to `_`, then to the current directory.
  const positionals = parsed._ ?? []
  const rawDir = typeof parsed.dir === 'string' && parsed.dir ? parsed.dir : positionals[0]
  await runScan(rawDir ?? '.', {
    deep: Boolean(parsed.deep),
    json: Boolean(parsed.json),
    ci: Boolean(parsed.ci),
    cache: parsed.cache !== false, // citty normalizes --no-cache into cache:false
  })
  return true
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // No args or help requested → show help; otherwise dispatch on the first token (. / directory / env / explain…)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  await dispatch(argv)
}

main().catch((error: unknown) => {
  console.error(pc.red(`nativecheck: ${error instanceof Error ? error.message : String(error)}`))
  process.exitCode = 1
})
