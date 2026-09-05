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
    readonly edgesIn?: ReadonlyMap<string, Edge>
    readonly os?: string[]
    readonly cpu?: string[]
    readonly libc?: string[]
    readonly hasInstallScript?: boolean
  }

  export class Arborist {
    constructor(options: { path: string })
    loadVirtual(): Promise<Node>
  }
}
