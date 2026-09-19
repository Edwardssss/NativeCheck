/**
 * Layer 3 — Match (purely local, zero network).
 *
 * Design doc §10.4. Compatibility is decided with **rule tables**, not scoring.
 * Input: native candidates from Layer 1 classification + the current
 * environment snapshot. Output: a `PackageFinding` with a complete evidence
 * chain, reliability annotation and risk level.
 *
 * The real risk for Pattern A is not "is there a prebuilt" but "is there a
 * prebuilt for *my* platform" — zero matches is the genuine HIGH.
 */
import { evidence, Reliability, weakestReliability, type Evidence } from '../../core/evidence'
import {
  DistributionPattern,
  InstallStrategy,
  NativeVerdict,
  type Artifact,
  type Blocker,
  type BuildRequirement,
  type Environment,
  type PackageRef,
} from '../../core/model'
import {
  type AllowScriptsNote,
  type FallbackPlan,
  type PackageFinding,
  type SystemLibNote,
} from '../../core/report'
import { RiskLevel } from '../../core/risk'
import type { NativeCandidate } from './classify'
import { matchesPlatform } from './classify'
import { allowScriptsPolicy } from './npm-policy'
import type { LockfilePackage } from './signals'
import { systemLibHint } from './system-libs'
import type { VerifyOutcome } from './verify'
import { toolchainBlockers } from './verify'

export interface MatchInput {
  readonly candidate: NativeCandidate
  readonly env: Environment
  /** --deep forensics result. Absent = fast mode, where B/C are honestly marked UNVERIFIED. */
  readonly verify?: VerifyOutcome
}

/** Promote a lockfile package into a report `PackageRef`. */
function toPackageRef(pkg: LockfilePackage): PackageRef {
  return {
    name: pkg.name,
    version: pkg.version,
    ecosystem: 'node',
    paths: pkg.pathChains.map((chain) => ({
      chain,
      dev: pkg.dev ?? false,
      optional: pkg.optional ?? false,
    })),
    raw: {
      os: pkg.os,
      cpu: pkg.cpu,
      libc: pkg.libc,
      hasInstallScript: pkg.hasInstallScript,
    },
  }
}

/** Whether the package relies on executing code at install time to get native functionality (compile / download / pick a binary). */
function reliesOnInstallScript(
  pattern: DistributionPattern,
  hasInstallScript: boolean | undefined,
  hasBindingGyp: boolean | undefined,
): boolean {
  // D / C necessarily compile / download at install time (node-gyp rebuild is an implicit or explicit install script).
  if (pattern === DistributionPattern.SourceOnly) return true
  if (pattern === DistributionPattern.RemoteDownload) return true
  // B (prebuildify) itself picks at runtime via node-gyp-build and has no install
  // script, but a tarball containing binding.gyp triggers npm's implicit
  // node-gyp rebuild (code execution at install time) → that also counts as relying on it.
  // (A no-op for packages with a prebuild_exists guard like better-sqlite3, but a
  // real compile for packages without one.)
  if (pattern === DistributionPattern.Prebuildify && hasBindingGyp === true) return true
  // Otherwise: any explicit install script recorded in the lockfile (S2) counts,
  // regardless of pattern — allowScripts blocks exactly that script (A's
  // esbuild/sharp pick-or-download script, SUSPICIOUS postinstall, etc.).
  return hasInstallScript === true
}

/**
 * Build the npm allowScripts note. Returned only when npm is 11.16+ (advisory) /
 * 12+ (blocked) and the package relies on executing code at install time;
 * suppressed when `scriptBenign` (--deep already confirmed the install script is
 * benign). This is an independent dimension: it changes neither risk nor
 * blockers, so it does not affect the L2 four-square table.
 */
