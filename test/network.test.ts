/**
 * network.ts — pure parsing plus mock-fetch-driven forensics logic (zero real network).
 */
import { describe, expect, it } from 'vitest'
import {
  abiMatchFor,
  deriveRemoteUrlFromMeta,
  detectDownloader,
  fetchManifest,
  getBestNapiBuildVersion,
  isNapiBindingGyp,
  isNapiBuild,
  parseGithubRepo,
  parsePrebuildEntry,
  prebuildMatchesEnv,
  probePrebuilds,
  probeRemoteHead,
  resolveDownloadAbi,
  type HttpLike,
} from '../src/adapters/node/network'
import type { Environment } from '../src/core/model'

const env: Environment = {
  os: 'linux',
  arch: 'x64',
  libc: 'glibc',
  nodeVersion: '22.22.2',
  nodeAbi: '127',
  sdks: [],
}

describe('parsePrebuildEntry', () => {
  it('解析老式平铺 platform-arch', () => {
    expect(parsePrebuildEntry('darwin-arm64.node')).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      libc: 'none',
      abi: null,
    })
  })
  it('识别老式平铺的 linux musl 尾巴', () => {
    expect(parsePrebuildEntry('linuxmusl-x64.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'musl',
      abi: null,
    })
  })
  it('win32 平台名含数字也能解析', () => {
    expect(parsePrebuildEntry('win32-x64.node')).toEqual({
      platform: 'win32',
      arch: 'x64',
      libc: 'none',
      abi: null,
    })
  })
  it('解析新式子目录 glibc 变体（bcrypt 式）', () => {
    expect(parsePrebuildEntry('linux-x64/bcrypt.glibc.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'glibc',
      abi: null,
    })
  })
  it('解析新式子目录 musl 变体', () => {
    expect(parsePrebuildEntry('linux-x64/bcrypt.musl.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'musl',
      abi: null,
    })
  })
  it('解析新式子目录 N-API 与 ABI 后缀', () => {
    expect(parsePrebuildEntry('linux-x64/node.napi.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'none',
      abi: 'napi',
    })
    expect(parsePrebuildEntry('linux-x64/node.abi127.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'none',
      abi: '127',
    })
  })
  it('非 linux 平台子目录无 libc 变体', () => {
    expect(parsePrebuildEntry('darwin-x64/bcrypt.node')).toEqual({
      platform: 'darwin',
      arch: 'x64',
      libc: 'none',
      abi: null,
    })
  })
  it('非 .node / 无关文件返回 null', () => {
    expect(parsePrebuildEntry('README')).toBeNull()
    expect(parsePrebuildEntry('libvips-cpp.so')).toBeNull()
  })
})

describe('prebuildMatchesEnv', () => {
  const t = (s: string) => parsePrebuildEntry(s)!
  const muslEnv: Environment = { ...env, libc: 'musl' }
  it('glibc 机器命中 glibc 变体 / 通用产物', () => {
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.glibc.node'), env)).toBe(true)
    expect(prebuildMatchesEnv(t('linux-x64.node'), env)).toBe(true)
  })
  it('glibc 机器不命中显式 musl 产物', () => {
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.musl.node'), env)).toBe(false)
  })
  it('musl 机器必须命中 musl 产物或通用产物', () => {
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.musl.node'), muslEnv)).toBe(true)
    expect(prebuildMatchesEnv(t('linuxmusl-x64.node'), muslEnv)).toBe(true)
    expect(prebuildMatchesEnv(t('linux-x64.node'), muslEnv)).toBe(true) // 老式平铺无 libc，不拒绝
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.glibc.node'), muslEnv)).toBe(false)
  })
  it('平台或架构不匹配 → false', () => {
    expect(prebuildMatchesEnv(t('win32-x64.node'), env)).toBe(false)
    expect(prebuildMatchesEnv(t('linux-arm64.node'), env)).toBe(false)
  })
})

