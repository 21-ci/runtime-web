---
title: Install
description: Install Runtime Web on a Linux host with one script, or deploy it onto a runtime node you already run.
---

# Install

Runtime Web runs as an App, the service `rtweb`, on a 21 Cloud Runtime node. The installer sets up the node, the
console and a Caddy reverse proxy with automatic TLS on one Linux host. This page covers the quick install, the manual
install onto an existing node, upgrades and uninstalling.

!!! warning

    Read the [security model](../security-model.md) before you expose an instance. Keep `RTWEB_INSECURE_COOKIES` unset
    outside local development, and serve the console over `https`.

## Requirements

| Requirement | Notes |
|---|---|
| Linux, x86_64 or aarch64, with systemd | The installer refuses other platforms |
| Root access | `sudo` for the install, `--dry-run` needs no root |
| `curl`, `tar`, `sha256sum` or `shasum` | Standard on most distributions |
| Node.js 22.5 or newer | Runs the install script that creates the App |
| [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) | Verifies the release signature. Required unless you pass `--insecure-skip-signature` |
| [Caddy](https://caddyserver.com/docs/install) | Serves the console over TLS. Install it with its systemd unit before you run the installer |
| Two DNS names | `A` or `AAAA` records for the console host (for example `console.example.com`) and the Apps host (default `apps.console.example.com`), both pointing at the host |
| Ports 80 and 443 open | Caddy needs both: 80 for the ACME challenge, 443 for HTTPS |

## Quick install

1. Download the installer and check its options:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh -o install.sh
    sh install.sh --help
    ```

2. Preview the steps. A dry run changes nothing on the host:

    ```bash
    sh install.sh --dry-run --domain console.example.com --email ops@example.com
    ```

3. Install. Use the console host name you set up in DNS and an e-mail address for the Let's Encrypt account:

    ```bash
    sudo sh install.sh --domain console.example.com --email ops@example.com
    ```

4. Copy the setup token that the installer prints. It is shown once. Then continue with
   [First run](first-run.md).

### Installer options

| Option | Default | Purpose |
|---|---|---|
| `--domain HOST` | required | Console host name. Caddy serves it with automatic TLS |
| `--email ADDR` | required | ACME account e-mail for Caddy |
| `--version X.Y.Z` | latest release | Runtime Web release to install |
| `--apps-domain HOST` | `apps.<domain>` | Apps host. Caddy serves it with automatic TLS; it must differ from `--domain` |
| `--public-url URL` | `https://<apps-domain>` | Public base of app URLs (`RTWEB_RUNTIME_PUBLIC_URL`). Must not be the console origin |
| `--default-plan NAME` | `free` | Runtime plan for new org tenants (`RTWEB_DEFAULT_PLAN`) |
| `--runtime-version X.Y.Z` | the version pinned in `install.sh` | Runtime release to install when `rt` is missing. Any other version needs cosign |
| `--insecure-skip-signature` | off | Install on checksums alone, without the Sigstore check. Not recommended |
| `--tarball PATH` | off | Install from a local `runtime-web-X.Y.Z.tar.gz` (the release layout) instead of downloading one: a local build or an air-gapped host. It is not signature-checked, so it also needs `--sha256 HEX` (checked against the file) or `--insecure-skip-signature` |
| `--dry-run` | off | Print every step without changing the host |
| `--uninstall` | off | Remove Runtime Web from the host. See [Uninstall](#uninstall) |

### Why Apps get their own host

Apps run untrusted code. If an App were served on the console origin, its pages could call the console API with a
signed-in admin's cookies, and the same-origin `Origin` check would let the request through. Runtime Web therefore
serves Apps at `https://<apps-domain>/s/<app>/`, a separate origin. The console host is mapped to the `rtweb` service,
and the runtime routes a mapped host before it looks at `/s/<app>/`, so app links on the console host would only reach
the console. The apps host is not mapped to any service, so the runtime routes it by path. The server refuses to
start when `RTWEB_RUNTIME_PUBLIC_URL` has the same origin as `RTWEB_ORIGIN`.

Set `RTWEB_SLUG` in the environment to give the console service a slug other than `rtweb`. The installer passes the
same value to `install.mjs` and to the Caddy site, which blocks `/s/<slug>/` on the Apps host and calls the `tls-ask`
endpoint under it. Choose it on the first install: changing it later creates a second service.

Set `GITHUB_TOKEN` in the environment to avoid GitHub API rate limits when the installer looks up the latest release.

### Tested platforms

The installer is tested end to end (install, a second run, `--dry-run`, `--uninstall`) on:

| Platform | Architecture | Runtime | Caddy | Node.js | Notes |
|---|---|---|---|---|---|
| Ubuntu 24.04 (systemd container) | aarch64 | rt 0.1.1 (pinned release asset) | 2.6.2 (Ubuntu package) | 22.20.0 | Fake `.test` domains: certificates came from Caddy's local CA, set by hand for the test |

Other systemd distributions with the same tools should work. Public certificates, real DNS and on-demand TLS for
custom domains need a host reachable from the internet, so they are not part of that test.

## What the installer does

1. Checks the platform, the tools and the Node.js version.
2. Downloads `runtime-web-<version>.tar.gz`, `SHA256SUMS` and the Sigstore bundle. It verifies the bundle with cosign
   against the release workflow's identity, then checks the tarball against `SHA256SUMS`, and unpacks it to
   `/opt/runtime-web`.
3. Installs the `rt` node from the pinned runtime release when `rt` is not on the `PATH`, and enables its systemd unit.
   If `/etc/default/rt` has no `RT_ROOT_TOKEN`, it generates one. The token is never printed.
4. Generates `RTWEB_RELAY_SECRET` into `/etc/rtweb/rtweb.env` (mode `0600`). It also sets `RTWEB_OP_TOKEN` in the rt
   environment file. Then it merges the `rtweb` plan and bindings from `deploy/rt.rtweb.toml` into `/etc/rt/rt.toml`,
   adds `trusted_proxies` for loopback so client IPs come from Caddy, and restarts `rt`.
5. Installs the Caddy site: the console host with HSTS, the Apps host (no HSTS), on-demand TLS for custom domains (gated by the console's
   `tls-ask` endpoint), and a loopback relay for tenant-scoped API calls. The site file starts with Caddy's global
   options, which Caddy accepts only before every site, so the installer puts
   `import /etc/caddy/Caddyfile.d/*.caddy` at the top of `/etc/caddy/Caddyfile` (backup:
   `/etc/caddy/Caddyfile.pre-rtweb`). It runs `caddy validate` and stops if the configuration is invalid.
6. Runs `server/scripts/install.mjs` with the node's root token. It creates the `runtime-web` tenant, publishes the
   `rtctl` SDK, creates the `rtweb` service with its secrets, uploads the console bundle and maps the console host.
7. Prints the first-run setup URL and firewall hints.

If `caddy` is not on the `PATH`, the installer finishes the node and the console but skips the proxy. Install Caddy
and run the installer again. The installer is idempotent.

## Check the install

Open the console's health endpoint. It answers `200` with the build version when the console and its database work:

```bash
curl -fsS https://console.example.com/healthz
```

```json
{"ok":true,"db":true,"version":"0.1.0"}
```

On the host, the node reports readiness on its metrics listener:

```bash
curl -fsS http://127.0.0.1:9090/readyz
```

If a check fails, see [Troubleshooting](../troubleshooting.md).

## Firewall

Allow only Caddy's ports from outside. Keep the node's own listeners on loopback: invoke on `8080`, control API on
`8081` and metrics on `9090`.

```bash
sudo ufw allow 80,443/tcp
# or, with firewalld:
sudo firewall-cmd --add-service=http --add-service=https --permanent && sudo firewall-cmd --reload
```

## Manual install onto an existing node

If you already run a 21 Cloud Runtime node, you can deploy the console onto it without the installer. The steps are
the same ones the installer runs. See [Manual install](manual-install.md).

## Upgrade

1. Back up first. See [Backups and keys](../admin/operations.md#backups-and-keys).
2. Read the [changelog](https://github.com/21-ci/runtime-web/blob/main/CHANGELOG.md) for the version you move to.
3. Run the installer again with the new version. Keep the same `--domain` and `--email`:

    ```bash
    sudo sh install.sh --version X.Y.Z --domain console.example.com --email ops@example.com
    ```

The installer keeps the existing secrets, including `RTWEB_SEAL_KEY`, and uploads a new service version only when the
bundle changed. The new version migrates the database the first time it opens it.

## Uninstall

```bash
sudo sh install.sh --uninstall
```

This removes the Runtime Web files under `/opt/runtime-web`, the secrets in `/etc/rtweb`, the Caddy site and its
systemd drop-in, the `RTWEB_OP_TOKEN` and `RTWEB_RELAY_SECRET` entries in the rt environment file, and the managed block
in `/etc/rt/rt.toml`. It also removes the `import` line the installer added to `/etc/caddy/Caddyfile`; a line that was
there before stays.

It keeps the runtime node, its data and `RT_ROOT_TOKEN`. It also keeps the `runtime-web` tenant and the `rtweb`
service. Delete them with the control API when you no longer need them:

!!! warning

    Deleting the tenant deletes the console's data, including users and sealed secrets. Back up first.

Run this as root in a shell that can read the rt environment file (`sudo -i`):

```bash
set -a; . /etc/default/rt; set +a
export RT_API=http://127.0.0.1:8081
TENANT_ID=$(curl -fsS "$RT_API/v1/tenants?limit=100" -H "Authorization: Bearer $RT_ROOT_TOKEN" \
  | jq -r '.items[] | select(.name == "runtime-web") | .id')
curl -fsS -X DELETE "$RT_API/v1/tenants/$TENANT_ID" -H "Authorization: Bearer $RT_ROOT_TOKEN"
```

## Next steps

- [First run](first-run.md): create the instance admin account
- [Manual install](manual-install.md): deploy onto a node you already run
- [Configuration](../reference/configuration.md): every variable and where it is set
- [Troubleshooting](../troubleshooting.md): logs, health checks and common failures
