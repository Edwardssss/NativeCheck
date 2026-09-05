# testdata/ground-truth/

真实安装结果基线。Ground truth 靠编译器 wrapper 采集：
把 `cc`/`gcc`/`g++`/`clang`/`clang++` 替换成记录器，任何一次调用都证明发生了本地编译 ——
C/C++ 变成 `.node` 物理上必经编译器，比抓 `gyp ERR!` 日志可靠得多。

> 故意不包装 `make`：node-gyp 即使空目标（如 better-sqlite3 v13 用
> `prebuild_exists` 让隐式 `node-gyp rebuild` 变成 no-op）也必跑 `make BUILDTYPE=Release`，
> 包装 make 会把「根本没编译」误判成 `compiled=yes`。真正的编译必经 cc/g++/clang，
> 所以只包装编译器本身即可保持 100% 精确。

## 本目录提供的脚本

```text
testdata/ground-truth/
├── wrap-compilers.sh    # 安装编译器 wrapper（容器内以 root 跑）；调用记入 $NC_COMPILE_LOG
├── probe-install.sh     # 单 fixture 测量：npm install + 判 compiled=yes|no → result.properties
├── run-matrix.sh        # 编排：Node{20,22,24} × libc{glibc,musl}，逐 cell 构建镜像+测量+汇总
├── repredict.sh         # 只重跑 predict.sh（不重跑 npm install），规则改动后的快速重测
├── Dockerfile           # 测量镜像（参数 BASE_IMAGE / LIBMODE）
├── collect.py           # 汇总 out/ → L1/L2/L3 指标（纯标准库，无 PyYAML 依赖）
└── README.md
```

## 用法（需 Docker）

```bash
# 全矩阵：Node 20/22/24 × glibc/musl（linux-x64）
bash testdata/ground-truth/run-matrix.sh

# 单 cell 快测
bash testdata/ground-truth/run-matrix.sh 22 glibc

# 改了取证规则、ground-truth(compiled) 未变时，只重跑预测（不重跑 npm install，快一个量级）
bash testdata/ground-truth/repredict.sh          # 全部 6 cell
bash testdata/ground-truth/repredict.sh 22 glibc # 单 cell

# 汇总（out/ 已存在时单独跑）
python3 testdata/ground-truth/collect.py testdata/ground-truth/out
```

产物：`testdata/ground-truth/out/<node>-<libc>/<fixture>/result.properties`
（compiled=yes|no + install 状态）与同 cell 的 `<fixture>.prediction.json`。
`out/` 与 `.cache` 不入库（gitignore）。

### L2 四格表来自 cell 内预测（env-accurate）

`collect.py` 不联网。L2 的 FP/FN 需要每个 fixture 的 `--deep` 预测。关键约束：
预测必须与被测 cell 同一 env（node/libc/工具链）生成 —— 宿主机是 glibc，
跑到 musl(alpine) cell 上预测会错位（如 esbuild 在 glibc 有预编译、musl 没有）。

因此 `run-matrix.sh` 在每个容器内既跑测量（probe-install.sh）也跑预测
（predict.sh，`nativecheck --deep`），把预测写到 `out/<cell>/<fixture>.prediction.json`。
`collect.py` 自动按 `(cell, fixture)` 键控加载这些文件做四格表：

```bash
python3 testdata/ground-truth/collect.py testdata/ground-truth/out --blockers
```

只有当你手头没有 cell 内预测、想本地快速看个近似时，才用跨 cell 的 jsonl fallback：

```bash
nativecheck <fixture> --deep --json \
  | jq -c '{fixture:.findings[0].pkg.name, strategy:.findings[0].strategy, blockers:.findings[0].blockers}'
# 逐行收集成 predictions.jsonl
python3 testdata/ground-truth/collect.py testdata/ground-truth/out --predict predictions.jsonl --blockers
```

