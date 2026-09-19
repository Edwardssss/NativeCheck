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
 * Companion offline tests: the generalization spot-check block in test/install-script.test.ts.
 */
import { parseInstallScript } from '../../dist/index.js'

const CASES = [
  // [name, version?, known real behaviour (manually curated ground truth)]
  [
    'sqlite3',
    undefined,
    'node-pre-gyp downloads the binding; compile on failure -> expect download_then_compile',
  ],
  ['fsevents', undefined, 'local build -> expect compile'],
  ['microtime', undefined, 'local build -> expect compile'],
  ['grpc', '1.24.11', 'node-pre-gyp download; compile on failure -> expect download_then_compile'],
  ['node-sass', undefined, 'scripts/install.js custom download logic -> actually download'],
  ['electron', undefined, 'install.js downloads the Electron binary -> actually download'],
  [
    'cypress',
    undefined,
    'index.js --exec install downloads the Cypress binary -> actually download',
  ],
  [
    '@biomejs/biome',
    undefined,
    'postinstall verifies the optionalDeps artifact (benign) -> expect select',
  ],
  ['esbuild', '0.15.18', 'older install.js (optionalDeps already covers it) -> observe'],
  ['core-js-pure', undefined, 'pure core-js build (watch for scripts)'],
  ['es5-ext', undefined, 'same author as core-js; watch whether the node -e rule matches'],
  ['nodemon', undefined, 'no install script (control group)'],
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
    console.log(
      `  L1 dependency-edge signal: ${nativeDeps.length ? nativeDeps.join(', ') : '(none)'}`,
    )
    console.log(`  -> parseInstallScript output: ${intent}    [known behaviour: ${note}]`)
    console.log('')
  } catch (e) {
    console.log(`✗ ${name}@${spec} ${e.message}`)
    console.log('')
  }
}
