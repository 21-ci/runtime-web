---
title: Docker
description: Run Runtime Web and 21 Cloud Runtime together in one container, with Docker or Docker Compose.
---

# Docker

The image `ghcr.io/21-ci/runtime-web` holds a 21 Cloud Runtime node (`rt` 0.1.1) and the Runtime Web console. One
container serves the console, your Apps and their custom domains. Data lives in one volume, `/data`.

!!! warning

    The container speaks plain HTTP. Put a TLS proxy in front before you expose it, and read the
    [security model](../security-model.md).

## Image flavors

| Tag | Base | Use it for |
|---|---|---|
| `edge`, `X.Y.Z`, `X.Y` | `gcr.io/distroless/cc-debian13` | Production. No shell, no package manager |
| `edge-slim`, `X.Y.Z-slim`, `X.Y-slim` | `debian:bookworm-slim` | Debugging, when you need `docker exec … sh` |

Both flavors run on `linux/amd64` and `linux/arm64`, run as uid `10001` and work with a read-only root filesystem.
Every image is signed with cosign (keyless) and carries an SBOM and SLSA provenance attestation.

## Quickstart

1. Start the container:

    ```bash
    docker run -d --name rtweb --read-only --tmpfs /tmp \
      -p 127.0.0.1:8080:8080 \
      -e RTWEB_CONSOLE_URL=http://console.localhost:8080 \
      -e RTWEB_APPS_URL=http://apps.localhost:8080 \
      -v rtweb-data:/data \
      ghcr.io/21-ci/runtime-web:edge
    ```

2. Wait until the container is healthy (about 20 seconds on the first boot), then read the setup token:

    ```bash
    docker logs rtweb 2>&1 | grep "Setup token"
    ```

3. Open `http://console.localhost:8080/setup`, paste the token and create the instance admin.

The setup token works once. After setup the container deletes it on the next start.

`*.localhost` names resolve to your machine in current browsers, so no DNS changes are needed for a local trial.

## Docker Compose

The repository has a ready [`docker-compose.yml`](https://github.com/21-ci/runtime-web/blob/main/docker-compose.yml):

```bash
docker compose up -d
docker compose logs rtweb | grep "Setup token"
```

Set the variables in a `.env` file next to it, for example `RTWEB_CONSOLE_URL`, `RTWEB_APPS_URL` and `RTWEB_PORT`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `RTWEB_CONSOLE_URL` | required | Console origin as the browser sees it, for example `https://console.example.com` |
| `RTWEB_APPS_URL` | required | Apps origin, for example `https://apps.example.com`. Must use a different host name than the console |
| `RTWEB_TRUSTED_PROXIES` | none | CIDRs or addresses of your TLS proxy. Their `X-Forwarded-For` and `X-Forwarded-Proto` are trusted |
| `RTWEB_DEFAULT_PLAN` | `apps` | Runtime plan for new org tenants. The image defines `apps`, which allows cron |
| `RTWEB_TLS_ASK_LISTEN` | off | Address such as `:8079` for the on-demand TLS check, see [Custom domains](#custom-domains) |
| `RTWEB_RT_CONFIG_EXTRA` | none | Path to extra TOML appended to the node's `rt.toml` (plans, limits). Do not add an `[ingress]` table |
| `RTWEB_LISTEN` | `:8080` | Edge listener inside the container |
| `RT_LOG` | `info` | Runtime log level |
| `RT__SECTION__KEY` | | Any runtime config key, as in the runtime image |

When the console URL uses `http`, the console sets cookies without `Secure`. Use `http` only for a local trial.

### Secrets

The container needs a root token, a master key and a relay secret. Each one is read in this order:

1. The variable itself: `RT_ROOT_TOKEN`, `RT_MASTER_KEY`, `RTWEB_RELAY_SECRET`.
2. A file named by `<NAME>_FILE`, for example `RT_MASTER_KEY_FILE=/run/secrets/rt_master_key`.
3. `/data/rtweb/secrets/`, generated on the first boot (mode `0600`).

The image itself contains no secrets. Back up `/data/rtweb/secrets/master-key` with the volume: without it the
sealed secrets in the runtime database cannot be read.

You can preset the setup token with `RTWEB_SETUP_TOKEN` or `RTWEB_SETUP_TOKEN_FILE`.

## Volumes

| Path | Contents |
|---|---|
| `/data` | Runtime database, App versions, blobs, logs, the generated `rt.toml` and `rtweb/secrets/` |

A bind mount must be writable by uid `10001`.

## Reverse proxy and TLS

The container listens on port `8080` and routes by `Host`: the console host, the Apps host and every active custom
domain. Your proxy terminates TLS and forwards all three to port `8080` with the original `Host` header.

Caddy in front of the container:

```caddyfile
console.example.com, apps.example.com {
	reverse_proxy rtweb:8080
}
```

Then set `RTWEB_CONSOLE_URL=https://console.example.com`, `RTWEB_APPS_URL=https://apps.example.com` and
`RTWEB_TRUSTED_PROXIES` to the proxy's address (for example the Docker network `172.16.0.0/12`).

The container already applies the rules of the host install's Caddy site: it answers `404` for internal routes, keeps
the console off the Apps host, sets HSTS on an `https` console host and replaces `X-Forwarded-For` with the real
client.

### Custom domains

Custom domains need certificates on demand. Set `RTWEB_TLS_ASK_LISTEN=:8079` and let the proxy ask before it issues
one. Do not publish port `8079`.

```caddyfile
{
	on_demand_tls {
		ask http://rtweb:8079/tls-ask
	}
}

https:// {
	tls {
		on_demand
	}
	reverse_proxy rtweb:8080
}
```

## Upgrading

1. Pull the new image: `docker compose pull` (or `docker pull ghcr.io/21-ci/runtime-web:X.Y.Z`).
2. Recreate the container: `docker compose up -d`.

On every start the container checks the console bundle and uploads a new version only when it changed. The seal key
and the setup token are never rotated.

Verify an image before you run it:

```bash
cosign verify ghcr.io/21-ci/runtime-web:X.Y.Z \
  --certificate-identity-regexp '^https://github\.com/21-ci/runtime-web/\.github/workflows/docker\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Limits

- Apps that import npm or JSR packages need outbound HTTPS from the container on their first build.
- The control API (`8081`) and the metrics listener stay on loopback inside the container. Use the console's admin
  pages instead.
- The prebuilt V8 has no sandbox, the same as the runtime's own image.
