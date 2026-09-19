/**
 * `scripts/audit.mjs` decides whether advisories block a build, and the part
 * that matters is telling **"found advisories"** apart from **"could not ask"**.
 *
 * On 2026-09-19 npm's advisory endpoint answered 503 for maintenance and the gate
 * turned a third party's outage into a red build — and into a blocked release,
 * since the publish pipeline runs the same step. These cases pin the contract:
 * advisories fail the build, an unreachable service warns and passes.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const script = join(repoRoot, 'scripts', 'audit.mjs')
const workRoot = mkdtempSync(join(tmpdir(), 'nativecheck-audit-'))

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true })
})

interface AuditReport {
  readonly vulnerabilities: Record<string, unknown>
  readonly metadata: { readonly vulnerabilities: Record<string, number> }
}

function captured(name: string, body: unknown): string {
  const file = join(workRoot, name)
  writeFileSync(file, JSON.stringify(body))
  return file
}

function runAudit(env: Readonly<Record<string, string>>): { status: number; output: string } {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
}

const clean: AuditReport = {
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
}

const withHighAdvisory: AuditReport = {
  vulnerabilities: {
    tar: {
      name: 'tar',
      severity: 'high',
      isDirect: true,
      via: [{ title: 'arbitrary file write', url: 'https://example.test/advisory/1' }],
      fixAvailable: { name: 'tar', version: '7.5.22', isSemVerMajor: false },
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
}

/** What npm prints when the advisory endpoint itself fails (the 503 of 2026-09-19). */
const endpointFailure = {
  message:
    '503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - We are currently performing maintenance.',
  error: { summary: '', detail: '' },
}

describe('audit script', () => {
  it('passes a report with nothing at or above the level', () => {
    const result = runAudit({ NATIVECHECK_AUDIT_REPORT: captured('clean.json', clean) })
    expect(result.status).toBe(0)
    expect(result.output).toContain('no advisories at or above high')
  })

  it('fails a report with a high advisory, and says which package', () => {
    const result = runAudit({ NATIVECHECK_AUDIT_REPORT: captured('high.json', withHighAdvisory) })
    expect(result.status).toBe(1)
    expect(result.output).toContain('tar')
    expect(result.output).toContain('arbitrary file write')
  })

  it('warns instead of failing when npm only printed an endpoint failure', () => {
    const result = runAudit({
      NATIVECHECK_AUDIT_REPORT: captured('maintenance.json', endpointFailure),
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain('::warning::')
    expect(result.output).toContain('maintenance')
  })

  it('warns instead of failing when the registry cannot be reached', () => {
    const result = runAudit({
      NATIVECHECK_AUDIT_REGISTRY: 'https://registry.invalid.example',
      NATIVECHECK_AUDIT_ATTEMPTS: '2',
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain('retrying') // the retry ran before giving up
    expect(result.output).toContain('::warning::')
  }, 30_000) // The retry backoff plus npm's own DNS lookup exceed the 5s default.
})
