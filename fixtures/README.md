# fixtures/

核心资产 —— 按分发模式组织的回归样本。

任何判定规则的改动必须补 fixture；`network_calls: 0` 是硬断言（维持默认路径零网络）。
`test/fixtures.test.ts` 是 fixture-runner：遍历每个含 `expected.yaml` 的样本（native 样本
配 lockfile，unsupported 样本配畸形 lockfile），用 `scan(<dir>, { mode: 'fast' })`
扫描并对照期望（零网络）。

覆盖目标： 四种分发模式各 ≥3 个真实样本，lockfile 全格式可读（npm package-lock v2+v3 /
pnpm-lock.yaml / yarn.lock v1+Berry / 二进制 bun.lockb，均见 `testdata/` 集成样本），
畸形 lockfile 一律明确退出（Fail Closed）。当前 A=5、B=3、C=5、D=53、
非 native 对照组 2、格式对照 4（共 72 样本；其中 native 样本 A+B+C+D = 66 ≥ 60，
满足 rule-of-three 的 ≤5% FN 置信度门槛）。
关键：模式 C 覆盖 prebuild-install 与 node-pre-gyp 两类下载器，非 native 覆盖「无 install 脚本」（lodash）与
「有 install 脚本」（core-js→SUSPICIOUS）两类，防判定过拟合。模式 D 全部经 Docker 编译器 wrapper
实测 `compiled=yes + install=ok`（真编译，非静态信号），覆盖现代 N-API 与 nan 两类源码编译路径。


## 目录约定

```text
fixtures/
├── pattern-a-platform-optional-deps/      # 模式 A：5 达标
│   ├── esbuild-style/           # esbuild@0.25，有 install 脚本但零风险（防误报）
│   ├── esbuild-style-lockfile-v2/  # 同 esbuild，lockfileVersion 2
│   ├── sharp-style/             # sharp，无 install 脚本（防漏报）
│   ├── swc-style/               # @swc/core，install 脚本 + 平台子包
│   └── node-rs-argon2/          # @node-rs/argon2（非 JS bundler 的密码学原生库，防过拟合）
├── pattern-b-prebuildify/                # 模式 B：3 达标
│   ├── all-platforms/           # better-sqlite3@13（node-gyp-build）
│   ├── bcrypt/                  # bcrypt@6（node-addon-api + node-gyp-build）
│   └── partial-platforms/       # microtime（node-gyp-build）
├── pattern-c-remote-download/            # 模式 C：5 达标（prebuild-install + node-pre-gyp 两类）
│   ├── available/               # better-sqlite3@11（prebuild-install）
│   ├── canvas/                  # canvas@3.2.3（prebuild-install）
│   ├── keytar/                  # keytar@7.9.0（prebuild-install）
│   ├── bcrypt-node-pre-gyp/     # bcrypt@5（@mapbox/node-pre-gyp + napi-v3，现代 Node 免编）
│   └── bcrypt-v3-node-pre-gyp/  # bcrypt@3（node-pre-gyp + nan，旧 ABI 现代 Node 404→源码编译）
├── pattern-d-source-only/                # 模式 D：53 达标（纯 node-gyp 源码编译，全部 Docker 实测 compiled=yes + install=ok）
│   # 现代 N-API（node-addon-api 头文件依赖，跨 ABI 稳定）
│   ├── sse4-crc32/              # sse4_crc32@7.0.0（bindings + node-addon-api + node-gyp）
│   ├── node-zopfli-es/          # node-zopfli-es@2.0.6
│   ├── node-zpaq/               # node-zpaq@1.0.3（+ bindings）
│   ├── zip-node-addon/          # zip-node-addon@0.0.11（+ bindings）
│   ├── napi-threadsafe-deferred/ # napi-threadsafe-deferred@0.3.1
│   ├── pqclean/                 # pqclean@0.8.1（+ bindings，密码学）
│   ├── spookyhash/              # spookyhash@3.0.0（+ bindings）
│   ├── test-native-addons/      # test-native-addons@1.0.0
│   ├── fjt-walter/              # fjt-walter@1.1.0
│   ├── bigint-buffer/           # bigint-buffer@1.1.5（bindings + 原生 node_api.h，install 有优雅降级）
│   └── node-pty/                # node-pty@1.1.0（node-addon-api + install 脚本 → D，防 B 误判）
│   # nan / bindings 源码编译（legacy V8 API，现代 Node 20/22/24 干净编译）
│   ├── cpu-features/            # cpu-features@0.0.10（nan，ssh2 加速器）
│   ├── nan-sleep/               # sleep（nan + node-gyp，必然源码编译）
│   ├── node-expat/              # node-expat@2.4.1（nan + bindings）
│   ├── heapdump/                # heapdump（nan，纯源码编译）
│   ├── posix/                   # posix@4.2.0（nan）
│   ├── unix-dgram/              # unix-dgram@2.0.7（nan + bindings）
│   ├── segfault-handler/        # segfault-handler@1.3.0（nan + bindings）
│   ├── abstract-socket/         # abstract-socket@2.1.1（nan + bindings，os:linux）
│   ├── raw-socket/              # raw-socket@1.8.1（nan）
│   ├── node-stringprep/         # node-stringprep@0.8.0（nan + bindings）
│   ├── bignum/                  # bignum@0.13.1（nan + bindings）
│   ├── node-inotify/            # node-inotify@1.0.0（nan + bindings，os:linux）
│   ├── diskusage/               # diskusage@1.2.0（nan）
│   ├── blake2/                  # blake2@5.0.1（nan）
│   ├── xxhash/                  # xxhash@0.3.0（nan）
│   ├── metrohash/               # metrohash@3.2.0（nan + bindings）
│   ├── ed25519/                 # ed25519@0.0.5（nan + bindings）
│   ├── node-statvfs/            # node-statvfs@0.0.2（nan）
│   ├── oniguruma/               # oniguruma@7.2.3（nan，内置 libonig）
│   ├── lz4/                     # lz4@0.6.5（nan）
│   ├── node-xxhash/             # node-xxhash@0.3.0（nan）
│   ├── cpuid/                   # cpuid@0.1.3（nan）
│   ├── mmmagic/                 # mmmagic@0.5.3（nan，依赖 libmagic）
│   ├── murmurhash3/             # murmurhash3（nan）
│   ├── epoll/                   # epoll（nan + bindings，os:linux）
│   ├── rpio/                    # rpio（nan + bindings，Raspberry Pi GPIO）
│   ├── pigpio/                  # pigpio（nan + bindings，Raspberry Pi GPIO）
│   ├── i2c/                     # i2c（bindings）
│   ├── i2c-bus/                 # i2c-bus（nan + bindings）
│   ├── lzo/                     # lzo（bindings）
│   ├── genx/                    # genx@2.0.0（nan，XML 生成器）
│   ├── pcap/                    # pcap@3.1.0（nan，依赖 libpcap）
│   ├── cap/                     # cap@0.2.1（nan，依赖 libpcap）
│   ├── speaker/                 # speaker@0.5.5（bindings，依赖 alsa）
│   ├── libpq/                   # libpq@1.11.0（nan + bindings，依赖 libpq）
│   ├── node-opus/               # node-opus@0.3.3（nan + bindings，依赖 libopus）
│   ├── nanomsg/                 # nanomsg@4.2.1（nan + bindings，依赖 libnanomsg）
│   ├── linux-device/            # linux-device@2.1.4（bindings，os:linux）
│   ├── actual-crash/            # actual-crash@1.0.3（nan + bindings）
│   ├── pprof/                   # pprof@5.0.0（nan + bindings，依赖 libunwind）
│   ├── zlib-sync/               # zlib-sync@0.1.10（nan）
│   └── tree-sitter-cairo/       # tree-sitter-cairo@0.0.2（nan）
├── non-native/                            # 2 样本
│   ├── pure-js-lodash/          # 防误报：纯 JS，零 native 候选（无 install 脚本）
│   └── core-js-postinstall/     # 纯 JS + postinstall → SUSPICIOUS/AMBIGUOUS（有候选非 native）
└── unsupported/                          # 畸形 lockfile → Fail Closed（各格式已支持，见 testdata/）
    ├── bun-malformed/           # 畸形 bun.lockb（随机字节）→ Fail Closed
    ├── lockfile-v1/             # package-lock.json v1 → Fail Closed（v1 结构未适配）
    ├── pnpm-lock/               # 不完整 pnpm（有 packages 无 snapshots）→ Fail Closed
    └── yarn-malformed/          # 畸形 yarn.lock（无合法顶层 entry）→ Fail Closed
```

