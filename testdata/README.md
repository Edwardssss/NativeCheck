# testdata/

Data directory for real install results and the accuracy baseline. Only scripts
and conventions are committed; runtime artifacts stay out of git.

- `ground-truth/` — the Ground Truth Docker matrix. See
  [`ground-truth/README.md`](./ground-truth/README.md) for the full workflow:
  compiler-wrapper measurement, a Node{20,22,24} × libc{glibc,musl} matrix, and
  the L1 / L2 / L3 tables.
- `windows/` — the same idea for Windows, run natively rather than in Docker.

> No measurement, no improvement. It is the easiest step to skip and the most
> important one not to.
