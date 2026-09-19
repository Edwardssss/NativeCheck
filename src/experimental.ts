/**
 * NativeCheck — **experimental** library surface (`nativecheck/experimental`).
 *
 * Everything here is real, tested code that the CLI depends on, but it is still
 * moving: rule tables get reordered, forensics signatures change, cache formats
 * get version bumps. There is no compatibility promise across minor versions —
 * pin an exact version and read the changelog if you depend on it.
 *
 * If something here turns out to be what embedders actually need, it gets promoted
 * into the root entry. Until then, importing this sub-path is a deliberate choice.
 */
import {
  classifyGraph,
  classifyPackage,
  matchesPlatform,
  verdictFor,
} from './adapters/node/classify'

// Layer 0 — lockfile ingestion and the normalized graph
export { ingest, probeLockfile, SUPPORTED_LOCKFILES } from './adapters/node/ingest'
export { parsePnpmLockfile } from './adapters/node/pnpm'
export { parseYarnLockfile } from './adapters/node/yarn'
export { parseBunLockfile } from './adapters/node/bun'

// Layer 1 — classification rules
export { classifyGraph, classifyPackage, matchesPlatform, verdictFor }

// Layer 2 — online forensics (network / tar) and its cache
export { buildFindings } from './adapters/node/pipeline'
export { verifyCandidate, patternNeedsNetwork, candidateNeedsNetwork } from './adapters/node/verify'
export { probePrebuilds, probeRemoteHead } from './adapters/node/network'
export {
  fetchManifest,
  deriveRemoteUrlFromMeta,
  deriveNodePreGypUrl,
  parseGithubRepo,
  detectDownloader,
  detectDownloadRuntime,
  resolveDownloadAbi,
  getBestNapiBuildVersion,
  isNapiBuild,
  isNapiBindingGyp,
  parsePrebuildEntry,
  prebuildMatchesEnv,
  abiMatchFor,
} from './adapters/node/network'
export {
  verifyCacheKey,
  verifyCachePath,
  loadVerifyCache,
  saveVerifyCache,
  lookupCachedOutcome,
  pruneVerifyCache,
  defaultVerifyCacheFs,
  DEFAULT_TTL_MS,
} from './adapters/node/verify-cache'

// Layer 3 — matching helpers and the npm-policy / system-library hints
export { matchCandidate, isNativeVerdict } from './adapters/node/match'
export { allowScriptsPolicy } from './adapters/node/npm-policy'
export { systemLibHint } from './adapters/node/system-libs'

// Install-script semantics
export {
  parseInstallScript,
  describeIntent,
  inspectScript,
  splitFallbackChain,
  mergeHookIntents,
} from './adapters/node/install-script'

// Types that only make sense next to the above
export type {
  NativeCandidate,
  ClassificationResult,
  ClassifyOptions,
} from './adapters/node/classify'
export type { MatchInput } from './adapters/node/match'
export type { LockfilePackage, IngestedGraph, LockfileDependency } from './adapters/node/signals'
export type { VerifyOutcome } from './adapters/node/verify'
export type { RegistryManifest, PackageProfile, HttpLike } from './adapters/node/network'
export type { VerifyCacheFs, VerifyCacheRecord } from './adapters/node/verify-cache'
export type { ScriptIntent, ScriptSegment } from './adapters/node/install-script'
export type { AllowScriptsPolicy } from './adapters/node/npm-policy'

/** Re-exported for the CLI's own tests; `classifyGraph` keeps its documented signature. */
export const __internal = { classifyGraph, classifyPackage, matchesPlatform, verdictFor }
