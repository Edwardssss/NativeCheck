/**
 * Advisory check for the runtime dependency tree — the `npm run audit` step.
 *
 * Two outcomes, deliberately different:
 *
 * - **Advisories at or above the level** → exit 1, with the packages listed. That
 *   is the gate.
 * - **The advisory service could not be asked** (503 maintenance, DNS, offline) →
 *   exit 0 with a loud warning. On 2026-09-19 npm's endpoint answered 503 for
 *   maintenance and every run in this repository went red for a reason that had
 *   nothing to do with this code. A check about *our* dependency tree must not
 *   turn a third party's outage into a blocked merge or a blocked release: the
 *   next run retries, and "could not ask" failing the build is worse than the
 *   state this step replaced, where no one asked at all.
 *
 * Three details are load-bearing:
 *
 * - **The environment is sanitized before npm is spawned.** When `npm run`
 *   invokes npm again, it exports its own effective configuration as
 *   `npm_config_*`. A user-level `allow-scripts` entry (npm's opt-in mechanism
 *   for install scripts) then makes the child `npm audit` abort with
 *   `EALLOWSCRIPTS` before it ever looks at an advisory — working in CI and
 *   failing on the maintainer's machine, which is the wrong way round.
 * - **The registry is pinned** (`NATIVECHECK_AUDIT_REGISTRY` overrides it): the
 *   advisory endpoint only exists on a real registry, and mirrors answer
 *   `NOT_IMPLEMENTED`, which would turn a security gate into a silent no-op.
 * - **`--json` is parsed rather than scraped**, so "found advisories" and "could
 *   not ask" are distinguishable instead of both being "exit 1".
 *
 * `--omit=dev`: runtime dependencies are what users install, so a known advisory
 * in one of them is a release blocker.
 *
 * Test hooks (the behaviour above is tested without the network):
 * `NATIVECHECK_AUDIT_REPORT=<file>` decides from a captured `npm audit --json`
 * output instead of running npm, and `NATIVECHECK_AUDIT_ATTEMPTS=<n>` bounds the
 * retries.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REGISTRY = process.env.NATIVECHECK_AUDIT_REGISTRY ?? 'https://registry.npmjs.org'
const REPORT_FILE = process.env.NATIVECHECK_AUDIT_REPORT
const LEVEL = 'high'
const ATTEMPTS = Math.max(1, Number(process.env.NATIVECHECK_AUDIT_ATTEMPTS ?? '3') || 3)
/** Waits between attempts; a maintenance window outlasts these, a blip does not. */
const BACKOFF_MS = [0, 2_000, 5_000]

/** npm's own configuration, minus the keys that break a nested `npm` invocation. */
function sanitizedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
  }
  return env
}

function runNpmAudit() {
  const result = spawnSync(
    'npm',
    ['audit', '--omit=dev', `--audit-level=${LEVEL}`, '--json', `--registry=${REGISTRY}`],
    { encoding: 'utf8', env: sanitizedEnv(), shell: process.platform === 'win32' },
  )
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 }
}

function parseJson(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** The audit report npm prints for a successful request, or `undefined` when it could not ask. */
function reportFrom(text) {
  const parsed = parseJson(text)
  if (parsed === undefined) return undefined
  if (parsed.error !== undefined) return undefined // endpoint failure, not a report
  if (parsed.vulnerabilities === undefined || parsed.metadata === undefined) return undefined
  return parsed
}

/** Why the service could not be asked, in npm's own words where possible. */
function serviceFailure({ stdout, stderr, status }) {
  const failure =
    parseJson(stderr)?.message ?? parseJson(stdout)?.message ?? parseJson(stderr)?.error?.summary
  if (typeof failure === 'string' && failure.length > 0) return failure
  const line = `${stderr}\n${stdout}`
    .split('\n')
    .find((candidate) => candidate.includes('audit endpoint returned an error'))
  if (line !== undefined) return line.trim()
  return status === 0 ? undefined : `npm audit exited with code ${status} without a report`
}

function counts(report) {
  const metadata = report.metadata?.vulnerabilities ?? {}
  const atOrAbove = Number(metadata.high ?? 0) + Number(metadata.critical ?? 0)
  return { atOrAbove, total: Number(metadata.total ?? 0), metadata }
}

/** One line per affected package, direct or not, with its advisory title. */
function describe(report) {
  return Object.values(report.vulnerabilities ?? {}).map((entry) => {
    const via = Array.isArray(entry?.via)
      ? entry.via.find((item) => typeof item === 'object' && item !== null)
      : undefined
    const title = typeof via?.title === 'string' ? ` — ${via.title}` : ''
    const fix =
      entry?.fixAvailable === true
        ? ' (fix available)'
        : entry?.fixAvailable
          ? ` (upgrade to ${entry.fixAvailable.version})`
          : ' (no fix available)'
    const direct = entry?.isDirect === true ? 'direct' : 'transitive'
    return `  ${entry?.name ?? '?'} [${entry?.severity ?? '?'}] ${direct}${title}${fix}`
  })
}

function decideFrom(report) {
  const { atOrAbove, total, metadata } = counts(report)
  const summary = `total=${total} low=${metadata.low ?? 0} moderate=${metadata.moderate ?? 0} high=${metadata.high ?? 0} critical=${metadata.critical ?? 0}`
  if (atOrAbove === 0) {
    process.stdout.write(
      `audit: no advisories at or above ${LEVEL} in runtime dependencies (${summary})\n`,
    )
    return 0
  }
  process.stdout.write(
    `audit: ${atOrAbove} runtime advisory(ies) at or above ${LEVEL} (${summary})\n`,
  )
  for (const line of describe(report)) process.stdout.write(`${line}\n`)
  process.stdout.write(
    'audit: run `npm audit --omit=dev` for the full report and fix or pin the package.\n',
  )
  return 1
}

function main() {
  if (REPORT_FILE !== undefined) {
    const captured = readFileSync(REPORT_FILE, 'utf8')
    const report = reportFrom(captured)
    if (report === undefined) {
      const reason = parseJson(captured)?.message
      process.stdout.write(
        `::warning::audit: ${REPORT_FILE} is not an audit report${
          typeof reason === 'string' ? ` (${reason})` : ''
        }\n`,
      )
      return 0
    }
    return decideFrom(report)
  }

  let failure
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = runNpmAudit()
    const report = reportFrom(result.stdout)
    if (report !== undefined) return decideFrom(report)
    failure = serviceFailure(result)
    if (failure === undefined) return 0 // npm was happy without printing a report
    if (attempt < ATTEMPTS) {
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 0
      if (wait > 0) {
        process.stdout.write(`audit: unavailable (${failure}); retrying in ${wait}ms\n`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
      }
    }
  }

  process.stdout.write(`::warning::audit: could not check advisories: ${failure}\n`)
  process.stdout.write(
    'audit: treating an unreachable advisory service as "unchecked" rather than a failed build — ' +
      'the next run retries. A dependency tree with advisories still fails.\n',
  )
  return 0
}

process.exit(main())