describe('parseGithubRepo', () => {
  it('解析 git:// / git+https:// / https:// / SSH 形态', () => {
    expect(parseGithubRepo('git://github.com/WiseLibs/better-sqlite3.git')).toBe(
      'https://github.com/WiseLibs/better-sqlite3',
    )
    expect(parseGithubRepo('git+https://github.com/atom/node-keytar.git')).toBe(
      'https://github.com/atom/node-keytar',
    )
    expect(parseGithubRepo('https://github.com/Automattic/node-canvas')).toBe(
      'https://github.com/Automattic/node-canvas',
    )
    expect(parseGithubRepo('git@github.com:user/repo.git')).toBe('https://github.com/user/repo')
  })
  it('非 GitHub / 缺 URL → null', () => {
    expect(parseGithubRepo(undefined)).toBeNull()
    expect(parseGithubRepo('https://gitlab.com/user/repo.git')).toBeNull()
  })
})

describe('isNapiBuild', () => {
  it('build/prebuild 脚本含 --napi → true（bcrypt/microtime 式）', () => {
    expect(isNapiBuild({ build: 'prebuildify --napi --tag-libc' })).toBe(true)
    expect(isNapiBuild({ prebuild: 'prebuildify --napi' })).toBe(true)
    expect(isNapiBuild({ build: 'prebuildify --n-api' })).toBe(true)
  })
  it('无 --napi 信号 → false（better-sqlite3@13 老式平铺）', () => {
    expect(isNapiBuild({ build: 'prebuildify' })).toBe(false)
    expect(isNapiBuild({ prebuild: 'prebuildify --tag-uv' })).toBe(false)
    expect(isNapiBuild({})).toBe(false)
  })
})

describe('isNapiBindingGyp', () => {
  it('binding.gyp 含 NAPI_VERSION 宏 → true（better-sqlite3 v13 式）', () => {
    expect(isNapiBindingGyp("'defines': ['NAPI_VERSION=10', 'NAPI_DISABLE_CPP_EXCEPTIONS']")).toBe(
      true,
    )
    expect(isNapiBindingGyp("'variables': { 'NAPI_VERSION%': 8 }")).toBe(true)
  })
  it('binding.gyp 含 NODE_API_MODULE → true', () => {
    expect(isNapiBindingGyp("'defines': ['NODE_API_MODULE']")).toBe(true)
  })
  it('普通 binding.gyp（V8/NAN ABI）→ false', () => {
    expect(isNapiBindingGyp("'defines': ['V8_DEPRECATION_WARNINGS=1']")).toBe(false)
    expect(isNapiBindingGyp("'sources': ['src/bcrypt.cc']")).toBe(false)
    expect(isNapiBindingGyp('')).toBe(false)
  })
})

