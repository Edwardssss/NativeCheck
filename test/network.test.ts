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
  it('parses old flat platform-arch entries', () => {
    expect(parsePrebuildEntry('darwin-arm64.node')).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      libc: 'none',
      abi: null,
    })
  })
  it('recognises the linux musl suffix in old flat entries', () => {
    expect(parsePrebuildEntry('linuxmusl-x64.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'musl',
      abi: null,
    })
  })
  it('parses a win32 platform name containing digits', () => {
    expect(parsePrebuildEntry('win32-x64.node')).toEqual({
      platform: 'win32',
      arch: 'x64',
      libc: 'none',
      abi: null,
    })
  })
  it('parses the new subdirectory glibc variant (bcrypt style)', () => {
    expect(parsePrebuildEntry('linux-x64/bcrypt.glibc.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'glibc',
      abi: null,
    })
  })
  it('parses the new subdirectory musl variant', () => {
    expect(parsePrebuildEntry('linux-x64/bcrypt.musl.node')).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'musl',
      abi: null,
    })
  })
  it('parses the new subdirectory N-API and ABI suffixes', () => {
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
  it('non-linux platform subdirectories carry no libc variant', () => {
    expect(parsePrebuildEntry('darwin-x64/bcrypt.node')).toEqual({
      platform: 'darwin',
      arch: 'x64',
      libc: 'none',
      abi: null,
    })
  })
  it('non-.node / unrelated files return null', () => {
    expect(parsePrebuildEntry('README')).toBeNull()
    expect(parsePrebuildEntry('libvips-cpp.so')).toBeNull()
  })
})

describe('prebuildMatchesEnv', () => {
  const t = (s: string) => parsePrebuildEntry(s)!
  const muslEnv: Environment = { ...env, libc: 'musl' }
  it('a glibc machine matches glibc variants / generic artifacts', () => {
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.glibc.node'), env)).toBe(true)
    expect(prebuildMatchesEnv(t('linux-x64.node'), env)).toBe(true)
  })
  it('a glibc machine does not match an explicit musl artifact', () => {
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.musl.node'), env)).toBe(false)
  })
  it('a musl machine must match a musl artifact or a generic one', () => {
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.musl.node'), muslEnv)).toBe(true)
    expect(prebuildMatchesEnv(t('linuxmusl-x64.node'), muslEnv)).toBe(true)
    expect(prebuildMatchesEnv(t('linux-x64.node'), muslEnv)).toBe(true) // old flat entry, no libc: not rejected
    expect(prebuildMatchesEnv(t('linux-x64/bcrypt.glibc.node'), muslEnv)).toBe(false)
  })
  it('platform or arch mismatch → false', () => {
    expect(prebuildMatchesEnv(t('win32-x64.node'), env)).toBe(false)
    expect(prebuildMatchesEnv(t('linux-arm64.node'), env)).toBe(false)
  })
})

