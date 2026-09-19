#!/usr/bin/env bash
# Ground Truth Docker matrix orchestration.
#
# Matrix: Node {20,22,24} × libc {glibc, musl} × {linux-x64} (x64 can run on this machine;
# arm64/darwin/win32 use GitHub Actions runners, see .github/workflows).
#
# Per cell: build the image -> for every sample under fixtures/ that has a package-lock.json
# run probe-install.sh in turn -> results go to out/<cell>/, then collect.py builds the
# four-square table.
#
# Usage (Docker required):
#   bash testdata/ground-truth/run-matrix.sh            # run all 6 cells
#   bash testdata/ground-truth/run-matrix.sh 22 glibc   # run a single cell
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT_ROOT="${GT_OUT:-$HERE/out}"
FIXTURES="$REPO_ROOT/fixtures"
mkdir -p "$OUT_ROOT"

NODE_MAJORS=("${NC_NODE_MAJORS:-20 22 24}")
LIBMODES=("${NC_LIBMODES:-glibc musl}")

# libc -> base image tag
base_for() {
  local major="$1" mode="$2"
  if [ "$mode" = "musl" ]; then echo "node:${major}-alpine"; else echo "node:${major}-bookworm-slim"; fi
}

measure_cell() {
  local major="$1" mode="$2"
  local tag="nc-gt:${major}-${mode}"
  local base
  base="$(base_for "$major" "$mode")"
  echo "== build $tag (base=$base) =="
  docker build \
    --build-arg "BASE_IMAGE=$base" \
    --build-arg "LIBMODE=$mode" \
    -t "$tag" \
    -f "$HERE/Dockerfile" "$REPO_ROOT"

  local cell="$OUT_ROOT/${major}-${mode}"
  mkdir -p "$cell"

  # Measure every real fixture sample (those with a package-lock.json), one by one.
  # find collects the directories holding a package-lock.json; unsupported/ is excluded
  # (npm is not supposed to install those anyway). Measurement + prediction run in the same
  # container, keeping the prediction env (node/libc/toolchain) identical to the measured cell
  # -- the precondition for the L2 four-square table (host env != container env would drift).
  local cells_count=0
  while IFS= read -r lockfile; do
    local project
    project="$(dirname "$lockfile")"
    local rel
    rel="$(realpath --relative-to="$FIXTURES" "$project")"
    case "$rel" in unsupported/*) continue ;; esac
    echo "  probe: $rel"
    # Mount the repo (read-only fixtures as the install source) and the out dir (result collection)
    docker run --rm \
      -v "$REPO_ROOT:$REPO_ROOT:ro" \
      -v "$OUT_ROOT:$OUT_ROOT" \
      -e "NC_COMPILE_LOG=/tmp/nc-compile.log" \
      -e "NC_REPO=$REPO_ROOT" \
      -e "NC_PROJECT=$project" \
      -e "NC_CELL=$cell" \
      "$tag" \
      bash -c 'bash /usr/local/bin/wrap-compilers.sh >/dev/null 2>&1 || true; \
               bash /usr/local/bin/probe-install.sh "$NC_PROJECT" "$NC_CELL" && \
               bash /usr/local/bin/predict.sh "$NC_PROJECT" "$NC_CELL" || true'
    cells_count=$((cells_count + 1))
  done < <(find "$FIXTURES" -name package-lock.json -type f)

  echo "cell $major-$mode: measured $cells_count fixtures → $cell"
}

run_all() {
  if [ $# -eq 2 ]; then
    measure_cell "$1" "$2"
  else
    for major in $NODE_MAJORS; do
      for mode in $LIBMODES; do
        measure_cell "$major" "$mode"
      done
    done
  fi
}

run_all "$@"
echo "==== summary ===="
python3 "$HERE/collect.py" "$OUT_ROOT"
