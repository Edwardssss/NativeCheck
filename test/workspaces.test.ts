/**
 * Workspace / monorepo attribution.
 *
 * A monorepo lockfile is one flat graph, but its ownership is not flat. These
 * tests pin the three facts attribution has to establish offline:
 *
 * 1. who declares what (so a finding can say *which* workspace asked for sharp),
 * 2. which nodes are the user's own source (never a third-party finding),
 * 3. that an ordinary single-package project sees none of this machinery.
 *
 * The glob expander is tested through the `WorkspaceFs` seam, so edge cases
 * (negations, missing dirs, dot-directories) do not need real trees.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverWorkspaces,
  EMPTY_WORKSPACE_MAP,
  expandWorkspaceGlobs,
  readWorkspaceGlobs,
  workspacesDeclaring,
  type WorkspaceFs,
} from '../src/adapters/node/workspaces'
import { ingest } from '../src/adapters/node/ingest'
import { classifyGraph } from '../src/adapters/node/classify'
import { DistributionPattern, NativeVerdict } from '../src/core/model'
import type { IngestedGraph, LockfilePackage } from '../src/adapters/node/signals'
import { indexPackages } from '../src/adapters/node/signals'

/** In-memory tree: path (POSIX, relative) → file contents. */
function fakeFs(files: Readonly<Record<string, string>>): WorkspaceFs {
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    readFile: (path) => {
      const key = normalize(path)
      const hit = files[key]
      if (hit === undefined) throw new Error(`ENOENT: ${key}`)
      return hit
    },
    // Directories count as existing when they contain a file: the real
    // `existsSync` is true for a directory, and the expander relies on that.
    exists: (path) => {
      const key = normalize(path)
      if (Object.hasOwn(files, key)) return true
      const prefix = `${key}/`
      return Object.keys(files).some((candidate) => candidate.startsWith(prefix))
    },
    listDirs: (path) => {
      const prefix = `${normalize(path)}/`
      const dirs = new Set<string>()
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const first = rest.split('/')[0]
        if (first && rest.includes('/')) dirs.add(first)
      }
      return [...dirs].sort()
    },
  }
}

describe('readWorkspaceGlobs', () => {
  it('reads the npm array form', () => {
    expect(readWorkspaceGlobs({ workspaces: ['packages/*', 'apps/*'] })).toEqual([
      'packages/*',
      'apps/*',
    ])
  })

  it('reads the yarn-style object form', () => {
    expect(readWorkspaceGlobs({ workspaces: { packages: ['tools/*'], nohoist: ['x'] } })).toEqual([
      'tools/*',
    ])
  })

  it('merges pnpm-workspace.yaml globs', () => {
    expect(readWorkspaceGlobs({}, 'packages:\n  - packages/*\n  - "!packages/legacy"\n')).toEqual([
      'packages/*',
      '!packages/legacy',
    ])
  })

  it('returns nothing for a single-package project', () => {
    expect(readWorkspaceGlobs({ name: 'solo', version: '1.0.0' })).toEqual([])
  })

  it('survives a malformed pnpm-workspace.yaml instead of taking ingest down', () => {
    expect(readWorkspaceGlobs({}, 'packages: [unclosed')).toEqual([])
  })
})

describe('expandWorkspaceGlobs', () => {
  it('expands a single-level star', () => {
    const fs = fakeFs({
      '/root/packages/a/package.json': '{}',
      '/root/packages/b/package.json': '{}',
      '/root/apps/web/package.json': '{}',
    })
    expect(expandWorkspaceGlobs('/root', ['packages/*'], fs)).toEqual(['packages/a', 'packages/b'])
  })

  it('accepts literal directories', () => {
    const fs = fakeFs({ '/root/tooling/release/package.json': '{}' })
    expect(expandWorkspaceGlobs('/root', ['tooling/release'], fs)).toEqual(['tooling/release'])
  })

  it('applies negations after positives', () => {
    const fs = fakeFs({
      '/root/packages/a/package.json': '{}',
      '/root/packages/b/package.json': '{}',
    })
    expect(expandWorkspaceGlobs('/root', ['packages/*', '!packages/b'], fs)).toEqual(['packages/a'])
  })

  it('skips dot-directories and directories without a manifest', () => {
    const fs = fakeFs({
      '/root/packages/.cache/package.json': '{}',
      '/root/packages/real/package.json': '{}',
    })
    expect(expandWorkspaceGlobs('/root', ['packages/*'], fs)).toEqual(['packages/real'])
  })

  it('deduplicates overlapping globs', () => {
    const fs = fakeFs({ '/root/packages/a/package.json': '{}' })
    expect(expandWorkspaceGlobs('/root', ['packages/*', 'packages/a'], fs)).toEqual(['packages/a'])
  })
})

