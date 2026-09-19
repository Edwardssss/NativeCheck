# Windows ground truth (native, no Docker)

The Linux harness in `../` runs each fixture in a container and wraps `cc` / `gcc`
on `PATH` to see whether a compile really happened. That design does not port to
Windows, so this directory produces the same kind of evidence natively: install a
fixture for real, record what actually happened on the machine, and compare it
with what the tool predicted for the same fixture.

## Prerequisites

1. **Visual Studio with the MSVC C++ toolset** (or Build Tools). `vcvars64.bat` is
   what supplies `INCLUDE` / `LIB`; without it nothing compiles, and the
   measurement would describe a broken machine rather than a package.
2. **`feat/windows-toolchain-probe` applied.** On a plain shell `cl.exe` is on
   `PATH` but cannot compile. Without the fix the probe reports "compiler present,
   probe failed" and every source-build finding becomes HIGH / _likely blocked_.
   Measured on this machine with the same fixtures: the two Pattern-D cells came
   out `SourceOnly` / **HIGH** without the fix and `SourceOnly` / **MEDIUM** with
   it. That difference is the fix's whole point, and it is why every recorded
   prediction carries `compilerVia: ...\vcvars64.bat` — if that field is missing
   from a results file, the predictions were produced in a broken shell and the
   numbers are not comparable.
3. Network access to a package registry, and to GitHub for Pattern C (see below).

## Running

```powershell
powershell -File testdata/ground-truth/windows/probe-install.ps1 -TimeoutSec 600
node testdata/ground-truth/windows/collect-windows.mjs testdata/ground-truth/windows/results/summary.json
```

Per cell, `probe-install.ps1` copies the fixture's `package.json` + lockfile into a
throwaway directory, installs it with `npm ci` **inside the MSVC developer
environment**, and records: install exit code, whether a compiler was invoked,
object files / `.node` binaries / `config.gypi`, whether binaries came from
`prebuilds/` (shipped in the tarball) or from a local build, the installed platform
sub-packages, and the tool's three-field projection for the same fixture. It
writes `result.json` per cell plus `summary.json`; `collect-windows.mjs` turns those
into the four-square table.

## Two harness decisions worth knowing

- **Install scripts are explicitly approved** (`--dangerously-allow-all-scripts`).
  This npm (11.19) blocks unapproved install scripts by default; without the flag a
  Pattern-D package never compiles and the table fills with false positives that
  belong to npm's script policy, not to NativeCheck. Packaging behaviour and script
  policy have to be measured separately.
- **`cl.exe` is not intercepted by the shim.** On Windows, gyp resolves MSVC
  through absolute paths rather than `PATH`, so a `cl.cmd` shim never fires (all
  cells: `shimHits = 0`). Ground truth therefore comes from observable side
  effects — the install log mentioning `node-gyp` / MSBuild, plus build
  intermediates on disk. That is weaker than compiler interception, which is why
  "tried to compile" exists as a column next to "compiled".

## Measured — 2026-09-19, Windows 10 19045, Node 26.7.0, npm 11.19.0, cl.exe 14.50.35717

Baseline: `main` at `985af76` (after the `feat/dependency-path` merge) with the
probe fix from `feat/windows-toolchain-probe` applied. The run was repeated on
that baseline after the merge, and the predictions did not move, so these numbers
describe the merged classifier rather than the pre-merge one.

| cell             | package        | install | compile observed                                              | predicted                                | verdict                   |
| ---------------- | -------------- | ------- | ------------------------------------------------------------- | ---------------------------------------- | ------------------------- |
| a-esbuild        | esbuild        | 0       | nothing ran; `@esbuild/win32-x64` installed                   | `PlatformOptionalDeps` / LOW / PREBUILT  | match                     |
| a-sharp          | sharp          | 0       | nothing ran; `@img/sharp-win32-x64` installed                 | `PlatformOptionalDeps` / LOW / PREBUILT  | match                     |
| b-better-sqlite3 | better-sqlite3 | 0       | nothing ran; 8 binaries under `prebuilds/`                    | `Prebuildify` / UNVERIFIED / PREBUILT    | undetermined, as declared |
| c-bcrypt         | bcrypt         | 1       | download failed (GitHub unreachable) → source build attempted | `RemoteDownload` / UNVERIFIED / PREBUILT | documented fallback fired |
| d-bignum         | bignum         | 1       | compile attempted, failed at link                             | `SourceOnly` / MEDIUM / SOURCE_BUILD     | match                     |
| d-sleep          | sleep          | 1       | compile attempted, failed at link                             | `SourceOnly` / MEDIUM / SOURCE_BUILD     | match                     |

