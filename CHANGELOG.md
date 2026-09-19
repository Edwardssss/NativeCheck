# Changelog

Notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`0.x` is a preview line: the command line, the `--json` contract and the CI gate
are the parts meant to be depended on. Adapter internals live behind
`nativecheck/experimental` and may move between minor versions.

## [Unreleased]

- The Node floor moves from 20.17 to **20.19** in `engines`: `eslint@10` requires
  it, and `engine-strict` turns a mismatch into a failed install rather than a
  warning. Node 20 remains supported.
- Development toolchain: `eslint` / `@eslint/js` 10, `@types/node` 26,
  `js-yaml` 5 (which ships its own types, so `@types/js-yaml` is gone).
- Nothing is published yet: `0.1.0` below is waiting for the tag that publishes
  it (see [Releasing](./CONTRIBUTING.md#releasing)).

## [0.1.0]

- **Four native distribution patterns**, because "native" is not one thing:
  platform optional dependencies (A), prebuildify (B), fetch-at-install (C) and
  source-only (D), each with the evidence chain that produced the verdict.
- **Five risk categories** plus reliability labels (`replay` ≈100%, `inferred`
  80–95%, `unverified`), so "I could not determine this" is never reported as a
  defect of the scanned project.
- **Lockfiles**: npm (v2 / v3), pnpm, yarn v1 and Berry, `bun.lockb`.
  Unsupported formats (lockfile v1, text `bun.lock`) exit with the list of
  supported ones instead of guessing.
- **Platform gate**: npm's own `os` / `cpu` / `libc` constraints are replayed, so
  a package that cannot work on this machine is skipped or blocked explicitly
  rather than reported as a build failure.
- **`--deep` forensics** for patterns B / C: streaming tarball inspection and one
  HTTP `HEAD` per package, cached for 7 days, with bounded retries, backoff and
  proxy support. The default path makes no network requests at all.
- **`nativecheck env`**: OS, Node ABI, libc, Python, C / C++ compilers, and
  system library probing via `pkg-config` on Linux. On Windows, a failed plain
  probe falls back to the toolchain environment from `vcvars64.bat`, discovered
  through `vswhere.exe`, and reports the script it used.
- **`--json`** for a stable, schema-validated contract, and **`--ci`** gating with
  `--fail-on`, `--ignore` and `--baseline`. `UNVERIFIED` / `AMBIGUOUS` never fail
  a build at any threshold.
- **Library surface** split into a frozen root (`nativecheck`) and
  `nativecheck/experimental`.
- **Measurement**: 68 installable fixtures × 6 environments (Node 20 / 22 / 24 ×
  glibc / musl) ≈ 408 real installs, with compiler wrappers as the ground truth;
  72 fixture samples and 40 held-out real packages drive the unit suite.
