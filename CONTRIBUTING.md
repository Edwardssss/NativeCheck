# Contributing

## 开发前

```bash
npm install
npm run typecheck && npm test
```

需要 Node **>= 20.17**（`@npmcli/arborist@9` 的约束）。

## 分支与提交

- 分支命名：`feat/...`、`fix/...`、`chore/...`、`docs/...`
- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat: add pattern-a reverse lookup`

## Fixture 约定

```yaml
# fixtures/pattern-a-platform-optional-deps/sharp-style/expected.yaml
pattern: PlatformOptionalDeps
strategy: PREBUILT
risk: LOW
native: true # 关键：纯 JS 检测器会漏报这个
network_calls: 0 # 关键：断言零网络，防止回归
```

目录按分发模式组织：

```text
fixtures/
├── pattern-a-platform-optional-deps/
├── pattern-b-prebuildify/
├── pattern-c-remote-download/
├── pattern-d-source-only/
├── non-native/          # 防误报对照组
└── unsupported/         # lockfile v1 / pnpm-lock.yaml
```

## 评测

准确率分三层统计：

| 层  | 判定内容             | 指标              |
| --- | -------------------- | ----------------- |
| L1  | 是不是 native 包     | 漏报率（权重 ×2） |
| L2  | 走预编译还是源码构建 | FP / FN 率        |
| L3  | 缺失哪些工具链       | 阻塞项召回率      |

Ground truth 靠编译器 wrapper采集：把 `cc` / `gcc` / `clang` 等替换成记录器，任何一次调用都证明发生了本地编译。C/C++ 要变成 `.node`，物理上必须经过编译器——准确率 100%。

## 代码风格

- TypeScript `strict` 全开，`noUncheckedIndexedAccess` 也在
- 类型导入统一用 `import type`（ESLint 强制）
- 格式化交给 Prettier，`npm run format` 后再提交
- 生态相关的逻辑只许出现在 `src/adapters/<ecosystem>/`，`src/core/` 必须保持生态无关
