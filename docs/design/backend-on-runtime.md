# Runtime Web backend on the 21 Cloud Runtime

Status: decided (2026-10-24). Supersedes the Go BFF (`cmd/rtweb`, `internal/*`) and `cmd/rtrouter`.
The HTTP contract `docs/api-web.md` is unchanged unless listed in §4; `web/` is not touched.
Runtime: v0.1.1, read-only. Facts below were checked in its docs/code and, where marked (live), on a local node.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Backend is **TypeScript** on the runtime's **Deno executor**, one service `rtweb` (Form B default export: `fetch` + `scheduled`). | Deno isolates are first class (std:* modules, npm: imports); WASM/Rust adds a toolchain for no capability gain. |
| D2 | Runtime Web owns one runtime **tenant** `runtime-web` (plan `rtweb`, operator-defined: storage ≥1 GB, cpu 2 s, wall 30 s). Each **org keeps its own runtime tenant** (as today). | Keeps per-org quotas, usage and key isolation. |
| D3 | All control-API access goes through an **operator SDK `rtctl`** (published with `POST /v1/sdks`, granted only to tenant `runtime-web`) that calls two **`[[binding]]`s**. | Guest `fetch` cannot reach loopback/private/node addresses (SSRF guard, `egress_denied`). Bindings are the only sanctioned path; credentials never enter guest memory. |
| D4 | Binding `rtctl-op` → `http://127.0.0.1:8081`, injects `authorization = env:RTWEB_OP_TOKEN` (root/operator token), `allowed_paths` = `/v1/tenants*`, `/v1/plans*`, `/v1/node/*`, `/v1/version`, `/v1/hosts*`. Binding `rtctl-tenant` → the **relay** (`http://127.0.0.1:8082`), injects `x-relay-auth = env:RTWEB_RELAY_SECRET`, `allowed_paths` = `/v1/services*`, `/v1/projects*`, `/v1/keys*`, `/v1/tenants/*/usage`. | A binding strips `authorization` and every `x-rt-*` header from the SDK request (checked: `rt-host/src/calls.rs` `forwarded_headers`), so per-org tenant keys and `x-rt-tenant` cannot pass through a binding directly. |
| D5 | The **relay** is the reverse proxy already required for TLS (Caddy). A loopback-only site on :8082 requires `x-relay-auth`, maps `x-rtweb-key: rtk_…` → `Authorization: Bearer rtk_…`, drops both headers, proxies to :8081. No custom code. | Smallest trusted component that lets the per-org hidden default key reach the control API. Caddy fragment ships in `deploy/Caddyfile`. |
| D6 | SPA (`web/dist`, 604 KB, 28 files, all < 1 MB) is **embedded in the deploy bundle**: the deploy script generates `server/src/gen/assets.ts` (path → `{type, b64, etag}`). Served by the same `rtweb` service with SPA fallback, immutable caching for `/assets/*`. | Bundle accepts only text sources (≤1 MB/file, ≤10 MB total); one atomic version for API + UI; no blob upload step. Fallback if dist grows past 7 MB: `std:blob` upload by the install script. |
| D7 | Storage: **`std:sql`** (per-service SQLite) for all relational state; **`std:kv`** for rate limits (`kv.incr` + TTL fixed windows), OAuth state/PKCE, SSE cursors. No durable objects. | Indexes, UNIQUE, PK work (live). One SQLite writer is enough for a console. |
| D8 | Passwords: **argon2id via `npm:hash-wasm@4.12.0`**, PHC string, same params as Go (m=64 MiB, t=3, p=2) so hashes stay compatible; verify accepts any PHC params. TOTP/recovery codes/CSRF/session ids via **WebCrypto** (HMAC-SHA1, SHA-256, getRandomValues). | Both ran inside a task under the 1 s CPU / 128 MB limits (live). |
| D9 | Secret sealing (`internal/seal`): AES-256-GCM via WebCrypto with key from service **secret** `RTWEB_SEAL_KEY` (32 B, base64). Same envelope `v1.<nonce>.<ct>` as Go. | Runtime secrets are themselves sealed at rest; we seal again so a DB export never carries plaintext keys/OAuth secrets. |
| D10 | `rtrouter` + its TLS are **deleted** (later). Custom domains = runtime **custom hosts** (`PUT /v1/services/{s}/hosts/{host}` by the operator binding → `active`; tenant flow keeps DNS TXT verification done by our backend). TLS = Caddy on-demand TLS with `ask` → `GET /api/internal/tls-ask?domain=` on `rtweb`. | The runtime routes by `Host` natively; it never terminates TLS. |
| D11 | Console host: operator maps `console.<domain>` as a custom host to `rtweb` (paths unchanged). On path routes (`/s/rtweb/…`) the app honours `x-rt-base-path` for the SPA `<base href>` and cookie `Path`. | Contract assumes origin root; path routing is only for local dev. |
| D12 | Sessions: opaque random id in `__Host-rtw_session` (HttpOnly, Secure, SameSite=Lax); server row stores SHA-256(id). CSRF: double-submit token bound to the session (`x-csrf-token`), plus `Origin` check against `RTWEB_ORIGIN` env. | Same semantics as Go (`internal/auth/csrf.go`, `origin.go`). Locally (`http`) the cookie name drops `__Host-` and `Secure` when `RTWEB_INSECURE_COOKIES=1`. |