describe('parseGithubRepo', () => {
  it('parses git:// / git+https:// / https:// / SSH forms', () => {
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
  it('non-GitHub / missing URL → null', () => {
    expect(parseGithubRepo(undefined)).toBeNull()
    expect(parseGithubRepo('https://gitlab.com/user/repo.git')).toBeNull()
  })
})

describe('isNapiBuild', () => {
  it('build/prebuild script with --napi → true (bcrypt/microtime style)', () => {
    expect(isNapiBuild({ build: 'prebuildify --napi --tag-libc' })).toBe(true)
    expect(isNapiBuild({ prebuild: 'prebuildify --napi' })).toBe(true)
    expect(isNapiBuild({ build: 'prebuildify --n-api' })).toBe(true)
  })
  it('no --napi signal → false (better-sqlite3@13 old flat layout)', () => {
    expect(isNapiBuild({ build: 'prebuildify' })).toBe(false)
    expect(isNapiBuild({ prebuild: 'prebuildify --tag-uv' })).toBe(false)
    expect(isNapiBuild({})).toBe(false)
  })
})

describe('isNapiBindingGyp', () => {
  it('binding.gyp with the NAPI_VERSION macro → true (better-sqlite3 v13 style)', () => {
    expect(isNapiBindingGyp("'defines': ['NAPI_VERSION=10', 'NAPI_DISABLE_CPP_EXCEPTIONS']")).toBe(
      true,
    )
    expect(isNapiBindingGyp("'variables': { 'NAPI_VERSION%': 8 }")).toBe(true)
  })
  it('binding.gyp with NODE_API_MODULE → true', () => {
    expect(isNapiBindingGyp("'defines': ['NODE_API_MODULE']")).toBe(true)
  })
  it('plain binding.gyp (V8/NAN ABI) → false', () => {
    expect(isNapiBindingGyp("'defines': ['V8_DEPRECATION_WARNINGS=1']")).toBe(false)
    expect(isNapiBindingGyp("'sources': ['src/bcrypt.cc']")).toBe(false)
    expect(isNapiBindingGyp('')).toBe(false)
  })
})

describe('deriveRemoteUrlFromMeta', () => {
  it('canvas: -r napi + napi_versions=[7] → napi-v7 (repo resolved to Automattic/node-canvas)', () => {
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

  it('keytar: config.runtime=napi + target=3 → napi-v3', () => {
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

  it('better-sqlite3: node runtime + repo resolved to WiseLibs → node-v{abi}', () => {
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

  it('musl platform → {libc}=musl and the artifact name carries linuxmusl', () => {
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

  it('binary.host + package_name template → expands {module_name}/{node_abi}/{version}', () => {
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

  it('no repository and no binary.host → null (never guesses github.com/{name})', () => {
    expect(
      deriveRemoteUrlFromMeta('canvas', '3.2.3', env, {
        binary: { napi_versions: [7] },
        config: null,
        repository: null,
        install: 'prebuild-install -r napi',
      }),
    ).toBeNull()
  })

  it('napi runtime without target/napi_versions → null (the ABI cannot be determined)', () => {
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

  it('bcrypt@3: {node_abi}=node-v127 default template (host already has the download path)', () => {
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

  it('sqlite3@3: S3 host + empty {toolset} + default package_name={node_abi}-{platform}-{arch}', () => {
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

  it('node-pre-gyp without binary.host → null (validate_config mandates it, nothing to derive)', () => {
    expect(
      deriveRemoteUrlFromMeta('x', '1.0.0', env, {
        binary: { module_name: 'x' },
        install: 'node-pre-gyp install',
      }),
    ).toBeNull()
  })

  it('musl machine → {libc}=musl', () => {
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
  it('napi_versions picks the largest value <= the host napi', () => {
    expect(
      resolveDownloadAbi(
        { binary: { napi_versions: [3, 7, 9] } },
        { ...env, napiVersion: '8' },
        'napi',
      ),
    ).toBe('7')
  })
  it('a numeric config.target outranks napi_versions', () => {
    expect(
      resolveDownloadAbi(
        { binary: { napi_versions: [3, 7] }, config: { target: 3 } },
        { ...env, napiVersion: '10' },
        'napi',
      ),
    ).toBe('3')
  })
  it('node runtime → env.nodeAbi', () => {
    expect(resolveDownloadAbi({}, env, 'node')).toBe('127')
  })
})

describe('getBestNapiBuildVersion', () => {
  it('largest value <= host napi; null when host napi is below every candidate', () => {
    expect(getBestNapiBuildVersion([3, 7, 9], { ...env, napiVersion: '8' })).toBe(7)
    expect(getBestNapiBuildVersion([3], { ...env, napiVersion: '10' })).toBe(3)
    expect(getBestNapiBuildVersion([9], { ...env, napiVersion: '8' })).toBeNull()
    expect(getBestNapiBuildVersion(undefined, env)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * IO driven by a mock fetch
 * ------------------------------------------------------------------ */

/** Build a minimal npm-layout tar byte stream: root is `package/`, holding prebuilds/<file>.
 *  `file` may contain subdirectories (e.g. `linux-x64/bcrypt.glibc.node`) to cover the new
 *  prebuildify layout. Passing `bindingGyp` writes a binding.gyp at the package root. */
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
  it('old flat artifact (no ABI tag) → unknown (cannot tell whether it needs compiling)', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64', 'win32-x64'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('unknown')
    expect(r.observed).toContain('linux-x64.node')
    expect(r.hasBindingGyp).toBe(false)
  })

  it('old flat + binding.gyp with NAPI_VERSION → matched (better-sqlite3 v13 style N-API)', async () => {
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

  it('old flat + binding.gyp without an N-API marker → still unknown (but hasBindingGyp is set)', async () => {
    const tarBytes = await buildTarBuffer(
      ['linux-x64'],
      "{ 'defines': ['V8_DEPRECATION_WARNINGS=1'] }",
    )
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('unknown')
    expect(r.hasBindingGyp).toBe(true)
  })

  it('N-API artifact (node.napi.node) → matched (stable across ABIs)', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.napi'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('matched')
  })

  it('ABI-matching artifact (node.abi127.node) → matched', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.abi127'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('matched')
  })

  it('ABI-mismatching artifact (node.abi115.node) → absent (present, but the ABI differs)', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.abi115'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('absent')
  })

  it('whole package read with no artifact for this platform → status=absent', async () => {
    const tarBytes = await buildTarBuffer(['win32-x64'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('absent')
    expect(r.observed).toEqual(['win32-x64.node'])
  })

  it('new subdirectory with a custom name (bcrypt style, no ABI tag) → unknown', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/bcrypt.glibc', 'linux-x64/bcrypt.musl'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl })
    expect(r.status).toBe('unknown')
    expect(r.observed).toContain('linux-x64/bcrypt.glibc.node')
  })

  it('new subdirectory custom name + napiBuild → matched (bcrypt --napi is really N-API)', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/bcrypt.glibc', 'linux-x64/bcrypt.musl'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const r = await probePrebuilds('https://example/x.tgz', env, { fetchImpl, napiBuild: true })
    expect(r.status).toBe('matched')
    expect(r.observed).toContain('linux-x64/bcrypt.glibc.node')
  })

  it('musl machine against a subdirectory glibc variant → absent (libc mismatch)', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/bcrypt.glibc'])
    const fetchImpl = mockFetchReturningTar(tarBytes)
    const muslEnv: Environment = { ...env, libc: 'musl' }
    const r = await probePrebuilds('https://example/x.tgz', muslEnv, { fetchImpl })
    expect(r.status).toBe('absent')
  })

  it('safety cap hit before the stream ends → status=unknown (never read as missing)', async () => {
    const tarBytes = await buildTarBuffer(['linux-x64/node.napi'])
    // Feed only the first 100 tar bytes and never end the stream; maxBytes=50 caps it after the
    // first chunk, before the artifact header is fully parsed → unknown, not matched/absent.
    const fetchImpl: HttpLike = async () => {
      const partial = tarBytes.subarray(0, 100)
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(partial)
          // no close: this mimics a network stream cut off by the budget
        },
      })
      return { status: 200, ok: true, body: stream }
    }
    const r = await probePrebuilds('https://example/x.tgz', env, { maxBytes: 50, fetchImpl })
    expect(r.status).toBe('unknown')
  })

  it('HTTP non-2xx throws (the caller folds that into a degradable result)', async () => {
    const fetchImpl = async () => ({ status: 500, ok: false, body: null })
    await expect(probePrebuilds('https://example/x.tgz', env, { fetchImpl })).rejects.toThrow()
  })
})

describe('abiMatchFor', () => {
  it('napi → match (across ABIs)', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.napi.node')!, env)).toBe('match')
  })
  it('abiN matching the current ABI → match', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.abi127.node')!, env)).toBe('match')
  })
  it('abiN not matching → no-match', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.abi115.node')!, env)).toBe('no-match')
  })
  it('no ABI tag (old flat / custom name) → unknown', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64.node')!, env)).toBe('unknown')
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/bcrypt.glibc.node')!, env)).toBe('unknown')
  })
  it('no ABI tag + napiBuild → match (bcrypt.glibc.node really is N-API)', () => {
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/bcrypt.glibc.node')!, env, true)).toBe('match')
    // napiBuild must not affect an artifact that already states its ABI
    expect(abiMatchFor(parsePrebuildEntry('linux-x64/node.abi115.node')!, env, true)).toBe(
      'no-match',
    )
  })
})

describe('fetchManifest', () => {
  it('reads dist.tarball + metadata from a single-version registry manifest', async () => {
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

  it('non-2xx throws', async () => {
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
  it('network failure → unverified (no guessing)', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET')
    }
    expect(await probeRemoteHead('https://x', { fetchImpl })).toBe('unverified')
  })
})
