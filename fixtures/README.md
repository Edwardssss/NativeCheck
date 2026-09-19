# fixtures/

The core asset: regression samples organized by distribution pattern.

Any change to a detection rule must come with a fixture. `network_calls: 0` is a
hard assertion that keeps the default path offline. `test/fixtures.test.ts` is the
fixture runner: it walks every sample containing an `expected.yaml` (native
samples ship a lockfile, unsupported samples ship a malformed one), scans it with
`scan(<dir>, { mode: 'fast' })`, and compares the result against expectations.

Coverage targets: at least three real samples per distribution pattern, every
lockfile format readable (npm package-lock v2 + v3, pnpm-lock.yaml, yarn.lock v1
+ Berry, binary bun.lockb — all covered by the integration samples in
`testdata/`), and malformed lockfiles exiting explicitly (fail closed). Current
counts: A=5, B=3, C=5, D=53, plus 2 non-native controls and 4 format controls
(72 samples; the 66 native ones satisfy the rule-of-three threshold for ≤5% FN
confidence). Pattern C covers both downloaders (prebuild-install and
node-pre-gyp), and the non-native controls cover both "no install script"
(lodash) and "has an install script" (core-js → SUSPICIOUS), so the classifier
cannot overfit to either. Every pattern-D sample was measured in Docker with the
compiler wrappers and recorded `compiled=yes` + `install=ok`, covering both the
modern N-API and the legacy nan source-build paths.

## Layout

```text
fixtures/
├── pattern-a-platform-optional-deps/      # pattern A: 5 samples
│   ├── esbuild-style/           # esbuild@0.25: install script yet zero risk (false-positive guard)
│   ├── esbuild-style-lockfile-v2/  # same as esbuild, lockfileVersion 2
│   ├── sharp-style/             # sharp: no install script (false-negative guard)
│   ├── swc-style/               # @swc/core: install script + platform sub-packages
│   └── node-rs-argon2/          # @node-rs/argon2: a crypto native library, not a bundler (overfitting guard)
├── pattern-b-prebuildify/                # pattern B: 3 samples
│   ├── all-platforms/           # better-sqlite3@13 (node-gyp-build)
│   ├── bcrypt/                  # bcrypt@6 (node-addon-api + node-gyp-build)
│   └── partial-platforms/       # microtime (node-gyp-build)
├── pattern-c-remote-download/            # pattern C: 5 samples (prebuild-install and node-pre-gyp)
│   ├── available/               # better-sqlite3@11 (prebuild-install)
│   ├── canvas/                  # canvas@3.2.3 (prebuild-install)
│   ├── keytar/                  # keytar@7.9.0 (prebuild-install)
│   ├── bcrypt-node-pre-gyp/     # bcrypt@5 (@mapbox/node-pre-gyp + napi-v3: no compile on modern Node)
│   └── bcrypt-v3-node-pre-gyp/  # bcrypt@3 (node-pre-gyp + nan: 404 on modern Node → source build)
├── pattern-d-source-only/                # pattern D: 53 samples (pure node-gyp source builds, all measured compiled=yes + install=ok)
│   # modern N-API (node-addon-api header dependency, stable across ABIs)
│   ├── sse4-crc32/              # sse4_crc32@7.0.0 (bindings + node-addon-api + node-gyp)
│   ├── node-zopfli-es/          # node-zopfli-es@2.0.6
│   ├── node-zpaq/               # node-zpaq@1.0.3 (+ bindings)
│   ├── zip-node-addon/          # zip-node-addon@0.0.11 (+ bindings)
│   ├── napi-threadsafe-deferred/ # napi-threadsafe-deferred@0.3.1
│   ├── pqclean/                 # pqclean@0.8.1 (+ bindings, cryptography)
│   ├── spookyhash/              # spookyhash@3.0.0 (+ bindings)
│   ├── test-native-addons/      # test-native-addons@1.0.0
│   ├── fjt-walter/              # fjt-walter@1.1.0
│   ├── bigint-buffer/           # bigint-buffer@1.1.5 (bindings + node_api.h; the install script degrades gracefully)
│   └── node-pty/                # node-pty@1.1.0 (node-addon-api + install script → D, guards against a B misread)
│   # nan / bindings source builds (legacy V8 API, clean builds on Node 20/22/24)
│   ├── cpu-features/            # cpu-features@0.0.10 (nan, ssh2 accelerator)
│   ├── nan-sleep/               # sleep (nan + node-gyp: always a source build)
│   ├── node-expat/              # node-expat@2.4.1 (nan + bindings)
│   ├── heapdump/                # heapdump (nan, pure source build)
│   ├── posix/                   # posix@4.2.0 (nan)
│   ├── unix-dgram/              # unix-dgram@2.0.7 (nan + bindings)
│   ├── segfault-handler/        # segfault-handler@1.3.0 (nan + bindings)
│   ├── abstract-socket/         # abstract-socket@2.1.1 (nan + bindings, os:linux)
│   ├── raw-socket/              # raw-socket@1.8.1 (nan)
│   ├── node-stringprep/         # node-stringprep@0.8.0 (nan + bindings)
│   ├── bignum/                  # bignum@0.13.1 (nan + bindings)
│   ├── node-inotify/            # node-inotify@1.0.0 (nan + bindings, os:linux)
│   ├── diskusage/               # diskusage@1.2.0 (nan)
│   ├── blake2/                  # blake2@5.0.1 (nan)
│   ├── xxhash/                  # xxhash@0.3.0 (nan)
│   ├── metrohash/               # metrohash@3.2.0 (nan + bindings)
│   ├── ed25519/                 # ed25519@0.0.5 (nan + bindings)
│   ├── node-statvfs/            # node-statvfs@0.0.2 (nan)
│   ├── oniguruma/               # oniguruma@7.2.3 (nan, bundles libonig)
│   ├── lz4/                     # lz4@0.6.5 (nan)
│   ├── node-xxhash/             # node-xxhash@0.3.0 (nan)
│   ├── cpuid/                   # cpuid@0.1.3 (nan)
│   ├── mmmagic/                 # mmmagic@0.5.3 (nan, needs libmagic)
│   ├── murmurhash3/             # murmurhash3 (nan)
│   ├── epoll/                   # epoll (nan + bindings, os:linux)
│   ├── rpio/                    # rpio (nan + bindings, Raspberry Pi GPIO)
│   ├── pigpio/                  # pigpio (nan + bindings, Raspberry Pi GPIO)
│   ├── i2c/                     # i2c (bindings)
│   ├── i2c-bus/                 # i2c-bus (nan + bindings)
│   ├── lzo/                     # lzo (bindings)
│   ├── genx/                    # genx@2.0.0 (nan, XML generator)
│   ├── pcap/                    # pcap@3.1.0 (nan, needs libpcap)
│   ├── cap/                     # cap@0.2.1 (nan, needs libpcap)
│   ├── speaker/                 # speaker@0.5.5 (bindings, needs alsa)
│   ├── libpq/                   # libpq@1.11.0 (nan + bindings, needs libpq)
│   ├── node-opus/               # node-opus@0.3.3 (nan + bindings, needs libopus)
│   ├── nanomsg/                 # nanomsg@4.2.1 (nan + bindings, needs libnanomsg)
│   ├── linux-device/            # linux-device@2.1.4 (bindings, os:linux)
│   ├── actual-crash/            # actual-crash@1.0.3 (nan + bindings)
│   ├── pprof/                   # pprof@5.0.0 (nan + bindings, needs libunwind)
│   ├── zlib-sync/               # zlib-sync@0.1.10 (nan)
│   └── tree-sitter-cairo/       # tree-sitter-cairo@0.0.2 (nan)
├── non-native/                            # 2 samples
│   ├── pure-js-lodash/          # false-positive guard: pure JS, zero native candidates (no install script)
│   └── core-js-postinstall/     # pure JS + postinstall → SUSPICIOUS/AMBIGUOUS (a candidate that is not native)
└── unsupported/                          # malformed lockfiles → fail closed (every real format is covered in testdata/)
    ├── bun-malformed/           # malformed bun.lockb (random bytes) → fail closed
    ├── lockfile-v1/             # package-lock.json v1 → fail closed (v1 is not adapted)
    ├── pnpm-lock/               # incomplete pnpm (packages without snapshots) → fail closed
    └── yarn-malformed/          # malformed yarn.lock (no valid top-level entry) → fail closed
```