## 2. Runtime facts that shape the design

- Handler gets `req.url = http://localhost/<path>`; `Host` is hidden; client IP in `ctx.client.ip`.
- Per-task limits (HTTP): wall 30 s, CPU 1 s, 128 MB, 50 outbound fetches, body 10 MB, response 100 MB streamed.
- Clock is frozen between I/O (`Date.now()` advances at I/O/timer boundaries): fine for expiry, useless for benchmarks.
- `std:sql`: `?` placeholders, 1 s/statement, 10k rows / 10 MB per result, 5 s interactive tx, no ATTACH/pragmas.
- `std:kv`: 2 KB keys, 1 MB values, `incr` atomic with TTL-on-create.
- Env + secrets via `Deno.env.get`, ≤100 each, 32 KB values, read-only, set by control API (`PUT …/env`, `PUT …/secrets/{n}`).
- Schedules: `interval`/`cron` triggers call `scheduled()`; on plan `free` capped at 30 s / 1 s CPU.
- Operator SDK call: JSON arg/result ≤ 256 KiB each; the SDK must read `ctx.caller` (else `422 sdk_unchecked_caller`).
- `[[binding]]` is read at node start: adding bindings needs a node restart (install step, §5).
- SSE out of a guest works (streamed `ReadableStream` body); but SDK results cannot stream.

## 3. Go package → runtime-native mapping

| Go | TS module (`server/src/…`) | Runtime mechanism |
|---|---|---|
| `config` | `config.ts` | `Deno.env` (env + secrets); validated once per task, fail closed |
| `seal` | `crypto/seal.ts` | WebCrypto AES-GCM, key = secret `RTWEB_SEAL_KEY` |
| `apperr` | `http/errors.ts` (done) | `AppError` → envelope §1.4 |
| `store` (+sqlc, migrations) | `storage/*`, `db/migrate.ts`, `db/schema.ts` | `std:sql`; migrations run lazily on first request per version (guarded by `schema_version` row + `BEGIN IMMEDIATE` via `sql.batch`) |
| `auth` password/argon2 | `auth/password.ts` | hash-wasm argon2id |
| `auth` sessions, CSRF, origin, mustchange, policy, login events/failures | `auth/session.ts`, `auth/csrf.ts`, `auth/middleware.ts`, `auth/login.ts` | SQL tables; lockout counters in `kv.incr` |
| `auth` TOTP + recovery | `auth/totp.ts` | WebCrypto HMAC-SHA1 (RFC 6238), SHA-256 hashed recovery codes |
| `auth` OAuth (GitHub/Google/OIDC, PKCE) | `auth/oauth.ts` | outbound `fetch` (public IdPs pass the SSRF guard); state+verifier in KV (10 min TTL) |
| `authz` | `authz/policy.ts` | pure functions over member/grant rows (port verbatim) |
| `orgs` | `orgs/*` | SQL + `rtctl.op` `POST /v1/tenants` on create, `DELETE` on delete |
| `users`, `invites` | `users/*`, `invites/*` | SQL; invite tokens SHA-256 at rest |
| `keys` (hidden default tenant key, revocable tokens) | `keys/*` | hidden default key: `rtctl.op POST /v1/tenants/{t}/keys` (operator route, no `x-rt-tenant` needed), secret stored sealed; rotate = create new, swap, `DELETE /v1/tenants/{t}/keys/{old}`; user tokens = `POST /v1/keys` through the relay with the org default key (`keys:write`) |
| `apps`, `runtime` client | `runtime/client.ts`, `apps/*` | `sdk("rtctl").tenant({key, method, path, query, body})` → relay → control API |
| `admin` (node status/config/drain) | `admin/*` | `sdk("rtctl").op({...})` |
| `domains` | `domains/*` | DNS TXT via DoH `fetch("https://cloudflare-dns.com/dns-query?…")`; on verify `rtctl.op PUT /v1/services/{s}/hosts/{h}` |
| `audit` | `audit/*` | SQL table, written in the same `sql.batch` as the change |
| logs SSE hub | `apps/logs.ts` | per request: poll `GET /v1/services/{s}/logs?since=<seq>` every 1 s through `rtctl`, emit `id:`/`event: log`; end stream at 25 s with `retry: 500`; client resumes with `Last-Event-ID`. No hub: each SSE request is its own task |
| `router`, `netx`, `cmd/rtrouter`, TLS | removed | runtime custom hosts + Caddy (D10) |
| `api` (SPA, routes) | `http/*`, `spa.ts`, `routes/*` | embedded assets (D6) |

