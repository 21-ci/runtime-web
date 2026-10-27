---
title: Troubleshooting
description: Check health, read the node and Caddy logs, and fix the common install and runtime problems of a Runtime Web instance.
---

# Troubleshooting

Start with the health checks and the logs, then find the symptom below. Commands run on the host unless they say
otherwise. Never paste a root token, a secret or a setup token into an issue or a chat.

## Health checks

| Check | Command | Healthy |
|---|---|---|
| Console through Caddy | `curl -fsS https://console.example.com/healthz` | `{"ok":true,"db":true,"version":"..."}` |
| Console on the node | `curl -fsS -H 'Host: console.example.com' http://127.0.0.1:8080/api/healthz` | the same JSON, without TLS |
| An App through Caddy | `curl -sSI https://<app>.apps.example.com/` | an HTTP status from the App (wildcard DNS and the App's certificate work) |
| Docker mode | `docker compose -p runtime-web ps` | `rtweb` is `healthy`, `caddy` is `running` |
| Node ready | `curl -fsS http://127.0.0.1:9090/readyz` | HTTP `200` |
| Caddy configuration | `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` | `Valid configuration` |

If the console check through Caddy fails but the node check passes, the problem is in Caddy, DNS or the firewall. If
both fail, read the node log.

## Logs

| What | Command |
|---|---|
| Node (`rt`) | `journalctl -u rt -n 200 --no-pager`, or `journalctl -u rt -f` to follow |
| Docker mode | `docker compose -p runtime-web logs -f rtweb caddy` |
| Caddy | `journalctl -u caddy -n 200 --no-pager`, or `journalctl -u caddy -f` |
| Services and units | `systemctl status rt caddy` |
| An app's own output | the **Logs** page of the app in the console, which streams live |

Installer steps print to the terminal. Run the installer again with `--dry-run` to see what it would change.

## Setup and first run

### The setup page rejects the token

The setup page answers `403 setup_token_invalid` when the token is wrong, is missing, or was issued by an earlier run.
Copy the token from the most recent installer output, or issue a new one. See
[First run: Lost setup token](getting-started/first-run.md#lost-setup-token).

### The installer says the setup token was issued by an earlier run

The installer never prints an existing token again. It keeps the token while the secret `RTWEB_SETUP_TOKEN` exists.
Delete the secret, then run the installer again. The steps are in
[First run](getting-started/first-run.md#lost-setup-token).

### Installer output lists operator steps

`server/scripts/install.mjs` prints the steps it cannot do for you under **Operator steps remaining**. Typical items:

- **The plan or the bindings are missing from `rt.toml`.** Run `sudo sh install.sh ...` again. It rewrites the
  managed block, sets the two binding secrets and restarts `rt`. A manual install follows the
  [manual install steps](getting-started/manual-install.md#steps).
- **The tenant is on another plan.** Change it with the root token:

    ```bash
    curl -fsS -X PATCH "$RT_API/v1/tenants/$TENANT_ID" -H "Authorization: Bearer $RT_ROOT_TOKEN" \
      -H 'Content-Type: application/json' -d '{"plan":"rtweb"}'
    ```

- **The plan lacks `cron`.** The `housekeeping` schedule is not created. Add `cron` to `allowed_triggers` in the
  `rtweb` plan, reload `rt`, and run the installer again.

### Console calls fail with `binding_denied`

The runtime refuses a call from the console when the binding does not exist, its secret is missing, or the node was not
restarted after the binding was added. The response carries the header `x-rt-reason: binding_denied`. Check the node:

```bash
sudo grep -n 'runtime-web' /etc/rt/rt.toml
sudo grep -E '^RTWEB_(OP_TOKEN|RELAY_SECRET)=' /etc/default/rt | sed 's/=.*/=<set>/'
```

The first command should print the managed block markers. The second should show both keys as `<set>`. Its output
does not print the values. Then run the installer again, or restart `rt` with `sudo systemctl restart rt`.

If the relay on `127.0.0.1:8082` answers `403 forbidden`, the relay secret in `/etc/rtweb/caddy.env` differs from
`RTWEB_RELAY_SECRET` in `/etc/default/rt`. Set both to the same value, then restart `rt` and reload Caddy.

### Pages fail with `429 rate_limited`

The console's own tenant uses the `rtweb` plan. That plan allows 300 requests a second, 64 in flight and no daily cap,
because one page load makes about 30 calls. A lower plan throttles normal use. Check that `[plans.rtweb]` in
`/etc/rt/rt.toml` matches [`deploy/rt.rtweb.toml`](https://github.com/21-ci/runtime-web/blob/main/deploy/rt.rtweb.toml),
then reload the node with `sudo systemctl reload rt`.

A `429` on sign-in is different. It means too many attempts for that account. The response carries a `Retry-After`
header. Wait for that time, or ask an instance admin to check the account.

### An org cannot be created: `default_plan_missing`

`RTWEB_DEFAULT_PLAN` names a runtime plan that the node does not define. Either add the plan to `rt.toml` and reload
the node, or run the installer with `--default-plan` naming a plan that exists. See
[Configuration](reference/configuration.md#service-env-rtweb).

## Sign-in and cookies

### Signing in does not stick, or saves fail with a forbidden response

The browser must open the console at the origin in `RTWEB_ORIGIN`, over `https`. Session cookies use the `__Host-`
prefix and `Secure`, and browsers drop them over plain `http`. Unsafe requests such as sign-in and saves are also
refused when their `Origin` header does not match `RTWEB_ORIGIN`.

- In production, serve the console over `https` and set `RTWEB_ORIGIN` to that exact origin.
- For a local test over `http`, set `RTWEB_INSECURE_COOKIES=1` in the service environment. Use this only for local
  development.

## Apps and domains

### App preview shows an "open in a new tab" message

The console embeds an app's preview in a frame. Its Content-Security-Policy allows framing only the runtime's public
origin, set by `RTWEB_APPS_URL`, and only when that origin differs from the console's origin. The console
does not frame its own origin on purpose: a framed app on the same origin would run with the console's rights.

The browser console shows a message such as `Refused to frame ... because it violates ... frame-src 'none'`. The
causes are:

- `RTWEB_APPS_URL` is empty, so the policy is `frame-src 'none'`.
- The App's subdomain is not served: check the wildcard record `*.apps.example.com` and that Caddy got a
  certificate for the App (`curl -I https://<app>.apps.example.com/`).

The server refuses to start when `RTWEB_APPS_URL` has the same origin as `RTWEB_ORIGIN`, so a same-origin
setup shows up as a startup `ConfigError`, not as a blocked preview.

### An App's URL answers 404, or its certificate is not issued

Every App is served at `https://<app>.<apps domain>/`. Check, in this order:

1. DNS: `dig +short A rtw-check-123.apps.example.com` must return the host's address (the wildcard record
   `*.apps.example.com`).
2. Routing on the node: `curl -sI -H 'Host: <app>.apps.example.com' http://127.0.0.1:8080/` reaches the App. A `404`
   from the runtime means `routing.base_domain` in `/etc/rt/rt.toml` (bare) or `/data/rtweb/rt.toml` (docker) is not the
   apps domain: run the installer again.
3. The certificate: Caddy asks the console first, and the console says yes only for an existing App:
   `curl -i 'http://127.0.0.1:8080/s/rtweb/api/internal/tls-ask?domain=<app>.apps.example.com'` (bare, on the host)
   must answer `200`. Then read `journalctl -u caddy` for ACME errors. Let's Encrypt limits new certificates per
   registered domain per week; with many Apps use `--wildcard-cert`.
4. `/s/<app>/` paths answer `404` on the apps domain on purpose: Apps are served only on their own subdomain.

With `--wildcard-cert`, a Cloudflare error in the Caddy log usually means the token lacks `DNS:Edit` for the zone.
Replace `/etc/rtweb/dns-token` (bare) or `/opt/runtime-web/docker/secrets/dns_token` (docker) and run the installer
again with `--dns-token-file`.

### Domain stays pending

The domain routes only after its TXT record matches. Check the record that the console shows:

```bash
dig +short TXT _rtweb.api.example.com
```

The answer must contain the token from the console. DNS caches can delay the result by minutes. Verification repeats
on its own. If the record disappears later, the domain is unmapped.

### TLS certificate is not issued for a custom domain

Caddy asks the console whether a host may get a certificate, and the console answers yes only for an active domain.
Check the answer on the host:

```bash
curl -i 'http://127.0.0.1:8080/s/rtweb/api/internal/tls-ask?domain=api.example.com'
```

`200` means the domain is active. Then check that ports 80 and 443 reach the host from the internet, and read the
Caddy log for ACME errors with `journalctl -u caddy -n 200 --no-pager`. `404` means the domain is not active. Fix its
DNS record first, as above. The endpoint answers only on loopback, so run the command on the host.

## Installer failures

| Message | Fix |
|---|---|
| `this installer needs 'curl' on PATH` (also `tar`, `awk`) | Install the tool with your package manager |
| `this installer needs sha256sum or shasum to verify downloads` | Install coreutils |
| `node ... is too old: need >= 22.5` | Install Node.js 22.5 or newer |
| `cosign is required to verify the release signature` | Install [cosign](https://docs.sigstore.dev/cosign/system_config/installation/), or pass `--insecure-skip-signature` to install on checksums alone. The latter is not recommended |
| `caddy validate failed` | The installer prints Caddy's error. Fix it, check with `caddy validate --config /etc/caddy/Caddyfile` (with the variables from `/etc/rtweb/caddy.env` exported), and run the installer again. Caddy is not restarted in this case |
| `server block without any key is global configuration, and if used, it must be first` | The Caddyfile.d import sits after a site block. The installer moves it to the top of `/etc/caddy/Caddyfile`; if you edited the file, put `import /etc/caddy/Caddyfile.d/*.caddy` back on the first line |
| `/etc/caddy/Caddyfile has its own global options block` | Caddy takes one global options block. Merge yours into the block at the top of `/etc/caddy/Caddyfile.d/rtweb.caddy` (or the reverse), put the import first, and run the installer again |
| `--tarball is not signature-checked` | Pass `--sha256 HEX` with the tarball's digest, or `--insecure-skip-signature` |
| `rt did not become ready` | Read `journalctl -u rt -n 200 --no-pager`. A typo in `/etc/rt/rt.toml` stops the node at start |
| `caddy not found` | Install Caddy, then run the installer again |
| `... has no A/AAAA record yet` or `... points at ... but this host is ...` | Add the records for the console host, the apps domain and `*.<apps domain>`. Without a terminal the installer continues; certificates follow once DNS is right |
| `port 80 is in use` | Another web server holds the port. Stop it, or in docker mode pick other ports with `--http-port` / `--https-port` (Let's Encrypt still needs 80 and 443 from the internet) |
| `docker mode needs Docker Engine with the compose plugin` | Install Docker, or re-run with `--install-docker` (or answer yes when asked) |
| `cosign could not verify ghcr.io/21-ci/runtime-web...` | The image is not the one the release workflow signed. Do not run it; check `--version` |
| `rtweb did not become healthy` | `docker compose -p runtime-web logs rtweb`. A volume made by an earlier container keeps its own secrets in `/data/rtweb/secrets` |
| `no answer (the terminal closed)` | The installer ran without a usable terminal. Pass the answers as flags with `--yes` |

### Test an install without public DNS

With made-up names such as `console.test`, Caddy cannot get public certificates. Install with `--tls internal`
(Caddy's own CA) and `--skip-dns-check`, then call it with `--resolve`:

```bash
curl -k --resolve console.test:443:127.0.0.1 https://console.test/api/setup        # {"needed":true}
curl -k --resolve apps.test:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://apps.test/   # 404
```

Run the installer again with `--tls auto` once real DNS is in place.

## Run the console and the tests locally

Use a local checkout to change the console or the server:

1. Start the console with Vite. It serves the UI on `http://localhost:5173`:

    ```bash
    cd web && npm ci && npm run dev
    ```

    Without a backend, the page loads but its API calls fail. To use a running backend, start Vite with
    `RTWEB_DEV_PROXY` set to the backend's origin. Vite forwards `/api` and rewrites the `Origin` header, so the
    server's same-origin check passes:

    ```bash
    RTWEB_DEV_PROXY=http://console.localhost:18443 npm run dev
    ```

    The backend must run with `RTWEB_INSECURE_COOKIES=1`, because the proxied origin is `http`. The proxy setting is in
    [`web/vite.config.ts`](https://github.com/21-ci/runtime-web/blob/main/web/vite.config.ts).

2. Run the tests for the area you change. The console's tests use MSW, and the server's use an in-memory harness, so
   neither needs a node:

    ```bash
    cd server && npx vitest run test/orgs
    cd web && npx vitest run src/components/features/apps
    ```

3. Run the full chain before you push: `make ci`. For a live check against a local node, see
   [Dev setup](contributing/dev-setup.md).

## Still stuck

Search [GitHub issues](https://github.com/21-ci/runtime-web/issues) and [Discussions](https://github.com/21-ci/runtime-web/discussions).
When you open an issue, include the output of the health checks, the Runtime Web version (`/healthz` reports it), and
the relevant log lines with secrets removed. See [SUPPORT.md](https://github.com/21-ci/runtime-web/blob/main/SUPPORT.md).
