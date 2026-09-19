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
import { readFileSync } from 'node:fs'
import { parseArgs } from 'citty'
import { scanEnvironment } from '../env'
import { renderEnvironment, renderGate, renderReport } from './render'
import { summarize, type ScanReport } from '../core/report'
import {
  evaluateGate,
  FAIL_ON_LEVELS,
  parseBaseline,
  parseIgnoreList,
  matchesIgnore,
  type FailOn,
} from '../core/gate'

/** Flag definitions for scan (citty, type-safe). */
const SCAN_ARGS = {
  dir: { type: 'positional' as const, description: 'project root directory (default: .)' },
  deep: {
    type: 'boolean' as const,
    description: 'fetch remote artifacts to verify patterns B / C',
  },
  json: { type: 'boolean' as const, description: 'emit machine-readable JSON' },
  ci: { type: 'boolean' as const, description: 'CI mode: exit non-zero when the gate fails' },
  ignore: {
    type: 'string' as const,
    description:
      'comma-separated package names (supports *), marked ignored and kept out of the gate',
  },
  'fail-on': {
    type: 'string' as const,
    description: 'CI failure threshold: blocker (default) | high | medium | never',
  },
  baseline: {
    type: 'string' as const,
    description: 'compare against a previous --json report and fail only on new or worse findings',
  },
  cache: {
    type: 'boolean' as const,
    default: true,
    description:
      'on-disk forensics cache for --deep (--no-cache disables it; a hit costs no network)',
  },
  proxy: {
    type: 'string' as const,
    description:
      'HTTP proxy for forensics requests (defaults to HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NC_PROXY)',
  },
}

const HELP = `${pc.bold('nativecheck')} — ${pc.dim('local-first native dependency compatibility diagnostics')}

Usage:
  nativecheck [dir] [--deep] [--json] [--ci]                scan a project (default: .)
  nativecheck [dir] --ci --fail-on <level> --ignore <pkgs>  CI gate (add --baseline to fail only on new findings)
  nativecheck [dir] --deep --no-cache                       deep scan without reading or writing the cache
  nativecheck env                                           environment check-up
  nativecheck explain <pkg>                                 evidence chain for one native candidate
  nativecheck target <pkg>[@version] [--deep] [--json]      diagnose one package (no lockfile / Docker needed)
  nativecheck --help                                        show this help`

async function runScan(
  dir: string,
  flags: {
    deep?: boolean
    json?: boolean
    ci?: boolean
    cache?: boolean
    proxy?: string
    ignore?: readonly string[]
    failOn?: FailOn
    baselinePath?: string
  },
): Promise<void> {
  const projectRoot = resolve(dir || '.')
  const { scan } = await import('../adapters/node/pipeline')
  const { report: scanned } = await scan(projectRoot, {
    mode: flags.deep ? 'deep' : 'fast',
    // --no-cache → cache:false → explicitly disable the disk cache; fast mode never writes anyway.
    cachePath: flags.cache === false ? null : undefined,
    ...(flags.proxy ? { proxy: flags.proxy } : {}),
  })

  // `--ignore` marks rather than drops: the report stays a full census, the gate
  // just stops treating those packages as the build's problem.
  const ignore = flags.ignore ?? []
  const report: ScanReport = ignore.length
    ? {
        ...scanned,
        findings: scanned.findings.map((f) =>
          matchesIgnore(f.pkg.name, ignore) ? { ...f, ignored: true } : f,
        ),
      }
    : scanned

  const baseline = readBaseline(flags.baselinePath)
  const decision = evaluateGate(report.findings, {
    failOn: flags.failOn ?? 'blocker',
    ignore,
    ...(baseline ? { baseline } : {}),
  })

  if (flags.json) {
    // The zod validation guarantees the JSON contract; it is also dogfooding of the schema.
    const { scanReportSchema } = await import('../core/schema')
    console.log(JSON.stringify(scanReportSchema.parse(report), null, 2))
  } else {
    console.log(renderReport(report))
    const gate = renderGate(decision)
    if (gate) console.log(gate)
  }

  // --ci: fail when the gate says so; unsupported format → 2
  if (flags.ci && decision.failed) process.exitCode = 1
  if (report.unsupported) process.exitCode = 2
}