## 4. Contract deltas (api-web.md)

| Endpoint | Status on runtime | Replacement |
|---|---|---|
| `GET /api/internal/router/routes`, `POST /api/internal/router/cert-status` | dropped (no rtrouter) | `GET /api/internal/tls-ask?domain=` (200 if an `active` domain, else 404), localhost-only by Caddy; `cert_status` in `Domain` becomes `"none"` unless Caddy reports (always `none` in v1) |
| `GET …/{app}/logs` (SSE) | works, but streams end every ≤25 s | EventSource auto-reconnect with `Last-Event-ID`; `web/` already uses EventSource, no change |
| `GET …/{app}/export` | works only ≤ 192 KiB per SDK hop | SDK method `exportChunk(offset)` re-reads the snapshot with `Range`; if the control API ignores `Range`, answer `413 export_too_large` with `details.cli: "21ci data export"` (R4) |
| `GET/PUT …/{app}/files` | bundles up to 10 MB vs 256 KiB SDK cap | chunk per file through the SDK (`filesList` then `fileGet`); PUT keeps 1 MB body cap per file, total sent in ≤200 KiB SDK chunks staged in KV then one `versionCreate` (R2) |
| `GET /healthz` | unchanged | also `GET /api/healthz` |
| everything else | 1:1 | — |

## 5. Bootstrap / install

`server/scripts/install.mjs` (T1) run once by the operator with `RT_ROOT_TOKEN`; idempotent; prints next steps:

1. Ensure plan `rtweb` exists in node config (prints the `[plans.rtweb]` and two `[[binding]]` fragments if missing; the
   operator pastes them into `rt.toml`, exports `RTWEB_OP_TOKEN` (an operator key) and `RTWEB_RELAY_SECRET`, restarts `rt`).
2. Writes `deploy/Caddyfile` snippet (relay :8082 + console host + on-demand TLS `ask`).
3. `POST /v1/tenants {name:"runtime-web", plan:"rtweb"}` (reuse if present).
4. `POST /v1/sdks {name:"rtctl", version, source}` from `server/sdk/rtctl/mod.ts`; `PUT /v1/sdk-grants {scope:"tenant:<id>", sdk:"rtctl"}` and a `deny` at `scope:"node"`.
5. Create service `rtweb` (triggers: http, cron `*/5 * * * *` for housekeeping; `call` off), set env `RTWEB_ORIGIN`,
   secrets `RTWEB_SEAL_KEY` (random 32 B) and `RTWEB_SETUP_TOKEN` (random, printed once).
