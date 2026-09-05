#!/usr/bin/env bash
# Ground Truth Docker matrix 编排（方案 §13.2/§13.4）。
#
# 矩阵：Node {20,22,24} × libc {glibc, musl} × {linux-x64}（x64 本机可跑；
# arm64/darwin/win32 用 GitHub Actions runner，见 .github/workflows）。
#
# 每个 cell：构建镜像 → 对 fixtures/ 下每个含 package-lock.json 的样本
# 依次跑 probe-install.sh → 结果写 out/<cell>/，最后 collect.py 汇总四格表。
#
# 用法（需 Docker）：
#   bash testdata/ground-truth/run-matrix.sh            # 跑全部 6 个 cell
#   bash testdata/ground-truth/run-matrix.sh 22 glibc   # 只跑一个 cell
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT_ROOT="${GT_OUT:-$HERE/out}"
FIXTURES="$REPO_ROOT/fixtures"
mkdir -p "$OUT_ROOT"

NODE_MAJORS=("${NC_NODE_MAJORS:-20 22 24}")
LIBMODES=("${NC_LIBMODES:-glibc musl}")

# libc → 基础镜像 tag
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

  # 对每个真实 fixture 样本（含 package-lock.json）逐一测量。
  # 用 find 抓含 package-lock.json 的目录；排除 unsupported（它们本来就不该被 npm 装）。
  # 测量 + 预测在同一容器内跑：保证预测的 env（node/libc/工具链）与测量 cell 完全一致
  # —— 这是 L2 四格表成立的前提（宿主机 env ≠ 容器 env 会导致预测错位）。
  local cells_count=0
  while IFS= read -r lockfile; do
    local project
    project="$(dirname "$lockfile")"
    local rel
    rel="$(realpath --relative-to="$FIXTURES" "$project")"
    case "$rel" in unsupported/*) continue ;; esac
    echo "  probe: $rel"
    # 挂载仓库（只读 fixture 作安装源）与 out 目录（收集结果）
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
echo "==== 汇总 ===="
python3 "$HERE/collect.py" "$OUT_ROOT"