describe('deriveRemoteUrlFromMeta', () => {
  it('canvas：-r napi + napi_versions=[7] → napi-v7（repo 取 Automattic/node-canvas）', () => {
    const url = deriveRemoteUrlFromMeta(
      'canvas',
      '3.2.3',
      { ...env, napiVersion: '10' },
      {
        binary: { napi_versions: [7] },
        config: null,
        repository: { url: 'git://github.com/Automattic/node-canvas.git', type: 'git' },
        install: 'prebuild-install -r napi || node-gyp rebuild',
      },
    )
    expect(url).toBe(
      'https://github.com/Automattic/node-canvas/releases/download/v3.2.3/canvas-v3.2.3-napi-v7-linux-x64.tar.gz',
    )
  })

  it('keytar：config.runtime=napi + target=3 → napi-v3', () => {
    const url = deriveRemoteUrlFromMeta('keytar', '7.9.0', env, {
      binary: { napi_versions: [3] },
      config: { runtime: 'napi', target: 3 },
      repository: { url: 'git+https://github.com/atom/node-keytar.git', type: 'git' },
      install: 'prebuild-install || npm run build',
    })
    expect(url).toBe(
      'https://github.com/atom/node-keytar/releases/download/v7.9.0/keytar-v7.9.0-napi-v3-linux-x64.tar.gz',
    )
  })

  it('better-sqlite3：node 运行时 + repo 取 WiseLibs → node-v{abi}', () => {
    const url = deriveRemoteUrlFromMeta('better-sqlite3', '11.10.0', env, {
      binary: null,
      config: null,
      repository: { url: 'git://github.com/WiseLibs/better-sqlite3.git', type: 'git' },
      install: 'prebuild-install || node-gyp rebuild --release',
    })
    expect(url).toBe(
      'https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-linux-x64.tar.gz',
    )
  })

  it('musl 平台 → {libc}=musl，产物名带 linuxmusl', () => {
    const muslEnv: Environment = { ...env, libc: 'musl' }
    const url = deriveRemoteUrlFromMeta('better-sqlite3', '11.10.0', muslEnv, {
      binary: null,
      config: null,
      repository: { url: 'git://github.com/WiseLibs/better-sqlite3.git', type: 'git' },
      install: 'prebuild-install',
    })
    expect(url).toBe(
      'https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-linuxmusl-x64.tar.gz',
    )
  })

  it('binary.host + package_name 模板 → 展开 {module_name}/{node_abi}/{version}', () => {
    const url = deriveRemoteUrlFromMeta('some-addon', '1.2.3', env, {
      binary: {
        host: 'https://example.com/releases/download',
        remote_path: 'v{version}',
        package_name: '{module_name}-v{version}-node-v{node_abi}-{platform}-{arch}.tar.gz',
        module_name: 'addon',
      },
      config: null,
      repository: null,
      install: 'prebuild-install',
    })
    expect(url).toBe(
      'https://example.com/releases/download/v1.2.3/addon-v1.2.3-node-v127-linux-x64.tar.gz',
    )
  })

  it('缺仓库且无 binary.host → null（不猜 github.com/{name}）', () => {
    expect(
      deriveRemoteUrlFromMeta('canvas', '3.2.3', env, {
        binary: { napi_versions: [7] },
        config: null,
        repository: null,
        install: 'prebuild-install -r napi',
      }),
    ).toBeNull()
  })

  it('napi 运行时但无 target/napi_versions → null（无法确定 ABI）', () => {
    expect(
      deriveRemoteUrlFromMeta('x', '1.0.0', env, {
        binary: null,
        config: { runtime: 'napi' },
        repository: { url: 'git://github.com/a/b.git', type: 'git' },
        install: 'prebuild-install',
      }),
    ).toBeNull()
  })
})

describe('detectDownloader', () => {
  it('node-pre-gyp / @mapbox/node-pre-gyp → node-pre-gyp', () => {
    expect(detectDownloader({ install: 'node-pre-gyp install --fallback-to-build' })).toBe(
      'node-pre-gyp',
    )
    expect(detectDownloader({ install: '@mapbox/node-pre-gyp install --fallback-to-build' })).toBe(
      'node-pre-gyp',
    )
  })
  it('prebuild-install → prebuild-install', () => {
    expect(detectDownloader({ install: 'prebuild-install -r napi' })).toBe('prebuild-install')
    expect(detectDownloader({ install: 'prebuild-install || node-gyp rebuild' })).toBe(
      'prebuild-install',
    )
  })
})

