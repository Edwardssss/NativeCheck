#!/usr/bin/env node
// scripts/check-rule-coverage.mjs
//
// Rule coverage check: scans `src/adapters/node/*.ts` for the **rule tables**
// (string-array constants and switch-case labels) and asserts each concrete
// rule value is referenced by at least one test file OR fixture under
// `testdata/`. Designed to catch silent rule-table decay — the kind that bit
// `better-sqlite3` v12 → v13 historically, where a rule value changed but no
// fixture referenced the new value and the degradation went unnoticed.
//
// Usage:
//   node scripts/check-rule-coverage.mjs           # human report
//   node scripts/check-rule-coverage.mjs --strict  # exit 1 on uncovered rule-item/case
//
// Coverage tiers:
//   - rule-item: a concrete string value inside an exported string-array rule
//     table (NATIVE_BUILD_TOOLS, REMOTE_DOWNLOADERS, ...). These are the core
//     asset — each must be referenced somewhere in test/ or testdata/.
//   - case: a switch-case label in a decision switch (install-script / match).
//   - export / regex: reported for visibility, but NOT part of the strict gate
//     — exported helpers are exercised via the scan() integration endpoint, and
//     regex fingerprints are too fuzzy to gate on.
//
// The strict gate therefore guards exactly the "rule table" surface, which is
// the part that silently decays.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const SRC_DIR = join(REPO_ROOT, 'src', 'adapters', 'node')
const TEST_DIR = join(REPO_ROOT, 'test')
const TESTDATA_DIR = join(REPO_ROOT, 'testdata')

const STRICT = process.argv.includes('--strict')

function listFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      listFiles(full, exts, out)
    } else if (exts.some((e) => full.endsWith(e))) {
      out.push(full)
    }
  }
  return out
}

/** Coverage corpus: unit tests + fixture data (lockfiles + expected.yaml). */
function readCorpus() {
  const testFiles = listFiles(TEST_DIR, ['.ts'])
  const dataFiles = listFiles(TESTDATA_DIR, ['.json', '.yaml', '.yml'])
  const all = [...testFiles, ...dataFiles]
  return all.map((f) => ({
    path: f,
    rel: relative(REPO_ROOT, f).split(sep).join('/'),
    content: readFileSync(f, 'utf8'),
  }))
}

const corpus = readCorpus()
const corpusAll = corpus.map((t) => t.content).join('\n\n')

// ---- Rule source extraction ------------------------------------------------

const srcFiles = listFiles(SRC_DIR, ['.ts']).map((f) => ({
  path: f,
  rel: relative(REPO_ROOT, f).split(sep).join('/'),
  content: readFileSync(f, 'utf8'),
}))

/** Strip comments so comment slashes are not mistaken for regex literals. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** Export-const NAME = [ ... ] (as const)? — the rule tables. */
function extractExportedStringArrays(src) {
  const results = []
  const reConst =
    /export\s+const\s+([A-Z][A-Z0-9_]+)\s*(?::\s*readonly\s+\w+\[\])?\s*=\s*\[([\s\S]*?)\]\s*(?:as\s+const)?/g
  let m
  while ((m = reConst.exec(src)) !== null) {
    const name = m[1]
    const items = []
    for (const line of m[2].split('\n')) {
      const itemMatch = line.match(/^\s*['"]([^'"]+)['"]/)
      if (itemMatch) items.push(itemMatch[1])
    }
    if (items.length > 0) results.push({ name, items })
  }
  return results
}

/**
 * Read the data-driven rule tables from `rules.json`. Since the keyword tables
 * moved out of `rules.ts` (L4), the coverage gate must scan the JSON source too —
 * otherwise the strict rule-item gate would silently lose its subject and the
 * whole "rule decay" protection would rot. Each JSON key whose value is a
 * `string[]` becomes a rule table; every string is a rule-item.
 */
function extractJsonRuleItems() {
  const jsonPath = join(SRC_DIR, 'rules.json')
  let data
  try {
    data = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    return [] // rules.json absent → nothing to gate (the TS tables still apply)
  }
  const results = []
  for (const [name, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      results.push({ name, items: value })
    }
  }
  return results
}

/** Exported function/const/class symbols (for visibility reporting). */
function extractExportedSymbols(src) {
  const out = new Set()
  const re = /^export\s+(?:function|const|class|async\s+function)\s+([A-Za-z_][A-Za-z0-9_]*)/gm
  let m
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return [...out]
}

