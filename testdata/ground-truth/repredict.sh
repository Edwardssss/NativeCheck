#!/usr/bin/env bash
# 只重跑 predict.sh（不重跑昂贵的 npm install 测量），用当前 dist/cli.js 覆盖各 cell 的
# prediction.json。适用于「改了取证规则、ground-truth(compiled=yes|no) 未变」时的快速重测，
# 比 run-matrix.sh 全套（含 npm install）快一个量级。
#
# 前置：
#   - dist/cli.js 已 npm run build；
#   - 镜像 nc-gt:<major>-<mode> 已由 run-matrix.sh 构建过。
#
# 用法：
#   bash testdata/ground-truth/repredict.sh            # 全部 6 cell
#   bash testdata/ground-truth/repredict.sh 22 glibc   # 单 cell
#   GT_OUT=/path/to/out bash testdata/ground-truth/repredict.sh  # 指定 out 根（默认同 run-matrix）
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