```
=== L2 four-square (predicted SOURCE_BUILD x a compile happened) ===
  TP = 2    FP = 0    FN = 0    TN = 2
  undetermined, excluded from the square = 1
  predicted prebuilt where the documented fallback fired = 1
  deterministic coverage = 4/6        installs that succeeded = 3/6
```

Raw records: `results/summary.json` and `results/<cell>.json` (they contain the
install-log tails and absolute paths of the machine that produced them).

## What this measurement does and does not show

**Does show.**

- No cell was labelled safe while a compile happened: FP = 0 and FN = 0.
- The prebuilt paths were confirmed positively, not by absence of evidence: for
  Pattern A the platform sub-package was installed (esbuild ships a Go binary, so
  there is no `.node` to count for it); for Pattern B eight binaries arrived under
  `prebuilds/`; for Pattern C a single `.node` arrived with no build — in an
  earlier repeat of the same cell, before GitHub became unreachable.
- Pattern D was right in kind: a compile really was attempted for both packages.

**Does not show.** Anything about accuracy in general. Six hand-picked cells, one
machine, one Node version, one package manager. The single undetermined cell is the
honest cost of the zero-network rule — in fast mode the tool refuses to claim
"prebuilt" for Pattern B offline — and "undetermined, then confirmed" is not the
same as "determined and correct".

**c-bcrypt is the interesting row, and it is not a miss.** `node-pre-gyp` asked
GitHub for a prebuilt binary and the connection timed out:

```
node-pre-gyp http GET https://github.com/kelektiv/node.bcrypt.js/releases/download/v5.1.1/bcrypt_lib-v5.1.1-napi-v3-win32-x64-unknown.tar.gz
node-pre-gyp ERR! install request ... failed, reason: connect ETIMEDOUT 20.205.243.166:443
node-pre-gyp WARN Pre-built binaries not installable ... (falling back to source compile with node-gyp)
```

The tool's finding for this cell documents exactly that path in its `fallback`
block ("falls back to node-gyp rebuild when the remote download fails"), which is
why the cell is scored in its own bucket rather than as a false negative — and why
fast mode declares Pattern C unverified instead of LOW. The same cell succeeded with
a fetched `.node` on an earlier repeat: the outcome flips with GitHub reachability,
which is the reason the caveat exists.

**Do not read the D rows as failures of the tool.** Both legacy packages failed at
**link**, not compile:

```
cl : warning D9002: ignoring unknown option '-flto=thin'
LINK : fatal error LNK1117: option 'opt:lldltojobs=2' is invalid
```

Those flags come from Node 26's own `common.gypi` (in the node-gyp headers cache),
which sets `AdditionalOptions: ['-flto=thin']` — clang-cl / lld flags. `cl.exe`
warns and continues; MSVC's `link.exe` rejects `/opt:lldltojobs`, so a source build
against Node 26 does not link with the plain MSVC toolchain. `clang-cl.exe` and
`lld-link.exe` are installed alongside it (`VC\Tools\Llvm\bin`), which is the
direction a working Node 26 Windows source build takes. NativeCheck's prediction —
"this one needs a local build" — was correct; whether the build then succeeds is a
toolchain/version question the tool does not claim to answer.

**Incidental confirmation of a product claim.** During the esbuild install, npm
11.19 warned that `esbuild@0.25.0` has an install script "not yet covered by
allowScripts". That is precisely the advisory NativeCheck derives from its
`allowScripts` policy table — observed live rather than modelled.

## Reproducing the toolchain environment

```powershell
cmd /c "call ""D:\VS2026\VC\Auxiliary\Build\vcvars64.bat"" && set"   # INCLUDE / LIB
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" `
    -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
```

## Next steps this measurement points at

- Point node-gyp at `clang-cl` / `lld-link` so Pattern-D cells reach a successful
  link on Node 26, which would turn "compile attempted" into "compiled" and make
  the four-square unconditional.
- Grow the cell set beyond six (the Linux matrix has 68 installable samples) and
  run it in a CI job on a Windows runner, where the toolchain is known-good and
  GitHub is reachable.