Each sample carries the two things the fixture runner requires:

- `package.json` + `package-lock.json`: produced by a real
  `npm install --package-lock-only`, loadable by arborist's `loadVirtual` without
  `node_modules`.
- `expected.yaml`: the expected verdict.

## `expected.yaml` format

```yaml
pattern: PlatformOptionalDeps  # pattern of the matched package (use subject when there are several findings)
strategy: PREBUILT            # expected InstallStrategy
risk: LOW                     # optional; omitted when environment-dependent (e.g. a missing compiler for pattern D)
native: true                  # whether it is a native entry point
subject: esbuild              # optional; selects the target package when several are native
network_calls: 0              # key: asserts zero network, which stops regressions
```

For `unsupported` samples (pnpm-lock / lockfile-v1 / yarn-malformed /
bun-malformed):

```yaml
unsupported: true
detected: pnpm-lock.yaml
reason_contains: pnpm   # substring the reason must contain
network_calls: 0
```

For the "zero native candidates" control (non-native/pure-js-lodash):

```yaml
native: false
native_count: 0   # asserts the candidate count, distinguishing "none" from "candidates that are not native"
network_calls: 0
```

### Notes

- `risk` is only asserted when it does not depend on the machine. Pattern D's
  risk depends on the local toolchain (no compiler → HIGH, complete → LOW /
  MEDIUM), so D samples pin only `pattern` / `strategy` / `native`.
- Deep-forensics-only scenarios (musl variants, missing platform, remote 404 or
  rate limiting) look identical to their base samples under `--fast` (A is always
  LOW, B / C always UNVERIFIED) and need `--deep` to be told apart. Those belong
  in a deep-fixture set and are still to be added, together with their harness
  (see `testdata/ground-truth/`).

## Unit-test fixtures

Classifier and matcher tests in `test/*.test.ts` feed hand-written
`LockfilePackage` records directly (see `signals.ts`). There is no need to
generate a real lockfile for pure logic — that is what the samples in this
directory are for.