function buildAllowScriptsNote(
  name: string,
  pattern: DistributionPattern,
  hasInstallScript: boolean | undefined,
  npmVersion: string | undefined,
  scriptBenign: boolean,
  hasBindingGyp: boolean | undefined,
): AllowScriptsNote | undefined {
  if (scriptBenign) return undefined
  const policy = allowScriptsPolicy(npmVersion)
  if (policy === 'scripts-run') return undefined
  if (!reliesOnInstallScript(pattern, hasInstallScript, hasBindingGyp)) return undefined

  const blocked = policy === 'blocked'
  const what =
    pattern === DistributionPattern.SourceOnly
      ? '编译（node-gyp rebuild）'
      : pattern === DistributionPattern.RemoteDownload
        ? '下载预编译产物（prebuild-install / node-pre-gyp）'
        : pattern === DistributionPattern.Prebuildify
          ? '隐式 node-gyp rebuild（tarball 含 binding.gyp）'
          : 'install 脚本（可能编译 / 下载原生产物）'
  return {
    policy,
    detail: `npm ${npmVersion ?? '未知'} ${blocked ? '默认阻止' : '将默认阻止（当前仅告警）'} install 脚本（allowScripts${blocked ? ' 默认关闭' : ''}）——本包依赖 ${what}，脚本被跳过会「安装成功但产物缺失」`,
    remedy: `在 package.json 的 allowScripts 批准 ${name}（npm approve-scripts ${name}），或 npm install --allow-scripts=${name}`,
  }
}

/**
 * Build the full finding for a single candidate — the layer that stitches L1
 * (what it is) together with env (what is missing).
 * Whether the platform sub-packages / prebuilds really match the current
 * platform is evidence only L2 (--deep, or a real lockfile) can provide, so in
 * fast mode we default to Unverified: this keeps UNVERIFIED/AMBIGUOUS separate
 * from HIGH and never presents "unverified" as "dangerous".
 */
