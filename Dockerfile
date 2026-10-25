# syntax=docker/dockerfile:1.7
#
# Runtime Web container image: 21 Cloud Runtime (rt) and the Runtime Web console in one container
# (docs/getting-started/docker.md).
#
#   docker buildx build --target distroless -t runtime-web:dev .          # default: no shell, no package manager
#   docker buildx build --target slim       -t runtime-web:dev-slim .     # debian bookworm-slim, with a shell
#
# Stages:
#   web         node:22-bookworm-slim     vite build of web/, gen-assets embeds it into server/src/gen (build platform)
#   entry       golang:1.26-bookworm      rtweb-entry, the static PID 1: supervisor, bootstrap, edge, relay (cross-compiled)
#   rt          ghcr.io/21-ci/rt:0.1.1    the runtime's own signed release image, only the rt binary is taken
#   fs          debian:bookworm-slim      an empty /data owned by uid 10001, CA bundle and passwd for slim
#   distroless  distroless/cc-debian13    glibc + libgcc + CA certificates (rt links libc, libm, libgcc_s)
#   slim        debian:bookworm-slim      the same files on a Debian userland, for operators who want a shell
#
# Both run as uid 10001, work with a read-only root filesystem (only /data is written) and carry a HEALTHCHECK.
# Secrets are never baked in: rtweb-entry reads them from the environment or *_FILE, or generates them into /data.
# Base images are pinned by digest; dependabot (docker ecosystem) bumps them.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG GO_IMAGE=golang:1.26-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af
ARG RT_IMAGE=ghcr.io/21-ci/rt:0.1.1@sha256:f97e799198af60447946792a910f2edc5b75bcf3daf5bf444bee115a0891a44f
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
ARG DISTROLESS_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:3ee00291cf386ec52a552e6a858d555debd74776eb4bfa53fa3df2cd6677515e

# ---------------------------------------------------------------------------------------------
# Console build + embedding (architecture independent: runs once on the build platform)
# ---------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --no-audit --no-fund
COPY web/ ./
COPY server/ /src/server/
RUN npm run build \
 && node /src/server/scripts/gen-assets.mjs \
 && mkdir -p /out/server \
 && cp -r /src/server/src /src/server/sdk /src/server/rt.json /out/server/ \
 && cp -r /src/web/dist /out/dist \
 && node -e 'const fs=require("fs"),p=require("path");const b=JSON.parse(fs.readFileSync("/src/server/.gen-blobs.json","utf8"));for(const x of b)x.file=p.join("dist",p.relative("/src/web/dist",x.file));fs.writeFileSync("/out/blobs.json",JSON.stringify(b,null,2)+"\n")'
COPY deploy/rt.rtweb.toml docker/rt.apps.toml /out/

# ---------------------------------------------------------------------------------------------
# rtweb-entry (static, no cgo; cross-compiled for the target platform)
# ---------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS entry
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
# No cgo anywhere: the binary is static and vet/test need no C toolchain.
ENV CGO_ENABLED=0
COPY docker/entry/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    go vet ./... \
 && go test ./... \
 && GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/rtweb-entry .

FROM ${RT_IMAGE} AS rt

# Built on the build platform, so no target stage runs a command and multi-arch builds need no emulation.
# ca-certificates (architecture independent) and the rt user are only used by the slim flavor; their versions
# float with the pinned base digest, which dependabot bumps.
FROM --platform=$BUILDPLATFORM ${DEBIAN_IMAGE} AS fs
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 rt && useradd -u 10001 -g 10001 -d /data -s /usr/sbin/nologin -M rt \
 && install -d -o 10001 -g 10001 -m 0750 /out/data \
 && mkdir -p /out/etc && cp /etc/passwd /etc/group /out/etc/

# ---------------------------------------------------------------------------------------------
# Shared metadata and layout of both flavors
# ---------------------------------------------------------------------------------------------
FROM ${DISTROLESS_IMAGE} AS distroless
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="runtime-web" \
      org.opencontainers.image.description="Runtime Web console and 21 Cloud Runtime (rt 0.1.1) in one container" \
      org.opencontainers.image.source="https://github.com/21-ci/runtime-web" \
      org.opencontainers.image.documentation="https://21-ci.github.io/runtime-web/getting-started/docker/" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="21 Cloud" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.base.name="gcr.io/distroless/cc-debian13:nonroot"
COPY --from=rt /usr/local/bin/rt /usr/local/bin/rt
COPY --from=entry /out/rtweb-entry /usr/local/bin/rtweb-entry
COPY --from=web /out/ /usr/local/share/rtweb/
COPY --from=fs --chown=10001:10001 /out/data /data
# The prebuilt V8 has no sandbox; rt refuses to start with the default require_v8_sandbox=true (see the runtime's
# SECURITY.md, "Known limitations"), exactly like its own image.
ENV HOME=/data \
    RT__SECURITY__REQUIRE_V8_SANDBOX=false \
    RT_LOG=info \
    RTWEB_VERSION=${VERSION}
VOLUME ["/data"]
WORKDIR /data
# 8080: the edge (console host, apps host, custom domains), plain HTTP behind your TLS proxy.
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 CMD ["/usr/local/bin/rtweb-entry", "healthcheck"]
USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/rtweb-entry"]

FROM ${DEBIAN_IMAGE} AS slim
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="runtime-web" \
      org.opencontainers.image.description="Runtime Web console and 21 Cloud Runtime (rt 0.1.1) in one container (Debian slim)" \
      org.opencontainers.image.source="https://github.com/21-ci/runtime-web" \
      org.opencontainers.image.documentation="https://21-ci.github.io/runtime-web/getting-started/docker/" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="21 Cloud" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.base.name="debian:bookworm-slim"
# CA certificates: rt fetches npm/jsr imports of Apps over TLS. passwd/group add the rt user (uid 10001).
COPY --from=fs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=fs /out/etc/passwd /out/etc/group /etc/
COPY --from=rt /usr/local/bin/rt /usr/local/bin/rt
COPY --from=entry /out/rtweb-entry /usr/local/bin/rtweb-entry
COPY --from=web /out/ /usr/local/share/rtweb/
COPY --from=fs --chown=10001:10001 /out/data /data
ENV HOME=/data \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    RT__SECURITY__REQUIRE_V8_SANDBOX=false \
    RT_LOG=info \
    RTWEB_VERSION=${VERSION}
VOLUME ["/data"]
WORKDIR /data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 CMD ["/usr/local/bin/rtweb-entry", "healthcheck"]
USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/rtweb-entry"]

# Default target: the minimal flavor.
FROM distroless
