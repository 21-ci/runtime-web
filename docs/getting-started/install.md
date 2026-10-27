---
title: Install
description: Install Runtime Web on a Linux host with one script, or deploy it onto a runtime node you already run.
---

# Install

Runtime Web runs as an App, the service `rtweb`, on a 21 Cloud Runtime node. One installer sets it up on a Linux host
in either of two modes:

- **bare**: the `rt` node as a systemd service, the console on it, and Caddy on the host for HTTPS.
- **docker**: the [container image](docker.md) with Docker Compose, plus a Caddy container for HTTPS.

The console lives on its own host (default `console.<your domain>`). Every App is served on its own subdomain,
`https://<app>.<apps domain>/` (default apps domain `apps.<your domain>`). This page covers the quick install, the
options, upgrades and uninstalling.

!!! warning

    Read the [security model](../security-model.md) before you expose an instance. Keep `RTWEB_INSECURE_COOKIES` unset
    outside local development, and serve the console over `https`.

## Requirements

| Requirement | Notes |
|---|---|
| Linux, x86_64 or aarch64 | systemd for bare mode; Docker Engine with the compose plugin for docker mode (the installer can install Docker, but only after you agree) |
| Root access | `sudo` for the install, `--dry-run` needs no root |
| `curl`, `tar`, `sha256sum` or `shasum` | Standard on most distributions |
| Node.js 22.5 or newer | Bare mode only: runs the install script that creates the App |
| [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) | Verifies the release (bare) or image (docker) signature. Required unless you pass `--insecure-skip-signature` |
| [Caddy](https://caddyserver.com/docs/install) | Bare mode only: serves the console and the Apps over TLS. Install it with its systemd unit first |
| DNS records | `A` or `AAAA` records pointing at the host for the console host (`console.example.com`), the apps domain (`apps.example.com`) and a wildcard under it (`*.apps.example.com`). The installer checks all three, the wildcard with a random name |
| Ports 80 and 443 open | Caddy needs both: 80 for the ACME challenge, 443 for HTTPS |

## Quick install

Run the installer in a terminal. It asks for the mode, your domain, the console host, the apps domain, how to get
certificates and the ACME e-mail, shows a plan and waits for your go-ahead. It also works under `curl | sh`, because
it reads the answers from the terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh | sudo sh
```

A shorter interactive run looks like this:

```text
Runtime Web installer (21 Cloud console)
How should Runtime Web run on this host?
  1) bare    rt as a systemd service, Caddy on the host (needs node >= 22.5)
  2) docker  the runtime-web container image with docker compose and a Caddy container
? Mode [1]: 2
? Your domain (for example example.com): example.com
? Console host [console.example.com]:
? Apps domain: every App at <app>.<apps domain> [apps.example.com]:
? Certificates [1]:
? Use one wildcard certificate (DNS-01, Cloudflare DNS only)? [y/N]
? E-mail for Let's Encrypt (expiry notices; a real mailbox): ops@example.com

==> Plan
  Mode           docker
  Console        https://console.example.com
  Apps           https://<app>.apps.example.com/
  Certificates   Let's Encrypt (automatic)
? Install now? [Y/n]
...
==> Runtime Web 0.2.0 is installed
  Console        https://console.example.com
  Apps           https://<app>.apps.example.com/
  Setup page     https://console.example.com/setup
  Setup token    (shown once)