export function matchCandidate(input: MatchInput): PackageFinding {
  const { candidate, env } = input
  const { pkg } = candidate
  // Effective pattern / verdict: a SUSPICIOUS candidate can be redirected to a
  // concrete pattern after --deep forensics (see below).
  let pattern: DistributionPattern = candidate.pattern
  let verdict: NativeVerdict = candidate.verdict
  const pkgRef = toPackageRef(pkg)

  const chain: Evidence[] = []
  const requirements: BuildRequirement[] = []
  const blockers: Blocker[] = []
  const artifacts: Artifact[] = []
  // Set when --deep has confirmed the install script is benign (select); suppresses the allowScripts note.
  let scriptBenign = false

  // SUSPICIOUS + NotNative: has an install script whose pattern L1 cannot determine statically.
  // After --deep fetches scripts.install/postinstall from the registry manifest and
  // parses its semantics, the candidate is redirected to a concrete distribution
  // pattern: compile→D, download/download_then_compile→C, select→not native;
  // when the semantics remain indeterminable (unknown) or in fast mode (no
  // verify) → stay AMBIGUOUS (neutral gray, never guess).
  if (candidate.verdict === NativeVerdict.Suspicious && pattern === DistributionPattern.NotNative) {
    const s = input.verify?.installScript
    if (!s || s.intent === 'unknown') {
      chain.push(
        evidence(
          'install-script-intent',
          `scripts:${pkg.name}@${pkg.version}`,
          s
            ? `install/postinstall 已读取但语义仍无法静态确定（${s.script}）`
            : `存在 install 脚本但 V0.1 无法静态解析其分发模式（lockfile 只记 hasInstallScript，不含脚本内容）`,
          s ? Reliability.Unverified : Reliability.Inferred,
          { layer: s ? 2 : 1, positive: true },
        ),
      )
      const allowScripts = buildAllowScriptsNote(
        pkg.name,
        pattern,
        pkg.hasInstallScript,
        env.npmVersion,
        scriptBenign,
        undefined,
      )
      return {
        pkg: pkgRef,
        verdict: NativeVerdict.Suspicious,
        pattern,
        strategy: InstallStrategy.Unknown,
        risk: RiskLevel.AMBIGUOUS,
        reliability: s ? Reliability.Unverified : Reliability.Inferred,
        evidence: chain,
        artifacts: [],
        requirements: [],
        blockers,
        resolveHint: '人工审查该包的 scripts.install/postinstall 内容，确认是否涉及编译',
        ...(allowScripts ? { allowScripts } : {}),
        paths: pkgRef.paths,
      }
    }

    if (s.intent === 'compile') {
      pattern = DistributionPattern.SourceOnly
      verdict = NativeVerdict.Yes
      chain.push(
        evidence(
          'install-script-intent',
          `scripts:${pkg.name}@${pkg.version}`,
          `install/postinstall 语义为编译（${s.script}）→ 本地源码构建`,
          Reliability.Replay,
          { layer: 2, positive: true },
        ),
      )
    } else if (s.intent === 'download' || s.intent === 'download_then_compile') {
      pattern = DistributionPattern.RemoteDownload
      verdict = NativeVerdict.Yes
      chain.push(
        evidence(
          'install-script-intent',
          `scripts:${pkg.name}@${pkg.version}`,
          `install/postinstall 语义为${s.intent === 'download' ? '远端下载' : '先下载、失败才编译'}（${s.script}）→ 远端下载`,
          Reliability.Replay,
          { layer: 2, positive: true },
        ),
      )
    } else {
      // select: benign script (no compile, no download, e.g. a funding notice) → converges to not-native.
      // verdict stays SUSPICIOUS (there really is an install script, but it has
      // been shown not to compile or download), pattern stays NotNative and falls
      // into the NotNative case below → LOW.
      // Reliability is Inferred rather than Replay: "we read the script text" is
      // fact, but "no compile/download keyword → benign" is an inference over the
      // keyword table (behaviour outside the table, e.g. a custom JS downloader,
      // is a blind spot), so we cannot claim ≈100%. Corrected by the
      // generalizability self-audit on 2026-09-04.
      scriptBenign = true
      chain.push(
        evidence(
          'install-script-intent',
          `scripts:${pkg.name}@${pkg.version}`,
          `install/postinstall 语义为 select（不编译不下载，如 funding 提示）：${s.script} → 非 native`,
          Reliability.Inferred,
          { layer: 2, positive: false },
        ),
      )
    }
  }

  // Common evidence: why it is judged native
  chain.push(
    evidence(
      'not-native',
      `node:${pkg.name}@${pkg.version}`,
      `判定为分发模式 ${patternName(pattern)}（${pattern}）`,
      Reliability.Replay,
      { positive: pattern !== DistributionPattern.NotNative },
    ),
  )

  let strategy: InstallStrategy = InstallStrategy.Prebuilt
  // A standalone flag is needed rather than relying on narrowing of `risk`: after
  // an exhaustive switch, TS narrows `risk` to "the union of all assigned case
  // values", and since AMBIGUOUS is never assigned in this function, comparing it
  // directly triggers no-overlap. An explicit boolean for "does this need --deep
  // forensics" is clearer.
  let risk: RiskLevel = RiskLevel.LOW
  let needsVerify = false
  // Case-specific remedy that overrides the generic `--deep` hint.
  let resolveHintOverride: string | undefined

  // Platform applicability, replayed from npm's own os / cpu / libc gate: a
  // package that excludes this machine is not installed here at all
  // (`npm install` fails with EBADPLATFORM). Optional-only packages never reach
  // this point when classify received an env (they are filtered there), so
  // getting here means a *required* dependency cannot be satisfied.
  if (!matchesPlatform(pkg, env)) {
    const declared = describePlatformConstraint(pkg)
    const host = `${env.os}-${env.arch}${env.libc ? ` (${env.libc})` : ''}`
    return {
      pkg: pkgRef,
      verdict,
      pattern,
      strategy: InstallStrategy.Unsupported,
      risk: RiskLevel.HIGH,
      reliability: Reliability.Replay,
      evidence: [
        evidence(
          'platform-constraint',
          `lockfile:${pkg.name}@${pkg.version}#os/cpu/libc`,
          `本包声明 ${declared}，当前环境为 ${host}：npm 不会安装（EBADPLATFORM）`,
          Reliability.Replay,
          { positive: true },
        ),
      ],
      artifacts: [],
      requirements: [],
      blockers: [
        {
          name: '平台不适用',
          detail: `包声明 ${declared}，当前环境 ${host}`,
          remedy: '在受支持的平台上安装，或改用该平台上可用的替代包',
        },
      ],
      paths: pkgRef.paths,
    }
  }

  switch (pattern) {
    case DistributionPattern.NotNative: {
      strategy = InstallStrategy.Prebuilt
      risk = RiskLevel.LOW
      break
    }
    case DistributionPattern.PlatformOptionalDeps: {
      strategy = InstallStrategy.Prebuilt
      // The real risk for Pattern A is not "is there a prebuilt" but "is there
      // one for *my* platform" (see the module header). The lockfile records the
      // sub-packages' own os / cpu / libc, so this is answerable offline — and
      // answering it is the difference between a verified LOW and a guess.
      const sub = platformSubpackageMatch(pkg, env)
      if (sub.state === 'matched') {
        risk = RiskLevel.LOW
        artifacts.push({
          source: 'optional-dependency',
          platform: env.os,
          arch: env.arch,
          ...(env.libc ? { libc: env.libc } : {}),
        })
        chain.push(
          evidence(
            'platform-constraint',
            `lockfile:${pkg.name}@${pkg.version}#optionalDependencies`,
            `平台子包 ${sub.name} 满足当前平台（${env.os}-${env.arch}），无需本地编译`,
            Reliability.Replay,
            { positive: false },
          ),
        )
      } else if (sub.state === 'absent') {
        // The sub-packages carry platform constraints and none matches → this
        // lockfile cannot supply a binary here. That much is certain; whether the
        // install script then fails hard or fetches something is not, so this
        // stays UNVERIFIED rather than being inflated into HIGH.
        risk = RiskLevel.UNVERIFIED
        resolveHintOverride =
          '确认 lockfile 与当前平台一致（重新生成：npm install --package-lock-only）'
        chain.push(
          evidence(
            'platform-constraint',
            `lockfile:${pkg.name}@${pkg.version}#optionalDependencies`,
            `可选子包没有任何一个匹配当前平台（${env.os}-${env.arch}）；锁文件中的平台：${sub.available}`,
            Reliability.Inferred,
            { positive: true },
          ),
        )
      } else {
        // No platform information on the sub-packages (pnpm / yarn adapters, or a
        // lockfile that never recorded os/cpu): mode A is confirmed, the platform
        // match is not — Fail Closed and say so instead of claiming a match.
        risk = RiskLevel.LOW
        chain.push(
          evidence(
            'platform-constraint',
            `lockfile:${pkg.name}@${pkg.version}#optionalDependencies`,
            '子包未记录 os/cpu/libc，无法离线确认本平台是否有对应产物',
            Reliability.Unverified,
            { positive: true },
          ),
        )
      }
      break
    }
    case DistributionPattern.Prebuildify: {
      strategy = InstallStrategy.Prebuilt
      const b = input.verify?.b
      if (b?.status === 'matched') {
        // Deep forensics hit: an artifact for this platform exists in the tarball's
        // prebuilds/ → definitively LOW
        risk = RiskLevel.LOW
        chain.push(
          evidence(
            'prebuilds-in-tarball',
            `tarball:${pkg.name}@${pkg.version}#prebuilds/`,
            `prebuilds/ 含本平台产物（${env.os}-${env.arch}），无需本地编译`,
            Reliability.Replay,
            { layer: 2, positive: false },
          ),
        )
        artifacts.push({ source: 'prebuildify', platform: env.os, arch: env.arch })
      } else if (b?.status === 'absent') {
        // Deep forensics: read the whole package and still no artifact for this
        // platform → take node-gyp-build's source fallback path
        strategy = InstallStrategy.SourceBuild
        const tb = toolchainBlockers(env)
        blockers.push(...tb)
        risk = tb.length > 0 ? RiskLevel.HIGH : RiskLevel.MEDIUM
        chain.push(
          evidence(
            'prebuilds-in-tarball',
            `tarball:${pkg.name}@${pkg.version}#prebuilds/`,
            `prebuilds/ 无本平台（${env.os}-${env.arch}）产物，将降级本地编译`,
            Reliability.Replay,
            { layer: 2, positive: true },
          ),
        )
      } else if (b?.status === 'unknown') {
        // Forensics hit the ceiling before reading the whole package → cannot
        // conclude; stay UNVERIFIED (never treat it as "missing" and escalate)
        risk = RiskLevel.UNVERIFIED
        needsVerify = true
        chain.push(
          evidence(
            'remote-artifact-http',
            `tarball:${pkg.name}@${pkg.version}#prebuilds/`,
            'tarball 扫描触顶未读完，无法确认本平台产物，维持未验证',
            Reliability.Unverified,
            { layer: 2, positive: true },
          ),
        )
      } else {
        // fast (no verify) → no network → honestly UNVERIFIED, never guess
        risk = RiskLevel.UNVERIFIED
        needsVerify = true
        chain.push(
          evidence(
            'remote-artifact-http',
            `tarball:${pkg.name}@${pkg.version}#prebuilds/`,
            'prebuilds/ 清单需读取 tarball（--deep 流式取证），默认未验证',
            Reliability.Unverified,
            { layer: 2, positive: true },
          ),
        )
      }
      break
    }
    case DistributionPattern.RemoteDownload: {
      strategy = InstallStrategy.Prebuilt
      const v = input.verify
      if (v?.remote === 'prebuilt') {
        // Remote artifact exists → no compile by default (LOW). But both
        // prebuild-install and node-pre-gyp carry `--fallback-to-build`: a failed
        // download silently degrades into a source compile, so the wording must
        // not hard-claim "no compile needed" — the caveat is stated explicitly in
        // the fallback field (see fallbackPlan).
        risk = RiskLevel.LOW
        chain.push(
          evidence(
            'remote-artifact-http',
            `remote:${pkg.name}@${pkg.version}`,
            '远端预编译产物存在（HEAD 200），默认免编；下载失败将降级源码编译（见 fallback）',
            Reliability.Replay,
            { layer: 2, positive: false },
          ),
        )
      } else if (v?.remote === 'source-build') {
        // No remote artifact → prebuild-install fails and degrades into node-gyp rebuild
        strategy = InstallStrategy.SourceBuild
        const tb = toolchainBlockers(env)
        blockers.push(...tb)
        risk = tb.length > 0 ? RiskLevel.HIGH : RiskLevel.MEDIUM
        chain.push(
          evidence(
            'remote-artifact-http',
            `remote:${pkg.name}@${pkg.version}`,
            '远端预编译产物不存在（HEAD 404），将降级本地编译',
            Reliability.Replay,
            { layer: 2, positive: true },
          ),
        )
      } else {
        // fast, or forensics timed out → UNVERIFIED (never treat "network flakiness" as "danger")
        risk = RiskLevel.UNVERIFIED
        needsVerify = true
        chain.push(
          evidence(
            'remote-artifact-http',
            `remote:${pkg.name}@${pkg.version}`,
            v
              ? '远端预编译产物取证超时/异常，维持未验证'
              : '远端预编译产物未验证（--deep 发起 HEAD）',
            Reliability.Unverified,
            { layer: 2, positive: true },
          ),
        )
      }
      break
    }
    case DistributionPattern.SourceOnly: {
      // Pattern D always builds locally — this is where the full toolchain comparison is needed
      strategy = InstallStrategy.SourceBuild
      risk = RiskLevel.MEDIUM
      requirements.push(
        { name: 'Python', versionRequirement: '>= 3.6', source: 'node-gyp 需要' },
        { name: 'C/C++ 编译器', source: 'node-gyp rebuild' },
      )
      if (!env.python) {
        blockers.push({
          name: 'Python',
          detail: '未检测到 python3 / python / py',
          remedy: '安装 Python 3.6+ 并确保在 PATH 中',
        })
      }
      if (!env.compiler || !env.compiler.cxxProbe) {
        blockers.push({
          name: 'C/C++ 编译器',
          detail: env.compiler
            ? `${env.compiler.name} 存在但 C++ 编译探针失败`
            : '未检测到可用 C/C++ 编译器',
          remedy:
            '安装编译器（macOS: Xcode CLT；Linux: build-essential；Windows: MSVC Build Tools）',
        })
      }
      // Any blocker → HIGH; complete toolchain → MEDIUM
      risk = blockers.length > 0 ? RiskLevel.HIGH : RiskLevel.MEDIUM
      break
    }
  }

  const reliability = weakestReliability(chain)
  const allowScripts = buildAllowScriptsNote(
    pkg.name,
    pattern,
    pkg.hasInstallScript,
    env.npmVersion,
    scriptBenign,
    input.verify?.b?.hasBindingGyp,
  )
  // System-library advisory applies only when the package will actually compile
  // (D always; B-absent / C-source-build fall back to node-gyp rebuild). For
  // prebuilt strategies no local compile happens, so the library is irrelevant.
  const systemLibs =
    strategy === InstallStrategy.SourceBuild ? buildSystemLibNote(pkg.name, env) : undefined
  return {
    pkg: pkgRef,
    verdict,
    pattern,
    strategy,
    risk,
    reliability,
    evidence: chain,
    artifacts,
    requirements: requirements.map((r) => `${r.name} ${r.versionRequirement ?? ''}`.trim()),
    blockers,
    // When unverified / statically indeterminable, always carry the "how to make it conclusive" hint
    ...(resolveHintOverride
      ? { resolveHint: resolveHintOverride }
      : needsVerify
        ? { resolveHint: 'nativecheck . --deep' }
        : {}),
    ...(allowScripts ? { allowScripts } : {}),
    ...(systemLibs ? { systemLibs } : {}),
    paths: pkgRef.paths,
    fallback: fallbackPlan(pattern, env),
  }
}