/** Read a baseline file; a broken/missing baseline is reported and ignored (it must not mask real findings). */
function readBaseline(path: string | undefined): ReturnType<typeof parseBaseline> {
  if (!path) return undefined
  try {
    const baseline = parseBaseline(readFileSync(resolve(path), 'utf8'))
    if (!baseline) {
      console.error(
        pc.yellow(
          `nativecheck: cannot parse the baseline (expected previous --json output): ${path}`,
        ),
      )
    }
    return baseline
  } catch (error) {
    console.error(
      pc.yellow(
        `nativecheck: failed to read the baseline: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return undefined
  }
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
    console.log(
      pc.yellow(`nativecheck explain: no native candidate matching "${query}" in ${projectRoot}`),
    )
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
  flags: { deep?: boolean; json?: boolean; proxy?: string },
): Promise<void> {
  if (!query) {
    console.log(`${pc.yellow('Usage:')} nativecheck target <pkg>[@version] [--deep] [--json]`)
    process.exitCode = 1
    return
  }
  const { scanTarget } = await import('../adapters/node/target')
  const report = await scanTarget(query, {
    deep: flags.deep,
    ...(flags.proxy ? { proxy: flags.proxy } : {}),
  })
  if (flags.json) {
    const { scanReportSchema } = await import('../core/schema')
    console.log(JSON.stringify(scanReportSchema.parse(report), null, 2))
  } else {
    console.log(renderReport(report))
  }
}

/** Flags the scan path understands; anything else is a typo, not a feature. */
const SCAN_FLAGS = new Set([
  '--deep',
  '--json',
  '--ci',
  '--cache',
  '--no-cache',
  '--proxy',
  '--ignore',
  '--fail-on',
  '--baseline',
  '--help',
  '-h',
])
const TARGET_FLAGS = new Set(['--deep', '--json', '--proxy', '--help', '-h'])

/** Unknown `--flags` — citty silently collects them as extra booleans, so a typo
 * like `--depp` would just do nothing. Reject them explicitly instead. */
function unknownFlags(argv: readonly string[], known: ReadonlySet<string>): string[] {
  return argv.filter((arg) => {
    if (!arg.startsWith('-')) return false
    // `--proxy=https://…` and `--fail-on=medium` are the same flags as
    // `--proxy https://…` and `--fail-on medium`
    return !known.has(arg.split('=')[0] ?? arg)
  })
}

/** Value of `--name <value>` or `--name=<value>`, without pulling in a parser. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
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
      console.log(`${pc.yellow('Usage:')} nativecheck explain <pkg>`)
      process.exitCode = 1
      return true
    }
    await runExplain(query)
    return true
  }
  if (first === 'target') {
    const query = argv[1]
    const rest = argv.slice(2)
    const bad = unknownFlags(rest, TARGET_FLAGS)
    if (bad.length > 0) {
      console.log(`${pc.yellow('unknown option:')} ${bad.join(' ')}`)
      console.log(`${pc.yellow('Usage:')} nativecheck target <pkg>[@version] [--deep] [--json]`)
      process.exitCode = 1
      return true
    }
    await runTarget(query, {
      deep: rest.includes('--deep'),
      json: rest.includes('--json'),
      ...(flagValue(rest, '--proxy') ? { proxy: flagValue(rest, '--proxy') as string } : {}),
    })
    return true
  }
  // Anything else (`.`, a directory, or a bare --flag) is treated as scan.
  const bad = unknownFlags(argv, SCAN_FLAGS)
  if (bad.length > 0) {
    console.log(`${pc.yellow('unknown option:')} ${bad.join(' ')}`)
    console.log(HELP)
    process.exitCode = 1
    return true
  }
  const failOn = flagValue(argv, '--fail-on')
  if (failOn !== undefined && !FAIL_ON_LEVELS.includes(failOn as FailOn)) {
    console.log(
      `${pc.yellow('invalid --fail-on value:')} ${failOn} (choose from: ${FAIL_ON_LEVELS.join(' | ')})`,
    )
    process.exitCode = 1
    return true
  }
  const ignoreList = parseIgnoreList(flagValue(argv, '--ignore'))
  const baselinePath = flagValue(argv, '--baseline')
  const parsed = parseArgs([...argv], SCAN_ARGS)
  // citty puts positionals into `dir`; fall back to `_`, then to the current directory.
  const positionals = parsed._ ?? []
  const rawDir = typeof parsed.dir === 'string' && parsed.dir ? parsed.dir : positionals[0]
  await runScan(rawDir ?? '.', {
    deep: Boolean(parsed.deep),
    json: Boolean(parsed.json),
    ci: Boolean(parsed.ci),
    cache: parsed.cache !== false, // citty normalizes --no-cache into cache:false
    ...(typeof parsed.proxy === 'string' && parsed.proxy ? { proxy: parsed.proxy } : {}),
    ...(ignoreList.length > 0 ? { ignore: ignoreList } : {}),
    ...(failOn ? { failOn: failOn as FailOn } : {}),
    ...(baselinePath ? { baselinePath } : {}),
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
