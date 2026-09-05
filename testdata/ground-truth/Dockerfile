# Ground Truth 测量镜像：Node + 完整 C/C++ 工具链，用作真实 npm install 的沙箱。
#
# libc 由调用方选定的基础镜像决定（见 run-matrix.sh 里 libc→基础镜像 tag 的映射）：
#   glibc → node:<N>-bookworm-slim
#   musl  → node:<N>-alpine
# 用法：
#   docker build \
#     --build-arg BASE_IMAGE=node:22-bookworm-slim \
#     --build-arg LIBMODE=glibc \
#     -t nc-gt:22-glibc .
#
# Ground Truth 目的：镜像工具链齐全 → 任何 native 包都能尝试编译，
# 才能干净地区分「本平台无预编译(需编译)」vs「有预编译(免编译)」。
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# wrapper / probe / predict 脚本（上下文必须是本仓库根，脚本在 testdata/ground-truth/）
COPY testdata/ground-truth/wrap-compilers.sh /usr/local/bin/wrap-compilers.sh
COPY testdata/ground-truth/probe-install.sh /usr/local/bin/probe-install.sh
COPY testdata/ground-truth/predict.sh /usr/local/bin/predict.sh
RUN chmod +x /usr/local/bin/wrap-compilers.sh /usr/local/bin/probe-install.sh /usr/local/bin/predict.sh

# 装工具链（glibc=debian apt / musl=alpine apk 分开）
ARG LIBMODE=glibc
# 常见系统开发库：让依赖系统库的「真 native」包（pcap/cap → libpcap，speaker → alsa，
# libpq → postgres）也能在矩阵里真实编译，而不是因缺 lib 误报 install-failed 噪声。
RUN if [ "$LIBMODE" = "musl" ]; then \
      apk add --no-cache build-base bash python3 git ca-certificates curl \
        linux-headers musl-dev libpcap-dev alsa-lib-dev postgresql-dev; \
    else \
      apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 git ca-certificates curl \
        libpcap-dev libasound2-dev libpq-dev \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# 预装编译器 wrapper（保留 .real 真身；probe 前若被污染可重跑 wrap-compilers.sh）
RUN bash /usr/local/bin/wrap-compilers.sh || true

WORKDIR /work
ENV NC_COMPILE_LOG=/tmp/nc-compile.log