/** Pull `case 'foo':` labels — string literal cases in decision switches. */
function extractSwitchCaseLabels(src) {
  const out = new Set()
  const re = /case\s+(['"])([^'"]+)\1\s*:/g
  let m
  while ((m = re.exec(src)) !== null) out.add(m[2])
  return [...out]
}

/** Pull regex literals like `/\bnode-gyp\s+(rebuild|build|configure)\b/`. */
function extractRegexLiterals(src) {
  const out = []
  const re = /\/((?:\\.|[^/\\\n])+)\/[gimsuy]*/g
  let m
  while ((m = re.exec(src)) !== null) {
    const body = m[1]
    if (body.length < 4) continue
    if (!/\\b|\(|\||\./.test(body)) continue
    out.push(body)
  }
  return out
}

// ---- Coverage checks -------------------------------------------------------

function isCovered(needle, hay = corpusAll) {
  if (!needle) return true
  return hay.includes(needle)
}

// ---- Report ----------------------------------------------------------------

const rows = []

for (const file of srcFiles) {
  const code = stripComments(file.content)
  const arrayNames = new Set(extractExportedStringArrays(file.content).map((a) => a.name))

  // exports — visibility only, covered if referenced anywhere in corpus
  for (const sym of extractExportedSymbols(file.content)) {
    const isType = /^(?:export\s+)?(interface|type)\s+/.test(
      file.content.match(new RegExp(`export\\s+(?:interface|type)\\s+${sym}\\b`))?.[0] ?? '',
    )
    if (isType) continue
    if (arrayNames.has(sym)) continue
    rows.push({ kind: 'export', name: sym, file: file.rel, covered: isCovered(sym) })
  }

  // rule-items — the strict-gated core
  for (const arr of extractExportedStringArrays(file.content)) {
    for (const item of arr.items) {
      rows.push({
        kind: 'rule-item',
        name: `${arr.name}: ${item}`,
        file: file.rel,
        covered: isCovered(item),
      })
    }
  }

  // switch cases — strict-gated (string-literal cases)
  for (const c of extractSwitchCaseLabels(code)) {
    rows.push({
      kind: 'case',
      name: `case '${c}'`,
      file: file.rel,
      covered: isCovered(`'${c}'`) || isCovered(`"${c}"`),
    })
  }

  // regexes — visibility only (fingerprint too fuzzy to gate)
  for (const r of extractRegexLiterals(code)) {
    const fingerprint = r
      .replace(/\\b/g, '')
      .replace(/[()]/g, ' ')
      .split(/[\s|]+/)
      .find((t) => t.length >= 4 && /[a-z]/.test(t))
    rows.push({
      kind: 'regex',
      name: `/${truncate(r, 32)}/`,
      file: file.rel,
      covered: fingerprint ? isCovered(fingerprint) : true,
    })
  }
}

// JSON rule tables (data-driven rules.json) — same strict gate as TS rule-items.
for (const arr of extractJsonRuleItems()) {
  for (const item of arr.items) {
    rows.push({
      kind: 'rule-item',
      name: `${arr.name}: ${item}`,
      file: 'src/adapters/node/rules.json',
      covered: isCovered(item),
    })
  }
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
const uncovered = rows.filter((r) => !r.covered)
const covered = rows.filter((r) => r.covered)
const total = rows.length
const pct = total === 0 ? 100 : ((covered.length / total) * 100).toFixed(1)

// Strict gate: rule-item + case must be fully covered.
const gateKinds = new Set(['rule-item', 'case'])
const gateUncovered = uncovered.filter((r) => gateKinds.has(r.kind))

const lines_ = []
lines_.push('')
lines_.push('== NativeCheck Rule Coverage ==')
lines_.push(
  `Source: ${srcFiles.length} files   |   Corpus: ${corpus.length} files (test/ + testdata/)   |   Total items: ${total}`,
)
lines_.push(`Coverage: ${covered.length}/${total} (${pct}%)`)
lines_.push('')

const visibilityUncovered = uncovered.filter((r) => !gateKinds.has(r.kind))
const renderGroup = (title, rs) => {
  if (rs.length === 0) return
  lines_.push(`${title} (${rs.length}):`)
  const byFile = new Map()
  for (const r of rs) {
    if (!byFile.has(r.file)) byFile.set(r.file, [])
    byFile.get(r.file).push(r)
  }
  for (const [file, items] of byFile) {
    lines_.push(`  ${file}`)
    for (const r of items) lines_.push(`    - [${r.kind}] ${r.name}`)
  }
  lines_.push('')
}

if (gateUncovered.length > 0) {
  renderGroup('UNCOVERED RULE (gate fail)', gateUncovered)
  lines_.push('Add a test fixture or assertion so each rule value is referenced.')
  lines_.push('')
} else {
  lines_.push('All rule-items and switch-cases covered. ✓')
  lines_.push('')
}

renderGroup('Uncovered exports/regex (visibility only, not gated)', visibilityUncovered)

const byKind = new Map()
for (const r of rows) {
  if (!byKind.has(r.kind)) byKind.set(r.kind, { c: 0, u: 0 })
  byKind.get(r.kind)[r.covered ? 'c' : 'u']++
}
lines_.push('By kind:')
for (const entry of byKind.entries()) {
  const kind = entry[0]
  const c = entry[1].c
  const u = entry[1].u
  lines_.push(`  ${kind.padEnd(12)} ${c} covered, ${u} uncovered`)
}
lines_.push('')

console.log(lines_.join('\n'))

process.exit(STRICT && gateUncovered.length > 0 ? 1 : 0)