/**
 * Build the system-library advisory note.
 *
 * Emitted only when all of: (1) a curated name→library hint matches the package,
 * (2) the probe ran (`pkg-config` available), and (3) the library was NOT
 * detected. Absence of `pkg-config` output is weak evidence (the package may
 * bundle the lib, or it may be present without a `.pc` file), so this is a
 * hint — never a blocker and never a risk change.
 */
function buildSystemLibNote(name: string, env: Environment): SystemLibNote | undefined {
  const hint = systemLibHint(name)
  if (!hint) return undefined
  const probe = env.systemLibs
  if (!probe || !probe.available) return undefined
  if (probe.present.includes(hint.pkgConfig)) return undefined
  return {
    libs: [hint.display],
    detail: `本包可能链接系统库 ${hint.display}，当前未通过 pkg-config 检测到（可能未安装、或未安装开发头文件）`,
    remedy: `Debian/Ubuntu: apt install ${hint.devPkg}；Alpine 请查对应包名。若该包内置/自带此库可忽略本提示`,
  }
}

/**
 * Which optional sub-package of a Pattern-A cluster is usable on this machine.
 *
 * Tri-state on purpose: "the sub-packages carry no platform information" (yarn,
 * or a lockfile that never recorded os/cpu) must never be read as "no sub-package
 * for this platform". The former is unverified, the latter is evidence.
 */