注意：jsonl fallback 跨 cell 共享同一条预测，会模糊掉 musl/glibc 的环境差异
（在报表里标 `[fb]`），只作近似，不取代容器内预测。

## 评测矩阵

```text
Node:  20 (ABI 115) / 22 (ABI 127) / 24 (ABI 137)
libc:  debian (glibc) / alpine (musl)
平台:  linux-x64 / linux-arm64    （darwin / win32 用 GitHub Actions runner）
```

CI 已在 `.github/workflows/ground-truth.yml` 落地（每周一 + 手动触发），在 ubuntu
runner 上跑全部 glibc/musl cell，用容器内预测汇总四格表 + FN 漏报率 5% 门禁。

## 分层指标

| 层  | 判定内容             | 指标                          |
| --- | -------------------- | ----------------------------- |
| L1  | 是不是 native 包     | 漏报率（权重 ×2，漏报最严重） |
| L2  | 走预编译还是源码构建 | FP / FN 率                    |
| L3  | 缺失哪些工具链       | 阻塞项召回率                  |

## 持续回归

每周定时 Docker matrix 跑真实安装 → 对比 `nativecheck --deep` 预测与实际 → 四格表；
准确率下降超阈值（FN > 5%）自动失败，新 FP/FN 自动落为 regression fixture。

## 已知测量噪声

`compiled=no` 不一定等于「有预编译产物」。全量 matrix 连续跑会引入系统性噪声，
看到 FP 先归因、再决定是否改预测规则：

0. 〔已修复〕musl cell 的 compiler wrapper 漏包装 `c++`（2026-09-05 定位）：
   alpine 上 node-gyp 用 `/usr/bin/c++` 编译 C++（c++ 是 g++ 的独立副本/硬链接，
   不像 Debian 里 c++ 是 update-alternatives 软链最终落到被包装的 g++）。旧
   `wrap-compilers.sh` 只包 `cc gcc g++ clang clang++`，漏了 `c++`，导致 musl cell
   上所有 D 模式包「真编译了却记 `compiled=no`」，制造 72 个假 FP（FP 率虚高到 54%）。
   已在包装列表补上 `c++`（对 glibc 是 no-op）。这就是历史 FP 全集中在 musl 的根因，
   不是 NativeCheck 分类器的问题。
1. node-gyp headers 下载限流：D 模式包（纯 `node-gyp rebuild`）编译前需从
   `unofficial-builds.nodejs.org` 下载 Node headers；连续安装会触发限流
   ETIMEDOUT → `configure` 失败 → 未到编译步骤。注意这只会造成 `install-failed`
   （不进 L2 四格表），不会造成 `compiled=no`——若见到 musl `compiled=no`，先怀疑第 0 条。
2. npm 10 对 install 脚本失败仍返回 exit 0：node-gyp `configure` 失败时
   `npm install` 仍以 0 退出 → `probe-install.sh` 误判 `install=ok`。于是出现
   「`install=ok` 但 `compiled=no`」的矛盾组合。某些包（如 `cpuid` 的
   `(node-gyp rebuild 2> builderror.log) || (exit 0)`）甚至主动吞掉编译失败——
   这是测量噪声，不是「免编译」证据。

判定 FP 真伪的三步：① 看该 cell 的 `compile-log.txt` 是否为空；② 空则手动
复现单包（`docker run --rm <image> sh -c "npm install <pkg> --foreground-scripts"`）；
③ 手动能编译 → 测量噪声（不改规则）；手动也免编译 → 真 FP（回归 fixture）。

> `run-matrix.sh` 的镜像在构建时已装好 compiler wrapper（Dockerfile 的 `RUN wrap-compilers.sh`），
> 运行时每个 fixture 容器里 `wrap-compilers.sh` 检测到 `.real` 已存在会跳过——wrapper 生效与否
> 与 `--foreground-scripts` 无关（后者只影响 npm 是否回显脚本 stdout）。
