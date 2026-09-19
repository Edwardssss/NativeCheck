#!/usr/bin/env bash
# Run nativecheck's L2 prediction (--deep) for a single fixture inside the container, writing
# the cell's prediction.json. Runs in the same container as probe-install.sh, keeping
# node/libc/toolchain = the measured cell's env.
#
# Usage: bash predict.sh <projectRoot> <cellOutDir>
#   projectRoot: this fixture's directory in the repo (mounted read-only)
#   cellOutDir:  run-matrix.sh's out/<node>-<libc>/
#   requires: $NC_REPO points at the repo root (containing dist/cli.js); npm run build before probing.
set -euo pipefail

PROJECT_ROOT="${1:?usage: predict.sh <projectRoot> <cellOutDir>}"
CELL="${2:?usage: predict.sh <projectRoot> <cellOutDir>}"
REPO="${NC_REPO:-/repo}"
CLI="$REPO/dist/cli.js"
FIXTURE="$(basename "$PROJECT_ROOT")"

if [ ! -f "$CLI" ]; then
  echo "warn: cannot find $CLI (run npm run build in the repo first); skipping prediction" >&2
  exit 0
fi

node "$CLI" "$PROJECT_ROOT" --deep --json \
  | node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c));
      process.stdin.on("end", () => {
        try {
          const r = JSON.parse(s);
          const x = (r.findings || []).find(
            (f) => f.verdict === "YES" || f.verdict === "SUSPICIOUS",
          );
          const out = {
            fixture: process.argv[1],
            strategy: x?.strategy || null,
            risk: x?.risk || null,
            pattern: x?.pattern || null,
            blockers: x?.blockers?.length || 0,
            env: {
              os: r.environment?.os,
              arch: r.environment?.arch,
              libc: r.environment?.libc,
              node: r.environment?.nodeVersion,
            },
          };
          process.stdout.write(JSON.stringify(out));
        } catch {
          process.stdout.write(JSON.stringify({ fixture: process.argv[1], error: "parse-failed" }));
        }
      });
    ' "$FIXTURE" > "$CELL/$FIXTURE.prediction.json"

echo "prediction=$CELL/$FIXTURE.prediction.json"