describe('deriveRemoteUrlFromMeta · node-pre-gyp', () => {
  it('bcrypt@5：binary.host + remote_path + napi_build_version + {libc}=glibc', () => {
    const url = deriveRemoteUrlFromMeta(
      'bcrypt',
      '5.1.1',
      { ...env, napiVersion: '10' },
      {
        binary: {
          host: 'https://github.com',
          module_name: 'bcrypt_lib',
          remote_path: 'kelektiv/node.bcrypt.js/releases/download/v{version}',
          package_name:
            '{module_name}-v{version}-napi-v{napi_build_version}-{platform}-{arch}-{libc}.tar.gz',
          napi_versions: [3],
        },
        install: 'node-pre-gyp install --fallback-to-build',
      },
    )
    expect(url).toBe(
      'https://github.com/kelektiv/node.bcrypt.js/releases/download/v5.1.1/bcrypt_lib-v5.1.1-napi-v3-linux-x64-glibc.tar.gz',
    )
  })

  it('bcrypt@3：{node_abi}=node-v127 默认模板（host 已含 download 路径）', () => {
    const url = deriveRemoteUrlFromMeta('bcrypt', '3.0.8', env, {
      binary: {
        host: 'https://github.com/kelektiv/node.bcrypt.js/releases/download/',
        module_name: 'bcrypt_lib',
        remote_path: 'v{version}',
        package_name: '{module_name}-v{version}-{node_abi}-{platform}-{arch}-{libc}.tar.gz',
      },
      install: 'node-pre-gyp install --fallback-to-build',
    })
    expect(url).toBe(
      'https://github.com/kelektiv/node.bcrypt.js/releases/download/v3.0.8/bcrypt_lib-v3.0.8-node-v127-linux-x64-glibc.tar.gz',
    )
  })

  it('sqlite3@3：S3 host + {toolset} 空 + 默认 package_name={node_abi}-{platform}-{arch}', () => {
    const url = deriveRemoteUrlFromMeta('sqlite3', '3.1.13', env, {
      binary: {
        host: 'https://mapbox-node-binary.s3.amazonaws.com',
        module_name: 'node_sqlite3',
        remote_path: './{name}/v{version}/{toolset}/',
        package_name: '{node_abi}-{platform}-{arch}.tar.gz',
      },
      install: 'node-pre-gyp install --fallback-to-build',
    })
    expect(url).toBe(
      'https://mapbox-node-binary.s3.amazonaws.com/sqlite3/v3.1.13/node-v127-linux-x64.tar.gz',
    )
  })

  it('node-pre-gyp 缺 binary.host → null（validate_config 强制，无法推导）', () => {
    expect(
      deriveRemoteUrlFromMeta('x', '1.0.0', env, {
        binary: { module_name: 'x' },
        install: 'node-pre-gyp install',
      }),
    ).toBeNull()
  })

  it('musl 机器 {libc}=musl', () => {
    const muslEnv: Environment = { ...env, libc: 'musl' }
    const url = deriveRemoteUrlFromMeta(
      'bcrypt',
      '5.1.1',
      { ...muslEnv, napiVersion: '10' },
      {
        binary: {
          host: 'https://github.com',
          module_name: 'bcrypt_lib',
          remote_path: 'kelektiv/node.bcrypt.js/releases/download/v{version}',
          package_name:
            '{module_name}-v{version}-napi-v{napi_build_version}-{platform}-{arch}-{libc}.tar.gz',
          napi_versions: [3],
        },
        install: 'node-pre-gyp install',
      },
    )
    expect(url).toContain('-linux-x64-musl.tar.gz')
  })
})

describe('resolveDownloadAbi', () => {
  it('napi_versions 取 ≤ 本机 napi 的最大值', () => {
    expect(
      resolveDownloadAbi(
        { binary: { napi_versions: [3, 7, 9] } },
        { ...env, napiVersion: '8' },
        'napi',
      ),
    ).toBe('7')
  })
  it('config.target 数字优先于 napi_versions', () => {
    expect(
      resolveDownloadAbi(
        { binary: { napi_versions: [3, 7] }, config: { target: 3 } },
        { ...env, napiVersion: '10' },
        'napi',
      ),
    ).toBe('3')
  })
  it('node 运行时 → env.nodeAbi', () => {
    expect(resolveDownloadAbi({}, env, 'node')).toBe('127')
  })
})

