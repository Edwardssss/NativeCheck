/**
 * Projection helper for the Windows ground-truth harness.
 *
 * Runs the CLI on one fixture and prints a three-field JSON line
 * (`pattern` / `risk` / `strategy` for the package under test).
 *
 * Why this exists instead of parsing the CLI's JSON in PowerShell: on Windows
 * PowerShell 5.1 decodes a child process's stdout with the console code page,
 * so the CLI's non-ASCII evidence text arrives as mojibake and `ConvertFrom-Json`
 * rejects the payload. Node captures the bytes as UTF-8, so the projection is
 * computed where the encoding is actually known.
 *
 * Usage: node predict.mjs <fixtureDir> <packageName>
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const [, , fixtureDir, packageName] = process.argv
if (!fixtureDir || !packageName) {
  console.error('usage: node predict.mjs <fixtureDir> <packageName>')
  process.exit(2)
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cli = join(repoRoot, 'src', 'cli', 'index.ts')

// `--deep` is deliberately NOT passed: the measurement asks what the tool
// concludes with zero network, which is the mode the iron rule is about.
// Runs the CLI as a Node child process directly: `npx.cmd` cannot be spawned
// without a shell on Windows (`EINVAL`), and a shell would concatenate arguments
// instead of escaping them. `--import tsx` lets the TypeScript entry point run
// without a build step, and the output is captured as UTF-8 bytes straight from
// the child, so nothing transcodes it on the way.
const run = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--no-warnings', cli, fixtureDir, '--json'],
  {
    encoding: 'utf8',
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  },
)

if (run.error || !run.stdout) {
  console.log(JSON.stringify({ error: run.error?.message ?? 'no output' }))
  process.exit(0)
}

let report
try {
  report = JSON.parse(run.stdout)
} catch (error) {
  console.log(JSON.stringify({ error: `unparseable CLI output: ${error.message}` }))
  process.exit(0)
}

const finding = (report.findings ?? []).find((f) => f.pkg?.name === packageName)
console.log(
  JSON.stringify({
    pattern: finding?.pattern ?? null,
    risk: finding?.risk ?? null,
    strategy: finding?.strategy ?? null,
    // The tool's own view of the shell it ran in: if this says the compiler is
    // unusable, every "predicted compile" in the table is describing a machine
    // state, not the package.
    compilerUsable: report.environment?.compiler?.cxxProbe ?? null,
    compilerVia: report.environment?.compiler?.viaToolchainEnv ?? null,
    networkCalls: report.summary?.networkCalls ?? null,
  }),
)