```

To script it, pass the answers as flags and add `--yes`. Nothing is asked then, and anything missing is an error:

```bash
sudo sh install.sh --yes --mode docker --base-domain example.com --email you@your-company.com
```

Preview any run with `--dry-run`. It changes nothing on the host and needs no root.

At the end the installer waits until the console answers, then prints the console URL, the App URL pattern, the
one-time setup token, the next steps, where data and secrets live and how to uninstall. It never prints the root token.
Copy the setup token, then continue with [First run](first-run.md).

### Installer options

| Option | Default | Purpose |
|---|---|---|
| `--mode bare\|docker` | asked; `bare` without a terminal | How to install |
| `--base-domain DOMAIN` | | Sets the console host `console.DOMAIN` and the apps domain `apps.DOMAIN` |
| `--domain HOST` | `console.<base domain>` | Console host name |
| `--apps-domain HOST` | `apps.<base domain>`, else `apps.<domain>` | Every App is served at `<app>.<apps domain>`. The console host must not be under it |
| `--email ADDR` | required for Let's Encrypt and in bare mode | ACME account e-mail. Reserved domains such as `example.com` are refused |
| `--tls MODE` | `auto` | `auto` (Let's Encrypt), `staging` (Let's Encrypt staging, untrusted), `internal` (Caddy's own CA, untrusted), `none` (docker only: no Caddy, your own TLS proxy in front of `127.0.0.1:8080`) |
| `--wildcard-cert` | on with a token | One wildcard certificate for `*.<apps domain>` over DNS-01. Needs Cloudflare DNS, see [App certificates](#app-certificates) |
| `--per-app-certs` | off | One certificate per App, on demand, even with a token |
| `--dns-token-file PATH` | asked, hidden | File with the Cloudflare API token; turns on the wildcard certificate. Never pass the token itself on the command line |
| `--yes`, `-y` | off | Never ask: use the flags and the defaults |
| `--skip-dns-check` | off | Skip the DNS check. The check asks `api.ipify.org` for the host's public address |
| `--version X.Y.Z` | latest release | Runtime Web release to install (docker: the image tag) |
| `--public-url URL` | `https://<apps-domain>` | Bare only. Apps origin (`RTWEB_APPS_URL`); an origin without a path |
| `--default-plan NAME` | `unlimited` | Runtime plan for new org tenants (`RTWEB_DEFAULT_PLAN`), see [Plans](#plans) |
| `--runtime-version X.Y.Z` | the version pinned in `install.sh` | Runtime release to install when `rt` is missing. Any other version needs cosign |
| `--insecure-skip-signature` | off | Install on checksums alone, without the Sigstore check. Not recommended |
| `--tarball PATH` | off | Install from a local `runtime-web-X.Y.Z.tar.gz` (the release layout) instead of downloading one: a local build or an air-gapped host. It is not signature-checked, so it also needs `--sha256 HEX` (checked against the file) or `--insecure-skip-signature` |
| `--caddy-sha256 HEX` | off | Bare with `--wildcard-cert`: the expected sha256 of the Caddy build with the Cloudflare module |
| `--image REF` | `ghcr.io/21-ci/runtime-web:<version>` | Docker only. Another image; not signature-checked, so it needs `--insecure-skip-signature` |
| `--install-docker` | off | Docker only. Install Docker Engine with Docker's script when it is missing. Interactive runs ask instead |
| `--http-port N`, `--https-port N` | `80`, `443` | Docker only. Host ports of the Caddy container |
| `--docker-subnet CIDR` | `172.31.221.0/24` | Docker only. Subnet of the compose network, trusted for `X-Forwarded-For` |
| `--dry-run` | off | Print every step without changing the host |
| `--uninstall` | off | Remove Runtime Web from the host. See [Uninstall](#uninstall) |
| `--purge` | off | With `--uninstall --mode docker`: also delete the data volumes and the secrets |

### Why every App gets its own subdomain

Apps run untrusted code. If an App were served on the console origin, its pages could call the console API with a
signed-in admin's cookies. Runtime Web serves every App on its own origin, `https://<app>.<apps domain>/`: the
installer sets the node's `routing.base_domain` to the apps domain, and the runtime routes the host `<app>.<apps
domain>` to the App. Two Apps never share an origin either. The console host must not be under the apps domain, and
the edge (Caddy, or `rtweb-entry` in the container) answers `404` for the console's own slug under the apps domain and
for the bare apps domain.

For the strongest isolation, put the Apps on a separate registrable domain (for example `example-apps.com` next to
`console.example.com`, as val.town uses `val.run`), or add the apps domain to the
[Public Suffix List](https://publicsuffix.org/). With `apps.example.com` and `console.example.com`, App pages are
*same-site* with the console: browsers send `SameSite=Lax` cookies on their requests. The console does not rely on
that (its session cookie is `__Host-`, and it checks the CSRF token and `Origin`), but it logs a warning at start when
both hosts share a registrable domain.

The runtime still routes `/s/<app>/` paths when no host rule matches. Runtime Web does not use them for Apps, and the
edge answers `404` for `/s/` on every host under the apps domain, so an App can never be reached on another App's
origin. Two internal calls still use `/s/rtweb/` over loopback only: Caddy's `tls-ask` request in bare mode (Caddy
cannot set a `Host` header there) and the health checks of `install.mjs`.

### App certificates

Recommended: one wildcard certificate for `*.<apps domain>`. Give the installer a Cloudflare API token
(`--dns-token-file /root/cloudflare-token`, or answer yes when it asks) and it uses one by default. Let's Encrypt checks
wildcard names over DNS (DNS-01), so the apps domain's zone must be on Cloudflare, and the token needs `Zone:Read` and
`DNS:Edit` for it. Custom domains still get their certificates on demand.

Without a token, every App gets its own certificate on its first HTTPS request (Caddy on-demand TLS with the HTTP-01
challenge). Before Caddy asks Let's Encrypt, it asks the console's `tls-ask` endpoint, which says yes only for an
existing App (`<app>.<apps domain>`) or an active custom domain. Let's Encrypt issues at most 50 certificates per
registered domain a week, so the installer warns about this mode; use it for a handful of Apps, or pass
`--per-app-certs` to choose it even with a token. Caddy needs the
Cloudflare DNS module:

- Docker mode builds a local image `runtime-web-caddy:<caddy version>-cloudflare` with `xcaddy` from the pinned official
  builder image. Go checks every module against `go.sum` and the checksum database.
- Bare mode downloads Caddy with the module from Caddy's build server (pinned Caddy and module versions) to
  `/usr/local/bin/caddy-rtweb` and runs it from the distribution's `caddy.service` through a drop-in. The build is not
  byte-for-byte reproducible, so the installer prints its sha256 and keeps it in `/etc/rtweb/caddy-rtweb.sha256`; pin
  it on other hosts with `--caddy-sha256`.

The token is stored as `/etc/rtweb/dns-token` (bare, `0600`, loaded by Caddy as a systemd credential) or as the Docker
secret `dns_token` (docker, `0400`). It is never on a command line, in an environment variable or in the output.

### Plans

The node gets a plan named `unlimited` (in `deploy/rt.rtweb.toml`), and new orgs get it by default. It has no quotas
of its own: rate, daily invocations and concurrency are `0` (no limit), and the quotas the runtime counts down
(services, schedules, storage, egress, builds, queue depth) are set far above any real use. Per-task maxima are still
clamped by the node's own limits. The console itself runs on the separate `rtweb` plan. To limit tenants, add your own
`[plans.<name>]` to `/etc/rt/rt.toml` (bare) or `RTWEB_RT_CONFIG_EXTRA` (docker) and pass `--default-plan <name>`.

Set `RTWEB_SLUG` in the environment to give the console service a slug other than `rtweb`. The installer passes the
same value to `install.mjs` and to the Caddy site, which keeps `<slug>.<apps domain>` blocked and calls the
`tls-ask` endpoint under it. Choose it on the first install: changing it later creates a second service.

Set `GITHUB_TOKEN` in the environment to avoid GitHub API rate limits when the installer looks up the latest release.

### Tested platforms

The installer is tested end to end (install, a second run, `--dry-run`, `--uninstall`) in both modes on:

| Platform | Architecture | Runtime | Caddy | Node.js | Notes |
|---|---|---|---|---|---|
| Ubuntu 24.04 (systemd container) | aarch64 | rt 0.1.1 (pinned release asset) | 2.6.2 (Ubuntu package) | 22.20.0 | Fake `.test` domains: certificates came from Caddy's local CA, set by hand for the test |
| Debian 12 (systemd container) | x86_64 | rt 0.1.1 (pinned release asset) | 2.6.2 (Debian package) | 22.20.0 | Same fake `.test` setup. Fake `.test` hosts get no public certificate, so the test enabled `local_certs` by hand |
| Ubuntu 24.04 (systemd container, Docker 29 inside) | aarch64 | the image's rt | 2.10.2 (container), 2.10.2 + Cloudflare module (xcaddy) | n/a | Docker mode with `--tls internal`, and with `--tls staging --wildcard-cert` (a fake token: config, build and secret handling only) |

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
5. Installs the Caddy site: the console host with HSTS, `*.<apps domain>` for the Apps (no HSTS; on-demand
   certificates, or the wildcard certificate), on-demand TLS for custom domains (both gated by the console's `tls-ask`
   endpoint), and a loopback relay for tenant-scoped API calls. The site file starts with Caddy's global
   options, which Caddy accepts only before every site, so the installer puts
   `import /etc/caddy/Caddyfile.d/*.caddy` at the top of `/etc/caddy/Caddyfile` (backup:
   `/etc/caddy/Caddyfile.pre-rtweb`). It runs `caddy validate` and stops if the configuration is invalid.
6. Runs `server/scripts/install.mjs` with the node's root token. It creates the `runtime-web` tenant, publishes the
   `rtctl` SDK, creates the `rtweb` service with its secrets, uploads the console bundle and maps the console host.
7. Waits for the console and HTTPS, then prints the URLs, the setup token and the next steps.

A new node gets its master key as a systemd credential (`/etc/rt/credentials/rt-master-key`, loaded with
`LoadCredential`), not in its environment. Where systemd cannot mount credentials (some containers), the key is a
`root:rt 0640` file read through `RT_MASTER_KEY_FILE`. An existing key is never moved.

Docker mode instead writes `/opt/runtime-web/docker/compose.yaml`, a `Caddyfile` and `secrets/` (the root token, the
master key and the relay secret as Docker secrets, mode `0400`), starts the compose project `runtime-web` and reads the
setup token from `/data/rtweb/secrets/setup-token` in the container. See [Docker](docker.md).

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
    sudo sh install.sh --version X.Y.Z --domain console.example.com --email you@your-company.com
    ```

The installer keeps the existing secrets, including `RTWEB_SEAL_KEY`, and uploads a new service version only when the
bundle changed. The new version migrates the database the first time it opens it.

## Uninstall

```bash
sudo sh install.sh --uninstall                      # the mode is detected
sudo sh install.sh --uninstall --mode docker --purge  # docker: also delete the data volumes and secrets
```

Docker mode stops and removes the containers and the generated files. It keeps the volumes and the secrets unless you
pass `--purge`. Bare mode removes the Runtime Web files under `/opt/runtime-web`, the secrets in `/etc/rtweb`, the Caddy site and its
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