6. Build SPA (`npm --prefix web run build`), generate `src/gen/assets.ts`, upload bundle, wait `ready`, activate.
7. Operator maps the console host: `PUT /v1/services/rtweb/hosts/console.example.com` (op → `active`).
8. Smoke: `GET /api/healthz` and `GET /api/setup` → `{needed:true}`.

`scripts/deploy.mjs` (exists) = steps 3, 5 (service only), 6 without assets; used in dev and CI.

First-run admin: unchanged contract. `GET /api/setup` → `needed` while `users` is empty. `POST /api/setup` requires
`setup_token` == secret `RTWEB_SETUP_TOKEN` (constant-time compare), creates the instance admin + its first org (and
that org's runtime tenant + hidden default key via `rtctl`), returns a session. After success the secret is irrelevant
(`409 already_set_up`); install prints a reminder to delete it.

## 6. Storage schema (`std:sql`, migration 0001)

Port of `internal/store/migrations` minus router tables. Times are unix ms INTEGER, ids are `xxx_<ulid>` TEXT.

```
users(id PK, email UNIQUE COLLATE NOCASE, name, pw_hash, must_change INT, instance_admin INT, disabled INT, created_at, updated_at, deleted_at)
identities(provider, subject, user_id → users, email, PRIMARY KEY(provider, subject))
user_totp(user_id PK, secret_sealed, enabled_at)       recovery_codes(user_id, code_hash, used_at, PRIMARY KEY(user_id, code_hash))
sessions(id_hash PK, user_id, csrf, mfa_pending INT, created_at, last_seen_at, expires_at, ip, ua)   INDEX(user_id), INDEX(expires_at)
login_events(id PK, user_id, ts, ip, ua, method, ok INT)   INDEX(user_id, ts)
orgs(id PK, slug UNIQUE, name, tenant_id UNIQUE, default_key_id, default_key_sealed, created_at, deleted_at)
members(org_id, user_id, role, created_at, PRIMARY KEY(org_id, user_id))   INDEX(user_id)
project_grants(org_id, user_id, project, role, PRIMARY KEY(org_id, user_id, project))
invites(id PK, token_hash UNIQUE, org_id NULL, email, role, instance_admin INT, created_by, created_at, expires_at, accepted_at)
tokens(id PK, org_id, runtime_key_id UNIQUE, name, scopes JSON, projects JSON, envs JSON, created_by, created_at, expires_at, revoked_at)
domains(id PK, org_id, app_slug, host UNIQUE COLLATE NOCASE, txt_token, status, created_at, verified_at)
audit(id PK, ts, org_id NULL, actor_id, action, target, data JSON)   INDEX(org_id, ts), INDEX(ts)
version_authors(org_id, app_slug, version, user_id, PRIMARY KEY(org_id, app_slug, version))
settings(key PK, value JSON)        schema_version(v INT)
pending_key_revokes(runtime_key_id PK, tenant_id, attempts, next_at)   -- retried by scheduled()
```

KV keys: `rl:login:<ip>:<window>`, `rl:email:<hash>`, `oauth:<state>` (TTL 600), `lockout:<user>`.

## 7. Module layout (`server/`)

```
server/
  package.json tsconfig.json vitest.config.ts eslint.config.mjs rt.json
  scripts/deploy.mjs            (done) dev deploy + healthz check
  scripts/install.mjs           T1  fresh-install bootstrap (§5)
  scripts/gen-assets.mjs        T1  web/dist → src/gen/assets.ts
  sdk/rtctl/mod.ts              T2  operator SDK: op(req), tenant(req), chunked helpers
  src/main.ts app.ts rt.d.ts    (done) entry, composition root, std:* types
  src/http/{router,json,errors}.ts   (done)
  src/http/cookies.ts, src/http/validate.ts       T3
  src/storage/{types,runtime}.ts     (done)   src/db/{migrate,schema}.ts   T3
  src/config.ts src/crypto/{seal,random,hash}.ts  T3
  src/auth/*  src/routes/{setup,auth,me,oauth}.ts T4
  src/authz/* src/orgs/* src/users/* src/invites/* src/routes/{orgs,admin_users,invites}.ts  T5
  src/runtime/client.ts src/keys/* src/routes/{tokens,projects,admin_node}.ts             T6
  src/apps/* src/routes/apps.ts (incl. logs SSE, files, env, secrets, schedules, queue)    T7
  src/domains/* src/audit/* src/routes/{domains,audit,settings,internal}.ts src/jobs.ts      T8
  src/spa.ts src/gen/assets.ts (generated, gitignored)                                       T1
  test/harness.ts (done)  test/fakes/rtctl.ts (T2)  test/**/*.test.ts  test/integration/*
```

Interfaces fixed now so tasks run in parallel:

- `Deps` (`src/app.ts`) grows to `{ storage, version, now, config, rtctl: RtCtl, random: (n) => Uint8Array }`.
- `RtCtl` (`src/runtime/types.ts`, written by T2 first, ~20 lines):
  `op(req: CtlReq): Promise<CtlRes>`, `tenant(key: string, req: CtlReq): Promise<CtlRes>`;
  `CtlReq = {method, path, query?, body?}`, `CtlRes = {status, headers: Record<string,string>, body: unknown}`.
  Real impl calls `sdk("rtctl")`; tests use `test/fakes/rtctl.ts` (in-memory tenants/services/keys/logs).
- Auth context: middleware sets `ctx.state.user`, `ctx.state.session`; `requireSession`, `requirePerm(perm, scope)`
  helpers exported from `src/auth/middleware.ts` (T4) and `src/authz/policy.ts` (T5). Until T4 merges, T5–T8 test with
  `test/fakes/auth.ts` that sets `ctx.state` from an `x-test-user` header (harness option, only in tests).
- Each route module exports `register(router, deps)`; T-owners add exactly one line in `app.ts` (merge conflicts trivial).

## 8. Test strategy

- **Unit (Vitest, Node 22+)**: whole app via `testApp()` (node:sqlite in-memory, Map KV, fake clock, fake `RtCtl`).
  Every contract row in api-web.md the task owns gets ≥1 success + ≥1 error test asserting status and `error.code`.
  Pure modules (argon2 PHC parse, TOTP vectors RFC 6238 App. B, seal round-trip, authz matrix) get table tests.
- **Integration** (`npm run test:int`, `RT_INVOKE` set, skipped otherwise): deploy with `scripts/deploy.mjs`, then
  black-box HTTP: healthz (done), setup → login → create org (tenant appears via root token) → create app → deploy file →
  invoke → logs SSE receives the line → delete org. Needs the bindings + relay; CI job `server-int` runs a node in Docker.
- **Contract guard**: `test/contract.test.ts` (T8) parses the endpoint tables in `docs/api-web.md` and fails for any
  method+path with no registered route (except §4 drops).
- `npm run ci` = typecheck + eslint + unit; root `make ci` gains `server-ci` (T1).

## 9. Parallel work breakdown

Each task owns its files exclusively (plus one `register` line in `src/app.ts`). Size: S ≈ Haiku 5.5, M ≈ Opus 5.5 low.

| Task | Size | Files (exclusive) | Contract endpoints | Acceptance tests |
|---|---|---|---|---|
| T1 Install, assets, SPA | M | `scripts/install.mjs`, `scripts/gen-assets.mjs`, `src/spa.ts`, `deploy/Caddyfile`, `deploy/rt.rtweb.toml`, root `Makefile` targets `server-*`, `.gitignore` (`server/src/gen/`) | `GET /` + SPA fallback, `/assets/*` | unit: `/orgs/x` → index.html, `/assets/a.js` → `immutable`, `/api/x` never falls back, `<base href>` honours `x-rt-base-path`; live: install on fresh node twice (idempotent) |
| T2 rtctl SDK + client | M | `sdk/rtctl/**`, `src/runtime/{types,client}.ts`, `test/fakes/rtctl.ts` | none directly | SDK refuses callers other than tenant `runtime-web` service `rtweb`; path allow-list; chunking >200 KiB; fake mirrors runtime error shapes (`x-rt-reason`) |
| T3 Foundation | S | `src/config.ts`, `src/crypto/*`, `src/db/*`, `src/http/{cookies,validate}.ts` | none | migrations idempotent on both adapters; seal compatible with Go envelope (fixture from `internal/seal` tests); cookie flags; validators produce `422 invalid {fields}` |
| T4 Auth | M | `src/auth/**`, `src/routes/{setup,auth,me,oauth}.ts` | `/api/setup`, `/api/auth/*` (login, mfa, logout, providers, oauth start/callback), `/api/me*` (password, sessions, totp, recovery-codes, logins) | setup token wrong → 403; login lockout via KV; MFA-pending cannot call `/api/me/sessions`; CSRF missing → 403 `csrf_invalid`; Origin mismatch → 403; argon2 verifies a Go-generated hash fixture; TOTP RFC vectors |
| T5 Orgs, users, invites, authz | M | `src/authz/**`, `src/orgs/**`, `src/users/**`, `src/invites/**`, `src/routes/{orgs,admin_users,invites}.ts` | `/api/orgs`, `/api/orgs/{org}` (+members, grants, projects metadata via T6 client), `/api/admin/users*`, `/api/admin/orgs*`, invites (org, admin, accept) | authz matrix table test (role × perm); `409 last_admin`, `409 last_owner`, `409 org_not_empty`; org create calls `rtctl.op POST /v1/tenants` (fake asserts) |
| T6 Keys, projects, node admin | S | `src/keys/**`, `src/routes/{tokens,projects,admin_node,limits_usage}.ts` | `/api/orgs/{org}/tokens*`, `default-key/rotate`, `limits`, `usage`, `projects*`, `/api/admin/node/*`, `/api/admin/orgs/{org}/usage` | default key never listed; rotate keeps custom tokens; failed revoke lands in `pending_key_revokes`; drain needs `{confirm:"drain"}` |
| T7 Apps | M | `src/apps/**`, `src/routes/apps.ts` | all `/api/orgs/{org}/apps…` rows (CRUD+ETag, files, versions, live, build-logs, rebuild, env, secrets, schedules, queue, dlq, stats, events, logs SSE, export) | `If-Match` stale → 409; files chunking round-trip 3 MB; SSE emits `id:` lines and ends with `retry:` before 25 s (fake clock); export over cap → 413 `export_too_large` |
| T8 Domains, audit, settings, jobs, contract guard | S | `src/domains/**`, `src/audit/**`, `src/routes/{domains,audit,settings,internal}.ts`, `src/jobs.ts`, `test/contract.test.ts` | app domains (add/verify/delete), `/api/admin/domains`, `/api/{orgs/{org},admin}/audit`, `/api/admin/settings`, `/api/internal/tls-ask` | TXT mismatch keeps `pending`; verify maps host via `rtctl.op PUT …/hosts/{h}`; `scheduled()` expires sessions/invites and retries key revokes; contract guard green |

Order: T2 and T3 publish their interface files in the first hour (types only) so T4–T8 code against them; all eight
then run in parallel. Merge order: T3, T2, T4, T5, T6, T7, T8, T1. After all merge: delete `cmd/`, `internal/`, `go.*`.

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Operator SDK + bindings + Caddy relay = three install-time pieces; a node restart is required for bindings. | `install.mjs` checks each (`GET /v1/node/config` shows bindings redacted) and prints exact fixes; integration CI covers it. |
| R2 | 256 KiB SDK arg/result cap breaks large passthroughs (files, export, big lists). | Chunked SDK methods; paging everywhere; export fallback (§4). |
| R3 | Tenant-scoped calls depend on the relay mapping `x-rtweb-key` → `Authorization`. | Keys for other tenants use operator routes `/v1/tenants/{t}/keys` (exist in v0.1.1); the relay is only for per-org service calls; T2 live-tests it. |
| R4 | argon2id m=64 MiB, t=3 uses half the 128 MB task memory; CPU close to 1 s on slow boxes. | Plan `rtweb` raises cpu to 2 s; params configurable; verify keeps working for old hashes. |
| R5 | SSE reconnect every 25 s; 50 fetch/task cap limits polling to ~45 SDK calls. | 1 s poll, stop at 40 calls/25 s; `Last-Event-ID` resume. |
| R6 | One SQLite writer; 1 s statement budget. | Indexed queries, keyset pagination, audit pruning job. |
| R7 | The root/op token lives in node env (binding), not the app; compromise of `rtweb` still gives op-level control within allowed paths. | Tight `allowed_paths`/methods, SDK caller check, audit every op call. |
