# NativeCheck

NativeCheck 是一个本地优先的依赖兼容性诊断工具。它在项目的包管理器开始编译之前，先进行一个评估，从而回答 4 个问题：

```text
我安装时会不会进入 Native Build（本地编译）？
为什么需要本地编译？
需要什么环境？
当前环境缺什么？
```

## 快速开始

需要 **Node.js ≥ 20.17**。无需安装即可用 `npx` 运行，也支持全局安装：

| 方式           | 命令                         |
| -------------- | ---------------------------- |
| 免安装（推荐） | `npx nativecheck .`          |
| 全局安装       | `npm install -g nativecheck` |

扫描一个项目（默认 `--fast`：**无需网络请求**）：

```text
$ nativecheck env        # 环境体检（可选，单独一条命令）

NativeCheck

Environment
  linux x64 · Node 22.22.2 (ABI 127) · npm 10.9.7 · libc glibc

$ nativecheck .          # 也可 nativecheck <目录>

NativeCheck

Dependency scan
  564 packages · 5 native candidates

Result
  🟢 5 prebuilt-compatible
  🟡 0 source-build
  🔴 0 likely blocked
  🔵 0 unverified
  🔵 0 ambiguous
  network calls: 0

🟢 sharp@0.35.4  PREBUILT-COMPATIBLE

Dependency path
  my-app
    └─ sharp

Evidence
  ✓ 判定为分发模式 A(平台可选依赖)（PlatformOptionalDeps）  [复刻型]
  ✓ 平台子包 @img/sharp-linux-x64 满足当前平台（linux-x64），无需本地编译  [复刻型]
```

`Result` 里的五类风险恒等于 `native candidates`；因当前平台不适用而被跳过的**可选**包（如 Windows 上的 `fsevents`）会单独提示，不进候选。

常用命令一览：

| 命令                               | 作用                                               |
| ---------------------------------- | -------------------------------------------------- |
| `nativecheck .`                    | 默认 `--fast`：只读 lockfile，零网络，秒级出结果   |
| `nativecheck . --deep`             | 联网取证 B / C 模式预编译产物（结果磁盘缓存 7 天） |
| `nativecheck . --deep --no-cache`  | 深扫但不写 / 不读取证缓存                          |
| `nativecheck . --json`             | 机器可读输出（zod schema 约束）                    |
| `nativecheck . --ci`               | CI 模式：存在 blocker 或 HIGH 风险时**非零退出**   |
| `nativecheck env`                  | 环境体检：OS / Node / Python / 编译器 / 系统库     |
| `nativecheck target <包名>[@版本]` | 单包诊断，无需 lockfile（联网查单包）              |
| `nativecheck explain <包名>`       | 从当前项目查某个 native 候选的证据链               |

退出码：`0` 正常 · `1` 参数错误，或（`--ci`）存在 blocker / HIGH 风险 · `2` 不支持的 lockfile 格式（只要检测到就返回，不依赖 `--ci`）。

### 项目结构

```text
nativecheck/
├── src/                        # 源码
│   ├── core/                   # 核心策略
│   ├── adapters/node/          # Node Adapter
│   ├── env/                    # 环境扫描
│   ├── cli/                    # CLI 入口与渲染
│   └── index.ts                # 库入口
├── fixtures/                   # 核心资产
├── testdata/                   # 测试数据
├── test/                       # 单元 / 集成测试
├── scripts/                    # 性能baseline
└── .github/workflows/          # CI 测试
```

### 开发命令

```bash
npm install
npm run typecheck               # tsc --noEmit
npm test                        # vitest run
npm run lint                    # eslint
npm run format:check            # prettier
npm run build                   # tsup → dist/
npm start -- .                  # 直接用 tsx 跑 CLI
npm run rules:coverage:strict   # 规则表覆盖率（CI 门禁）
```

## 特性

- **默认本地检测**：默认路径完全离线，不发任何网络请求；`--deep` 才联网，且结果落盘缓存。
- **按需懒加载**：CLI 入口按子命令懒加载——`env` / `--help` / 参数报错等轻命令不加载扫描引擎，只有 `scan` / `explain` / `target` 才按需 `import`（重依赖如 `@npmcli/arborist` 不会在启动时全量加载），冷启动大幅下降。
- **诊断四类 native 分发模式**：平台专属可选依赖（A）、prebuildify（B）、安装时远端下载（C）、纯源码构建（D）。
- **回答「这包跟我的机器有关系吗」**：复刻 npm 自己的 `os` / `cpu` / `libc` 闸门——本平台不适用的**可选**包直接跳过（不入候选，只在摘要里提示），必需的则报 `UNSUPPORTED` + 阻塞项；模式 A 还会比对锁文件里子包的平台约束，而不是默认「一定有预编译产物」。
- **可溯源**：结果会标注它到底是复刻了 npm/node-gyp 自己的决策逻辑（复刻型，≈100%）、基于约定的推测（推测型，80–95%）、还是离线未验证（未验证）；每条结论都带完整依赖链（`my-app > tsup > esbuild`），回答「谁把 native 带进了项目」。
- **Fail Closed**：检测不到时如实报「未验证 / 不确定」（灰色），绝不猜成「高风险」；不确定的结论恒带「如何变确定」的提示。
- **环境体检**：探测 OS / Node ABI / libc / Python / C·C++ 编译器；Linux 上做系统库探测（`pkg-config`，提示可能缺的 `-dev` 库）。
- **CI 友好**：`--json`（zod 契约）+ `--ci`（非零退出门禁）。
- **预防非法输入**：检测到不支持的 lockfile 格式时报错退出（含 Bun 1.2+ 的文本 `bun.lock`），不做猜测；未知命令行参数也会报错，而不是静默忽略。