describe('getBestNapiBuildVersion', () => {
  it('取 ≤ 本机 napi 的最大值；本机 napi 低于全部候选时 null', () => {
    expect(getBestNapiBuildVersion([3, 7, 9], { ...env, napiVersion: '8' })).toBe(7)
    expect(getBestNapiBuildVersion([3], { ...env, napiVersion: '10' })).toBe(3)
    expect(getBestNapiBuildVersion([9], { ...env, napiVersion: '8' })).toBeNull()
    expect(getBestNapiBuildVersion(undefined, env)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * mock fetch 驱动的 IO
 * ------------------------------------------------------------------ */

/** 构造一个最小 npm 布局的 tar 字节流：根是 `package/`，内含 prebuilds/<file>。
 *  `file` 可含子目录（如 `linux-x64/bcrypt.glibc.node`）以覆盖新式 prebuildify 布局。
 *  `bindingGyp` 传入时会在包根写一个 binding.gyp（用于 N-API 信号测试）。 */
async function buildTarBuffer(files: string[], bindingGyp?: string): Promise<Uint8Array> {
  const { mkdtemp, mkdir, writeFile, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const tar = await import('tar')

  const dir = await mkdtemp(join(tmpdir(), 'nc-net-'))
  const pkgDir = join(dir, 'package')
  try {
    await mkdir(join(pkgDir, 'prebuilds'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), '{}')
    if (bindingGyp !== undefined) {
      await writeFile(join(pkgDir, 'binding.gyp'), bindingGyp)
    }
    for (const p of files) {
      const target = join(pkgDir, 'prebuilds', `${p}.node`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'binary')
    }
    const out = join(dir, 'bundle.tgz')
    await tar.c({ gzip: false, file: out, cwd: dir, portable: true }, ['package'])
    return new Uint8Array(await readFile(out))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function mockFetchReturningTar(tarBytes: Uint8Array): HttpLike {
  return async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tarBytes)
        controller.close()
      },
    })
    return { status: 200, ok: true, body: stream }
  }
}

describe('probePrebuilds', () => {
  it('老式平铺产物（无 ABI 标注）→ unknown（无法断定是否免编译）', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64', 'win32-x64'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('unknown')
    expect(r.observed).toContain('linux-x64.node')
    expect(r.hasBindingGyp).toBe(false)
  })

  it('老式平铺 + binding.gyp 含 NAPI_VERSION → matched（better-sqlite3 v13 式 N-API）', async () => {
    const tarBytes = await buildTarBuffer(
      ['linux-x64', 'win32-x64'],
      "{ 'defines': ['NAPI_VERSION=10'] }",
    )
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('matched')
    expect(r.observed).toContain('linux-x64.node')
    expect(r.hasBindingGyp).toBe(true)
  })

  it('老式平铺 + binding.gyp 无 N-API 标记 → 仍 unknown（但 binding.gyp 存在被标出）', async () => {
    const tarBytes = await buildTarBuffer(
      ['linux-x64'],
      "{ 'defines': ['V8_DEPRECATION_WARNINGS=1'] }",
    )
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('unknown')
    expect(r.hasBindingGyp).toBe(true)
  })

  it('N-API 产物（node.napi.node）→ matched（跨 ABI 稳定）', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.napi'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('matched')
  })

  it('ABI 匹配产物（node.abi127.node）→ matched', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.abi127'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('matched')
  })

  it('ABI 不匹配产物（node.abi115.node）→ absent（本平台有产物但 ABI 不符）', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.abi115'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('absent')
  })

  it('读完整包仍无本平台产物 → status=absent', async () => {
    const tarBytes = await buildTarBuffer(['win32-x64'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('absent')
    expect(r.observed).toEqual(['win32-x64.node'])
  })

  it('新式子目录自定义命名（bcrypt 式，ABI 无标注）→ unknown', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/bcrypt.glibc', 'linux-x64/bcrypt.musl'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('unknown')
    expect(r.observed).toContain('linux-x64/bcrypt.glibc.node')
  })

  it('新式子目录自定义命名 + napiBuild → matched（bcrypt --napi 产物实为 N-API）', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/bcrypt.glibc', 'linux-x64/bcrypt.musl'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl, napiBuild: true })
    expect(r.status).toBe('matched')
    expect(r.observed).toContain('linux-x64/bcrypt.glibc.node')
  })

  it('musl 机器对子目录 glibc 变体 → absent（libc 不匹配）', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/bcrypt.glibc'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const muslEnv: Environment = { ...env, libc: 'musl' }
    const r = await probePrebuilds('https://example/x.tgz', muslEnv, { fetchImpl })
    expect(r.status).toBe('absent')
  })

  it('命中安全上限仍未读完 → status=unknown（绝不当作缺失）', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.napi'])
    // 只投喂 tar 前 100 字节且不结束流；maxBytes=50 使首 chunk 后即触顶，
    // 此时产物 header 尚未被完整解析 → unknown，而非误判 matched/absent。
    const fetchImpl: HttpLike = async () => {
      const partial = tarBytes.subarray(0, 100)
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(partial)
          // 不 close：模拟被预算掐断的网络流
        },
      })
      return { status: 200, ok: true, body: stream }
    }
    const r = await probePrebuilds('https://example/x.tgz', env, { maxBytes: 50, fetchImpl })
    expect(r.status).toBe('unknown')
  })

  it('HTTP 非 2xx 抛错（由调用方折叠为可降级结果）', async () => {
    const fetchImpl = async () => ({ status: 500, ok: false, body: null })
    await expect(probePrebuilds('https://example/x.tgz', env, { fetchImpl })).rejects.toThrow()
  })
})

