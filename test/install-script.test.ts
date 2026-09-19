/**
 * Install script semantic parsing — the core of false-positive control (design doc §11.2).
 *
 * Observed samples:
 *   esbuild  `node install.js`                              → select (no compile)
 *   bcrypt   `node-gyp-build`                               → select (no compile)
 *   canvas   `prebuild-install -r napi || node-gyp rebuild` → download_then_compile
 *   fsevents `node-gyp rebuild`                             → compile
 */
import { describe, expect, it } from 'vitest'
import {
  describeIntent,
  inspectScript,
  mergeHookIntents,
  parseInstallScript,
} from '../src/adapters/node/install-script'

describe('parseInstallScript', () => {
  it('esbuild: node install.js → select（挑选，不编译）', () => {
    expect(parseInstallScript('node install.js')).toBe('select')
  })

  it('bcrypt: node-gyp-build → select（挑选，非 node-gyp）', () => {
    // 关键陷阱：node-gyp-build ≠ node-gyp。前者是挑选器。
    expect(parseInstallScript('node-gyp-build')).toBe('select')
  })

  it('fsevents: node-gyp rebuild → compile（真的编译）', () => {
    expect(parseInstallScript('node-gyp rebuild')).toBe('compile')
  })

  it('canvas: A || B → download_then_compile（下载优先，失败才编译）', () => {
    expect(parseInstallScript('prebuild-install -r napi || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
  })

  it('空脚本 / 未定义 → unknown', () => {
    expect(parseInstallScript(undefined)).toBe('unknown')
    expect(parseInstallScript('')).toBe('unknown')
    expect(parseInstallScript('   ')).toBe('unknown')
  })

  it('纯 download → download', () => {
    expect(parseInstallScript('prebuild-install || exit 1')).toBe('download')
  })

  it('core-js: node -e 内联 eval（funding 提示，无编译信号）→ select（不编译）', () => {
    // core-js@3.40.0 的 postinstall 就是这条：`require('./postinstall')` 只打印 funding。
    expect(parseInstallScript(`node -e "try{require('./postinstall')}catch(e){}"`)).toBe('select')
  })

  it('node --eval 无编译信号 → select', () => {
    expect(parseInstallScript('node --eval "console.log(1)"')).toBe('select')
  })

  it('node -e 内联里藏了 node-gyp rebuild → 仍判 compile（regex 扫全段）', () => {
    expect(
      parseInstallScript(`node -e "require('child_process').execSync('node-gyp rebuild')"`),
    ).toBe('compile')
  })

  it('node-pty 型：node scripts/prebuild.js || node-gyp rebuild → download_then_compile（§1.2 修复）', () => {
    // 自定义 JS 下载器 + node-gyp 兜底：先下载预编译、失败才编译。此前被弱启发式
    // 判 compile（误判为纯编译），修复后识别为 download_then_compile。
    expect(parseInstallScript('node scripts/prebuild.js || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
  })

  it('下载器脚本名含暗示词才升级；普通脚本名保持 compile（不猜）', () => {
    expect(parseInstallScript('node scripts/download.js || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
    expect(parseInstallScript('node scripts/install.js || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
    // 脚本名无下载暗示词 → 保守判 compile（可能漏掉下载，但不漏编译）
    expect(parseInstallScript('node scripts/foo.js || node-gyp rebuild')).toBe('compile')
  })
})

describe('mergeHookIntents', () => {
  it('install 下载 + postinstall 编译 → compile（都要执行，编译是终态，§1.4 修复）', () => {
    expect(mergeHookIntents('download', 'compile')).toBe('compile')
    expect(mergeHookIntents('compile', 'download')).toBe('compile')
  })

  it('compile 优先于 download_then_compile', () => {
    expect(mergeHookIntents('download_then_compile', 'compile')).toBe('compile')
  })

  it('download_then_compile + select → download_then_compile（select 不改变可能编译）', () => {
    expect(mergeHookIntents('download_then_compile', 'select')).toBe('download_then_compile')
  })

  it('两个 unknown → unknown', () => {
    expect(mergeHookIntents('unknown', 'unknown')).toBe('unknown')
  })
})

describe('parseInstallScript · 泛化性抽查（非 benchmark 包的真实脚本）', () => {
  // 2026-09-04 自审：拿不在 Docker GT 矩阵里的包验证规则不是打表。
  // 脚本字符串取自 registry manifest 实测，纯离线断言。
  it('sqlite3@6: prebuild-install || node-gyp rebuild → download_then_compile', () => {
    expect(parseInstallScript('prebuild-install -r napi || node-gyp rebuild')).toBe(
      'download_then_compile',
    )
  })

  it('fsevents@2: node-gyp rebuild → compile', () => {
    expect(parseInstallScript('node-gyp rebuild')).toBe('compile')
  })

  it('grpc@1.24: node-pre-gyp install --fallback-to-build → download', () => {
    // 注：--fallback-to-build 是 flag 非 `||` 降级链，语义偏保守（漏掉 fallback 编译
    // 细节），但方向正确：识别为远端下载而非良性。
    expect(
      parseInstallScript('node-pre-gyp install --fallback-to-build --library=static_library'),
    ).toBe('download')
  })

  it('core-js-pure@3.50 / es5-ext@0.10.64: 同构 node -e 良性脚本 → select', () => {
    expect(parseInstallScript(`node -e "try{require('./postinstall')}catch(e){}"`)).toBe('select')
    expect(parseInstallScript(`node -e "try{require('./_postinstall')}catch(e){}" || exit 0`)).toBe(
      'select',
    )
  })

  it('已知盲区（文档化，不修）：cypress 型自定义 JS 下载器 → 误判 select', () => {
    // cypress@16 的 postinstall 实际下载独立二进制，但脚本是 `node dist/index.js …`
    // → 弱启发式 select。这是 `node xxx.js` 规则（项目原有）的 FAIL-OPEN 盲区：
    // 词汇表外的自定义下载逻辑不可见。cypress 下载的是独立二进制（非 Node ABI
    // addon），对 ABI 兼容威胁模型无害，故文档化接受。
    expect(parseInstallScript('node dist/index.js --exec install')).toBe('select')
  })

  it('node-sass@9: install.js 自定义下载，但 L1 依赖边（nan/node-gyp）已兜住', () => {
    // parseInstallScript 层面会误判 select；整条漏斗不依赖这层——node-sass 的
    // 依赖边有 nan + node-gyp，L1 classify 先命中 D 模式，轮不到脚本语义解析。
    expect(parseInstallScript('node scripts/install.js || node scripts/build.js')).toBe('select')
  })
})

describe('inspectScript', () => {
  it('canvas 的降级链被逐段拆出', () => {
    const segments = inspectScript('prebuild-install -r napi || node-gyp rebuild')
    expect(segments.map((s) => s.intent)).toEqual(['download', 'compile'])
  })
})

describe('describeIntent', () => {
  it('给每个意图一个可读标签', () => {
    expect(describeIntent('compile')).toContain('compiles')
    expect(describeIntent('select')).toContain('picks')
  })
})
