# Runtime Web v1 — design (spec)

Status: accepted for implementation · 2026-10-22 (revised after plan review, same day)
Supersedes the open choices in [00-research-and-design.md](00-research-and-design.md). The runtime facts come from
[01-runtime-changelog.md](01-runtime-changelog.md). The build target is the runtime at commit `b52766e`
(snapshot in `../runtime-copy`), whose API is `../runtime-copy/openapi/openapi.json`.

## 1. Decisions (deltas from 00)

| # | Decision |
|---|---|
| D1 | The user-facing unit is an **App** (a runtime *service*). The UI never says "val". The API and code say `app` on the web side and `service` only inside `internal/runtime`. |
| D2 | **No self-registration and no personal orgs.** The first visitor to an empty instance creates the instance admin (`/setup`), which requires `RTWEB_SETUP_TOKEN` (or a one-time token logged at startup). After that, only an instance admin creates users (email + temporary password, or an invite link). Only an instance admin creates organizations. |
| D3 | **No plans or billing in the UI.** Every org is created on one configured runtime plan (`RUNTIME_DEFAULT_PLAN`, default `standard`; the runtime's built-in `free` plan lacks cron and caps services/schedules, so compose defines `[plans.standard]`). Plan pickers, upgrade prompts and usage billing are not shown. The quota bar (`/v1/limits`) stays read-only. |
| D4 | **Auth bridge = option B now, option D later.** Each org has a hidden **default key** (all tenant scopes except `keys:write`), stored sealed, and used only by the backend for that org's traffic. Go enforces org role, project grants and app checks. Instance-admin pages use the root token. Option D (runtime verifies JWTs issued by Runtime Web) is designed in §6 and is not built in v1. |
| D5 | **Tokens.** Default key: one per org, hidden, never shown, rotated by an admin action. **Custom tokens:** org admins create them for CI/CLI/MCP with chosen scopes and optional expiry. They are shown once and can be revoked. They are minted with the **root token** (`POST /v1/tenants/{t}/keys`), *not* from the default key, because runtime revocation cascades to child keys and rotating the default key must not kill custom tokens. |
| D6 | **Custom domains through a separate request router** (`cmd/rtrouter`), see §4. |
| D7 | **No email trigger.** Triggers are HTTP, schedules (interval/cron), queue, and service calls. |
| D8 | **Guest modules are `std:*`.** Templates and editor type stubs use `std:kv`, `std:sqlite`, `std:sql`, `std:queue`, `std:blob`, `std:services`, `std:platform`. `rt:*` is never emitted. |
| D9 | WebSockets/durable objects and the SDK-as-a-service are **not built against** (not merged). The UI leaves room for them: there is a Triggers tab, and an "SDKs" area is reserved. |
| D10 | Show `503 queue_timeout` and `503 overloaded` as **"busy"**, not as user-code errors. |

## 2. Roles

| Role | Scope | Can |
|---|---|---|
| Instance admin | instance | Operator pages (node status/config/scheduler/cache/drain), orgs CRUD, users CRUD + invites + 2FA reset, instance settings (OAuth providers, public URL, require 2FA, SSO-only login), instance audit log, all domains, impersonating an org (acts as org owner, audited) |
| Org owner | org | Everything in the org: projects, apps, members, invites, project grants, custom tokens, domains, rotating the default key, org audit log, own org usage |
| Org admin | org | Same as owner except deleting the org and changing owners (`members.owners`) |
| Org member | org | Only the projects granted to them, at the granted project role |
| Project admin | project | Apps CRUD, deploy, env, secrets, schedules, queue, hosts/domains (`domains.manage`), data export, grants on the project |
| Project developer | project | Apps CRUD, deploy, env, schedules, queue, logs. No secrets write, data export or grants |
| Project viewer | project | Read code, versions, logs and stats |

The permission check is one function: `authz.Can(principal, action, resource) bool`. Actions are a closed enum
(§3 of the plan). Org owners and admins implicitly hold the project admin role on every project. Project grants are keyed by
project **slug** (the runtime's `ServiceView.project` is the slug; it is immutable and unique per tenant).

## 3. Authentication

- Local password (argon2id) for every user. Admin-created users must change their temporary password on first
  login.
- OAuth/OIDC **login linking** (GitHub, Google, generic OIDC) is configured by the instance admin. It can only
  *link* to an existing user, matched by verified email, and **never creates a user** (D2).
- Sessions: an opaque 32-byte ID in a cookie `__Host-rtw_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`; dev
  mode only: `rtw_session` without `Secure`), with the
  row stored in SQLite as `sha256(id)`. Idle TTL is 7 days and absolute TTL 30 days. Mutations need the
  `X-CSRF-Token` header to equal the session's csrf value, and every unsafe method (login and setup included) must carry
  an `Origin` equal to `RTWEB_PUBLIC_URL`. Disabling a user, resetting or changing a password revokes their sessions.
- The console must be a different site (eTLD+1) from `RUNTIME_PUBLIC_URL` and `BASE_DOMAIN`; config loading rejects
  a same-site setup.
- OAuth linking requires a verified email (`email_verified` for OIDC/Google; GitHub's primary verified address from
  `/user/emails`).
- Login rate limit: 10 failures per 15 min per (ip, email). Error messages never reveal whether a user exists.
- **TOTP 2FA** (RFC 6238) with 10 single-use recovery codes. Login is two-step: password → short-lived MFA-pending
  session → code. Codes cannot be replayed. Instance settings: *require 2FA for all users* (forces enrollment after
  login) and *disable password login* (only when an OAuth/OIDC provider is configured; instance admins keep a
  break-glass password login). `rtweb admin reset-2fa --email` clears a user's 2FA from the host.
- Users see and revoke their sessions and see their login history (every attempt is recorded).
- **Invites** (D2): single-use links, 7-day expiry, optionally bound to an org + role, revocable.
- **Audit log**: org owners/admins read their org's log; instance admins read the instance-wide log.
- App writes are optimistic-concurrency checked: the app's `ETag` must be sent as `If-Match` on settings PATCH and
  file save (missing → 428, stale → 409).

## 4. Custom domains and the request router

`cmd/rtrouter` is a second small Go binary in the same repo. The operator points `*:443`/`*:80` at it.

```
client ──TLS──▶ rtrouter ──HTTP (Host preserved)──▶ runtime public :8080
                  │  certs: operator wildcard cert for *.BASE_DOMAIN; ACME on-demand only for verified custom domains
                  │  routes: GET {RTWEB_URL}/internal/router/routes (shared secret), cached, ETag polled every 5 s
                  └  console host → rtweb; {app}.{BASE_DOMAIN} and verified custom domains → runtime; else → 404 page
```

Domain lifecycle:
1. A project admin adds `shop.example.com` to an app. The web stores it as `pending` with a random token. Several
   orgs may hold a pending claim; the first to verify wins (unique index on active hosts only). The console host, the
   runtime public host and `BASE_DOMAIN` (apex and subdomains) are rejected.
2. The user creates a DNS TXT record `_rtweb.shop.example.com = <token>` and a CNAME/A record pointing to the router.
3. The web verifies the TXT record (on button press, and with a background check every 60 s for 24 h). Once it
   matches, the web calls `PUT /v1/services/{s}/hosts/{host}` with the **root token** (active at once, so no plan
   `custom_host_suffixes` are needed) and marks the domain `active`.
4. TLS (Dokploy parity, Let's Encrypt): custom domains get on-demand certs (HTTP-01 / TLS-ALPN-01); the router's
   `ask` hook allows only domains that are `active` in the web DB. `*.BASE_DOMAIN` uses a wildcard cert from operator
   cert files or, optionally, DNS-01 via Cloudflare (the only DNS provider in v1). `:80` redirects to HTTPS except ACME
   challenges. The router reports cert status (pending/issued/error, expiry) back to the web, shown in the domains
   tab. So no certificates
   are issued for arbitrary hosts.
5. Removing the domain calls `DELETE …/hosts/{host}` and drops it from the routes. The TXT record must stay: an active
   domain whose TXT is missing for 3 checks (6 h apart) is deactivated. The checker also reconciles with runtime
   `GET …/hosts`.

The runtime is configured with `routing.base_domain = BASE_DOMAIN` and `ingress.trusted_proxies` = the router; the
router uses `ReverseProxy.Rewrite` + `SetXForwarded` and drops client-sent `X-Forwarded-*`.

The router knows nothing about users. It holds no runtime credentials and only reads the routes endpoint. A
runtime `503 queue_timeout|overloaded` passes through unchanged.

## 5. Stack and layout

Go 1.26 (`net/http` routing, `modernc.org/sqlite`, `sqlc`, `goose`, `x/oauth2`,
`go-oidc`, `certmagic` only in rtrouter). The runtime client is hand-written (typed structs from the OpenAPI
schemas); codegen is not used because the spec is OpenAPI 3.1 with nullable unions and an untyped upload body.
Runtime service routes take `svc_` ids and service slugs are node-global, so the web resolves app slug → id with
`GET /v1/services?slug=`. Log streams are fanned out (one upstream per service per org) because the shared default
key is limited to `ingress.sse_streams_per_key` streams. Saving uploads with `compile=eager`, waits for `ready`,
then sets live with `If-Match`. React 19 + Vite + TS + Tailwind 4 + TanStack Router/Query +
CodeMirror 6 with in-browser TS and `std:*` `.d.ts` stubs. One `rtweb` binary embeds `web/dist`.

```
cmd/rtweb  cmd/rtrouter
internal/{config,store,auth,authz,runtime,keys,orgs,apps,domains,admin,api,audit,seal}
web/        (React app; ./temp is copied to docs/ui-reference as the visual reference, then deleted)
e2e/        (Playwright against docker compose: runtime-copy + rtweb + rtrouter)
```

`.env`: `RUNTIME_URL`, `RUNTIME_PUBLIC_URL`, `RUNTIME_ROOT_TOKEN`, `RUNTIME_DEFAULT_PLAN`, `RTWEB_SECRET_KEY`
(32-byte hex, seals default keys and OAuth secrets with AES-GCM), `RTWEB_PUBLIC_URL`, `RTWEB_DB`, `RTWEB_LISTEN`,
`RTWEB_DEV`, `RTWEB_SETUP_TOKEN`, `ROUTER_SHARED_SECRET`, `ROUTER_WILDCARD_CERT`/`ROUTER_WILDCARD_KEY`, `BASE_DOMAIN`,
`ACME_EMAIL`.

## 6. Later: option D

The web becomes an OIDC/OAuth 2.1 issuer that publishes JWKS at `/.well-known/jwks.json`. Its access tokens
(about 5 min) carry `tenant`, `scopes`, and `project_ids` and `environments` (matching the runtime's in-progress
key restrictions). The runtime's `rt-sec` gains a JWT verifier that is configured with the issuer URL. Then:
- the BFF sends the user's own JWT instead of the org default key, so the runtime enforces per-user scope;
- the CLI/MCP use device-code or PKCE flows against the web issuer.

v1 prepares for this: the `authz` role→scope map (`authz.ScopesFor(role)`) is the single source of truth for
both, and every runtime call goes through `runtime.Client` with a `Credential` interface (`RootCred`,
`TenantKeyCred`, later `JWTCred`).

## 7. Success criteria (v1 is done when…)

1. `docker compose up` (runtime-copy + rtweb + rtrouter) on a clean volume gets to the `/setup` page. The admin
   then creates an org and a user, the user logs in, creates an app from the HTTP template, saves, and gets a 200
   from `RUNTIME_PUBLIC_URL/s/{slug}/` within 15 s. This is automated in Playwright.
2. A member with a viewer grant on project A gets `403` from every mutation on A and `404` on project B's apps.
   This is covered by table tests over the full action × role matrix.
3. A custom token can be created, shown once and revoked. After revocation the runtime rejects it (`401`).
   Rotating the default key does not invalidate custom tokens.
4. A verified custom domain serves the app through rtrouter, and an unverified one gets no certificate and no
   route.
5. `rtweb` binary ≤ 30 MB, idle RSS ≤ 40 MB, web JS ≤ 250 KB gzip on the first route; the lazy editor chunk ≤ 900 KB
   gzip, excluding the lazy TS worker, which has its own budget of ≤ 1.5 MB gzip (loaded on the editor page only).
6. A user can enroll TOTP, then login requires a code; a used code is rejected; revoking a session logs it out; an
   expired or used invite link fails.
7. Security review (Opus) has no open high findings, and the UI/UX review findings are triaged with every "must"
   fixed.
8. `go test -race ./...`, `gofmt -l` + `go vet`, `npm test`, `npm run lint`, `npm run build` and Playwright all pass in
   `make ci`.
