/**
 * Layer 2 — Verify (off by default; network requests only for B / C).
 *
 * Design doc §10.3.
 *
 *   nativecheck .          # --fast: 0 network calls
 *   nativecheck . --deep   # online forensics for B / C candidates, 1–3s
 *
 * This file is the **orchestration** layer of `--deep`: it defines what "one
 * forensics result" looks like (`VerifyOutcome`) and how a single candidate is
 * verified according to its distribution pattern (`verifyCandidate`). The real
 * HTTP / tar noise lives in `network.ts`; this file only decides which path to
 * take between fast and deep, and hands the result to Layer 3.
 *
 * Zero-network iron rule: `pipeline.ts` guarantees fast mode never enters this
 * module's network branches — under `--fast`, B / C are always UNVERIFIED and no
 * network is touched (see match.ts).
 */
import { DistributionPattern, NativeVerdict, type Environment } from '../../core/model'
import type { NativeCandidate } from './classify'
import {
  deriveRemoteUrlFromMeta,
  fetchManifest,
  isNapiBuild,
  probePrebuilds,
  probeRemoteHead,
  type HttpLike,
} from './network'
import { mergeHookIntents, parseInstallScript, type ScriptIntent } from './install-script'
import type { Blocker } from '../../core/model'

/** The result of one online forensics run. B and C are mutually exclusive, but optional fields express that more safely. */
export interface VerifyOutcome {
  /** Pattern B: tri-state conclusion of streaming the tarball's prebuilds/. */
  readonly b?: {
    readonly status: 'matched' | 'absent' | 'unknown'
    readonly observed: readonly string[]
    /** Whether the tarball contains binding.gyp — the "implicit node-gyp rebuild" signal (allowScripts dimension). */
    readonly hasBindingGyp?: boolean
  }
  /** Pattern C: HEAD result for the derived remote URL. */
  readonly remote?: 'prebuilt' | 'source-build' | 'unverified'
  /**
   * Pattern S (SUSPICIOUS + NotNative candidate) forensics: read
   * scripts.install/postinstall from the registry manifest and parse their
   * semantics. Used to converge AMBIGUOUS:
   * compile→D, download/download_then_compile→C, select→not native, unknown→stays gray.
   */
  readonly installScript?: {
    /** Merged raw script content (install / postinstall joined by ` || `; may be an empty string). */
    readonly script: string
    readonly intent: ScriptIntent
  }
  /** Number of network requests actually issued. Feeds the networkCalls counter and the --fast zero-network assertion. */
  readonly networkCalls: number
}

/** Which distribution patterns need online forensics under --deep. */
export function patternNeedsNetwork(pattern: DistributionPattern): boolean {
  return (
    pattern === DistributionPattern.Prebuildify || pattern === DistributionPattern.RemoteDownload
  )
}

/**
 * Whether a single candidate needs online forensics under --deep. B/C always do;
 * in addition SUSPICIOUS + NotNative (has an install script whose pattern L1
 * cannot determine statically) also does — we fetch the script content and parse
 * its semantics to converge AMBIGUOUS.
 */
export function candidateNeedsNetwork(candidate: NativeCandidate): boolean {
  if (patternNeedsNetwork(candidate.pattern)) return true
  return (
    candidate.verdict === NativeVerdict.Suspicious &&
    candidate.pattern === DistributionPattern.NotNative
  )
}

/** Blockers for a Pattern C fallback to source build when the toolchain has real gaps and no remote artifact is available. */
function toolchainBlockers(env: Environment): Blocker[] {
  const blockers: Blocker[] = []
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
      remedy: '安装编译器（macOS: Xcode CLT；Linux: build-essential；Windows: MSVC Build Tools）',
    })
  }
  return blockers
}

/**
 * Run one forensics pass for a single B / C candidate. Never throws — any
 * network anomaly is folded into the degradable result for the corresponding
 * pattern, and Layer 3 decides the final risk. "Network flakiness" is never
 * treated as "danger".
 *
 * @param fetchImpl Injectable HTTP (tests pass a mock to avoid real network).
 */
