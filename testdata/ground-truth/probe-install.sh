#!/usr/bin/env bash
# Run one real npm install in the given fixture project; the compiler wrappers decide whether a
# local build happened. This is the smallest Ground Truth measurement unit: `compiled=yes|no` is
# a physical fact (a build must go through a compiler).
#
# Usage (inside a container with the wrappers already installed, project root as $1):
#   bash probe-install.sh <projectRoot>
#
# Output to <projectRoot>/../../..? No -- results go to the explicit outdir ($2, optional,
# default /out). Convention: one subdirectory per measured project under outdir; its file names
# carry the outcome, for collect.py to aggregate.
set -euo pipefail

PROJECT_ROOT="${1:?usage: probe-install.sh <projectRoot> [outdir]}"
OUT_DIR="${2:-/out}"
CELL="$OUT_DIR/$(basename "$(realpath "$PROJECT_ROOT")")"

: "${NC_COMPILE_LOG:=/tmp/nc-compile.log}"
# The wrappers must be installed from outside (the docker image entrypoint) before the probe;
# this only backstops that cc is present. (Real compilers are mv'd to .real by the wrapper
# script, so if cc cannot be found the container has no toolchain -- the measurement is void.)
if [ ! -x "$(command -v cc 2>/dev/null)" ] && [ ! -x "$(command -v gcc 2>/dev/null)" ]; then
  echo "warn: no cc/gcc detected -- the toolchain may be missing, compiled=no is not trustworthy" >&2
fi

mkdir -p "$CELL"
rm -f "$NC_COMPILE_LOG"

# Install into a writable temp copy inside the container, so the read-only mounted repo is
# not modified or left with node_modules. (The image mounts the repo :ro at the same path;
# this copies it under /work and installs there.)
WORK_COPY="/work/probe-$(basename "$PROJECT_ROOT")"
rm -rf "$WORK_COPY"
cp -r "$PROJECT_ROOT" "$WORK_COPY"
cd "$WORK_COPY"
# The copy carries the real package-lock.json, so npm install runs directly (a v3 lockfile installs)
if npm install --no-audit --no-fund > "$CELL/install.log" 2>&1; then
  status="ok"
else
  status="install-failed"
fi

if [ -s "$NC_COMPILE_LOG" ]; then
  compiled="yes"
  # Record which files/compilers were actually used, for auditing
  sort -u "$NC_COMPILE_LOG" > "$CELL/compile-log.txt" 2>/dev/null || true
else
  compiled="no"
  # When nothing compiled, truncate compile-log.txt so stale lines from a previous measurement
  # cannot mislead the audit
  : > "$CELL/compile-log.txt"
fi

cat > "$CELL/result.properties" <<EOF
project=$(basename "$PROJECT_ROOT")
compiled=$compiled
install=$status
node=$(node -v 2>/dev/null || echo unknown)
libc=$(ldd --version 2>&1 | head -1 || echo unknown)
EOF
echo "cell=$CELL compiled=$compiled install=$status"