function platformSubpackageMatch(
  pkg: LockfilePackage,
  env: Environment,
):
  | { state: 'matched'; name: string }
  | { state: 'absent'; available: string }
  | { state: 'unknown' } {
  const optionalSubs = Object.values(pkg.dependencies ?? {}).filter((dep) => dep.optional)
  const constrained = optionalSubs.filter((dep) => dep.os || dep.cpu || dep.libc)
  if (constrained.length === 0) return { state: 'unknown' }

  const hit = constrained.find((dep) => matchesPlatform(dep, env))
  if (hit) return { state: 'matched', name: hit.name }

  const label = (dep: (typeof constrained)[number]): string =>
    `${dep.os?.join('|') ?? '?'}-${dep.cpu?.join('|') ?? '?'}`
  const platforms = [...new Set(constrained.map(label))].sort()
  const shown = platforms.slice(0, 6).join(' / ')
  return {
    state: 'absent',
    available: platforms.length > 6 ? `${shown} …（共 ${platforms.length} 种）` : shown,
  }
}

/** Human-readable os / cpu / libc triple, for evidence text and remedies. */
function describePlatformConstraint(pkg: Pick<LockfilePackage, 'os' | 'cpu' | 'libc'>): string {
  const parts: string[] = []
  if (pkg.os?.length) parts.push(`os=${pkg.os.join('|')}`)
  if (pkg.cpu?.length) parts.push(`cpu=${pkg.cpu.join('|')}`)
  if (pkg.libc?.length) parts.push(`libc=${pkg.libc.join('|')}`)
  return parts.length > 0 ? parts.join(' ') : '无平台约束'
}

