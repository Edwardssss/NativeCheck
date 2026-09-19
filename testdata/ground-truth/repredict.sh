#!/usr/bin/env bash
# Re-run only predict.sh (not the expensive npm install measurement), overwriting each cell's
# prediction.json with the current dist/cli.js. Meant for fast re-measurement when the evidence
# rules changed but ground-truth (compiled=yes|no) did not; an order of magnitude faster than a
# full run-matrix.sh (which includes npm install).
#
# Prerequisites:
#   - dist/cli.js has already been npm run build'd;
#   - the nc-gt:<major>-<mode> images were already built by run-matrix.sh.
#
# Usage:
#   bash testdata/ground-truth/repredict.sh            # all 6 cells
#   bash testdata/ground-truth/repredict.sh 22 glibc   # a single cell
#   GT_OUT=/path/to/out bash testdata/ground-truth/repredict.sh  # explicit out root (defaults to run-matrix's)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT_ROOT="${GT_OUT:-$HERE/out}"
FIXTURES="$REPO_ROOT/fixtures"

NODE_MAJORS=("${NC_NODE_MAJORS:-20 22 24}")
LIBMODES=("${NC_LIBMODES:-glibc musl}")

repredict_cell() {
  local major="$1" mode="$2"
  local tag="nc-gt:${major}-${mode}"
  local cell="$OUT_ROOT/${major}-${mode}"
  echo "== re-predict $major-$mode =="
  docker run --rm \
    -v "$REPO_ROOT:$REPO_ROOT:ro" \
    -v "$OUT_ROOT:$OUT_ROOT" \
    -e NC_REPO="$REPO_ROOT" \
    -e NC_CELL="$cell" \
    -e NC_FIXTURES="$FIXTURES" \
    "$tag" \
    bash -c '
      set -e
      while IFS= read -r lockfile; do
        project="$(dirname "$lockfile")"
        rel="${project#$NC_FIXTURES/}"
        case "$rel" in unsupported/*) continue ;; esac
        echo "  predict: $rel"
        bash /usr/local/bin/predict.sh "$project" "$NC_CELL" || true
      done < <(find "$NC_FIXTURES" -name package-lock.json -type f | sort)
    '
}

run() {
  if [ $# -eq 2 ]; then
    repredict_cell "$1" "$2"
  else
    for major in $NODE_MAJORS; do
      for mode in $LIBMODES; do
        repredict_cell "$major" "$mode"
      done
    done
  fi
}

run "$@"
echo "==== re-predict done ===="
