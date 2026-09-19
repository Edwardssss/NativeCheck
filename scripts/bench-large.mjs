// 一次性性能基线脚本：生成 N 包的大 lockfile，benchmark fast scan 耗时。
// 用法：node scripts/bench-large.mjs [N]   （默认 2000）
// 需要先 `npm run build`（它跑的是 dist/cli.js）。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// 用当前解释器，而不是写死某一台机器的 node 路径。
const NODE = process.execPath
const CLI = new URL('../dist/cli.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const N = Number(process.argv[2] ?? 2000)

// 生成：root 依赖 N 个 leaf 包（纯 JS，无 native 信号），其中夹杂少量 native 包。
function genLock(n) {
  const packages = {
    '': { name: 'big-repo', version: '1.0.0', dependencies: {} },
  }
  for (let i = 0; i < n; i++) {
    const name = `pkg-${i}`
    packages[''].dependencies[name] = '1.0.0'
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      integrity: `sha512-${String(i).padStart(40, '0')}`,
    }
  }
  // 每 100 个里掺一个 native（依赖 nan）→ 触发 classify 的真实路径
  for (let i = 0; i < n; i += 100) {
    const name = `native-${i}`
    packages[''].dependencies[name] = '1.0.0'
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      hasInstallScript: true,
      dependencies: { nan: '2.18.0' },
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      integrity: `sha512-${String(i).padStart(40, '0')}`,
    }
    packages['node_modules/nan'] = {
      version: '2.18.0',
      resolved: 'https://registry.npmjs.org/nan/-/nan-2.18.0.tgz',
      integrity: `sha512-${'n'.padStart(40, 'n')}`,
    }
  }
  return {
    name: 'big-repo',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages,
  }
}

const root = mkdtempSync(join(tmpdir(), 'nc-bench-'))
const lock = genLock(N)
writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2))
// package.json 的 dependencies 必须与 lockfile 一致，否则 arborist loadVirtual 的 root edgesOut 为空
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'big-repo',
    version: '1.0.0',
    dependencies: lock.packages[''].dependencies,
  }),
)

const t0 = Date.now()
const out = execFileSync(NODE, [CLI, root, '--json'], { encoding: 'utf8' })
const wallMs = Date.now() - t0
const r = JSON.parse(out)
console.log(
  `packages=${r.summary.totalPackages} nativeCandidates=${r.summary.nativeCandidates} networkCalls=${r.summary.networkCalls} wallMs=${wallMs} durationMs(内部)=${r.durationMs}`,
)
rmSync(root, { recursive: true, force: true })
