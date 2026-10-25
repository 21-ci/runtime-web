---
title: Manual install
description: Deploy Runtime Web onto a 21 Cloud Runtime node you already run, without the host installer.
---

# Manual install

Use this path when the node already exists and you manage its configuration yourself, for example in a configuration
management tool or a cluster. It does the same steps as the [installer](install.md), by hand.

!!! warning

    Use `https` for `RTWEB_ORIGIN` and do not set `RTWEB_INSECURE_COOKIES` outside local development. The installer
    sets both for you. A manual install must set them.

## Before you start

- A running `rt` node with its control API on `127.0.0.1:8081` and its invoke listener on `127.0.0.1:8080`
- The node's root token (`RT_ROOT_TOKEN`)
- Node.js 22.5 or newer, npm, and GNU make on the machine that runs the install
- Caddy in front of the node, if the console is served over the internet

## Steps

1. **Merge the plan and bindings into the node.** Set `trusted_proxies` in the `[ingress]` table of `/etc/rt/rt.toml`
   (create the table if it does not exist, and never add a second one). Then append the `[plans.rtweb]` and `[[binding]]` tables from
   [`deploy/rt.rtweb.toml`](https://github.com/21-ci/runtime-web/blob/main/deploy/rt.rtweb.toml):

    ```toml
    [ingress]
    trusted_proxies = ["127.0.0.1/32", "::1/128"]
    ```

    Unknown keys stop the node at startup, so keep to the documented keys.

2. **Export the two binding secrets in the node's environment.** Add them to the rt environment file, for example
   `/etc/default/rt`:

    ```bash
    RTWEB_OP_TOKEN="Bearer <root token>"
    RTWEB_RELAY_SECRET=<64 random hex characters>
    ```

    Generate the relay secret with `openssl rand -hex 32`. Caddy must use the same value.

3. **Restart the node.** Bindings are read when the node starts. Plans reload on `SIGHUP`:

    ```bash
    sudo systemctl restart rt
    ```

4. **Serve the console through Caddy.** Copy [`deploy/Caddyfile`](https://github.com/21-ci/runtime-web/blob/main/deploy/Caddyfile)
   to a file that Caddy imports, and give Caddy its environment:

    ```bash
    sudo install -d -m 0755 /etc/caddy/Caddyfile.d
    sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile.d/rtweb.caddy
    ```

    Write `/etc/rtweb/caddy.env` with mode `0600` and these three lines. The relay secret is the same value as in
    step 2:

    ```bash
    RTWEB_DOMAIN=console.example.com
    RTWEB_ACME_EMAIL=ops@example.com
    RTWEB_RELAY_SECRET=<same value as step 2>
    ```

    Add `import /etc/caddy/Caddyfile.d/*.caddy` to `/etc/caddy/Caddyfile` if it is not there yet. Then load the
    environment file in a systemd drop-in for `caddy.service` (`EnvironmentFile=/etc/rtweb/caddy.env`), run
    `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, and reload Caddy.

5. **Set the install variables.** Copy `.env.example` to `.env` and replace the placeholders. Do not keep the
   `dev-insecure-*` values outside local development:

    ```bash
    RT_ROOT_TOKEN=<root token>
    RT_API=http://127.0.0.1:8081
    RT_INVOKE=http://127.0.0.1:8080
    RTWEB_ORIGIN=https://console.example.com
    RTWEB_HOST=console.example.com
    RTWEB_RUNTIME_PUBLIC_URL=https://console.example.com
    RTWEB_DEFAULT_PLAN=free
    ```

    `RTWEB_ORIGIN` has no safe default for a manual install. `install.mjs` falls back to `RT_INVOKE`, which is
    `http`, and the service refuses to start with it unless `RTWEB_INSECURE_COOKIES=1` is set.

6. **Run the install.** It builds the console into the server, then runs the idempotent install script:

    ```bash
    set -a; . ./.env; set +a
    make server-install
    ```

    The script creates the tenant, the SDK, the service, its secrets and env, uploads the bundle and maps the console
    host. It prints the setup token once, and any operator steps that still need doing, such as a plan that is not on
    the node. Apply those steps and run `make server-install` again.

7. **Check the install.** Open `https://console.example.com/healthz`, then follow [First run](first-run.md).

## Re-running the install

The script is safe to run again. It reuses existing secrets, never rotates `RTWEB_SEAL_KEY`, never reissues
`RTWEB_SETUP_TOKEN`, and uploads a new service version only when the bundle changed. To upgrade, check out the new
release, back up, and run `make server-install` again.

## Next steps

- [Configuration](../reference/configuration.md): every variable, its default and where it is set
- [Troubleshooting](../troubleshooting.md): what to do when a step fails
- [Operations](../admin/operations.md): backups, keys and upgrades