describe('discoverWorkspaces', () => {
  it('returns the empty map for a single-package project (no behaviour change)', () => {
    const fs = fakeFs({ '/root/package.json': JSON.stringify({ name: 'solo' }) })
    expect(discoverWorkspaces('/root', fs)).toEqual(EMPTY_WORKSPACE_MAP)
  })

  it('builds the attribution table across all four dependency fields', () => {
    const fs = fakeFs({
      '/root/package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      '/root/packages/api/package.json': JSON.stringify({
        name: '@mono/api',
        dependencies: { sharp: '^0.33.0' },
        devDependencies: { esbuild: '^0.20.0' },
      }),
      '/root/packages/web/package.json': JSON.stringify({
        name: '@mono/web',
        dependencies: { sharp: '^0.32.0' },
        optionalDependencies: { fsevents: '^2.3.0' },
        peerDependencies: { canvas: '*' },
      }),
    })
    const map = discoverWorkspaces('/root', fs)
    expect(map.members.map((m) => m.dir)).toEqual(['packages/api', 'packages/web'])
    // Sorted and unique: two members declare sharp.
    expect(workspacesDeclaring(map, 'sharp')).toEqual(['@mono/api', '@mono/web'])
    expect(workspacesDeclaring(map, 'esbuild')).toEqual(['@mono/api'])
    expect(workspacesDeclaring(map, 'fsevents')).toEqual(['@mono/web'])
    expect(workspacesDeclaring(map, 'canvas')).toEqual(['@mono/web'])
  })

  it('reports undefined — not an empty list — for a package no member declares', () => {
    const fs = fakeFs({
      '/root/package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      '/root/packages/api/package.json': JSON.stringify({ name: '@mono/api' }),
    })
    const map = discoverWorkspaces('/root', fs)
    expect(workspacesDeclaring(map, 'left-pad')).toBeUndefined()
  })

  it('skips a member with a broken manifest rather than failing the scan', () => {
    const fs = fakeFs({
      '/root/package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      '/root/packages/api/package.json': '{ not json',
      '/root/packages/ok/package.json': JSON.stringify({ name: '@mono/ok' }),
    })
    const map = discoverWorkspaces('/root', fs)
    expect(map.members.map((m) => m.name)).toEqual(['@mono/ok'])
  })

  it('falls back to the directory name when a member is unnamed', () => {
    const fs = fakeFs({
      '/root/package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      '/root/packages/anonymous/package.json': JSON.stringify({ version: '1.0.0' }),
    })
    expect(discoverWorkspaces('/root', fs).members[0]?.name).toBe('packages/anonymous')
  })
})

