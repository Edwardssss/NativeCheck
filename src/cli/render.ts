/**
 * Terminal rendering: turn a ScanReport / environment snapshot into the kind of
 * text block shown in the README examples.
 *
 * Maps to design doc §2, §11.3, §11.4. Kept as pure functions so it is
 * testable — no console is passed in.
 */
import pc from 'picocolors'
import type { ScanReport, PackageFinding } from '../core/report'
import type { Environment } from '../core/model'
import { RISK_META } from '../core/risk'
import { MARKER, RELIABILITY_LABEL } from '../core/evidence'

/** Top banner. */
export function renderHeader(): string {
  return pc.bold('NativeCheck')
}

/** Summary block. */
export function renderSummary(report: ScanReport): string {
  const { summary } = report
  const lines: string[] = [
    '',
    pc.dim('Dependency scan'),
    `  ${summary.totalPackages} packages · ${summary.nativeCandidates} native candidates`,
    // Transparency: silently dropping packages would look like a miss.
    ...(summary.platformExcluded
      ? [pc.dim(`  ${summary.platformExcluded} optional packages skipped: platform not applicable`)]
      : []),
    // Same reasoning: a silently skipped package looks like a miss.
    ...(summary.workspaceMembers?.length
      ? [
          pc.dim(
            `  workspace members (own source, never reported as third-party candidates): ${summary.workspaceMembers.join(', ')}`,
          ),
        ]
      : []),
    '',
    pc.dim('Result'),
    `  ${RISK_META.LOW.badge} ${summary.byRisk.LOW ?? 0} prebuilt-compatible`,
    `  ${RISK_META.MEDIUM.badge} ${summary.byRisk.MEDIUM ?? 0} source-build`,
    `  ${RISK_META.HIGH.badge} ${summary.byRisk.HIGH ?? 0} likely blocked`,
    `  ${RISK_META.UNVERIFIED.badge} ${summary.byRisk.UNVERIFIED ?? 0} unverified`,
    // AMBIGUOUS used to be counted in byRisk but never rendered, so the four
    // visible numbers silently failed to add up to `native candidates`.
    `  ${RISK_META.AMBIGUOUS.badge} ${summary.byRisk.AMBIGUOUS ?? 0} ambiguous`,
    summary.networkCalls === 0
      ? pc.dim(`  network calls: 0`)
      : pc.dim(`  network calls: ${summary.networkCalls}`),
  ]
  return lines.join('\n')
}

/** Evidence block for a single package. */
export function renderFinding(finding: PackageFinding): string {
  const meta = RISK_META[finding.risk]
  const name = `${finding.pkg.name}@${finding.pkg.version}`
  // Monorepo attribution: without it a finding reads "this project depends on
  // sharp", which in a 40-package workspace is not actionable.
  const owned = finding.pkg.workspaces?.length
    ? `  ${pc.dim(`(workspaces: ${finding.pkg.workspaces.join(', ')})`)}`
    : ''
  const lines: string[] = [
    '',
    `${meta.badge} ${pc.bold(name)}  ${pc.dim(meta.label.toUpperCase())}${owned}`,
  ]

  if (finding.paths.length > 0) {
    lines.push('', pc.dim('Dependency path'))
    for (const path of finding.paths) {
      lines.push(`  ${path.chain.join('\n    └─ ')}`)
    }
  }

  lines.push('', pc.dim('Evidence'))
  for (const item of finding.evidence) {
    const mark = MARKER[item.reliability]
    const label = RELIABILITY_LABEL[item.reliability]
    lines.push(`  ${mark} ${item.description}  [${pc.dim(label)}]`)
  }

  if (finding.blockers.length > 0) {
    lines.push('', pc.dim('Blockers'))
    for (const blocker of finding.blockers) {
      lines.push(`  ✗ ${blocker.name}: ${blocker.detail}`)
      if (blocker.remedy) lines.push(`    ${pc.dim(`→ ${blocker.remedy}`)}`)
    }
  }

  if (finding.resolveHint) {
    lines.push('', pc.dim('To resolve'), `  ${finding.resolveHint}`)
  }

  if (finding.allowScripts) {
    lines.push(
      '',
      pc.dim('npm allowScripts'),
      `  ${pc.yellow('⚠')} ${finding.allowScripts.detail}`,
      `    ${pc.dim(`→ ${finding.allowScripts.remedy}`)}`,
    )
  }

  if (finding.systemLibs) {
    lines.push(
      '',
      pc.dim('System library'),
      `  ${pc.yellow('⚠')} ${finding.systemLibs.detail}`,
      `    ${pc.dim(`→ ${finding.systemLibs.remedy}`)}`,
    )
  }
  return lines.join('\n')
}

/** Full human-readable report. */
export function renderReport(report: ScanReport): string {
  const parts: string[] = [renderHeader(), renderSummary(report)]

  if (report.unsupported) {
    parts.push(
      '',
      pc.yellow('Unsupported project format'),
      `  ${report.unsupported.detected}`,
      `  ${report.unsupported.reason}`,
      // The field was in the JSON contract but never rendered, so the user was
      // left guessing what the tool can actually read.
      `  ${pc.dim(`supported: ${report.unsupported.supported.join(' · ')}`)}`,
    )
    parts.push(`  ${pc.dim('No analysis performed.')}`)
    return parts.join('\n')
  }

  for (const finding of report.findings) {
    parts.push(renderFinding(finding))
  }
  return parts.join('\n') + '\n'
}

/** Environment check-up output (`nativecheck env`). */
export function renderEnvironment(env: Environment): string {
  const lines: string[] = [
    renderHeader(),
    '',
    pc.dim('Environment'),
    `  ${env.os} ${env.arch} · Node ${env.nodeVersion ?? '?'}${env.nodeAbi ? ` (ABI ${env.nodeAbi})` : ''}${
      env.npmVersion ? ` · npm ${env.npmVersion}` : ''
    }${env.libc ? ` · libc ${env.libc}` : ''}`,
  ]
  if (env.python?.version)
    lines.push(`  Python ${env.python.version}${env.python.path ? ` (${env.python.path})` : ''}`)
  if (env.compiler) {
    lines.push(
      `  C/C++ ${env.compiler.name}${env.compiler.version ? ` ${env.compiler.version}` : ''}${
        env.compiler.path ? ` (${env.compiler.path})` : ''
      }`,
      `    C probe  ${env.compiler.cProbe ? '✓ compiles' : '✗ failed'}`,
      `    C++ probe ${env.compiler.cxxProbe ? '✓ compiles' : '✗ failed'}`,
    )
  } else {
    lines.push(pc.yellow('  C/C++ compiler: not found'))
  }
  return lines.join('\n')
}
