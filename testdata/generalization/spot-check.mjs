/**
 * Generalization spot-check (doc §31): verify that parseInstallScript rules
 * generalize beyond the benchmark, using real packages NOT in the Docker GT
 * matrix. For each package, compare the rule output against the known real
 * behaviour (manually curated ground truth).
 *
 * Usage:
 *   npm run build && node testdata/generalization/spot-check.mjs
 *
 * Hits live registry (registry.npmjs.org); network required.
 * Companion offline tests: test/install-script.test.ts "泛化性抽查" block.
 */
import { parseInstallScript } from '../../dist/index.js'

const CASES = [
  // [name, version?, known real behaviour (manually curated ground truth)]
  ['sqlite3', undefined, 'node-pre-gyp 下载 binding，失败编译 → 期望 download_then_compile'],
  ['fsevents', undefined, '本地编译 → 期望 compile'],
  ['microtime', undefined, '本地编译 → 期望 compile'],
  ['grpc', '1.24.11', 'node-pre-gyp 下载，失败编译 → 期望 download_then_compile'],
  ['node-sass', undefined, 'scripts/install.js 自定义下载逻辑 → 实际 download'],
  ['electron', undefined, 'install.js 下载 Electron 二进制 → 实际 download'],
  ['cypress', undefined, 'index.js --exec install 下载 Cypress 二进制 → 实际 download'],
  ['@biomejs/biome', undefined, 'postinstall 校验 optionalDeps 产物（良性）→ 期望 select'],
  ['esbuild', '0.15.18', '老版 install.js（optionalDeps 已兜底）→ 观察'],
  ['core-js-pure', undefined, 'core-js 纯净版（观察是否有脚本）'],
  ['es5-ext', undefined, '与 core-js 同作者，观察是否命中 node -e 规则'],
  ['nodemon', undefined, '无 install 脚本（对照组）'],
]

for (const [name, version, note] of CASES) {
  const spec = version ?? 'latest'
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/${spec}`)
    if (!res.ok) {
      console.log(`✗ ${name}@${spec} HTTP ${res.status}`)
      continue
    }
    const m = await res.json()
    const s = m.scripts ?? {}
    // Mimic verify.ts joining: install || postinstall
    const parts = [s.install, s.postinstall].filter(Boolean)
    const script = parts.join(' || ')
    const intent = parseInstallScript(script)
    const deps = m.dependencies ?? {}
    const nativeDeps = Object.keys(deps).filter((d) =>
      /node-gyp|node-pre-gyp|prebuild-install|node-addon-api|^nan$|node-gyp-build/.test(d),
    )
    console.log(`${name}@${m.version}`)
    console.log(`  install:      ${s.install ?? '(none)'}`)
    console.log(`  postinstall: ${s.postinstall ?? '(none)'}`)
    console.log(`  L1 依赖边信号: ${nativeDeps.length ? nativeDeps.join(', ') : '(无)'}`)
    console.log(`  → parseInstallScript 输出: ${intent}    [已知行为: ${note}]`)
    console.log('')
  } catch (e) {
    console.log(`✗ ${name}@${spec} ${e.message}`)
    console.log('')
  }
}
