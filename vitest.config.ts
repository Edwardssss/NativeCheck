import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Fixtures are the core asset: any change to a detection rule must come with
    // an explicit snapshot update — silent drift is not accepted
    snapshotFormat: {
      printBasicPrototype: false,
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**'],
      reporter: ['text', 'html'],
    },
  },
})