## 工作原理

v1 的平铺流程要求每个包都走完整（含网络）检查；NativeCheck 用**四层漏斗**逐层收窄候选集，让昂贵的网络 I/O 只发生在极少数包上：

```text
第 1 层 Ingest    用 arborist 读 lockfile · 采集五类信号 + 依赖链 · 0 网络
第 2 层 Classify  模式分类 A/B/C/D · 平台闸门 · 依赖边信号（S3） · 0 网络
第 3 层 Verify    流式 tar / HTTP HEAD（仅 --deep）            · 需网络
第 4 层 Match     环境比对 → 策略 + 证据链 + 可靠性标注 + 风险
```

### 四种分发模式

| 模式                   | 机制                                                   | 代表包                       | 零网络可检测                        |
| ---------------------- | ------------------------------------------------------ | ---------------------------- | ----------------------------------- |
| **A** 平台专属可选依赖 | 主包 + 多个按 `os`/`cpu` 限定的二进制子包              | esbuild、sharp、swc、rollup  | ✅ 100%（含子包与本平台的匹配比对） |
| **B** prebuildify      | 预编译产物打进自身 tarball 的 `prebuilds/`             | better-sqlite3 ≥13、bcrypt 6 | ⚠️ 可判定「是 native」              |
| **C** 安装时远端下载   | `prebuild-install` / `node-pre-gyp` 拉 GitHub Releases | canvas、sqlite3              | ⚠️ 需 1 次 HEAD                     |
| **D** 纯源码构建       | 只有 `binding.gyp` + 源码                              | node-sass、posix             | ✅                                  |

### 可靠性标注

| 标记 | 类型              | 含义                                       | 可靠度 |
| ---- | ----------------- | ------------------------------------------ | ------ |
| `✓`  | 复刻型 Replay     | 判定逻辑就是 npm / node-gyp 自己的决策逻辑 | ≈100%  |
| `~`  | 推测型 Inferred   | 基于约定与启发式的推断                     | 80–95% |
| `?`  | 未验证 Unverified | 离线未查询，或行为无法静态确定             | —      |

> 因为 install 脚本是图灵完备的、系统库依赖无法静态穷举、网络状态不可预知、编译能否成功必须实际运行一遍编译，所以编译前的 100% 可靠是不可能实现的

---

## 准确率与测试

NativeCheck 用 ground-truth 自证准确率：在真实容器里跑 `npm install`，用编译器 wrapper 判定每个包有没有发生本地编译（C/C++ 编译必经 `cc`/`g++`，比抓日志可靠）：

| 指标                                                          | 结果                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| 平台验证矩阵                                                  | Linux glibc + musl × Node 20/22/24，6-cell 全量测试          |
| 全量测试结果（68 个可安装 fixture × 6 环境 ≈ 408 次真实安装） | L2 判定 FN 漏报率 0.00%，FP 误报率 3.08%，确定性覆盖率 98.2% |
| L1 native 检出                                                | 由 fixtures（66 native）+ held-out（40）单测覆盖             |
| 自动化测试                                                    | 371 用例 / 21 文件通过测试（vitest）                         |
| 泛化验证                                                      | 40 个非 benchmark 真实包 held-out 集                         |

> `fixtures/` 共 72 个样本（66 native + 2 非 native 对照 + 4 格式对照）；其中 4 个
> 格式对照（lockfile v1 / 形态错误的 pnpm、yarn、bun）本来就不该被安装，所以进
> Docker 矩阵的是 68 个可安装样本。

## 支持范围

```text
✓ Node.js ≥ 20.17 · npm
✓ package.json + package-lock.json   （lockfileVersion 2 / 3）
✓ pnpm-lock.yaml                     （packages + snapshots 结构）
✓ yarn.lock                          （v1 classic + Berry __metadata）
✓ bun.lockb                          （二进制，经解码复用 yarn v1 归一化）
✗ lockfileVersion 1 · bun 文本 bun.lock（检测到即明确退出）
```

> 未支持格式的退出信息会原样列出上面这份支持范围（`--json` 里的
> `unsupported.supported`），不会写死成 npm 一条。

> 系统库探测（`System library` 段）目前仅在 Linux 上跑（`pkg-config`），macOS / Windows 后期会加入支持。

## 后续开发

- [ ] 系统库探测扩展到 macOS（brew 的 `.pc` 路径）与 Windows（vcpkg / MSYS2）
- [ ] pnpm / yarn 适配器补 `hasInstallScript` 等价信号：两种 lockfile 都不记录 install 脚本，导致「node-addon-api + install 脚本」的 D / B 区分退化（目前靠 `--deep` 取证兜底）
- [ ] 模式 A 的 `absent` 结论进一步落地：确认子包缺失时安装脚本到底是硬失败还是自行下载

## License

本项目采用 [GNU GPL v3.0](./LICENSE) 许可证。
