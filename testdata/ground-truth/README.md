# testdata/ground-truth/

Baseline of real install results. Ground truth is collected with compiler
wrappers: `cc` / `gcc` / `g++` / `clang` / `clang++` are replaced by recorders, so
any single call proves a local compile happened. A C/C++ addon cannot become a
`.node` without going through a compiler, which is far more reliable than
scraping `gyp ERR!` output.

> `make` is deliberately *not* wrapped: node-gyp runs `make BUILDTYPE=Release`
> even for an empty target (better-sqlite3 v13 turns the implicit
> `node-gyp rebuild` into a no-op via `prebuild_exists`), so wrapping it would
> report `compiled=yes` for packages that never compiled. Real compilation must
> pass through cc / g++ / clang, so wrapping the compilers alone stays exact.

## What is in this directory

```text
testdata/ground-truth/
├── wrap-compilers.sh    # install the compiler wrappers (root, inside the container); calls are logged to $NC_COMPILE_LOG
├── probe-install.sh     # measure one fixture: npm install, then compiled=yes|no → result.properties
├── run-matrix.sh        # orchestrate Node{20,22,24} × libc{glibc,musl}: build image, measure, aggregate per cell
├── repredict.sh         # re-run predictions only (no npm install), for fast iteration after a rule change
├── Dockerfile           # measurement image (BASE_IMAGE / LIBMODE arguments)
├── collect.py           # aggregate out/ into L1 / L2 / L3 metrics (stdlib only, no PyYAML)
└── windows/             # native Windows cells (no Docker)
```

## Usage (requires Docker)

```bash
# Full matrix: Node 20/22/24 × glibc/musl (linux-x64)
bash testdata/ground-truth/run-matrix.sh

# One cell, for a quick answer
bash testdata/ground-truth/run-matrix.sh 22 glibc

# Forensic rules changed but ground truth (compiled) did not? Re-predict only.
bash testdata/ground-truth/repredict.sh          # all six cells
bash testdata/ground-truth/repredict.sh 22 glibc # a single cell

# Aggregate an existing out/
python3 testdata/ground-truth/collect.py testdata/ground-truth/out
```

Artifacts: `testdata/ground-truth/out/<node>-<libc>/<fixture>/result.properties`
(`compiled=yes|no` plus install status) and, in the same cell,
`<fixture>.prediction.json`. `out/` and `.cache` are gitignored.

### The L2 table is built from in-cell predictions

`collect.py` never goes online, but L2's FP / FN needs a `--deep` prediction per
fixture, and that prediction must come from the **same** environment as the
measurement (same node, libc, toolchain). The host is glibc, so predicting for a
musl (alpine) cell from here would be wrong: esbuild ships a prebuilt binary for
glibc and not for musl.

`run-matrix.sh` therefore runs both halves inside each container: the measurement
(`probe-install.sh`) and the prediction (`predict.sh`, `nativecheck --deep`),
writing predictions to `out/<cell>/<fixture>.prediction.json`. `collect.py` keys
them by `(cell, fixture)`:

```bash
python3 testdata/ground-truth/collect.py testdata/ground-truth/out --blockers
```

Only when you have no in-cell predictions and want a rough local look, use the
cross-cell jsonl fallback:

```bash
nativecheck <fixture> --deep --json \
  | jq -c '{fixture:.findings[0].pkg.name, strategy:.findings[0].strategy, blockers:.findings[0].blockers}'
# collect the lines into predictions.jsonl
python3 testdata/ground-truth/collect.py testdata/ground-truth/out --predict predictions.jsonl --blockers
```

The fallback reuses one prediction across cells, which blurs the musl / glibc
difference (rows are tagged `[fb]` in the report). It is an approximation, not a
replacement for in-cell predictions.

## Matrix

```text
Node:   20 (ABI 115) / 22 (ABI 127) / 24 (ABI 137)
libc:   debian (glibc) / alpine (musl)
Target: linux-x64 / linux-arm64     (darwin / win32 run on GitHub Actions runners)
```

`.github/workflows/ground-truth.yml` runs this weekly (plus on demand): the full
glibc / musl matrix on an ubuntu runner, aggregating in-cell predictions into the
four-square table with a 5% FN gate.

## Metrics by layer

| Layer | Question                               | Metric                        |
| ----- | -------------------------------------- | ----------------------------- |
| L1    | Is this package native?                | miss rate (weighted ×2)       |
| L2    | Prebuilt binary or local source build? | FP / FN rate                  |
| L3    | Which toolchain pieces are missing?    | blocker recall                |

## Continuous regression

The weekly matrix installs for real, compares `nativecheck --deep` predictions
against what happened, and builds the four-square table. Accuracy dropping past
the threshold (FN > 5%) fails the job, and new FP / FN cases are kept as
regression fixtures.

## Known measurement noise

`compiled=no` does not prove a prebuilt binary was used. A full matrix run
back-to-back introduces systematic noise, so attribute an FP before deciding the
prediction rule is wrong:

0. **[fixed]** The musl cells missed the `c++` wrapper (diagnosed 2026-09-05). On
   alpine, node-gyp compiles C++ with `/usr/bin/c++`, which is a separate copy of
   g++ rather than the update-alternatives symlink Debian uses, so the old
   `wrap-compilers.sh` list (`cc gcc g++ clang clang++`) never wrapped it. Every
   pattern-D package in the musl cells "compiled but was logged as
   `compiled=no`", producing 72 phantom FPs (an FP rate inflated to 54%). `c++`
   is now in the list (a no-op on glibc). This was the root cause of the FPs that
   used to cluster in musl — not the classifier.
1. Node headers download limits: pattern-D packages need Node headers from
   `unofficial-builds.nodejs.org` before compiling, and back-to-back installs can
   hit `ETIMEDOUT` → `configure` fails → the build never reaches compilation.
   That only produces `install-failed` (which is not part of the L2 table), never
   `compiled=no`. So if you see `compiled=no` on musl, suspect item 0 first.
2. npm 10 exits 0 even when an install script fails: if node-gyp's `configure`
   fails, `npm install` still exits 0, so `probe-install.sh` records `install=ok`
   and you get the contradictory `install=ok` plus `compiled=no`. Some packages
   swallow the failure outright (`cpuid` runs
   `(node-gyp rebuild 2> builderror.log) || (exit 0)`). This is measurement noise,
   not evidence that nothing was compiled.

Three steps to tell a real FP from noise: (1) check whether that cell's
`compile-log.txt` is empty; (2) if it is, reproduce the single package by hand
(`docker run --rm <image> sh -c "npm install <pkg> --foreground-scripts"`);
(3) if it compiles by hand it is measurement noise (do not touch the rules); if it
does not, it is a real FP and belongs in a regression fixture.

> `run-matrix.sh` builds the compiler wrappers into the image (the Dockerfile's
> `RUN wrap-compilers.sh`). Inside a fixture container, `wrap-compilers.sh` sees
> the existing `.real` and skips. Whether the wrappers are active has nothing to
> do with `--foreground-scripts`, which only controls whether npm echoes script
> stdout.