export async function verifyCandidate(
  candidate: NativeCandidate,
  env: Environment,
  fetchImpl: HttpLike,
): Promise<VerifyOutcome> {
  const { pkg, pattern } = candidate

  switch (pattern) {
    case DistributionPattern.Prebuildify: {
      // B: get the tarball URL (1 GET), then stream-scan prebuilds/ (1 GET, abort as soon as we hit).
      // If the build script explicitly says `prebuildify --napi`, the artifact is
      // N-API (cross-ABI), so custom-named artifacts without an ABI marker (bcrypt's
      // `bcrypt.glibc.node`) are also treated as a definite match → converges UNVERIFIED.
      // Network anomalies fold into unknown (→ UNVERIFIED); never treat "network
      // flakiness" as "artifact missing" and conclude a compile — consistent with
      // pattern C (fetchManifest / probePrebuilds may both throw on flaky networks).
      let manifest
      try {
        manifest = await fetchManifest(pkg.name, pkg.version, fetchImpl)
      } catch {
        return { b: { status: 'unknown', observed: [] }, networkCalls: 1 }
      }
      let probe
      try {
        probe = await probePrebuilds(manifest.tarballUrl, env, {
          fetchImpl,
          napiBuild: isNapiBuild(manifest.meta),
        })
      } catch {
        return { b: { status: 'unknown', observed: [] }, networkCalls: 2 }
      }
      return {
        b: { status: probe.status, observed: probe.observed, hasBindingGyp: probe.hasBindingGyp },
        networkCalls: 2,
      }
    }
    case DistributionPattern.RemoteDownload: {
      // C: read the manifest for binary/config/repository (1 GET), faithfully derive
      // the remote URL, then issue one HEAD against the derived URL. When the URL
      // cannot be derived (missing repo / ABI information) → never guess, degrade to unverified.
      let manifest
      try {
        manifest = await fetchManifest(pkg.name, pkg.version, fetchImpl)
      } catch {
        return { remote: 'unverified', networkCalls: 1 }
      }
      const url = deriveRemoteUrlFromMeta(pkg.name, pkg.version, env, manifest.meta)
      if (!url) return { remote: 'unverified', networkCalls: 1 }
      const remote = await probeRemoteHead(url, { fetchImpl })
      return { remote, networkCalls: 2 }
    }
    default: {
      // SUSPICIOUS + NotNative: has an install script whose pattern L1 cannot
      // determine statically (the lockfile only records hasInstallScript, not the
      // script content). Under --deep we fetch scripts.install/postinstall from the
      // registry manifest and parse their semantics to converge AMBIGUOUS:
      //   compile → D(SourceOnly); download / download_then_compile → C(RemoteDownload);
      //   select → not native; unknown → stays gray.
      if (
        candidate.verdict === NativeVerdict.Suspicious &&
        pattern === DistributionPattern.NotNative
      ) {
        let manifest
        try {
          manifest = await fetchManifest(pkg.name, pkg.version, fetchImpl)
        } catch {
          return { networkCalls: 1 }
        }
        // npm runs preinstall → install → postinstall, and all three run
        // unconditionally, so the combined semantics is "the most severe action
        // that definitely happens". Dropping preinstall (where a plain
        // `node-gyp rebuild` often sits) left such packages at AMBIGUOUS forever.
        const hooks = [
          manifest.meta.preinstall,
          manifest.meta.install,
          manifest.meta.postinstall,
        ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        // Joining the hooks with `||` would make "install downloads + postinstall
        // compiles" read as a download-then-compile *fallback*; parse each hook
        // separately and merge by severity (compile wins). Blind spot §1.4.
        const intent = hooks
          .map((hook) => parseInstallScript(hook))
          .reduce<ScriptIntent>((merged, next) => mergeHookIntents(merged, next), 'unknown')
        const base = { installScript: { script: hooks.join(' ; '), intent } }
        // Download-ish intents: reuse pattern C and issue one more HEAD to confirm the remote artifact exists.
        if (intent === 'download' || intent === 'download_then_compile') {
          const url = deriveRemoteUrlFromMeta(pkg.name, pkg.version, env, manifest.meta)
          if (!url) return { ...base, remote: 'unverified', networkCalls: 1 }
          const remote = await probeRemoteHead(url, { fetchImpl })
          return { ...base, remote, networkCalls: 2 }
        }
        return { ...base, networkCalls: 1 }
      }
      // Non-B/C must not reach here; defensively report zero network usage.
      return { networkCalls: 0 }
    }
  }
}

/** Toolchain blockers reported when pattern C has no usable remote artifact and will fall back to a source build. */
export { toolchainBlockers }