describe('abiMatchFor', () => {
  it('napi → match（跨 ABI）', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.napi.node')!, env)).toBe('match')
  })
  it('abiN 命中当前 ABI → match', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.abi127.node')!, env)).toBe('match')
  })
  it('abiN 不匹配 → no-match', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.abi115.node')!, env)).toBe('no-match')
  })
  it('无 ABI 标注（老式平铺 / 自定义命名）→ unknown', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64.node')!, env)).toBe('unknown')
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/bcrypt.glibc.node')!, env)).toBe('unknown')
  })
  it('无 ABI 标注 + napiBuild → match（bcrypt 的 bcrypt.glibc.node 实为 N-API）', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/bcrypt.glibc.node')!, env, true)).toBe('match')
    // napiBuild 不应影响已显式标 ABI 的产物
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.abi115.node')!, env, true)).toBe(
      'no-match',
    )
  })
})

describe('fetchManifest', () => {
  it('读 registry 单版本 manifest 的 dist.tarball + 元数据', async () => {
    const fetchImpl = async (url: string) => {
      expect(url).toContain('registry.npmjs.org/sharp/0.33.0')
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                dist: { tarball: 'https://t/x.tgz' },
                binary: { napi_versions: [7] },
                config: null,
                repository: { url: 'git://github.com/a/b.git', type: 'git' },
                scripts: {
                  install: 'prebuild-install -r napi',
                  build: 'prebuildify --napi',
                  prebuild: 'prebuildify --napi',
                },
              }),
            ),
          )
          c.close()
        },
      })
      return { status: 200, ok: true, body }
    }
    const m = await fetchManifest('sharp', '0.33.0', fetchImpl)
    expect(m.tarballUrl).toBe('https://t/x.tgz')
    expect(m.meta.binary).toEqual({ napi_versions: [7] })
    expect(m.meta.repository).toEqual({ url: 'git://github.com/a/b.git', type: 'git' })
    expect(m.meta.install).toBe('prebuild-install -r napi')
    expect(m.meta.build).toBe('prebuildify --napi')
    expect(m.meta.prebuild).toBe('prebuildify --napi')
    expect(isNapiBuild(m.meta)).toBe(true)
  })

  it('非 2xx 抛错', async () => {
    const fetchImpl = async () => ({ status: 404, ok: false, body: null })
    await expect(fetchManifest('nope', '1.0.0', fetchImpl)).rejects.toThrow()
  })
})

describe('probeRemoteHead', () => {
  it('200 → prebuilt', async () => {
    const fetchImpl = async (_url: string, init?: { method?: string }) => {
      expect(init?.method).toBe('HEAD')
      return { status: 200, ok: true, body: null }
    }
    expect(await probeRemoteHead('https://x', { fetchImpl })).toBe('prebuilt')
  })
  it('404 → source-build', async () => {
    const fetchImpl = async () => ({ status: 404, ok: false, body: null })
    expect(await probeRemoteHead('https://x', { fetchImpl })).toBe('source-build')
  })
  it('网络异常 → unverified（不武断）', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET')
    }
    expect(await probeRemoteHead('https://x', { fetchImpl })).toBe('unverified')
  })
})
