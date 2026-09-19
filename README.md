# NativeCheck

NativeCheck tells you what will happen when you install a native dependency,
**before** you run `npm install`. It reads your lockfile and your machine — no
install, no network — and answers four questions:

```text
Will this install trigger a native build?
Why does it need one?
What does that build need?
What is this machine missing?
```

## Quick start

Requires **Node.js ≥ 20.17**. Run it with `npx`, or install it globally:

| Method                   | Command                      |
| ------------------------ | ---------------------------- |
| No install (recommended) | `npx nativecheck .`          |
| Global                   | `npm install -g nativecheck` |

```console
$ nativecheck env          # environment check-up (optional, standalone)

NativeCheck

Environment
  linux x64 · Node 22.22.2 (ABI 127) · npm 10.9.7 · libc glibc

$ nativecheck .            # or: nativecheck <directory>

NativeCheck

Dependency scan
  564 packages · 5 native candidates

Result
  🟢 5 prebuilt-compatible
  🟡 0 source-build
  🔴 0 likely blocked
  🔵 0 unverified
  🔵 0 ambiguous
  network calls: 0

🟢 sharp@0.35.4  PREBUILT-COMPATIBLE

Dependency path
  my-app
    └─ sharp

Evidence
  ✓ classified as distribution pattern A(platform optional deps) (PlatformOptionalDeps)  [replay]
  ✓ platform sub-package @img/sharp-linux-x64 matches the current platform (linux-x64); no local compile needed  [replay]
```

The five risk categories in `Result` always add up to `native candidates`.
**Optional** packages the current platform cannot use (say `fsevents` on Windows)
are reported separately and never counted as candidates.

### Commands

| Command                              | What it does                                                      |
| ------------------------------------ | ----------------------------------------------------------------- |
| `nativecheck .`                      | Default `--fast`: read the lockfile, zero network, instant        |
| `nativecheck . --deep`               | Fetch remote artifacts to verify patterns B / C (cached 7 days)   |
| `nativecheck . --deep --no-cache`    | Deep scan without reading or writing the forensics cache          |
| `nativecheck . --json`               | Machine-readable output (zod-validated)                           |
| `nativecheck . --ci`                 | CI mode: **non-zero exit** on a blocker or a HIGH risk            |
| `nativecheck env`                    | Environment check-up: OS / Node / Python / compiler / system libs |
| `nativecheck target <pkg>[@version]` | Diagnose one package without a lockfile                           |
| `nativecheck explain <pkg>`          | Evidence chain for one native candidate in this project           |

Exit codes: `0` success · `1` bad arguments, or (with `--ci`) a blocker / HIGH
risk · `2` unsupported lockfile format, reported on detection regardless of `--ci`.

## Features

- **Local by default.** The default path is fully offline and makes no network
  requests at all. Only `--deep` goes online, and its results are cached on disk.
- **Lazy loading.** The CLI loads subcommands on demand: `env`, `--help` and
  argument errors never pull in the scan engine, and heavy dependencies such as
  `@npmcli/arborist` are imported only by `scan` / `explain` / `target`. Cold
  start stays small.
- **Four native distribution patterns**, because "native" is not one thing:
  platform-specific optional dependencies (A), prebuildify (B), fetch-at-install
  (C), source-only (D).
- **Does this package even apply to my machine?** NativeCheck replays npm's own
  `os` / `cpu` / `libc` gate. Optional packages that cannot work here are skipped
  (not counted, just noted); required ones are reported as `UNSUPPORTED` with a
  blocker. For pattern A it compares the platform constraints recorded in the
  lockfile instead of assuming a prebuilt binary must exist.
- **Traceable.** Every finding says how it was reached: replaying npm / node-gyp's
  own decision logic (replay, ≈100%), inference from conventions (inferred,
  80–95%), or unverified offline. Each carries the full dependency chain
  (`my-app > tsup > esbuild`), so you can see who brought the native dependency in.
- **Fail closed.** When something cannot be determined, NativeCheck says
  "unverified / ambiguous" instead of guessing "high risk", and always suggests
  how to settle it.
- **Environment check-up.** OS, Node ABI, libc, Python, C / C++ compilers, plus
  system library probing via `pkg-config` on Linux (naming the `-dev` packages
  that may be missing).
