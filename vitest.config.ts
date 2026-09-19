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
      // Measured 87.2 / 78.9 / 84.9 / 89.1 (statements / branches / functions /
      // lines), the same on Windows and on the Linux CI runner. The floors sit
      // just below that: a real drop fails the build, ordinary fluctuation does
      // not. Raise them when the measured value rises; never lower one to make a
      // build pass.
      thresholds: {
        statements: 86,
        branches: 77,
        functions: 83,
        lines: 88,
      },
    },
  },
})
