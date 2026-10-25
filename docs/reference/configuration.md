# Configuration

Runtime Web is a service (`rtweb`) on a 21 Cloud Runtime node, so there is no process of its own to configure. Settings
live in three places:

- **Service env and secrets** of `rtweb`, set by `server/scripts/install.mjs` and validated fail-closed by
  `server/src/config.ts` (a bad value stops every request with an error naming the variable).
- **The node**: the `rtweb` plan and two bindings from `deploy/rt.rtweb.toml`, plus two secrets in the node's
  environment.
- **Caddy**: the console host, the ACME e-mail and the relay secret, read by `deploy/Caddyfile`.

`install.sh` fills all three. For a manual or development install, start from `.env.example`; every `dev-insecure-*`
value there is a placeholder for local use only.

## Service env (`rtweb`)

| Variable | Default | Meaning |
|---|---|---|
| `RTWEB_ORIGIN` | `RT_INVOKE` in `install.mjs`; `https://<domain>` from `install.sh` | Browser origin of the console. Origin checks on unsafe methods compare against it. `https` unless `RTWEB_INSECURE_COOKIES=1`. |
| `RTWEB_RUNTIME_PUBLIC_URL` | `RT_INVOKE`; `https://<apps-domain>` from `install.sh` (`--apps-domain`, `--public-url`) | Public base of app URLs, `<this>/s/{slug}/`. Empty keeps app URLs relative. Must not have the same origin as `RTWEB_ORIGIN` (startup fails): Apps need their own origin. |
| `RTWEB_DEFAULT_PLAN` | `free` (`--default-plan`) | Runtime plan for new org tenants. It must exist on the node: an org create with an unknown plan fails with `500 default_plan_missing`. |
| `RTWEB_VERSION` | `dev` | Build label reported by `/healthz`. `install.sh` sets the release version. |
| `RTWEB_BUNDLE` | set by install | Digest of the deployed bundle; lets a re-run skip an unchanged upload. |
| `RTWEB_INSECURE_COOKIES` | unset | Local development only: `1` drops `__Host-` and `Secure` from cookies and allows an `http` origin. |

## Service secrets (`rtweb`)

| Secret | Meaning |
|---|---|
| `RTWEB_SEAL_KEY` | 32 random bytes, base64. AES-256-GCM key for secrets at rest (OAuth client secrets, TOTP seeds, default org keys). Generated once, never rotated by install. Losing it makes sealed data unreadable. |
| `RTWEB_SETUP_TOKEN` | First-run setup token, printed once by install. Delete the secret after setup; without it, setup answers `403`. |
| `RTWEB_ASSET_TOKEN` | Set by each install run to authorise the upload of console files too large for the bundle. The same run deletes it after the upload is checked. |

## Install script (`server/scripts/install.mjs`)

| Variable | Default | Meaning |
|---|---|---|
| `RT_ROOT_TOKEN` | required | Root (operator) token of the node. Read from the environment only, never printed. |
| `RT_API`, `RT_INVOKE` | `http://127.0.0.1:8081`, `http://127.0.0.1:8080` | Control API and invoke listener of the node. |
| `RTWEB_TENANT`, `RTWEB_SLUG` | `runtime-web`, `rtweb` | Tenant and service the console is installed as. |
| `RTWEB_PLAN` | `rtweb` | Plan of the console's own tenant. Falls back to `free` with a warning when the node lacks it. |
| `RTWEB_HOST` | empty | Console host to map on the runtime (custom host). `install.sh` passes `--domain`. |
| `RTCTL_SDK_VERSION` | `0.1.0` | Version of the `rtctl` operator SDK that install publishes. |

## Node (`rt.toml` and its environment)

`deploy/rt.rtweb.toml` adds `[plans.rtweb]` and the bindings `rtctl-op` (operator routes, injects
`RTWEB_OP_TOKEN`) and `rtctl-tenant` (tenant routes through the Caddy relay, injects `RTWEB_RELAY_SECRET`). Both
values must be exported in the node's environment; `install.sh` generates them into `/etc/rtweb/rtweb.env` (0600)
and adds them to the rt environment file.

## Caddy (`deploy/Caddyfile`)

| Variable | Meaning |
|---|---|
| `RTWEB_DOMAIN` | Console host, e.g. `console.example.com`. |
| `RTWEB_ACME_EMAIL` | ACME account e-mail for certificates. |
| `RTWEB_RELAY_SECRET` | Same value as the node's; the loopback relay on `127.0.0.1:8082` only accepts calls that carry it. |

`install.sh` writes them to `/etc/rtweb/caddy.env` (0600), loaded by a systemd drop-in for `caddy.service`.

## Before production

- Never set `RTWEB_INSECURE_COOKIES` outside local development, and use an `https` `RTWEB_ORIGIN`.
- Keep the node's control API (8081), invoke listener (8080) and metrics (9090) on loopback; only Caddy (80, 443)
  is public.
- Delete `RTWEB_SETUP_TOKEN` after first-run setup.
- Back up `RTWEB_SEAL_KEY`, the rt environment file and `/etc/rtweb/` together with the node's data, and store the
  keys apart from the data backups.

See the [security model](../security-model.md) for why each of these matters.