- **CI ready.** `--json` for a stable contract, `--ci` for a non-zero exit.
- **No guessing at input.** Unsupported lockfile formats exit explicitly
  (including Bun 1.2's text `bun.lock`), and unknown flags are errors rather than
  being silently ignored.

## How it works

A flat pipeline would run an expensive check on every package. NativeCheck
narrows the candidate set in four layers, so network I/O only touches the few
packages that need it:

```text
Layer 1  Ingest    read the lockfile with arborist · five signals + dependency chains · no network
Layer 2  Classify  pattern A/B/C/D · platform gate · dependency-edge signal (S3) · no network
Layer 3  Verify    streaming tar / HTTP HEAD (--deep only)                 · network
Layer 4  Match     compare against the environment → strategy + evidence + reliability + risk
```

### The four distribution patterns

| Pattern                      | Mechanism                                                | Examples                     | Detectable offline                    |
| ---------------------------- | -------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| **A** platform optional deps | main package + `os`/`cpu`-constrained binary packages    | esbuild, sharp, swc, rollup  | ✅ 100% (including sub-package match) |
| **B** prebuildify            | prebuilt artifacts inside the package's own tarball      | better-sqlite3 ≥13, bcrypt 6 | ⚠️ "is native" yes, artifacts no      |
| **C** fetch at install       | `prebuild-install` / `node-pre-gyp` from GitHub Releases | canvas, sqlite3              | ⚠️ needs one HEAD request             |
| **D** source only            | `binding.gyp` + sources, nothing else                    | node-sass, posix             | ✅                                    |

### Reliability labels

| Mark | Label      | Meaning                                               | Confidence |
| ---- | ---------- | ----------------------------------------------------- | ---------- |
| `✓`  | Replay     | The decision logic is npm / node-gyp's own            | ≈100%      |
| `~`  | Inferred   | Inferred from conventions and heuristics              | 80–95%     |
| `?`  | Unverified | Not looked up offline, or not statically determinable | —          |

> Install scripts are Turing-complete, system library dependencies cannot be
> enumerated statically, the network is unpredictable, and whether a compile
> succeeds can only be known by compiling. 100% confidence before a build is not
> achievable, and NativeCheck does not pretend otherwise.

## Accuracy and testing

NativeCheck is measured against ground truth: real `npm install` runs in real
containers, with compiler wrappers deciding whether a local compile actually
happened (C / C++ must go through `cc` / `g++` to produce a `.node`, which is more
reliable than scraping logs).

| Metric                                                                     | Result                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Platform matrix                                                            | Linux glibc + musl × Node 20 / 22 / 24, six cells, full runs      |
| Full matrix (68 installable fixtures × 6 environments ≈ 408 real installs) | L2 FN 0.00%, FP 3.08%, deterministic coverage 98.2%               |
| L1 native detection                                                        | covered by unit tests over fixtures (66 native) + held-out (40)   |
| Automated tests                                                            | 371 cases across 21 files (vitest)                                |
| Generalization                                                             | 40 real packages held out from the benchmark set                  |
| Windows                                                                    | native cells in `testdata/ground-truth/windows/` (see its README) |

> `fixtures/` holds 72 samples (66 native + 2 non-native controls + 4 format
> controls). The 4 format controls (lockfile v1 and malformed pnpm / yarn / bun)
> should never be installed, so 68 installable samples go into the matrix.

## Supported inputs

```text
✓ Node.js ≥ 20.17 · npm
✓ package.json + package-lock.json   (lockfileVersion 2 / 3)
✓ pnpm-lock.yaml                     (packages + snapshots)
✓ yarn.lock                          (v1 classic + Berry __metadata)
✓ bun.lockb                          (binary; decoded and normalized through yarn v1)
✗ lockfileVersion 1 · text bun.lock   (detected and reported, never guessed)
```

> When a format is unsupported, the error lists exactly this set of supported
> formats (`unsupported.supported` in `--json`) rather than assuming npm.

> System library probing (the `System library` section) currently runs on Linux
> only (`pkg-config`); macOS and Windows support is planned.

> On Windows, `cl.exe` is on `PATH` but cannot compile from a plain shell — it
> needs `INCLUDE` / `LIB`, which only a Developer Command Prompt or `vcvars64.bat`
> provides. The compiler probe reports what it actually found rather than
> assuming a working toolchain.

## Project layout

```text
nativecheck/
├── src/
│   ├── core/                   # ecosystem-independent core
│   ├── adapters/node/          # Node adapter
│   ├── env/                    # environment probing
│   ├── cli/                    # CLI entry point and rendering
│   └── index.ts                # library entry point
├── fixtures/                   # the core asset: samples per distribution pattern
├── testdata/                   # integration and ground-truth data
├── test/                       # unit and integration tests
├── scripts/                    # performance baseline
└── .github/workflows/          # CI
```

## Development

```bash
npm install
npm run typecheck               # tsc --noEmit
npm test                        # vitest run
npm run lint                    # eslint
npm run format:check            # prettier
npm run build                   # tsup → dist/
npm start -- .                  # run the CLI through tsx
npm run rules:coverage:strict   # rule-table coverage (CI gate)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for fixture conventions and code style.

## Roadmap

- [ ] System library probing on macOS (brew `.pc` paths) and Windows (vcpkg / MSYS2)
- [ ] Windows: when the target Node's `common.gypi` requires clang-cl-only flags
      (`-flto=thin`, `/opt:lldltojobs`), say so — MSVC's `link.exe` rejects them,
      so a correct-looking toolchain still fails to link
- [ ] Grow the Windows ground-truth cells (six today) and run them in CI
- [ ] Pattern A `absent`: determine whether the install script fails hard or
      fetches a fallback when no sub-package matches the platform

## License

[GNU GPL v3.0](./LICENSE)
