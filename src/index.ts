/**
 * NativeCheck — **stable** library surface.
 *
 * What is exported here follows semantic versioning: additive changes are minor,
 * removals and incompatible changes need a major. That promise is why the surface
 * is small — it contains only what an embedder (editor plugin, CI dashboard,
 * another front-end) builds on:
 *
 * - the unified data model plus the evidence / reliability / risk vocabulary;
 * - the JSON schema, so consumers can validate what they are handed;
 * - the CI gate policy;
 * - the two scan entry points and the environment snapshot.
 *
 * Adapter internals — the classification rule tables, the `--deep` forensics, the
 * lockfile parsers, the forensics cache — are useful but still moving. They live
 * in `nativecheck/experimental` so that depending on them is an explicit choice
 * rather than something discovered by accident.
 */
export * from './core/model'
export * from './core/evidence'
export * from './core/risk'
export * from './core/report'
export * from './core/schema'

export { scan } from './adapters/node/pipeline'
export { scanTarget, parsePackageSpec } from './adapters/node/target'
export { scanEnvironment, probeSystemLibs, SYSTEM_LIBS } from './env'

export type { ScanOptions, ScanOutcome } from './adapters/node/pipeline'
export type { TargetOptions, ParsedSpec } from './adapters/node/target'
export type { SystemLibEntry } from './env/system-libs'
export type { NodeRuntimeInfo } from './env/node'
export type { PythonInfo } from './env/python'