describe('ingest attribution (real lockfile + real manifests)', () => {
  // Must be async: the temp tree has to outlive the awaited callback. A sync
  // helper would `rmSync` the directory while ingest is still reading it.
  async function withMonoWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), 'nc-ws-'))
    try {
      mkdirSync(join(root, 'packages', 'addon'), { recursive: true })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'mono',
          version: '1.0.0',
          private: true,
          workspaces: ['packages/*'],
        }),
      )
      writeFileSync(
        join(root, 'packages', 'addon', 'package.json'),
        JSON.stringify({
          name: '@mono/addon',
          version: '1.0.0',
          dependencies: { sharp: '^0.33.0' },
          scripts: { install: 'node-gyp rebuild' },
        }),
      )
      writeFileSync(
        join(root, 'package-lock.json'),
        JSON.stringify({
          name: 'mono',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'mono',
              version: '1.0.0',
              workspaces: ['packages/*'],
              dependencies: {},
            },
            'node_modules/@mono/addon': { resolved: 'packages/addon', link: true },
            'packages/addon': {
              name: '@mono/addon',
              version: '1.0.0',
              dependencies: { sharp: '^0.33.0' },
              hasInstallScript: true,
            },
            'node_modules/sharp': {
              version: '0.33.0',
              hasInstallScript: true,
              os: ['darwin', 'linux', 'win32'],
            },
          },
        }),
      )
      // `await` matters: returning the promise directly would run the cleanup
      // before the callback's async body ever read the tree.
      return await fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('attributes a dependency to the member that declared it', async () => {
    const packages = await withMonoWorkspace(async (root) => {
      const outcome = await ingest(root)
      if (!outcome.ok) throw new Error(outcome.reason)
      return outcome.graph.packages
    })
    expect(packages['sharp@0.33.0']?.workspaces).toEqual(['@mono/addon'])
  })

  it('marks the member itself and keeps it out of the candidate list', async () => {
    const { graph, members } = await withMonoWorkspace(async (root) => {
      const outcome = await ingest(root)
      if (!outcome.ok) throw new Error(outcome.reason)
      const result = classifyGraph(outcome.graph)
      return { graph: outcome.graph, members: result.workspaceMembers }
    })
    const addon = Object.values(graph.packages).find((p) => p.name === '@mono/addon')
    expect(addon?.isWorkspaceMember).toBe(true)
    // The member has an install script of its own — that is the user's build
    // step, not a third-party download, so it must not be a candidate.
    expect(members).toEqual(['@mono/addon@1.0.0'])
  })

  it('leaves a single-package project untouched', async () => {
    const packages = await withMonoWorkspace(async () => {
      const solo = mkdtempSync(join(tmpdir(), 'nc-solo-'))
      try {
        writeFileSync(
          join(solo, 'package.json'),
          JSON.stringify({ name: 'solo', version: '1.0.0', dependencies: {} }),
        )
        writeFileSync(
          join(solo, 'package-lock.json'),
          JSON.stringify({
            name: 'solo',
            version: '1.0.0',
            lockfileVersion: 3,
            requires: true,
            packages: {
              '': { name: 'solo', version: '1.0.0', dependencies: {} },
              'node_modules/sharp': { version: '0.33.0', hasInstallScript: true },
            },
          }),
        )
        const outcome = await ingest(solo)
        if (!outcome.ok) throw new Error(outcome.reason)
        return outcome.graph.packages
      } finally {
        rmSync(solo, { recursive: true, force: true })
      }
    })
    expect(packages['sharp@0.33.0']?.workspaces).toBeUndefined()
  })
})

describe('classifyGraph workspace handling (hand-written records)', () => {
  const graph = (list: readonly LockfilePackage[]): IngestedGraph => indexPackages(list)

  it('never reports a workspace member, however native-looking', () => {
    const result = classifyGraph(
      graph([
        {
          name: '@mono/addon',
          version: '1.0.0',
          hasInstallScript: true,
          dependencies: { 'node-gyp': { name: 'node-gyp' } },
          pathChains: [['@mono/addon']],
          isWorkspaceMember: true,
        },
      ]),
    )
    expect(result.candidates).toEqual([])
    expect(result.workspaceMembers).toEqual(['@mono/addon@1.0.0'])
  })

  it('still walks what the member pulls in', () => {
    const result = classifyGraph(
      graph([
        {
          name: '@mono/addon',
          version: '1.0.0',
          isWorkspaceMember: true,
          pathChains: [['@mono/addon']],
        },
        {
          name: 'sharp',
          version: '0.33.0',
          hasInstallScript: true,
          pathChains: [['@mono/addon', 'sharp']],
          workspaces: ['@mono/addon'],
        },
      ]),
    )
    const found = result.candidates.find((c) => c.pkg.name === 'sharp')
    // A lone `hasInstallScript` with nothing else is not enough to name a
    // pattern offline — but it *is* enough to be reported, and the workspace
    // attribution must ride along untouched.
    expect(found?.pattern).toBe(DistributionPattern.NotNative)
    expect(found?.verdict).toBe(NativeVerdict.Suspicious)
    expect(found?.pkg.workspaces).toEqual(['@mono/addon'])
  })

  it('keeps workspaceMembers empty for a flat project', () => {
    const result = classifyGraph(
      graph([
        {
          name: 'sharp',
          version: '0.33.0',
          hasInstallScript: true,
          pathChains: [['sharp']],
        },
      ]),
    )
    expect(result.workspaceMembers).toEqual([])
    expect(result.candidates[0]?.verdict).toBe(NativeVerdict.Suspicious)
  })
})
