# Contributing

## Before you start

```bash
npm install
npm run typecheck && npm test
```

Node **>= 20.17** is required (`@npmcli/arborist@9`).

## Branches and commits

- Branch names: `feat/...`, `fix/...`, `chore/...`, `docs/...`
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: add pattern-a reverse lookup`

## Fixture conventions

```yaml
# fixtures/pattern-a-platform-optional-deps/sharp-style/expected.yaml
pattern: PlatformOptionalDeps
strategy: PREBUILT
risk: LOW
native: true # key: a pure-JS detector misses this one
network_calls: 0 # key: asserts zero network, which stops regressions
```

Samples are organized by distribution pattern:

```text
fixtures/
├── pattern-a-platform-optional-deps/
├── pattern-b-prebuildify/
├── pattern-c-remote-download/
├── pattern-d-source-only/
├── non-native/          # false-positive controls
└── unsupported/         # lockfile v1 / malformed pnpm / yarn / bun
```

Any change to a detection rule needs a fixture. `network_calls: 0` is a hard
assertion: it is what keeps the default path offline.

## Measurement

Accuracy is tracked in three layers:

| Layer | Question                                  | Metric                       |
| ----- | ----------------------------------------- | ---------------------------- |
| L1    | Is this package native?                   | miss rate (weighted ×2)      |
| L2    | Prebuilt binary or local source build?    | FP / FN rate                 |
| L3    | Which toolchain pieces are missing?       | blocker recall               |

Ground truth comes from compiler wrappers: `cc` / `gcc` / `g++` / `clang` are
replaced by recorders, and any call proves a local compile happened. A C/C++
addon cannot become a `.node` without going through a compiler, which makes this
more reliable than scraping build logs. See
[`testdata/ground-truth/README.md`](./testdata/ground-truth/README.md).

## Code style

- TypeScript with `strict` and `noUncheckedIndexedAccess` enabled
- Type-only imports must use `import type` (ESLint enforces this)
- Prettier owns formatting: run `npm run format` before committing
- Ecosystem-specific logic belongs in `src/adapters/<ecosystem>/`; `src/core/`
  stays ecosystem-independent
