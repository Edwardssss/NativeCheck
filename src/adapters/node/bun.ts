/**
 * Layer 0 — Bun lockfile adapter (bun.lockb).
 *
 * bun.lockb is Bun's private *binary* lockfile (a struct-of-arrays dump of its
 * in-memory dependency graph). It is not a text format and changes format
 * version; hand-parsing it would be a large, brittle maintenance burden. So
 * NativeCheck delegates the binary decode to the tiny zero-dependency
 * `@hyrious/bun.lockb` parser (MIT, 12 KB, translates Bun's own lockfile.zig
 * logic to JS, `assert(format === 2)` pins the current binary format).
 *
 * `@hyrious/bun.lockb` renders a bun.lockb into **yarn lockfile v1 text** that
 * preserves the nested `dependencies:` / `optionalDependencies:` blocks (and
 * therefore the Pattern-A platform cluster and the S3 build-tool edges).
 * Because of that, a bun.lockb is decoded to text and then re-parsed by the
 * yarn v1 parser — the two adapters share one normalizer and one contract.
 *
 * Cost assessment (why the dependency is acceptable): the parser is a pure
 * synchronous function, ~12 KB unpacked with zero runtime deps, so it adds
 * <1% to the bundle and only ever runs when a bun.lockb is actually scanned
 * (and it lives behind the CLI's lazy chunking, so it does not affect
 * env/help cold start).
 *
 * Fail Closed: a malformed / unknown-format bun.lockb throws inside the
 * decoder → caught by the caller and reported as an explicit unsupported
 * outcome (never a guess). Bun 1.2+ default text `bun.lock` is a separate,
 * JSON-like format and is intentionally out of scope here.
 */
import { parse as parseBinaryBun } from '@hyrious/bun.lockb'
import { parseYarnLockfile } from './yarn'
import type { LockfilePackage } from './signals'

/**
 * Parse a binary bun.lockb into normalized `LockfilePackage[]`.
 * Throws on a malformed / unsupported-format buffer; the caller converts that
 * into a Fail-Closed unsupported outcome. Returns an empty list if the decoded
 * yarn-v1 text carried no packages.
 */
export function parseBunLockfile(buf: Buffer): LockfilePackage[] {
  const yarnText = parseBinaryBun(buf)
  return parseYarnLockfile(yarnText)
}
