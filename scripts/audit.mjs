/**
 * Advisory check for the runtime dependency tree — the `npm run audit` step.
 *
 * Two details are load-bearing:
 *
 * - **The environment is sanitized before npm is spawned.** When `npm run`
 *   invokes npm again, it exports its own effective configuration as
 *   `npm_config_*`. A user-level `allow-scripts` entry (npm's opt-in mechanism
 *   for install scripts) then makes the child `npm audit` abort with
 *   `EALLOWSCRIPTS ("not allowed in project-scoped installs")` before it ever
 *   looks at an advisory — the command would work in CI and fail on the
 *   maintainer's machine, which is the wrong way round.
 * - **The registry is pinned.** The advisory endpoint only exists on
 *   `registry.npmjs.org`; mirrors answer `NOT_IMPLEMENTED`, which would turn a
 *   security gate into a silent no-op.
 *
 * `--omit=dev` because runtime dependencies are what users install; a known
 * advisory in one of them is a release blocker.
 */
import { spawnSync } from 'node:child_process'

const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
}

const result = spawnSync(
  'npm',
  ['audit', '--omit=dev', '--audit-level=high', '--registry=https://registry.npmjs.org'],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
)

if (result.error !== undefined) {
  console.error(`audit: could not run npm: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
