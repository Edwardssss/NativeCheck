/**
 * JSON output contract.
 *
 * Design doc §12: JSON output is defined with a zod schema so that future HTML
 * reports / editor plugins can consume it. This module is both the runtime
 * validator (CI artifacts, cache contents) and the source of types, so the two
 * definitions cannot drift apart.
 */

import { z } from 'zod'
import { DistributionPattern, InstallStrategy, NativeVerdict } from './model'
import { Reliability } from './evidence'
import { RiskLevel } from './risk'

export const reliabilitySchema = z.enum(Reliability)
export const riskLevelSchema = z.enum(RiskLevel)
export const distributionPatternSchema = z.enum(DistributionPattern)
export const installStrategySchema = z.enum(InstallStrategy)
export const nativeVerdictSchema = z.enum(NativeVerdict)

export const evidenceLayerSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])

export const evidenceSchema = z.object({
  kind: z.string(),
  source: z.string(),
  description: z.string(),
  layer: evidenceLayerSchema,
  reliability: reliabilitySchema,
  positive: z.boolean(),
})

export const artifactSchema = z.object({
  source: z.enum(['optional-dependency', 'prebuildify', 'remote-download', 'source-build']),
  platform: z.string().optional(),
  arch: z.string().optional(),
  runtime: z.string().optional(),
  abi: z.string().optional(),
  napi: z.string().optional(),
  libc: z.enum(['glibc', 'musl']).optional(),
})

export const blockerSchema = z.object({
  name: z.string(),
  detail: z.string(),
  remedy: z.string().optional(),
})

export const fallbackPlanSchema = z.object({
  description: z.string(),
  requirements: z.array(z.string()),
  blockers: z.array(blockerSchema),
  evidence: z.array(evidenceSchema),
})

export const dependencyPathSchema = z.object({
  chain: z.array(z.string()),
  dev: z.boolean(),
  optional: z.boolean(),
})

export const packageRefSchema = z.object({
  name: z.string(),
  version: z.string(),
  ecosystem: z.enum(['node', 'python', 'rust', 'cpp']),
  paths: z.array(dependencyPathSchema),
  raw: z.record(z.string(), z.unknown()),
})

/**
 * npm allowScripts note. Independent dimension: not a blocker and not part of
 * risk classification, but it IS part of the JSON contract — a missing field
 * here would make zod strip the note from `--json` output silently.
 */
export const allowScriptsSchema = z.object({
  policy: z.enum(['advisory', 'blocked']),
  detail: z.string(),
  remedy: z.string(),
})

/**
 * System-library advisory. Independent dimension, same contract discipline as
 * allowScripts: it IS part of the JSON output, so a missing field here would
 * make zod strip the note from `--json` silently.
 */
export const systemLibNoteSchema = z.object({
  libs: z.array(z.string()),
  detail: z.string(),
  remedy: z.string(),
})

/** System-library probe result (Linux pkg-config). Part of the environment snapshot. */
export const systemLibProbeSchema = z.object({
  available: z.boolean(),
  present: z.array(z.string()),
})

export const packageFindingSchema = z.object({
  pkg: packageRefSchema,
  verdict: nativeVerdictSchema,
  pattern: distributionPatternSchema,
  strategy: installStrategySchema,
  risk: riskLevelSchema,
  reliability: reliabilitySchema,
  evidence: z.array(evidenceSchema),
  artifacts: z.array(artifactSchema),
  requirements: z.array(z.string()),
  blockers: z.array(blockerSchema),
  fallback: fallbackPlanSchema.optional(),
  resolveHint: z.string().optional(),
  allowScripts: allowScriptsSchema.optional(),
  systemLibs: systemLibNoteSchema.optional(),
  paths: z.array(dependencyPathSchema),
})

export const compilerInfoSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  path: z.string().optional(),
  cProbe: z.boolean(),
  cxxProbe: z.boolean(),
  viaToolchainEnv: z.string().optional(),
})

export const sdkSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  path: z.string().optional(),
})

export const environmentSchema = z.object({
  os: z.string(),
  arch: z.string(),
  libc: z.enum(['glibc', 'musl']).optional(),
  nodeVersion: z.string().optional(),
  nodeAbi: z.string().optional(),
  napiVersion: z.string().optional(),
  npmVersion: z.string().optional(),
  python: z
    .object({
      version: z.string().optional(),
      path: z.string().optional(),
    })
    .optional(),
  compiler: compilerInfoSchema.optional(),
  sdks: z.array(sdkSchema),
  systemLibs: systemLibProbeSchema.optional(),
})

export const scanSummarySchema = z.object({
  totalPackages: z.number(),
  nativeCandidates: z.number(),
  byRisk: z.record(riskLevelSchema, z.number()),
  // Declared so zod does not strip it from `--json` (same discipline as allowScripts).
  platformExcluded: z.number().optional(),
  workspaceMembers: z.array(z.string()).optional(),
  networkCalls: z.number(),
})

export const unsupportedProjectSchema = z.object({
  detected: z.string(),
  reason: z.string(),
  supported: z.array(z.string()),
})

export const scanReportSchema = z.object({
  target: z.string(),
  generatedAt: z.string(),
  environment: environmentSchema,
  mode: z.enum(['fast', 'deep']),
  durationMs: z.number(),
  findings: z.array(packageFindingSchema),
  summary: scanSummarySchema,
  unsupported: unsupportedProjectSchema.optional(),
})

export type ScanReportJson = z.infer<typeof scanReportSchema>
