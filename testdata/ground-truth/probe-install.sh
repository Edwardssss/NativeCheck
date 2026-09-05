#!/usr/bin/env bash
# 在给定 fixture 项目里做一次真实 npm install，用编译器 wrapper 判定是否本地编译。
# 这是 Ground Truth 的最小测量单元：`compiled=yes|no` 是物理事实（编译必经编译器）。
#
# 用法（在已装好 wrapper 的容器内，项目根为 $1）：
#   bash probe-install.sh <projectRoot>
#
# 产出到 <projectRoot>/../../..? 不 —— 结果写到显式给出的 outdir（$2，可选，默认 /out）。
# 约定：outdir 下每个被测项目一个子目录，文件名含产物结论，供 collect.py 汇总。
set -euo pipefail

PROJECT_ROOT="${1:?用法: probe-install.sh <projectRoot> [outdir]}"
OUT_DIR="${2:-/out}"
CELL="$OUT_DIR/$(basename "$(realpath "$PROJECT_ROOT")")"

: "${NC_COMPILE_LOG:=/tmp/nc-compile.log}"
# wrapper 需在 probe 之前由外部（docker 镜像 entrypoint）装好；这里兜底确认 cc 存在。
# （真实编译器被 wrapper 脚本 mv 成 .real，若探测不到 cc，说明容器没装工具链 —— 测量无效）
if [ ! -x "$(command -v cc 2>/dev/null)" ] && [ ! -x "$(command -v gcc 2>/dev/null)" ]; then
  echo "warn: 未检测到 cc/gcc —— 工具链可能未装，compiled=no 将不可信" >&2
fi

mkdir -p "$CELL"
rm -f "$NC_COMPILE_LOG"

# 在容器内的可写临时副本里安装，避免改动只读挂载的仓库 / 在仓库留 node_modules。
# （容器内镜像把仓库以 :ro 挂载到同路径；这里复制到 /work 下再装。）
WORK_COPY="/work/probe-$(basename "$PROJECT_ROOT")"
rm -rf "$WORK_COPY"
cp -r "$PROJECT_ROOT" "$WORK_COPY"
cd "$WORK_COPY"
# 复制会带上真实 package-lock.json，直接 npm install（v3 lockfile 可装）
if npm install --no-audit --no-fund > "$CELL/install.log" 2>&1; then
  status="ok"
else
  status="install-failed"
fi

if [ -s "$NC_COMPILE_LOG" ]; then
  compiled="yes"
  # 记录到底编译了哪些文件/编译器，便于审计
  sort -u "$NC_COMPILE_LOG" > "$CELL/compile-log.txt" 2>/dev/null || true
else
  compiled="no"
  # 免编时清空 compile-log.txt，避免残留上一次测量的 stale 行误导审计
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
