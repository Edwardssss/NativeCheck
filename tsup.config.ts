import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    index: 'src/index.ts',
    experimental: 'src/experimental.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  // Code-split so the CLI can `await import()` the scan path on demand. With
  // splitting off, local modules are inlined and `@npmcli/arborist`'s import is
  // hoisted to the eager top of the bundle, defeating the lazy cold-start win.
  splitting: true,
  sourcemap: true,
  shims: true,
})
