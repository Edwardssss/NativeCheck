#!/usr/bin/env bash
# Compiler wrapper installation (design doc §13.1). Every C/C++ compile call leaves a trace in
# the log, proving 100% precisely whether a local build happened -- far more reliable than
# grepping `gyp ERR!` logs.
#
# Usage: run `bash /workspace/testdata/ground-truth/wrap-compilers.sh` as root in the container;
# afterwards any cc/gcc/g++/clang/clang++ call appends one line to $NC_COMPILE_LOG.
#
# Note: `make` is **deliberately not wrapped**. node-gyp still runs `make BUILDTYPE=Release`
# even for an empty target (e.g. better-sqlite3 v13 uses `prebuild_exists` to turn the implicit
# node-gyp rebuild into a no-op), so wrapping make would misjudge "no compilation at all" as
# compiled=yes. A real build must go through cc/g++/clang, so wrapping only the compilers
# themselves stays 100% precise.
set -euo pipefail

: "${NC_COMPILE_LOG:=/tmp/nc-compile.log}"
rm -f "$NC_COMPILE_LOG"

wrap() {
  local c="$1" real
  real="$(command -v "$c" 2>/dev/null)" || return 0 # skip when the image has no such compiler
  # Skip when this compiler is already wrapped (so .real is never wrapped recursively)
  [ -e "${real}.real" ] && return 0
  # Symlinks must resolve to the real file, otherwise mv'ing the symlink breaks the system
  real="$(readlink -f "$real")"
  [ -e "${real}.real" ] && return 0
  mv "$real" "${real}.real"
  cat > "$real" <<EOF
#!/bin/sh
echo "\$0 \$*" >> "$NC_COMPILE_LOG"
exec "${real}.real" "\$@"
EOF
  chmod +x "$real"
}

# c++ must be included: on alpine(musl) node-gyp compiles C++ with `/usr/bin/c++` (there c++ is
# a separate copy/hardlink of g++, unlike Debian where c++ is an update-alternatives symlink
# that ends up pointing at the wrapped g++). Missing c++ makes every D-mode (source build)
# package on the musl cell "really compile yet record compiled=no", manufacturing 72 false FPs
# (see the ground-truth README section on known measurement noise).
for c in cc gcc g++ c++ clang clang++; do wrap "$c"; done

echo "compiler wrappers installed → $NC_COMPILE_LOG"
