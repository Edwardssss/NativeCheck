/**
 * Semantic parsing of install scripts.
 *
 * Maps to design doc §11.2 — **the core of false-positive control**.
 *
 * Central trap: `node-gyp-build` ≠ `node-gyp`.
 * The former is a zero-dependency runtime binary picker, the latter is a
 * compiler. Their names are nearly identical but their semantics are opposite;
 * listing them side by side in one detection checklist is itself a source of
 * false positives.
 *
 * Observed samples:
 *   `esbuild`  `node install.js`                              → select (no compile)
 *   `bcrypt`   `node-gyp-build`                               → select (no compile)
 *   `canvas`   `prebuild-install -r napi || node-gyp rebuild` → download_then_compile
 *   `fsevents` `node-gyp rebuild`                             → compile
 */

export type ScriptIntent =
  /** `node-gyp rebuild` — genuinely compiles */
  | 'compile'
  /** `prebuild-install` — download only */
  | 'download'
  /** `A || B` — tries download first, falls back to compiling */
  | 'download_then_compile'
  /** `node-gyp-build` / `install.js` — picks from artifacts that already exist, no compile */
  | 'select'
  /** Not parseable; falls through to AMBIGUOUS */
  | 'unknown'

export interface ScriptSegment {
  readonly raw: string
  readonly intent: Exclude<ScriptIntent, 'download_then_compile'>
}

/** Split the fallback chain on `||`; `&&` is ignored (conjunctions inside one segment do not change the main semantics). */
export function splitFallbackChain(script: string): string[] {
  return script
    .split('||')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

function classifySegment(segment: string): Exclude<ScriptIntent, 'download_then_compile'> {
  // `node-gyp rebuild|build|configure` — word boundaries matter so we don't swallow `node-gyp-build`
  if (/\bnode-gyp\s+(rebuild|build|configure)\b/.test(segment)) return 'compile'
  if (/\bprebuild-install\b/.test(segment)) return 'download'
  // `\bnode-pre-gyp\b` already covers `@mapbox/node-pre-gyp` (the scope prefix
  // ends on a non-word character), so no separate branch is needed.
  if (/\bnode-pre-gyp\b/.test(segment)) return 'download'
  if (/\bnode-gyp-build\b/.test(segment)) return 'select'
  // `node -e "..."` / `node --eval` inline eval: it can execute arbitrary code,
  // but in practice these are mostly benign scripts such as funding notices or
  // telemetry (e.g. core-js's postinstall). The compile/download regexes above
  // scan the whole segment including the inline code, so reaching this branch
  // means the inline code carries no compile/download signal → treat it as
  // benign `select` (no compile).
  // Known blind spot (documented, accepted): a custom JS downloader hidden
  // behind inline eval with vocabulary outside the regex table would be
  // mislabeled benign. See temp/NativeCheck_改进方法评估.md §31.
  if (/\bnode\s+(?:-e|--eval)\b/.test(segment)) return 'select'
  // Weak heuristic: `node xxx.js` is usually a custom picker (esbuild is one)
  if (/\bnode\s+\S+\.js\b/.test(segment)) return 'select'
  return 'unknown'
}

/**
 * Filename keywords that hint a `node xxx.js` script is a *downloader* rather
 * than a picker/compiler (e.g. node-pty's `node scripts/prebuild.js`). Used only
 * together with a `node-gyp rebuild` fallback in the same chain, so a bare
 * `node install.js` (esbuild) still stays `select`.
 */
const DOWNLOAD_HINT = /\b(?:prebuild|download|install|fetch|binary)\b/i

/**
 * Whether a segment is a "custom JS downloader" — `node xxx.js` whose script
 * filename hints at fetching a prebuilt artifact. On its own this is still
 * ambiguous (hence the weak heuristic stays `select`); the signal only matters
 * when the same chain also has a `node-gyp rebuild` fallback.
 */
function isCustomDownloader(segment: string): boolean {
  const match = segment.match(/\bnode\s+([^\s;|&]+\.js)\b/)
  if (!match) return false
  return DOWNLOAD_HINT.test(match[1] ?? '')
}

/**
 * Merge the intents of two independent lifecycle hooks (preinstall / install /
 * postinstall). npm runs them all, in that order, so the combined semantics is
 * "the most severe action that definitely happens":
 *
 *   compile > download_then_compile > download > select > unknown
 *
 * This fixes blind spot §1.4: joining the hooks with `||` made
 * "install downloads + postinstall compiles" look like a download-then-compile
 * *fallback*, when in fact the compile is unconditional — the package will
 * compile no matter what the download hook does.
 */
export function mergeHookIntents(a: ScriptIntent, b: ScriptIntent): ScriptIntent {
  const severity: Record<ScriptIntent, number> = {
    compile: 5,
    download_then_compile: 4,
    download: 3,
    select: 2,
    unknown: 1,
  }
  return severity[a] >= severity[b] ? a : b
}

/**
 * Parse the overall intent of an install script.
 *
 * Order matters: `download_then_compile` must be decided first, otherwise
 * `A || B` would be misread as a plain compile.
 */
export function parseInstallScript(script: string | undefined): ScriptIntent {
  if (!script || script.trim().length === 0) return 'unknown'

  const segments = splitFallbackChain(script)
  if (segments.length === 0) return 'unknown'

  const intents = segments.map((segment) => classifySegment(segment))

  const hasCompile = intents.includes('compile')
  const hasDownload = intents.includes('download')

  if (hasDownload && hasCompile) return 'download_then_compile'
  // Blind spot §1.2: `node scripts/prebuild.js || node-gyp rebuild` — the custom
  // JS downloader is labeled `select` by the weak heuristic, but paired with a
  // compile fallback the chain really means "download first, compile on failure".
  // Upgrade it to download_then_compile so SUSPICIOUS forensics converges to C
  // (HEAD-probe the remote) instead of blindly assuming a compile.
  if (hasCompile && segments.some((segment) => isCustomDownloader(segment)))
    return 'download_then_compile'
  if (hasCompile) return 'compile'
  if (hasDownload) return 'download'
  if (intents.includes('select')) return 'select'
  return 'unknown'
}

/** Breakdown result, used to show the fallback chain segment by segment in the report. */
export function inspectScript(script: string | undefined): readonly ScriptSegment[] {
  if (!script) return []
  return splitFallbackChain(script).map((segment) => ({
    raw: segment,
    intent: classifySegment(segment),
  }))
}

// User-facing labels (Chinese) rendered in reports and by the CLI.
const INTENT_LABEL: Record<ScriptIntent, string> = {
  compile: '真的编译',
  download: '远端下载',
  download_then_compile: '先下载，失败才编译',
  select: '挑选已有产物，不编译',
  unknown: '无法静态确定',
}

export function describeIntent(intent: ScriptIntent): string {
  return INTENT_LABEL[intent]
}
