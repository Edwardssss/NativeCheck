/**
 * NativeCheck library entry point.
 *
 * Exposes the unified data model (core), scan orchestration (the node adapter's
 * four-layer funnel), the environment snapshot and the JSON schema. The CLI
 * (`src/cli`) and future HTML reports / editor plugins all consume this entry.
 */

// Unified data model (ecosystem-agnostic)
export * from './core/model'
export * from './core/evidence'
export * from './core/risk'
export * from './core/report'
export * from './core/schema'

// Node adapter public API
export { scan, buildFindings } from './adapters/node/pipeline'
export { scanTarget, parsePackageSpec } from './adapters/node/target'
export {
  classifyGraph,
  classifyPackage,
  dependsOnBuildTool,
  matchesPlatform,
  verdictFor,
} from './adapters/node/classify'
export { matchCandidate, isNativeVerdict } from './adapters/node/match'
export { ingest, probeLockfile } from './adapters/node/ingest'
export { verifyCandidate, patternNeedsNetwork, candidateNeedsNetwork } from './adapters/node/verify'
export {
  verifyCacheKey,
  verifyCachePath,
  loadVerifyCache,
  saveVerifyCache,
  lookupCachedOutcome,
  defaultVerifyCacheFs,
} from './adapters/node/verify-cache'
export {
  fetchManifest,
  probePrebuilds,
  probeRemoteHead,
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
  parseInstallScript,
  describeIntent,
  inspectScript,
  splitFallbackChain,
  mergeHookIntents,
} from './adapters/node/install-script'
export { parsePnpmLockfile } from './adapters/node/pnpm'
export { parseYarnLockfile } from './adapters/node/yarn'
export { parseBunLockfile } from './adapters/node/bun'
export { allowScriptsPolicy } from './adapters/node/npm-policy'
export { systemLibHint } from './adapters/node/system-libs'
export type {
  NativeCandidate,
  ClassificationResult,
  ClassifyOptions,
} from './adapters/node/classify'
export type { MatchInput } from './adapters/node/match'
export type { TargetOptions, ParsedSpec } from './adapters/node/target'
export type { LockfilePackage, IngestedGraph, LockfileDependency } from './adapters/node/signals'
export type { ScanOptions, ScanOutcome } from './adapters/node/pipeline'
export type { VerifyOutcome } from './adapters/node/verify'
export type { RegistryManifest, PackageProfile } from './adapters/node/network'
export type { ScriptIntent, ScriptSegment } from './adapters/node/install-script'
export type { AllowScriptsPolicy } from './adapters/node/npm-policy'

// Environment scanning
export { scanEnvironment, probeSystemLibs, SYSTEM_LIBS } from './env'
export type { SystemLibEntry } from './env/system-libs'
export type { NodeRuntimeInfo } from './env/node'
export type { PythonInfo } from './env/python'
