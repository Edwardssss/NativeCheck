#!/usr/bin/env bash
# 在容器内对单个 fixture 跑 nativecheck 的 L2 预测（--deep），写入 cell 的 prediction.json。
# 与 probe-install.sh 在同一容器跑，保证 node/libc/工具链 = 测量 cell 的 env。
#
# 用法：bash predict.sh <projectRoot> <cellOutDir>
#   projectRoot: 仓库里该 fixture 的目录（只读挂载）
#   cellOutDir:  run-matrix.sh 的 out/<node>-<libc>/
#   依赖：$NC_REPO 指向仓库根（含 dist/cli.js），probe 前需 npm run build。
set -euo pipefail

PROJECT_ROOT="${1:?用法: predict.sh <projectRoot> <cellOutDir>}"
CELL="${2:?用法: predict.sh <projectRoot> <cellOutDir>}"
REPO="${NC_REPO:-/repo}"
CLI="$REPO/dist/cli.js"
FIXTURE="$(basename "$PROJECT_ROOT")"

if [ ! -f "$CLI" ]; then
  echo "warn: 找不到 $CLI（需先在仓库 npm run build），跳过预测" >&2
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
