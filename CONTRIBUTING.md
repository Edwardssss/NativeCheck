# Contributing

## Before you start

```bash
npm install
npm run typecheck && npm test
```

`npm run test:coverage` runs the same suite with the coverage floors in
`vitest.config.ts` — that is what CI runs instead of `npm test`.

Node **>= 20.19** is required: `@npmcli/arborist@9` wants 20.17 and `eslint@10`
wants 20.19, so the higher of the two wins.

`.npmrc` sets `engine-strict=true`, so one dependency that wants a newer Node
turns `npm ci` into a hard failure on the oldest CI job. Declared dependencies
therefore have to admit the floor in `engines`, which `test/node-floor.test.ts`
enforces.

## Branches and commits

- Branch names: `feat/...`, `fix/...`, `chore/...`, `docs/...`
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: add pattern-a reverse lookup`

## Security

`npm run audit` checks the runtime dependency tree against npm's advisories — it
is the step CI runs, and it pins the registry because the advisory endpoint only
exists on `registry.npmjs.org`. Advisories at or above `high` fail the build; an
**unreachable** advisory service (503 maintenance, DNS, offline) warns and passes
instead, because a third party's outage must not block a merge or a release. The
next run retries.

A vulnerability in NativeCheck itself should not be reported in a public issue:
see [SECURITY.md](./SECURITY.md).

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

| Layer | Question                               | Metric                  |
| ----- | -------------------------------------- | ----------------------- |
| L1    | Is this package native?                | miss rate (weighted ×2) |
| L2    | Prebuilt binary or local source build? | FP / FN rate            |
| L3    | Which toolchain pieces are missing?    | blocker recall          |

Ground truth comes from compiler wrappers: `cc` / `gcc` / `g++` / `clang` are
replaced by recorders, and any call proves a local compile happened. A C/C++
addon cannot become a `.node` without going through a compiler, which makes this
more reliable than scraping build logs. See
[`testdata/ground-truth/README.md`](./testdata/ground-truth/README.md).

Accuracy is gated, not just reported: the matrix cell ends in `collect.py --gate`
(FN 0%, FP 5%, minimum sample count), and a pull request touching `src/**` or
`fixtures/**` runs one glibc cell before merge rather than the following Monday.

## Code style

- TypeScript with `strict` and `noUncheckedIndexedAccess` enabled
- Type-only imports must use `import type` (ESLint enforces this)
- Prettier owns formatting: run `npm run format` before committing
- Ecosystem-specific logic belongs in `src/adapters/<ecosystem>/`; `src/core/`
  stays ecosystem-independent

## Releasing

1. Move the entries under `[Unreleased]` in [`CHANGELOG.md`](./CHANGELOG.md) to a
   new version heading. The changelog is the release note; nothing generates one.
2. `npm version <major|minor|patch>` — this bumps `package.json` and creates the
   `vX.Y.Z` tag in one step, which is exactly the tag the workflow asserts
   against.
3. `git push --follow-tags`. The tag starts
   [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which
   re-runs every gate (lint, typecheck, coverage, rule coverage, format, build)
   and publishes with provenance.
4. Watch the run, then confirm the version and its attestation on npm.

Authentication is npm **trusted publishing** (OIDC): no publishing token is
stored in this repository. That requires a one-time entry on npmjs.com — package
`nativecheck` → Settings → Trusted Publisher → GitHub Actions, naming this
repository and `publish.yml`. If a token ever has to be used instead, put
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` back on the publish step.

Prereleases should not move `latest`: `npm publish --tag next` (or `npm version
prerelease --preid next`) keeps the stable tag untouched.
