# Ground Truth measurement image: Node + a full C/C++ toolchain, a sandbox for real npm installs.
#
# libc is decided by the base image the caller picks (see the libc->base image tag map in run-matrix.sh):
#   glibc -> node:<N>-bookworm-slim
#   musl  -> node:<N>-alpine
# Usage:
#   docker build \
#     --build-arg BASE_IMAGE=node:22-bookworm-slim \
#     --build-arg LIBMODE=glibc \
#     -t nc-gt:22-glibc .
#
# Ground Truth goal: a complete toolchain in the image means any native package can be given a
# build attempt, which is what cleanly separates "no prebuilt for this platform (must compile)"
# from "has a prebuilt (no compile)".
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# wrapper / probe / predict scripts (build context must be the repo root; scripts live in testdata/ground-truth/)
COPY testdata/ground-truth/wrap-compilers.sh /usr/local/bin/wrap-compilers.sh
COPY testdata/ground-truth/probe-install.sh /usr/local/bin/probe-install.sh
COPY testdata/ground-truth/predict.sh /usr/local/bin/predict.sh
RUN chmod +x /usr/local/bin/wrap-compilers.sh /usr/local/bin/probe-install.sh /usr/local/bin/predict.sh

# Install the toolchain (glibc=debian apt / musl=alpine apk kept separate)
ARG LIBMODE=glibc
# Common system dev libraries: so "truly native" packages that need system libs (pcap/cap ->
# libpcap, speaker -> alsa, libpq -> postgres) really compile in the matrix instead of adding
# install-failed noise from a missing lib.
RUN if [ "$LIBMODE" = "musl" ]; then \
      apk add --no-cache build-base bash python3 git ca-certificates curl \
        linux-headers musl-dev libpcap-dev alsa-lib-dev postgresql-dev; \
    else \
      apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 git ca-certificates curl \
        libpcap-dev libasound2-dev libpq-dev \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# Preinstall the compiler wrappers (the .real originals are kept; re-run wrap-compilers.sh if
# they get polluted before a probe)
RUN bash /usr/local/bin/wrap-compilers.sh || true

WORKDIR /work
ENV NC_COMPILE_LOG=/tmp/nc-compile.log