每个样本含（fixture-runner 的硬前提）：

- `package.json` + `package-lock.json`：真实 `npm install --package-lock-only` 产物，
  arborist `loadVirtual` 无需 node_modules 即可加载。
- `expected.yaml`：期望判定结果。

## expected.yaml 格式

```yaml
pattern: PlatformOptionalDeps  # 命中包的判定模式（多 finding 时需 subject 定位）
strategy: PREBUILT            # 期望 InstallStrategy
risk: LOW                     # 可选；环境相关（如模式 D 的编译器缺失）则不 pin
native: true                  # 是否 native 入口
subject: esbuild              # 可选；多 native 候选时用于定位目标包
network_calls: 0              # 关键：断言零网络，防回归
```

对 `unsupported` 样本（pnpm-lock / lockfile-v1 / yarn-malformed / bun-malformed）：

```yaml
unsupported: true
detected: pnpm-lock.yaml
reason_contains: pnpm   # 期望 reason 包含的子串
network_calls: 0
```

对「零 native 候选」对照组（non-native/pure-js-lodash）：

```yaml
native: false
native_count: 0   # 断言 native 候选数（区分「无候选」与「有候选但非 native」）
network_calls: 0
```

### 说明

- `risk` 只在环境无关时断言。模式 D 的 risk 取决于本机工具链是否齐全
  （缺编译器→HIGH，齐全→LOW/MEDIUM），故 D 样本不 pin risk，只 pin 环境无关的
  `pattern`/`strategy`/`native`。
- 深取证专属场景（musl 变体、缺当前平台、远端 404/限流）在 fast 下与对应基础样本
  判定相同（A 恒 LOW、B/C 恒 UNVERIFIED），需 `--deep` 才能区分 —— 属于
  deep-fixture 范围，待配套 harness 后补充（见`testdata/ground-truth/`）。

## 单元测试 fixture

`test/*.test.ts` 里的分类器 / 匹配器测试直接喂手写 `LockfilePackage`（见 `signals.ts`），
不必为纯逻辑生成真实 lockfile —— 那是本目录里「真实样本」fixture 的用途。
