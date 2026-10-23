# syntax=docker/dockerfile:1.7
#
# rtweb: Go BFF with the React console embedded (go:embed of internal/api/dist).
#
#   make docker            # docker build -t rtweb:dev -f Dockerfile .
#   docker compose up -d   # see docker-compose.yml
#
# Three stages:
#   web      node:24-bookworm-slim     npm ci + vite build -> /src/web/dist (npm cache in a BuildKit cache)
#   build    golang:1.26.10-bookworm   CGO_ENABLED=0 static binary with web/dist copied into internal/api/dist
#   runtime  distroless/static         nonroot, no shell, no package manager
#
# Needs BuildKit (default in Docker >= 23) for the cache mounts.

# ---------------------------------------------------------------------------------------------
# Stage 1: web console
# ---------------------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS web

WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------------------------
# Stage 2: rtweb binary
# ---------------------------------------------------------------------------------------------
FROM golang:1.26.10-bookworm AS build

WORKDIR /src

ARG VERSION=dev
ARG COMMIT=none
ARG DATE=unknown

ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=readonly

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
# The embed directory is generated from the web stage; it is excluded from the context (.dockerignore).
COPY --from=web /src/web/dist ./internal/api/dist

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.date=${DATE}" \
      -o /out/rtweb ./cmd/rtweb

# ---------------------------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

LABEL org.opencontainers.image.title="Runtime Web console" \
      org.opencontainers.image.description="Admin and tenant console for 21 Cloud Runtime (BFF + React SPA)"

COPY --from=build /out/rtweb /usr/local/bin/rtweb

# The SQLite database lives on a volume owned by the nonroot user (uid 65532).
ENV RTWEB_LISTEN=:8090 \
    RTWEB_DB=/data/rtweb.db
VOLUME ["/data"]
WORKDIR /data

EXPOSE 8090

# distroless has no shell or curl: the compose healthcheck for rtweb is served by the
# router-side probe, not by the container (see docker-compose.yml).
USER nonroot:nonroot
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/rtweb"]
