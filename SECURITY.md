# Security policy

## Reporting a vulnerability

Use GitHub's private reporting form: **Security → Report a vulnerability** in this
repository. Please do not open a public issue for anything exploitable — a public
issue is a disclosure, not a report.

If the form is unavailable, open an issue that says only "security report, please
contact me" and nothing about the details.

What to include: the version (`nativecheck --version` or the npm version), your OS
and Node version, the command you ran, the lockfile kind (npm / pnpm / yarn /
bun) if it matters, and what you expected instead.

## What is in scope

NativeCheck reads lockfiles, compares them with the machine, and — with `--deep` —
downloads package tarballs to look for prebuilt artifacts. Anything that turns
_someone else's package data_ into code execution or data loss on the machine
running the scan is in scope. In particular:

- tarball parsing that escapes into the filesystem, or is not bounded in memory;
- lockfile input that makes the tool hang, crash, or write outside its cache;
- the `--deep` cache (`<project>/node_modules/.cache/nativecheck/verify.json`)
  being poisoned by a scanned project in a way that changes later verdicts;
- command injection through package metadata, proxy settings, or file paths;
- a dependency advisory that reaches the published package.

## What NativeCheck does and does not do

Worth knowing before you write a report, because some of it is deliberate:

- **It never runs the scanned project's install scripts.** Scanning is analysis,
  not installation.
- **The default path makes no network requests at all.** Only `--deep` goes
  online, and only to the registry / GitHub URLs of the packages being verified.
  There is no telemetry, and no project data is sent anywhere else.
- **It does run processes on your machine**, because the environment is half the
  question: `pkg-config` for system libraries, the C / C++ compilers for a trivial
  probe compile (in a temp directory), `where` / `command -v` for lookups, and on
  Windows `vswhere.exe` plus `cmd /c call vcvars64.bat && set` to read the
  toolchain environment. `nativecheck env` is the loudest example; the scan uses
  the compiler probe too.
- **A proxy from the environment is honoured** (`HTTP_PROXY` and friends) when
  `--deep` is used. A configured-but-unusable proxy is an error rather than a
  silent direct connection.
- **`--deep` is a fetch, not a sandbox.** Tarballs are streamed and parsed in
  memory; nothing from them is executed or unpacked to disk.

## Supported versions

This is a `0.x` preview: only the latest published version is supported, and there
are no backports. Fixes land on `main` and in the next release.

## How reports are handled

Best effort, no SLA. You will get an acknowledgement, an assessment of whether you
found a real issue, and credit in the changelog entry for the fix if you want it.