/** The fallback path is an annotation, not the main verdict. */
function fallbackPlan(pattern: DistributionPattern, env: Environment): FallbackPlan | undefined {
  if (pattern === DistributionPattern.RemoteDownload) {
    return {
      description: '远端下载失败时降级 node-gyp rebuild（附注，非主路径）',
      requirements: ['Python >= 3.6', 'C/C++ 编译器'],
      // Use the same toolchain blocker detection as the main verdict (both python
      // and the C/C++ compiler), otherwise the fallback note would miss the key
      // risk that "degrading to a source compile will fail" when no compiler exists.
      blockers: toolchainBlockers(env),
      evidence: [],
    }
  }
  return undefined
}

// User-facing pattern names (Chinese) rendered in reports.
function patternName(pattern: DistributionPattern): string {
  switch (pattern) {
    case DistributionPattern.PlatformOptionalDeps:
      return 'A(平台可选依赖)'
    case DistributionPattern.Prebuildify:
      return 'B(prebuildify)'
    case DistributionPattern.RemoteDownload:
      return 'C(远端下载)'
    case DistributionPattern.SourceOnly:
      return 'D(纯源码)'
    default:
      return '非 native'
  }
}

/** Helper for report sorting / aggregation: is this verdict native (YES or SUSPICIOUS)? */
export function isNativeVerdict(v: NativeVerdict): boolean {
  return v === NativeVerdict.Yes || v === NativeVerdict.Suspicious
}
