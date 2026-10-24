# Configuration

Runtime Web reads its settings from environment variables. Compose reads them from `.env` in the repository root, and
the console and router also receive them through `env_file`. Start from `.env.example`.

Every value marked `dev-insecure-*` is a placeholder for local development. The console refuses it unless
`RTWEB_DEV=1`.

## Runtime node

| Variable | Default | Meaning |
|---|---|---|
| `RUNTIME_URL` | `http://runtime:8081` | Control API of the runtime as seen from the console. Port 8081 is the control listener. |
| `RUNTIME_PUBLIC_URL` | `http://localhost:8082` | Public base of the runtime as seen from browsers. App URLs are `RUNTIME_PUBLIC_URL/s/{slug}/`. |
| `RUNTIME_ROOT_TOKEN` | placeholder | The runtime's root token. The console uses it for the control API. Keep it secret. |
| `RUNTIME_MASTER_KEY` | placeholder | 64 hex characters. The runtime uses it to encrypt its own secrets at rest. |
| `RUNTIME_DEFAULT_PLAN` | `standard` | Plan assigned to new tenants. Plans are defined in the runtime's config. |

## Console

| Variable | Default | Meaning |
|---|---|---|
| `RTWEB_PUBLIC_URL` | `http://console.localhost:8080` | Public URL of the console. Origin checks compare against it. Must be a different site from `RUNTIME_PUBLIC_URL` and `BASE_DOMAIN`. |
| `RTWEB_LISTEN` | `:8090` | Listen address inside the container. |
| `RTWEB_DB` | `./data/rtweb.db` | SQLite database path. Keep it on persistent storage. |
| `RTWEB_SECRET_KEY` | placeholder | 64 hex characters. Seals secrets at rest. Losing it makes sealed data unreadable. |
| `RTWEB_SETUP_TOKEN` | generated | Token for the first-run setup page. If unset, the console generates one and logs it at `WARN` on start. |
| `RTWEB_TRUSTED_PROXIES` | empty | Comma-separated CIDRs of reverse proxies whose `X-Forwarded-For` is trusted. Empty trusts no proxy. |
| `RTWEB_DEV` | `0` | `1` enables development mode: accepts `dev-insecure-*` secrets and the local console host. Never set it in production. |
| `RTWEB_DEV_DNS_OVERRIDE` | empty | Development only. Fake TXT answers for domain verification, as `name=value;name=value`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

## Router and domains

| Variable | Default | Meaning |
|---|---|---|
| `ROUTER_SHARED_SECRET` | placeholder | Bearer secret that `rtrouter` uses to read the route table from the console. |
| `ROUTER_HTTP_PORT` | `8080` | Host port on `127.0.0.1` for the router. |
| `ROUTER_TLS` | `off` | `off` serves plain HTTP (development). `on` serves HTTPS on port 443 with ACME. |
| `BASE_DOMAIN` | `apps.localhost` | Base domain for app hosts, `{slug}.BASE_DOMAIN`. Must not be the console's or the runtime's site. |
| `ACME_EMAIL` | empty | Contact address for the certificate authority. Required when `ROUTER_TLS=on`. |
| `ROUTER_ACME_CA` | empty | ACME directory. Empty means Let's Encrypt production. |
| `ROUTER_WILDCARD_CERT`, `ROUTER_WILDCARD_KEY` | empty | Optional wildcard certificate for `BASE_DOMAIN`, as PEM paths in the router container. |
| `ROUTER_DNS_PROVIDER`, `CLOUDFLARE_API_TOKEN` | empty | Optional DNS provider for wildcard certificate validation. |

## Before production

- Replace every `dev-insecure-*` value with a random secret (`openssl rand -hex 32`).
- Leave `RTWEB_DEV` unset or set it to `0`.
- Set `ROUTER_TLS=on` and use HTTPS URLs for `RTWEB_PUBLIC_URL` and `RUNTIME_PUBLIC_URL`.
- Make sure `RTWEB_PUBLIC_URL`, `RUNTIME_PUBLIC_URL` and `BASE_DOMAIN` are three different sites.
- Set `RTWEB_TRUSTED_PROXIES` only to proxies you control.
- Back up the database and the two keys (`RTWEB_SECRET_KEY`, `RUNTIME_MASTER_KEY`) together, and store them apart from
  the backups.

See the [security model](security-model.md) for why each of these matters.
