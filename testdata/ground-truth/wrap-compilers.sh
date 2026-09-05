#!/usr/bin/env bash
# 编译器 wrapper 安装（方案 §13.1）。任何一次 C/C++ 编译调用都会留痕到日志，
# 100% 精确地证明「是否发生了本地编译」——比抓 `gyp ERR!` 日志可靠得多。
#
# 用法：在容器内以 root 运行 `bash /workspace/testdata/ground-truth/wrap-compilers.sh`
# 之后任何 cc/gcc/g++/clang/clang++ 调用都会 append 一行到 $NC_COMPILE_LOG。
#
# 注意：**故意不包装 `make`**。node-gyp 即使空目标（如 better-sqlite3 v13 用
# `prebuild_exists` 让隐式 node-gyp rebuild 变成 no-op）也必跑 `make BUILDTYPE=Release`，
# 包装 make 会把「根本没编译」误判成 compiled=yes。真正的编译必经 cc/g++/clang，
# 所以只包装编译器本身即可 100% 精确。
set -euo pipefail

: "${NC_COMPILE_LOG:=/tmp/nc-compile.log}"
rm -f "$NC_COMPILE_LOG"

wrap() {
  local c="$1" real
  real="$(command -v "$c" 2>/dev/null)" || return 0 # 镜像里没有该编译器则跳过
  # 已在包里的 compiler 目录则跳过（避免把 .real 也递归包装）
  [ -e "${real}.real" ] && return 0
  # 软链接要解析到真实文件，否则 mv 软链会破坏系统
  real="$(readlink -f "$real")"
  [ -e "${real}.real" ] && return 0
  mv "$real" "${real}.real"
  cat > "$real" <<EOF
#!/bin/sh
echo "\$0 \$*" >> "$NC_COMPILE_LOG"
exec "${real}.real" "\$@"
EOF
  chmod +x "$real"
}

# 必须包含 c++：alpine(musl) 上 node-gyp 用 `/usr/bin/c++` 编译 C++（c++ 是 g++ 的独立
# 副本/硬链接，不像 Debian 里 c++ 是 update-alternatives 软链最终落到被包装的 g++）。
# 漏掉 c++ 会让 musl cell 上所有 D 模式（源码编译）包「真编译了却记 compiled=no」，
# 制造 72 个假 FP（见 ground-truth README §已知测量噪声）。
for c in cc gcc g++ c++ clang clang++; do wrap "$c"; done

echo "compiler wrappers installed → $NC_COMPILE_LOG"
