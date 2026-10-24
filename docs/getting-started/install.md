# Install

Runtime Web runs as an App (the service `rtweb`) on a 21 Cloud Runtime node, with Caddy in front for TLS. The
installer sets up all three on one Linux host. Before you expose an instance, read the [admin guide](../admin-guide.md)
and the [security model](../security-model.md).

## Requirements

- Linux on x86_64 or aarch64, as root
- `curl`, `tar`, `sha256sum` or `shasum`, and Node.js 22.5 or newer (for `install.mjs`)
- [Caddy](https://caddyserver.com/docs/install) with its systemd unit (the installer adds a site to it)
- A DNS name for the console pointing at the host, and inbound 80/tcp and 443/tcp open
- Optional: [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) to verify the release signature

## Steps

1. Download the installer and look at it:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh -o install.sh
    sh install.sh --help
    ```

2. See what it would do, without changing the host:

    ```bash
    sh install.sh --dry-run --domain console.example.com --email ops@example.com
    ```

3. Install:

    ```bash
    sudo sh install.sh --domain console.example.com --email ops@example.com
    ```

    Options: `--version X.Y.Z` (default: the latest release), `--runtime-version X.Y.Z`, `--public-url URL`
    (public base of app URLs, default `https://<domain>`), `--default-plan NAME` (plan for new orgs, default `free`)
    and `--verify-signature` (fail when cosign is missing).

4. Copy the setup token that the installer prints (it is shown once), open `https://console.example.com/setup` and
   continue with [First run](../admin-guide.md#first-run).

Re-running the installer is safe: it upgrades to the requested release, keeps the existing secrets and only uploads
a new service version when the bundle changed. `sh install.sh --uninstall` removes the Runtime Web files and the
Caddy site; the runtime node and its data stay.

## What the installer does

1. Checks the platform and tools.
2. Installs the runtime node (`rt`) with the runtime's own installer, pinned to a release tag, when it is missing.
3. Downloads `runtime-web-<version>.tar.gz` and `SHA256SUMS`, verifies the checksum and, when cosign is present, the
   Sigstore signature of the release workflow, then unpacks to `/opt/runtime-web/<version>`.
4. Generates `RTWEB_OP_TOKEN` and `RTWEB_RELAY_SECRET` into `/etc/rtweb/rtweb.env` (0600, never printed), merges
   `deploy/rt.rtweb.toml` (the `rtweb` plan and the `rtctl-op` / `rtctl-tenant` bindings) into `/etc/rt/rt.toml`
   and restarts `rt`.
5. Installs `deploy/Caddyfile` as a Caddy site: the console host, on-demand TLS for app custom domains (gated by
   the console's `tls-ask` endpoint) and the loopback relay for tenant-scoped control-API calls.
6. Runs `server/scripts/install.mjs` with the node's root token: creates the `runtime-web` tenant, publishes the
   `rtctl` SDK, creates the `rtweb` service with its secrets and env, uploads the bundle with the embedded console,
   maps the console host and runs a smoke check.

## What runs

| Component | Role | Listens on |
|---|---|---|
| `rt` | 21 Cloud Runtime node: runs `rtweb` and the apps, storage, schedules, queues | `127.0.0.1:8080` (invoke), `:8081` (control API), `:9090` (metrics) |
| `rtweb` service | console API and single-page app, state in `std:sql` and `std:kv` | inside the node |
| Caddy | TLS for the console and app domains; relay `127.0.0.1:8082` | `:80`, `:443` |

Only Caddy is reachable from outside. Keep the node's listeners on loopback.

## Development install

On a machine with a local runtime node, `cp .env.example .env`, `set -a; . ./.env; set +a`, then
`make server-install` (or `make server-deploy` for a quick dev deploy). See [Configuration](../configuration.md).

## Next steps

- [Configuration](../configuration.md): every variable and where it lives
- [First run](../admin-guide.md#first-run): create the first instance admin
- [Orgs](../user-guide/orgs.md) and [Apps](../user-guide/apps.md): your first app
