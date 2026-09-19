/**
 * `@npmcli/arborist` ships no type declarations (it is npm's own internal library).
 * This declares the minimal surface we actually use, rather than pulling in the
 * whole tree model. Extend it (or wait for official @types) when more is needed.
 */
declare module '@npmcli/arborist' {
  /** A dependency edge (node → to). */
  export interface Edge {
    readonly name?: string
    readonly spec?: string
    readonly optional?: boolean
    readonly dev?: boolean
    readonly peer?: boolean
    readonly to?: Node | null
    readonly from?: Node
  }

  /**
   * The package.json fields a node was built from.
   *
   * Platform constraints live HERE, not on the node: arborist's `Node` exposes
   * no `os` / `cpu` / `libc` getters (only `package`), so reading
   * `node.os` silently yields `undefined` and the S1 signal is lost.
   */
  export interface NodePackageJson {
    readonly os?: string[]
    readonly cpu?: string[]
    readonly libc?: string[]
    /** Declaration order matters only to npm; membership is what S5 needs. */
    readonly optionalDependencies?: Readonly<Record<string, string>>
  }

  /** A virtual dependency tree node. We use only a small subset of its fields. */
  export interface Node {
    readonly name?: string
    readonly version?: string | null
    readonly dev?: boolean
    readonly devOptional?: boolean
    readonly optional?: boolean
    readonly peer?: boolean
    readonly edgesOut?: ReadonlyMap<string, Edge>
    /** arborist keeps incoming edges in a Set, unlike the outgoing Map. */
    readonly edgesIn?: ReadonlySet<Edge>
    readonly hasInstallScript?: boolean
    readonly package?: NodePackageJson
  }

  export class Arborist {
    constructor(options: { path: string })
    loadVirtual(): Promise<Node>
  }
}
