/**
 * Detection rule tables for the Node ecosystem.
 *
 * One of NativeCheck's core assets. Any change here must be accompanied by
 * fixture updates — rules decay over time (it already happened once with
 * `better-sqlite3` v12.4 → v13), and without regression tests the degradation
 * is silent.
 *
 * The **keyword tables** live in `rules.json` (data-driven — editing the allowlists
 * does not touch this TS file); the semantics / "why" stay here as comments.
 * `scripts/check-rule-coverage.mjs` scans BOTH `rules.json` (rule-item values)
 * and this file (switch cases), so the strict coverage gate still guards the
 * rule surface after the split.
 *
 * Maps to design doc §10.1, §10.2, §11.2
 */
import rules from './rules.json'

/**
 * Native build-tool allowlist — the **union view** of every build tool.
 *
 * Nothing imports it: the classifier reads the per-pattern sets below, and a
 * dependency edge on any of these names already lands in one of them. It is kept
 * as the single reviewable place listing the allowlist (and it is what the rule-
 * coverage gate walks).
 *
 * Key insight: **a native package may declare no native trait at all, but it
 * must depend on a build tool.** So "dependency edge hits the allowlist" is far
 * more reliable than `gypfile` / `hasInstallScript` — the latter are largely
 * missing from registry metadata (`better-sqlite3@13` reports `gypfile: false`
 * and has no install script).
 */
export const NATIVE_BUILD_TOOLS: readonly string[] = rules.NATIVE_BUILD_TOOLS

/** Pattern B criterion: a prebuilt picker. */
export const PREBUILDIFY_LOADERS: readonly string[] = rules.PREBUILDIFY_LOADERS

/** Pattern C criterion: a remote downloader. */
export const REMOTE_DOWNLOADERS: readonly string[] = rules.REMOTE_DOWNLOADERS

/** Legacy Pattern D signals: these packages almost always require a source build. */
export const LEGACY_NATIVE_DEPS: readonly string[] = rules.LEGACY_NATIVE_DEPS

/** N-API header dependency — more modern than nan; covers packages like better-sqlite3@13. */
export const NAPI_HEADERS: readonly string[] = rules.NAPI_HEADERS

/**
 * Supporting signals: hitting one alone is not enough to conclude, but
 * combined with an install script it forms a medium-strength signal.
 *
 * Note that `detect-libc` is deliberately NOT in this list (nor any "drop to
 * SUSPICIOUS" list): it is far too common — many pure-JS packages depend on it
 * (sharp, lightningcss, @parcel/watcher, …) — so treating it as a native signal
 * would flood the report with gray noise. `detect-libc` is therefore ignored by
 * the classifier entirely; SUSPICIOUS is produced only by `hasInstallScript`.
 *
 * Like `NATIVE_BUILD_TOOLS` this table has no code consumer: it documents *why*
 * those names are absent from every per-pattern set.
 */
export const AUXILIARY_NATIVE_DEPS: readonly string[] = rules.AUXILIARY_NATIVE_DEPS

/** Minimum count for a platform-constrained optional dependency cluster (S5 signal). */
export const PLATFORM_CLUSTER_THRESHOLD: number = rules.PLATFORM_CLUSTER_THRESHOLD

/** Fallback Node ABI table. The normal path uses the `node-abi` library; we maintain no table ourselves. */
export const FALLBACK_ABI: Readonly<Record<string, string>> = {
  '18': '108',
  '20': '115',
  '22': '127',
  '23': '131',
  '24': '137',
  '25': '141',
}

const SET = (list: readonly string[]): ReadonlySet<string> => new Set(list)

// Per-pattern lookup sets — the tables the classifier actually reads.
export const PREBUILDIFY_LOADERS_SET = SET(PREBUILDIFY_LOADERS)
export const REMOTE_DOWNLOADERS_SET = SET(REMOTE_DOWNLOADERS)
export const LEGACY_NATIVE_DEPS_SET = SET(LEGACY_NATIVE_DEPS)
export const NAPI_HEADERS_SET = SET(NAPI_HEADERS)
