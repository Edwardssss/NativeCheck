/**
 * Aggregate Windows ground-truth cells into the L2 four-square table.
 *
 * Reads `results/summary.json` (written by probe-install.ps1) and classifies each
 * cell along two axes that are deliberately independent:
 *
 *   predicted  — did the tool say this package builds from source locally?
 *   observed   — did a compile actually get attempted / succeed?
 *
 * A cell whose prediction is UNVERIFIED is counted as *undetermined*, not as a
 * correct answer. That is the whole point of the three-state reliability model,
 * and a table that quietly folded it into "correct" would be measuring the
 * harness's optimism rather than the tool.
 *
 * Usage: node collect-windows.mjs <summary.json>
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? new URL('./results/summary.json', import.meta.url).pathname
// PowerShell's `Set-Content -Encoding UTF8` writes a BOM; JSON.parse rejects it.
const cells = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

const PREDICTED_SOURCE = new Set(['SOURCE_BUILD'])
const rows = []

for (const cell of cells) {
  const prediction = cell.prediction ?? {}
  const strategy = prediction.strategy ?? null
  const risk = prediction.risk ?? null
  const pattern = prediction.pattern ?? null
  const predictedSource = PREDICTED_SOURCE.has(strategy)
  const predictedPrebuilt = strategy === 'PREBUILT'
  // "A compile was attempted" is the weaker, always-observable fact: the failing
  // legacy packages leave nothing on disk, but node-gyp clearly ran.
  const compiled = cell.compiled === true || cell.buildAttempted === true
  // Fast mode declares B/C unverified rather than prebuilt: count that apart.
  const undetermined = risk === 'UNVERIFIED' || risk === 'AMBIGUOUS'
  /**
   * Pattern C is the one pattern whose prebuilt path can legitimately degrade
   * into a compile: `node-pre-gyp install --fallback-to-build`. The finding for
   * such a cell carries a `fallback` block stating exactly that (verified on
   * this machine: bcrypt fast-mode finding is RemoteDownload / UNVERIFIED /
   * PREBUILT with the fallback documented).
   *
   * So when a compile happens here, it is not a missed prediction -- it is the
   * documented fallback, triggered by a failed download. Counting it as a false
   * negative would score the tool for its own disclosure; folding it into "no
   * compile" would hide the fact. It gets its own bucket, and the raw column
   * stays visible.
   */
  const documentedFallback = predictedPrebuilt && pattern === 'RemoteDownload'
  rows.push({
    ...cell,
    pattern,
    predictedSource,
    predictedPrebuilt,
    compiled,
    undetermined,
    documentedFallback,
  })
}

let tp = 0
let fp = 0
let fn = 0
let tn = 0
let undetermined = 0
let fallbackRealised = 0
for (const row of rows) {
  if (row.documentedFallback && row.compiled) {
    fallbackRealised += 1
    continue
  }
  if (row.undetermined) {
    undetermined += 1
    continue
  }
  if (row.predictedSource && row.compiled) tp += 1
  else if (row.predictedSource && !row.compiled) fp += 1
  else if (!row.predictedSource && row.compiled) fn += 1
  else tn += 1
}

const determined = tp + fp + fn + tn
const installOk = rows.filter((r) => r.installExit === 0).length

console.log(
  'cell                  pkg                install  compile  observed-by              predicted                          verdict',
)
for (const row of rows) {
  const how =
    row.compiled && row.shimHits > 0
      ? `shim (${row.shimHits})`
      : row.compiled
        ? `log/artifacts (obj=${row.intermediates}, node=${row.nodeBinaries})`
        : 'nothing ran'
  const verdict =
    row.documentedFallback && row.compiled
      ? 'fallback realised (documented)'
      : row.undetermined
        ? 'undetermined (as declared)'
        : row.predictedSource === row.compiled
          ? 'match'
          : 'MISMATCH'
  const pred = row.prediction?.error
    ? `error: ${row.prediction.error}`
    : `${row.prediction?.pattern}/${row.prediction?.risk}/${row.prediction?.strategy}`
  console.log(
    `${row.cell.padEnd(21)} ${row.package.padEnd(18)} ${String(row.installExit).padEnd(8)} ` +
      `${String(row.compiled).padEnd(8)} ${how.padEnd(24)} ${pred.padEnd(34)} ${verdict}`,
  )
}

console.log('')
console.log('=== L2 four-square (predicted SOURCE_BUILD x a compile happened) ===')
console.log(`  TP (predicted source build, compiled) = ${tp}`)
console.log(`  FP (predicted source build, no compile) = ${fp}`)
console.log(`  FN (predicted prebuilt, compiled anyway) = ${fn}`)
console.log(`  TN (predicted prebuilt, no compile) = ${tn}`)
console.log(`  undetermined, excluded from the square = ${undetermined}`)
console.log(`  predited prebuilt where the documented fallback fired = ${fallbackRealised}`)
console.log('')
console.log(`  deterministic coverage (determined/all cells) = ${determined}/${rows.length}`)
console.log(`  installs that succeeded = ${installOk}/${rows.length}`)
console.log('')
console.log('Reading notes:')
console.log('  - A cell is only counted as correct when the tool committed to a verdict.')
console.log('  - Pattern C is scored separately: its finding documents that a failed download')
console.log('    degrades into a source build, so a compile there is the disclosure being')
console.log('    borne out, not a missed prediction.')
console.log('  - "compiled" includes "a compile was attempted and failed": for the two')
console.log("    legacy Pattern-D packages the linker rejected Node 26's clang-cl LTO flags,")
console.log('    which is an environment failure, not a package that needs no compiler.')
console.log('  - Sample size is 6. This is a smoke measurement, not an accuracy claim.')
