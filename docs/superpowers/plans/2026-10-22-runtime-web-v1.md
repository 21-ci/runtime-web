# Runtime Web v1 Implementation Plan

> **Revision log:** 2026-10-22 — plan review applied (blockers 1–4, majors 5–18, splits, minors). Codegen dropped for a hand-written client; apps resolve slug→`svc_` id; grants keyed by project slug; router wildcard cert + console route; Task 3/8/11/13/14 split; new Task 5b owns `docs/api-web.md`. Runtime claims re-checked against `../runtime-copy` (`openapi.json` is 3.1 with nullable unions, version upload typed as an `octet-stream` int array; `GET /v1/services?slug=` exists; `ServiceView.project` is a slug; `sse_streams_per_key = 10`; built-in `free` plan: 10 services, 3 schedules, no cron).
> 2026-10-22 (pass 2) — folded MUST + SHOULD items from `docs/reviews/parity-and-ux-research.md`: TOTP 2FA + recovery codes, session list/revoke, login events, invites with expiry (Task 6b), org/admin audit API+UI, If-Match on app PATCH and file save (409 stale / 428 missing), full app settings UI, status pill, events, rebuild, build logs, DLQ, export, env selector, ⌘K/org switcher/empty states, version authors, owner usage, require-2FA and SSO-only instance settings, `rtweb admin reset-2fa`, TLS parity with Dokploy (HTTP-01/TLS-ALPN on-demand, optional DNS-01 via Cloudflare, operator cert files, cert status in UI, HTTP→HTTPS), budgets first-route ≤ 250 KB / editor chunk ≤ 900 KB gzip. Task 4 → 4a/4b, 12 → 12a/12b, 14d → 14d/14e/14f, 15 → 15a/15b, new 6b and 11f. Verified in `runtime-copy`: `/v1/tenants/{t}/usage`, `/v1/services/{s}/events`, `/versions/{v}/rebuild`, `DELETE /dlq`, key-create `services` restriction exist.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted web console (Go backend + static React SPA, plus a Go custom-domain router) for 21 Cloud Runtime with users, orgs, project grants, apps, tokens and domains.

**Architecture:** `rtweb` is a BFF. Browser sessions are checked against role/grant authz in Go. Calls to the runtime control API use the org's hidden default key (option B), or the root token for operator actions. `rtrouter` terminates TLS for the console host, `*.BASE_DOMAIN` (wildcard cert) and verified custom domains, and proxies to rtweb or the runtime public listener. State lives in one SQLite file.

**Tech Stack:** Go 1.26, net/http, modernc.org/sqlite, sqlc, goose, x/oauth2, go-oidc, pquerna/otp, certmagic (+ libdns/cloudflare); React 19, Vite, TS, Tailwind 4, TanStack Router/Query, Radix/shadcn, cmdk, CodeMirror 6, Vitest, MSW, Playwright; npm. (No oapi-codegen: the runtime spec is OpenAPI 3.1 with nullable unions and an untyped upload body; the client is hand-written.)

**Spec:** `docs/02-design-v1.md` (decisions D1–D10, success criteria §7). Runtime facts: `docs/01-runtime-changelog.md`, `../runtime-copy/openapi/openapi.json`, `../runtime-copy/docs/api.md`. Web HTTP contract: `docs/api-web.md` (Task 5b). Style: `docs/CODESTYLE.md`.

## Global Constraints

- Build against `../runtime-copy` (runtime commit `b52766e`) only. Never read from or build against `../runtime` (in-flight work).
- `docs/CODESTYLE.md` is binding for every task: stdlib `testing` (no testify), `fmt.Errorf("pkg: what: %w")`, slog, npm, shadcn-style `ui/`.
- UI copy: "App", never "val". No plans/billing UI, no signup page, no personal orgs, no email trigger.
- Guest code in templates/stubs uses `std:*` modules only.
- Error JSON: `{"error":{"code":"snake_case","message":"…","details":{…}?}}`. Unknown/forbidden org-scoped resources → `404`; known-but-insufficient role → `403 forbidden`.
- Domain errors live in one package `internal/apperr` (`ErrNotFound`, `ErrForbidden`, `ErrInvalid`, `ErrConflict{Code}`, `ErrLastOwner`, `ErrLastAdmin`, …); services return these, `internal/api` maps them.
- Runtime service routes take the `svc_` id only, and service slugs are unique per runtime node (not per tenant). Every web call by app slug goes through `apps.Resolve` (Task 8a).
- Project grants are keyed by **project slug** (`ServiceView.project` is the slug; it is immutable and unique per tenant).
- Secrets at rest (default keys, OAuth client secrets) are AES-256-GCM sealed with `RTWEB_SECRET_KEY` (64 hex chars); the process refuses to start on a bad key.
- The console (`RTWEB_PUBLIC_URL`) must be a different *site* (registrable domain) from `RUNTIME_PUBLIC_URL` and `BASE_DOMAIN`, so guest apps cannot set or read console cookies.
- Every unsafe method (incl. `/api/auth/login` and `/api/setup`) checks `Origin` against `RTWEB_PUBLIC_URL`.
- Runtime timestamps are unix ms; the web API passes them through unchanged.
- TDD: every task writes its tests first, runs them red, then implements. A task is not done until `make ci` (or the task's subset) is green.
- Budgets: `rtweb` binary ≤ 30 MB, idle RSS ≤ 40 MB (docker stats, 30 s after start), first-route JS ≤ 250 KB gzip, editor lazy chunk (incl. TS worker) ≤ 900 KB gzip.
- Optimistic concurrency: `GET /…/apps/{app}` returns the runtime service `etag` as `ETag`; `PATCH /…/apps/{app}` and `PUT /…/files` require `If-Match` (missing → `428 precondition_required`; runtime `412` → `409 stale`).

## Review Focus

1. **Cross-org leakage through IDs**: a member of org A passes org B's app slug, `svc_` id or project slug in any route → `404`, never data. Owned by Task 5 (`TestCrossOrgIsolation`) and Task 8a (`TestAppOfOtherOrgIs404`, `TestResolveRejectsOtherTenant`).
2. **Default key exposure**: the default key's secret must never appear in any API response, log line, error message or audit row. Owned by Task 7 (`TestDefaultKeyNeverSerialized`, a grep of slog output in tests).
3. **Runtime down / 5xx / 503 busy / 429**: the UI must show "runtime unreachable" or "busy" states, not blank pages, and the API maps them to `502 runtime_unavailable` / `503 busy` / `429`. Owned by Task 3a (`TestRuntimeErrorMapping`), Task 11a (`TestErrorMappingTable`) and Task 13b.
4. **Domain takeover**: TXT removed after verification, the same host claimed by two orgs (first to verify wins), console/runtime hosts, and wildcard/IP/punycode hosts. Owned by Task 10 (`TestDomainValidation`, `TestDomainConflict`, `TestDomainReconcile`).
5. **Last owner removal / self-demotion / deleting yourself as last instance admin** → `409 last_owner` / `409 last_admin`. Owned by Task 6 (`TestLastAdminProtected`) and Task 7 (`TestLastOwnerProtected`).
6. **Setup hijack / session survival**: `/setup` needs the setup token; disabling a user or changing a password kills sessions. Owned by Task 4a.
7. **2FA bypass**: no session is issued before the TOTP/recovery step; codes can't be replayed; require-2FA and SSO-only settings can't be skipped via another login path (OAuth, invite accept). Owned by Task 4b (`TestLoginRequiresTOTPWhenEnabled`, `TestTOTPReplayRejected`, `TestPasswordLoginDisabledWhenSSOEnforced`) and Task 11f (`TestInviteAcceptNoCSRFBypass`).

---

## Execution model

| Who | Model | Used for |
|---|---|---|
| Controller (this session) | Opus 5.5 | Dispatch, integration, `make ci` gate between tasks |
| Implementer | **Haiku 5.5** (`model: "haiku"`) | Tasks tagged `[haiku]` |
| Implementer | **Opus 5.5, effort low** (`model: "opus", effort: "low"`) | Tasks tagged `[opus-low]`: security-sensitive or cross-cutting |
| Task reviewer | Haiku for `[haiku]` tasks, Opus low for `[opus-low]` | Spec + test review per task |
| UI/UX reviewer | Opus low | Task 16 |
| Security reviewer | Opus low | Task 17 |
| Final branch reviewer | Opus high | After Task 18 |

Every implementer prompt includes: the full task text, `docs/CODESTYLE.md`, the Global Constraints above, and the Interfaces blocks of the tasks it consumes. Tasks 1→3c→4a→4b→5→5b are sequential. After Task 5b, the backend tasks 6–11d follow their dependency order, and the frontend tasks 13a–15 run in parallel with them against `docs/api-web.md` + MSW.

---

### Task 1: Repo scaffold, config, sealing `[haiku]`

**Files:**
- Create: `go.mod`, `Makefile`, `.env.example`, `.gitignore`, `CLAUDE.md`, `cmd/rtweb/main.go`, `internal/config/config.go`, `internal/config/config_test.go`, `internal/seal/seal.go`, `internal/seal/seal_test.go`, `internal/apperr/apperr.go`
- Init git (`git init`, branch `main`); copy `temp/` → `docs/ui-reference/` (read-only reference), then delete `temp/`.

**Interfaces — Produces:**
- `config.Load(getenv func(string) string) (Config, error)`; `Config{RuntimeURL, RuntimePublicURL, RuntimeRootToken, RuntimeDefaultPlan, SecretKey [32]byte, PublicURL, DBPath, Listen, RouterSharedSecret, BaseDomain, ACMEEmail, SetupToken string, Dev bool}`. Env names: `RUNTIME_URL`, `RUNTIME_PUBLIC_URL`, `RUNTIME_ROOT_TOKEN`, `RUNTIME_DEFAULT_PLAN`, `RTWEB_SECRET_KEY`, `RTWEB_PUBLIC_URL`, `RTWEB_DB`, `RTWEB_LISTEN`, `RTWEB_DEV`, `RTWEB_SETUP_TOKEN`, `ROUTER_SHARED_SECRET`, `BASE_DOMAIN`, `ACME_EMAIL`. Defaults: `RuntimeDefaultPlan="standard"`, `DBPath="./data/rtweb.db"`, `Listen=":8090"`.
- `RTWEB_SECRET_KEY`: 64 hex → 32 bytes; a `dev-insecure-…` value is accepted only with `RTWEB_DEV=1` and becomes `sha256(value)`.
- Same-site rule: `Load` rejects a `PublicURL` whose registrable domain (publicsuffix eTLD+1) equals that of `RuntimePublicURL` or `BaseDomain` → error naming both. Skipped when `Dev` and all hosts are `localhost`/`*.localhost`.
- `seal.New(key [32]byte) *Sealer`; `(*Sealer).Seal(plain []byte) ([]byte, error)`; `Open(sealed []byte) ([]byte, error)`; `seal.ErrOpen`.
- `apperr`: `ErrNotFound`, `ErrForbidden`, `ErrInvalid` (wraps field errors), `ErrRateLimited`, `ErrPreconditionRequired`, `type Conflict struct{Code string}` (`last_owner`, `last_admin`, `host_taken`, `slug_taken`, `org_not_empty`, `already_set_up`, `stale`, …), `apperr.ConflictCode(err) (string, bool)`.

- [ ] Step 1: Tests: `TestLoad` table: missing `RUNTIME_URL` → error naming it; `RTWEB_SECRET_KEY` not 64 hex → error; `dev-insecure-x` rejected without `RTWEB_DEV=1`, accepted with it and equals `sha256("dev-insecure-x")`; defaults applied; `TestLoadRejectsSameSite` (`console.example.com` vs `RUNTIME_PUBLIC_URL=https://run.example.com` → error; vs `apps.example.net` → ok; `BASE_DOMAIN=example.com` → error). `TestSealRoundTrip`, `TestSealTamper` (flip one byte → `ErrOpen`), `TestSealNonceUnique`.
- [ ] Step 2: `go test ./...` → FAIL (undefined).
- [ ] Step 3: Implement. AES-GCM with a random 12-byte nonce prepended. `main.go` loads config, opens slog, exits 1 on config error (other wiring comes in Task 11a).
- [ ] Step 4: `make fmt-check vet test` → PASS.
- [ ] Step 5: Commit `chore: scaffold rtweb module, config and sealing`.

### Task 2: Store: schema, migrations, sqlc `[haiku]`

**Files:** `internal/store/{store.go,store_test.go,sqlc.yaml}`, `internal/store/migrations/0001_init.sql`, `internal/store/queries/{users,sessions,orgs,members,grants,keys,domains,audit,settings,invites,totp,login_events,version_authors}.sql`, generated `internal/store/db/`.

**Schema (exact tables; ids are prefixed ULIDs `usr_ ses_ org_ mem_ tok_ dom_ aud_ inv_ lge_`):**
- `users(id, email UNIQUE COLLATE NOCASE, name, password_hash, must_change_password INT, is_instance_admin INT, disabled INT, created_at, updated_at)`
- `identities(id, user_id FK, provider, subject, email, UNIQUE(provider,subject))`
- `sessions(id_hash PK, user_id FK, csrf, mfa_pending INT, created_at, last_seen_at, expires_at, ip, user_agent)` (`mfa_pending=1` rows authorize only the TOTP step, 5 min TTL)
- `user_totp(user_id PK FK, secret_sealed BLOB, enabled_at, last_used_step INT)` (`enabled_at NULL` = enrolling)
- `recovery_codes(user_id FK, hash, used_at, PK(user_id,hash))`
- `login_events(id, at, user_id NULL, email, ip, ua, method CHECK IN ('password','oauth','invite'), result CHECK IN ('ok','bad_password','bad_totp','rate_limited','disabled','sso_only'))`
- `invites(id, email, org_id NULL, role NULL, token_hash UNIQUE, expires_at, used_at, revoked_at, created_by, created_at)` (D2 invite link; 7-day expiry)
- `version_authors(org_id, service_id, version INT, user_id, created_at, PK(service_id,version))`
- `orgs(id, slug UNIQUE, name, tenant_id UNIQUE, default_key_id, default_key_sealed BLOB, created_at)`
- `pending_key_revokes(key_id PK, tenant_id, created_at, attempts INT)` (rotation retry, Task 7)
- `members(org_id, user_id, role CHECK IN ('owner','admin','member'), PK(org_id,user_id))`
- `project_grants(org_id, user_id, project_slug, role CHECK IN ('admin','developer','viewer'), PK(org_id,user_id,project_slug))`
- `tokens(id, org_id, runtime_key_id, name, scopes TEXT/*json*/, expires_at, created_by, created_at, revoked_at)`
- `domains(id, org_id, project_slug, service_id, host, token, status CHECK IN ('pending','active','failed'), last_checked_at, verified_at, txt_misses INT, cert_status CHECK IN ('none','pending','issued','error') DEFAULT 'none', cert_not_after, cert_error, created_at)` + `CREATE UNIQUE INDEX domains_active_host ON domains(host) WHERE status='active'`; `UNIQUE(org_id, host)`.
- `audit(id, at, actor_user_id, as_instance_admin INT, org_id, action, target, detail TEXT)`
- `settings(key PK, value BLOB, sealed INT)`; `login_failures(ip, email, at)`.

**Produces:** `store.Open(ctx, path string) (*Store, error)` (runs goose up, `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000`); `(*Store).Q() *db.Queries`; `(*Store).Tx(ctx, func(*db.Queries) error) error`; `store.NewID(prefix string) string`.

- [ ] Step 1: Tests: `TestOpenMigrates` (`:memory:`, all tables exist), `TestEmailCaseInsensitiveUnique`, `TestTxRollback`, `TestNewIDPrefixAndSortable`, `TestActiveHostUniqueOnlyWhenActive` (two pending rows for one host in different orgs ok; second `active` → constraint error), `TestRecoveryCodeSingleUse` (mark-used query affects 1 row then 0), `TestInviteTokenStoredHashed`.
- [ ] Step 2: Red. Step 3: Write the migration and queries, run `sqlc generate` (committed output), implement. Step 4: Green. Step 5: Commit `feat(store): sqlite schema, migrations and queries`.

### Task 3a: Runtime credentials, errors, typed client `[opus-low]`

**Files:** `internal/runtime/{client.go,cred.go,errors.go,types.go,services.go,versions.go,tenants.go,config.go,client_test.go}`.

**Decision:** no codegen. `types.go` holds hand-written structs copied from `openapi.json` component schemas (only fields the web uses; nullable unions → pointers / `json.RawMessage`). Each method documents its runtime path.

**Produces:**
- `type Credential interface{ apply(*http.Request) }`; `RootCred{Token string; Tenant string /*optional x-rt-tenant*/}`; `TenantKeyCred{Secret string}`. (`JWTCred` is reserved for option D and not implemented.)
- `runtime.New(baseURL string, hc *http.Client) *Client`; `(*Client).With(c Credential) *Scoped`.
- `*Scoped` methods (all ids are runtime ids; services by `svc_` id):
  - tenants/keys: `CreateTenant(ctx, TenantCreate) (Tenant, error)`, `DeleteTenant`, `CreateTenantKey(ctx, tenantID string, KeyCreate) (KeyCreated, error)` (`POST /v1/tenants/{t}/keys`), `RevokeTenantKey(ctx, tenantID, keyID)` (`DELETE /v1/tenants/{t}/keys/{key}`), `TenantUsage(ctx, tenantID)` (`GET /v1/tenants/{t}/usage`), `Limits`, `Me`. `KeyCreate{Name, Scopes, Services []string, ExpiresAt}`.
  - projects: `ListProjects`, `CreateProject`, `UpdateProject`, `DeleteProject`.
  - services: `ListServices(ctx, ServiceFilter{Slug, Project, Environment, Cursor}) (Page[Service], error)` (`GET /v1/services?slug=` → 0/1 items), `GetService(ctx, svcID) (Service, etag string, error)`, `CreateService`, `PatchService(ctx, svcID, ServicePatch, ifMatch string)`, `DeleteService`.
  - versions: `UploadVersion(ctx, svcID string, body io.Reader, contentType string, opts UploadOpts{Activate bool; Compile string /*lazy|eager*/}) (Version, error)`, `GetVersion`, `ListVersions`, `VersionSource(ctx, svcID, v) (body []byte, contentType string, error)`, `BuildLogs`, `Rebuild(ctx, svcID, v)`, `SetLive(ctx, svcID string, version int, ifMatch string) (Service, error)`.
  - config: env, secrets, schedules, queue, dlq, hosts (`PutHost/DeleteHost/ListHosts`), stats, events (`GET /v1/services/{s}/events`), data export (stream), node/*.
  - `StreamLogs(ctx, svcID, lastEventID string) (io.ReadCloser, error)` (raw SSE body).
- `runtime.Error{Status int; Code, Message string; RetryAfter time.Duration; Details json.RawMessage}`; `IsNotFound(err)`, `IsBusy(err)` (503 `queue_timeout|overloaded`), `IsThrottled(err)` (429 `rate_limited|build_quota|queue_full`), `IsDisabled(err)` (503 `control_disabled`), `ErrUnavailable` for transport errors.

- [ ] Step 1: Tests (httptest stub): `TestRootCredSetsTenantHeader`, `TestTenantKeyBearer`, `TestRuntimeErrorMapping` (404→IsNotFound; 503 queue_timeout→IsBusy; 429 build_quota + `Retry-After: 7`→IsThrottled, RetryAfter=7s; 503 control_disabled→IsDisabled; conn refused→ErrUnavailable; 422 with `details.diagnostics`→`Details` preserved), `TestUploadVersionJSON` (content-type `application/json`, `?compile=eager`, no `activate` unless set), `TestListServicesBySlug` (query `slug=x`), `TestDecodeNullableFields` (fixtures copied from openapi examples decode).
- [ ] Step 2: Red. Step 3: Implement. Step 4: Green. Step 5: Commit `feat(runtime): hand-written typed control-API client`.

### Task 3b: Fake runtime: tenants and keys `[haiku]`

**Files:** `internal/runtime/runtimetest/{server.go,tenants.go,server_test.go}`.

**Produces:** `runtimetest.NewServer(t) *Fake` with real auth semantics: root token vs `rtk_` keys, scopes, tenant isolation (`404`), cascade revoke of child keys, `Fake.URL`, `Fake.RootToken`, `Fake.FailNext(status int, code string, retryAfter time.Duration)`, `Fake.SetPlan(name string, p FakePlan{MaxServices, MaxSchedules int; Triggers []string})` (enforced: `403 quota_exceeded`, `403 trigger_not_allowed`).

- [ ] Tests: `TestFakeCascadeRevoke`, `TestFakeTenantIsolation`, `TestFakeScopesEnforced`, `TestFakePlanEnforced`. Commit `test(runtime): fake runtime tenants and keys`.

### Task 3c: Fake runtime: services, versions, hosts, SSE `[haiku]`

**Files:** `internal/runtime/runtimetest/{services.go,versions.go,hosts.go,logs.go,services_test.go}`.

**Produces:** in-memory services with node-global unique slugs (`409 slug_taken`), `?slug=` filter, ETag/If-Match (`412`), versions storing the raw uploaded bytes + content type (`/source` echoes them), `compile=eager` → `building` then `ready`/`failed` (driven by `Fake.FailBuild(svc, diagnostics)`), `PUT /live` (`409 version_not_ready`), hosts (`409 host_taken`), rebuild, events, tenant usage, key `services` restriction, env/secrets/schedules/queue/dlq, and an SSE log stream honoring `Last-Event-ID` with a per-key stream limit (`Fake.SSELimit`, default 10 → `429 rate_limited`). `Fake.EmitLog(svc, line)`, `Fake.OpenStreams(key) int`.

- [ ] Tests: `TestFakeSlugGlobal`, `TestFakeSourceRoundTrip`, `TestFakeEagerBuildStates`, `TestFakeIfMatch`, `TestFakeSSELimitAndResume`. Commit `test(runtime): fake services, versions, hosts and logs`.

### Task 4a: Auth: passwords, sessions, CSRF, setup `[opus-low]`

**Files:** `internal/auth/{password.go,session.go,csrf.go,origin.go,ratelimit.go,setup.go,mustchange.go,events.go,*_test.go}`.

**Produces:**
- `auth.Hasher interface{ Hash(p string) (string, error); Verify(hash, p string) bool }`; `auth.Argon2{}` (argon2id, m=64MiB, t=3, p=2, 16-byte salt, PHC string, constant-time). Minimum password length 12.
- `auth.Sessions{Q, Now func() time.Time}`; `Create(ctx, userID, ip, ua) (cookieValue string, csrf string, err)`; `Lookup(ctx, cookieValue) (Session, User, error)` (sliding idle 7 d, absolute 30 d; disabled user → `ErrNoSession`); `Revoke`, `RevokeAllForUser(ctx, userID, exceptSessionID string)` (called on disable, reset, password change); `ListForUser(ctx, userID) ([]SessionInfo{ID /*public: first 12 hex of id_hash*/, IP, UA, CreatedAt, LastSeenAt, Current bool}, error)`; `RevokeByPublicID(ctx, userID, publicID)` (other users' ids → `apperr.ErrNotFound`).
- `auth.LoginEvents.Record(ctx, LoginEvent{UserID, Email, IP, UA, Method, Result})`; `ListForUser(ctx, userID, limit)`. Every login path records one row.
- Cookie: `__Host-rtw_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no Domain). `Secure` and the `__Host-` prefix are dropped only when `cfg.Dev` (name `rtw_session`).
- Middleware: `auth.RequireSession(next)` (puts `auth.Principal{User, SessionID, CSRF}` in ctx; `auth.FromContext(ctx)`); `auth.RequireCSRF` for non-GET/HEAD; `auth.CheckOrigin(publicURL)` for every unsafe method (incl. unauthenticated `/api/auth/login`, `/api/setup`); `auth.RequireInstanceAdmin`; `auth.RequirePasswordChanged(allow ...string) func(http.Handler) http.Handler` (403 `password_change_required` unless the path is in `allow`).
- `auth.Login(ctx, email, password, ip) (User, error)` → `ErrInvalidCredentials` (same error for unknown user / bad password / disabled; unknown user still calls `Hasher.Verify` on a dummy hash); limiter 10 fails / 15 min per (ip,email) → `apperr.ErrRateLimited`.
- `auth.SetupNeeded(ctx) bool` (no users); `auth.Setup(ctx, setupToken, email, name, password) (User, error)` requires `setupToken` to equal `cfg.SetupToken`, or, when unset, a one-time random token generated at startup and logged once at `WARN` (`auth.NewSetupToken(cfg) string`). It creates the first user as instance admin in a tx that rejects with `apperr.Conflict{"already_set_up"}` if any user exists (race safe).

- [ ] Step 1: Tests: `TestPasswordRoundTripAndWrong`, `TestSessionIdleAndAbsoluteExpiry` (fake clock), `TestSessionStoredHashed` (row id ≠ cookie), `TestCookieFlags` (prod: name `__Host-rtw_session`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain; dev: `rtw_session`, not Secure), `TestCSRFRejectsMissingOrWrong`, `TestOriginRejectedOnUnsafe` (POST `/api/auth/login` and `/api/setup` with foreign `Origin` → 403), `TestLoginNoUserEnumeration` (same error; a spy `Hasher` records `Verify` called once for an unknown user), `TestLoginRateLimit`, `TestSetupOnlyOnce` (two concurrent Setups → exactly one succeeds), `TestSetupRequiresToken` (missing/wrong token → 403 `setup_token_invalid`, no user created), `TestDisableRevokesSessions` (disable → `Lookup` fails for all sessions), `TestPasswordChangeRevokesOtherSessions`, `TestRequirePasswordChanged` (stub mux: `/api/apps` → 403 `password_change_required`; `/api/me`, `/api/me/password`, `/api/auth/logout` pass), `TestListOwnSessions`, `TestRevokeOtherSession` (also: another user's session id → not found), `TestRevokeAllExceptCurrent`, `TestLoginEventsRecorded` (success, bad password, bad TOTP — the TOTP row is written by 4b's path through the same recorder).
- [ ] Step 2–4: Red → implement → green. Step 5: Commit `feat(auth): passwords, sessions, csrf and setup token`.

### Task 4b: Auth: TOTP 2FA, recovery codes, instance auth policy, reset CLI `[opus-low]`

**Files:** `internal/auth/{totp.go,recovery.go,policy.go,*_test.go}`, `cmd/rtweb/admin.go`.

**Produces:**
- `auth.TOTP{Q, Sealer, Now}` (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step): `Enroll(ctx, userID) (otpauthURL string, err)` (seals secret, `enabled_at NULL`); `Confirm(ctx, userID, code) (recoveryCodes []string, err)` (valid code required; returns 10 codes once, stores sha256 hashes); `Disable(ctx, userID, password, code)` (both required); `Verify(ctx, userID, code) error` (rejects `step <= last_used_step` → replay); `UseRecovery(ctx, userID, code) error` (single use); `Regenerate(ctx, userID, password) ([]string, error)`.
- Two-step login: `auth.Login` returns `LoginResult{User; MFARequired bool}`. With TOTP enabled it creates an `mfa_pending` session (cookie, 5 min) that only `POST /api/auth/mfa` accepts; `auth.CompleteMFA(ctx, pendingCookie, code|recoveryCode) (cookie, csrf, err)` swaps it for a full session. TOTP failures share the login limiter (5 / 15 min per user) → `apperr.ErrRateLimited`.
- `auth.Policy{Require2FA bool; PasswordLoginDisabled bool}` loaded from `settings`. `Require2FA`: users without confirmed TOTP get a normal session, and middleware `auth.RequireMFAEnrolled(allow ...string)` (checks policy + `user_totp` per request) answers (403 `mfa_enrollment_required` except `/api/me`, `/api/me/totp/*`, `/api/auth/logout`). `PasswordLoginDisabled` is only settable when an OAuth/OIDC provider is configured; password login then → 403 `password_login_disabled` (instance admins keep password login as break-glass; logged as event `sso_only` for others). Invite accept and OAuth login go through the same MFA and policy checks.
- CLI: `rtweb admin reset-2fa --email <email>` (opens the DB directly, deletes `user_totp` + `recovery_codes`, revokes sessions, writes an audit row with actor `cli`).

- [ ] Step 1: Tests: `TestTOTPEnrollRequiresValidCode`, `TestLoginRequiresTOTPWhenEnabled` (pending session cannot call any other route), `TestTOTPReplayRejected` (same code within window), `TestRecoveryCodesShownOnceAndConsumed`, `TestTOTPRateLimited`, `TestDisableTOTPRequiresPasswordAndCode`, `TestRequire2FAForcesEnrollmentAfterLogin`, `TestPasswordLoginDisabledWhenSSOEnforced`, `TestOAuthLoginStillRequiresTOTP`, `TestReset2FACLI` (fake clock throughout).
- [ ] Step 2–4. Step 5: Commit `feat(auth): totp 2fa, recovery codes and auth policy`.

### Task 5: Authz matrix `[opus-low]`

**Files:** `internal/authz/{authz.go,scopes.go,authz_test.go}`.

**Produces:**
- `type Action string` with the closed set: `org.read org.update org.delete org.audit.read org.usage.read members.manage members.owners invites.manage tokens.manage defaultkey.rotate project.create project.read project.update project.delete grants.manage domains.manage app.read app.create app.update app.delete app.deploy app.env.write app.secrets.write app.schedules.write app.queue.write app.logs.read app.data.export instance.admin`.
- `authz.Subject{UserID string; InstanceAdmin bool; OrgRole string /*"" if not member*/; ProjectRoles map[string]string /*project slug → role*/}`.
- `authz.Can(s Subject, a Action, projectSlug string) bool`. `projectSlug` is ignored for org-level actions.
- `authz.ScopesFor(projectRole string) []string` (viewer/developer/admin → runtime scopes per 00 §3.3). This is the shared source for option D later.
- Rules: org owner = all; admin = all except `org.delete` and `members.owners` (granting/removing/demoting the owner role); member = project-level via grants only; project admin ⊇ developer ⊇ viewer; `domains.manage` is project-admin level (developer lacks it); developer lacks `app.secrets.write app.data.export grants.manage domains.manage`; instance admin = `instance.admin` and acts as owner of every org (each use is audited by the caller with `as_instance_admin=1`). `org.audit.read`, `org.usage.read`, `invites.manage` are owner/admin only.

- [ ] Step 1: Test `TestCanMatrix`: a table over every Action × {owner, admin, member+admin, member+developer, member+viewer, member no grant, non-member, instance admin}, with the expected bool spelled out per row (rows for `domains.manage` and `members.owners` explicit). `TestScopesFor` uses exact slices. `TestCrossOrgIsolation`: non-member asking about any action → false; grant on slug `a` does not apply to slug `b`.
- [ ] Step 2–4. Step 5: Commit `feat(authz): role and project-grant permission matrix`.

### Task 5b: Web HTTP contract `docs/api-web.md` `[opus-low]`

**Files:** `docs/api-web.md`.

Written before handlers so frontend tasks (13a+) start in parallel. Contents: every route of Tasks 11a–11f with method, path, `authz.Action`, request/response JSON shapes (TS-style), error codes per route, the error envelope (incl. `details` for 422 diagnostics), cookie/CSRF/Origin rules, SSE event format for `/logs` (`id`, `event: log`, `data`), pagination (`cursor`), and the router routes payload. Names match Interfaces blocks (app slug in paths, project slug in paths and grants).

- [ ] Review by controller against Tasks 6–11f Interfaces. Commit `docs: web api contract`.

### Task 6: Orgs and users (admin services) `[haiku]`

**Files:** `internal/orgs/{orgs.go,orgs_test.go}`, `internal/users/{users.go,users_test.go}`, `internal/audit/{audit.go,audit_test.go}`.

**Consumes:** store, runtime client + fake, seal, auth.Hasher, auth.Sessions, apperr.
**Produces:**
- `audit.Actor{UserID string; AsInstanceAdmin bool}` (`UserID="cli"` for CLI actions); `audit.Log(ctx, q, actor audit.Actor, orgID, action, target string, detail any)`; `audit.List(ctx, q, Filter{OrgID *string /*nil = instance-wide*/; ActorUserID, Action string; Before string /*cursor*/; Limit int}) ([]Entry, next string, error)`.
- `users.Service`: `Create(ctx, actor audit.Actor, email, name string, admin bool) (User, tempPassword string, error)` (temporary password: 20 random base32 chars, `must_change_password=1`); `List`, `Disable` (→ `RevokeAllForUser`), `SetAdmin`, `ResetPassword` (→ `RevokeAllForUser`). Removing the last enabled instance admin → `apperr.Conflict{"last_admin"}`.
- `orgs.Service`: `Create(ctx, actor, slug, name string, ownerUserID string) (Org, error)`. Creates a runtime tenant (root cred, plan = `cfg.RuntimeDefaultPlan`), mints the default key via `CreateTenantKey` with all tenant scopes **except `keys:write`**, named `rtweb-default`, seals it, inserts org + owner member in one tx. On a DB failure after the tenant exists it deletes the tenant (compensation). Also `List(ctx, forUser)`, `Get`, `Rename`, `Delete` (runtime `409 tenant_not_empty` → `apperr.Conflict{"org_not_empty"}`).
- `orgs.Service.DefaultCred(ctx, orgID) (runtime.TenantKeyCred, error)` (unseal, cached 60 s); `InvalidateCred(orgID)`.

- [ ] Step 1: Tests against the fake runtime: `TestCreateOrgProvisionsTenantAndKey` (plan = configured; key scopes lack `keys:write`), `TestCreateOrgCompensatesOnDBError`, `TestLastAdminProtected`, `TestTempPasswordForcesChange`, `TestDisableUserRevokesSessions`, `TestAuditWritten`, `TestAuditListFilters` (actor, action, cursor), `TestAuditMarksInstanceAdmin` (instance admin acting in a non-member org → `as_instance_admin=1`).
- [ ] Step 2–4. Step 5: Commit `feat(orgs): admin-created orgs and users with runtime provisioning`.

### Task 6b: Invites `[haiku]`

**Files:** `internal/invites/{invites.go,invites_test.go}`.

**Consumes:** store, auth.Hasher, auth.Policy, orgs.Service.AddMember, audit.
**Produces:** `invites.Service`: `Create(ctx, actor audit.Actor, email string, orgID, role *string) (Invite, link string, error)` (instance admin; or org owner/admin when `orgID` set — `members.manage`, owner role needs `members.owners`; 32-byte token, sha256 stored, 7-day expiry; link shown once); `List(ctx, orgID *string)` (pending only); `Revoke(ctx, actor, id)`; `Accept(ctx, token, name, password string) (User, error)` (single use; creates the user — or uses the existing user with that email — sets the password, adds membership when bound; expired/used/revoked → `apperr.ErrNotFound` `invite_invalid`; then the normal 4b MFA/policy flow applies at login).

- [ ] Step 1: Tests: `TestInviteAcceptCreatesUserAndMembership`, `TestInviteExpired`, `TestInviteReuseRejected`, `TestInviteRevoke`, `TestAdminCannotInviteOwner`.
- [ ] Step 2–4. Step 5: Commit `feat(invites): expiring single-use invite links`.

### Task 7: Members, grants, tokens, default key `[opus-low]`

**Files:** `internal/orgs/{members.go,members_test.go}`, `internal/keys/{keys.go,keys_test.go}`.

**Produces:**
- `orgs.Service.AddMember(ctx, actor, sub authz.Subject, orgID, userID, role)`, `SetRole`, `RemoveMember` (owner role changes or removing an owner require `members.owners` → else `apperr.ErrForbidden`; `apperr.Conflict{"last_owner"}` when the last owner would be removed or demoted), `SetGrant(ctx, actor, sub, orgID, userID, projectSlug, role)`, `RemoveGrant`, `Subject(ctx, userID, orgID) (authz.Subject, error)` (ProjectRoles keyed by project slug).
- `keys.Service.CreateToken(ctx, actor, sub authz.Subject, orgID string, req TokenRequest{Name string; Scopes []string; Services []string /*app slugs → svc ids, optional*/; ExpiresAt *time.Time}) (Token, secret string, error)`: `POST /v1/tenants/{t}/keys` with **RootCred** (not the default key; runtime `CreateKeyBody.services` restriction used when set), validates scopes ⊆ runtime scope list and ⊆ the creator's reach (org owner/admin: any; project admin: `authz.ScopesFor("admin")` and `Services` required within granted projects); the secret is returned only here.
- `keys.Service.ListTokens(ctx, orgID) ([]Token, error)` (never secrets, never the default key), `RevokeToken(ctx, actor, orgID, tokenID)` (`DELETE /v1/tenants/{t}/keys/{key}` + `revoked_at`).
- `keys.Service.RotateDefault(ctx, actor, orgID) error`: mints the new key, in one tx swaps the sealed value and inserts a `pending_key_revokes` row for the old key, invalidates the `DefaultCred` cache, then revokes the old key in the runtime and deletes the row. `keys.Service.RetryPendingRevokes(ctx)` (runs at startup and every 5 min) retries failed revokes.

- [ ] Step 1: Tests: `TestLastOwnerProtected`, `TestAdminCannotChangeOwners` (admin → SetRole(owner) / RemoveMember(owner) → forbidden), `TestCustomTokenShownOnce`, `TestRevokedTokenRejectedByRuntime` (fake → 401), `TestRotateDefaultKeepsCustomTokens` (spec §7.3), `TestRotateRetriesRevoke` (fake `FailNext(503)` on DELETE → row kept; `RetryPendingRevokes` → old key 401, row gone), `TestDefaultKeyNeverSerialized` (capture slog + JSON of every returned struct; assert the secret is absent), `TestTokenScopesValidated`, `TestTokenScopesSubsetOfCreator`, `TestTokenServiceRestriction`, `TestGrantKeyedBySlug`.
- [ ] Step 2–4. Step 5: Commit `feat(keys): members, grants, custom tokens and default key rotation`.

### Task 8a: Projects, app CRUD, slug resolution `[opus-low]`

**Files:** `internal/apps/{service.go,resolve.go,projects.go,apps.go,*_test.go}`.

**Produces:** `apps.Service` methods taking `(ctx, sub authz.Subject, orgID, …)`, each checking `authz.Can` first (`apperr.ErrForbidden` / `apperr.ErrNotFound`):
- `Resolve(ctx, orgID, slug string) (App{SvcID, Slug, ProjectSlug, Environment}, error)`: `ListServices(Slug: slug)` with the org's default cred (tenant-scoped; another tenant's slug → 0 items → `ErrNotFound`); cached per (org, slug) 30 s, evicted on delete. Every app-level method calls it, then checks `authz.Can(sub, action, app.ProjectSlug)`.
- Projects: `ListProjects` (members see only granted slugs), `CreateProject`, `UpdateProject`, `DeleteProject`, `ListEnvironments`.
- Apps: `List(projectSlug, environment string)`, `Get(slug) (AppView{Service; ETag string; Status{BuildState, Tier, LastError}; Limits{Requested, Effective, Source /*plan|profile|service*/}}, error)`, `Create(projectSlug, environment, slug, template string)` (environment must be one of the project's) (create service → runtime `409 slug_taken` → `apperr.Conflict{"slug_taken"}` with message "This app name is taken on this runtime"; then upload the template as version 1, `compile=eager`, `activate=1`), `Update(slug, AppPatch{Scaling, Access, Ingress{Methods, PathPrefixes, IPAllow []string, RateLimit}, Egress, Call{AllowedCallers}, Limits, Profile *…}, etag string)` (etag required → else `apperr.ErrPreconditionRequired`; each block **replaces** the runtime block, documented in the UI; `IPAllow` entries parsed with `netip.ParsePrefix` → `apperr.ErrInvalid` per field; runtime 412 → `apperr.Conflict{"stale"}`), `Delete`.

- [ ] Step 1: Tests (fake runtime): `TestResolveBySlug`, `TestResolveRejectsOtherTenant`, `TestMemberSeesOnlyGrantedProjects`, `TestAppOfOtherOrgIs404`, `TestCreateSlugTakenGlobal` (slug used by another tenant → `slug_taken`), `TestCreateAppUploadsTemplateV1`, `TestCreateRejectsUnknownEnvironment`, `TestUpdateSendsIfMatch`, `TestPatchAppStaleEtag409`, `TestPatchWithoutIfMatch428`, `TestUpdateIngressValidatesCIDR`, `TestUpdateBlockReplacesNotMerges`, `TestGetShowsEffectiveLimitsAndStatus`.
- [ ] Step 2–4. Step 5: Commit `feat(apps): projects, app crud and slug resolution`.

### Task 8b: Code, source sniffing, save, promote, templates `[haiku]`

**Files:** `internal/apps/{code.go,source.go,templates.go,authors.go,code_test.go,source_test.go}`, `internal/apps/templates/{http,cron,queue,sqlite-crud}/main.ts`.

**Produces:**
- `Files(sub, orgID, slug string, version int) (Files{Entry string; Files map[string]string; ReadOnly bool; Kind string}, error)`: `VersionSource` returns raw uploaded bytes; `source.Unpack(body, contentType)` sniffs (content type, then magic bytes): `.ts`/`.js` single file → `{main.ts|main.js}`; JSON `{entry, files}` → as-is; zip/tar → unpacked (size cap 10 MB, path traversal rejected); wasm → `ReadOnly=true`, `Kind="wasm"`, no files.
- `Save(sub, orgID, slug string, files Files, etag string) (Version, error)`: upload JSON `{entry, files}` with `compile=eager` (no activate) → poll `GetVersion` until `ready|failed` (timeout 60 s) → on `ready` `SetLive(version, If-Match etag)` (etag required; stale → `apperr.Conflict{"stale"}`) and inserts `version_authors(sub.UserID)`; on `failed` return `apperr.ErrInvalid` carrying build diagnostics; never activates a pending build. `422 validation_failed` → `Details` passed through for the editor.
- `Versions` (joined with `version_authors` → `Author{UserID, Name}` or null for versions made outside the web), `Promote(slug, v, etag)` (`SetLive` + If-Match; `409 version_not_ready`), `BuildLogs(slug, v)`, `Rebuild(slug, v)` (`POST /versions/{v}/rebuild`, `app.deploy`).
- Templates use only `std:*` imports (`std:sqlite` for sqlite-crud, `std:kv` counter in http).

- [ ] Step 1: Tests: `TestFilesUnpackTS`, `TestFilesUnpackJS`, `TestFilesUnpackJSON`, `TestFilesUnpackZip`, `TestFilesUnpackTar`, `TestFilesUnpackRejectsTraversal`, `TestFilesWasmReadOnly`, `TestSaveEagerThenLive`, `TestSaveFailedBuildNotActivated` (diagnostics returned, live unchanged), `TestSaveFilesStaleEtag409`, `TestVersionAuthorRecorded`, `TestRebuildFailedVersion`, `TestViewerCannotSave`, `TestPromoteRollsBack`, `TestTemplatesUseStdOnly` (no `rt:` imports, no `"val"`).
- [ ] Step 2–4. Step 5: Commit `feat(apps): code view, save and templates`.

### Task 8c: Env, secrets, schedules, queue, DLQ `[haiku]`

**Files:** `internal/apps/{config.go,config_test.go}`.

**Produces:** `Env/SetEnv`, `Secrets/SetSecret/DeleteSecret` (names only on read), `Schedules CRUD`, `Queue/Enqueue`, `DLQ/PurgeDLQ (DELETE /dlq)/Redrive`. Each resolves the slug and checks its action.

- [ ] Step 1: Tests: `TestDeveloperCannotWriteSecrets`, `TestSecretsListNamesOnly`, `TestCronTemplateOnConfiguredPlan` (fake `SetPlan("free", {MaxSchedules:3, Triggers: no cron})` + `SetPlan("standard", {…cron})`; org on `standard` → cron template creates schedule; on `free` → `403 trigger_not_allowed` surfaced as 403 `plan_limit`), `TestQueueFullThrottled` (429 passes through with Retry-After), `TestDLQPurgeAndRedrive`.
- [ ] Step 2–4. Step 5: Commit `feat(apps): env, secrets, schedules and queues`.

### Task 8d: Logs fan-out, stats, events, export `[opus-low]`

**Files:** `internal/apps/{logs.go,stats.go,logs_test.go}`.

**Produces:**
- `apps.LogHub`: `Subscribe(ctx, sub, orgID, slug, lastEventID string) (<-chan LogEvent, func(), error)`. One upstream `StreamLogs` per (org, svc) shared by all browser subscribers (the org's default key has `sse_streams_per_key = 10` on the runtime); ring buffer of last 500 events for `Last-Event-ID` resume; upstream reconnects with its last seen id and backoff; closes 30 s after the last subscriber leaves; per-org cap of 8 upstreams → `apperr.ErrRateLimited`.
- `Stats`, `Events(sub, orgID, slug, cursor)` (`app.read`; runtime events passthrough for the events panel), `ExportData(…) (io.ReadCloser, error)` (`app.data.export`).

- [ ] Step 1: Tests: `TestLogFanoutOneUpstream` (5 subscribers → `Fake.OpenStreams(key)==1`), `TestLogResumeLastEventID`, `TestLogUpstreamReconnect`, `TestLogUpstreamClosedAfterIdle`, `TestEventsPassthroughScoped` (other org's app → 404; only this svc's events), `TestExportRequiresAdmin`.
- [ ] Step 2–4. Step 5: Commit `feat(apps): shared log streams, stats and export`.

### Task 9: Admin operator views `[haiku]`

**Files:** `internal/admin/{admin.go,admin_test.go}`.
**Produces:** `admin.Service` (root cred, instance admin only): `NodeStatus`, `NodeConfig`, `SetNodeConfig(ctx, actor, NodeConfigPatch{DegradationMode, DefaultProfile *string; RateLimit *RateLimit})` (only these fields; response marks `rate_limit` as `pending_restart`), `Scheduler`, `Cache`, `Drain`, `Version`, `OrgUsage(ctx, sub authz.Subject, orgID)` (root-cred `TenantUsage`; allowed for instance admin, and for the org's owner/admin for their own org only — `org.read` + role check), `Domains(ctx) ([]DomainView, error)` (all orgs' domains for the admin domain view). Every mutation is audited.

- [ ] Steps 1–5 with tests `TestNonAdminForbidden`, `TestSetNodeConfigAudited`, `TestSetNodeConfigRejectsOtherFields`, `TestAdminDomainList`, `TestOrgOwnerSeesOwnUsageOnly`, `TestAdminCacheView`. Commit `feat(admin): operator node views`.

### Task 10: Domains and router routes `[opus-low]`

**Files:** `internal/domains/{domains.go,verify.go,domains_test.go}`.

**Produces:**
- `domains.Service.Add(ctx, sub, orgID, appSlug, host string) (Domain, error)` (`domains.manage` on the app's project): normalize (lowercase, strip trailing dot, IDNA → punycode). Reject IPs, wildcards, ports, `BASE_DOMAIN` apex and anything under it, the console host (`RTWEB_PUBLIC_URL`), the runtime public host, and hosts > 253 chars → `apperr.ErrInvalid`. Same host already `active` anywhere → `apperr.Conflict{"host_taken"}`; pending rows in several orgs are allowed (first to verify wins). The token is 32 random hex chars; TXT name `_rtweb.<host>`.
- `Verify(ctx, sub, orgID, domainID) (Domain, error)` uses an injectable `Resolver interface{ LookupTXT(ctx, name string) ([]string, error) }`. On a match: in one tx set `active` (unique index decides the race; loser → `failed`, `host_taken`), then root-cred `PutHost(svcID, host)`; runtime `409 host_taken` → revert to `failed`.
- `Remove` (runtime DELETE, then row delete). `RunChecker(ctx)` re-checks pending domains every 60 s for up to 24 h, then marks them `failed`. It re-checks active domains every 6 h; TXT absent for 3 consecutive checks → deactivate (runtime DELETE, status `failed`) and audit. It also reconciles against runtime `ListHosts` per app: hosts active in DB but missing in the runtime are re-PUT; runtime hosts not active in DB are left alone and logged.
- `domains.DevResolver` reads `RTWEB_DEV_DNS_OVERRIDE` (`name=value;…`), used only when `cfg.Dev`, otherwise `net.Resolver`.
- `Routes(ctx) (RouteTable, etag string)` returns `{console_host, hosts: {host: {slug}}, base_domain}` for active domains only.
- `SetCertStatus(ctx, map[host]CertStatus)` (from rtrouter; unknown hosts ignored); `Domain` view includes `cert_status, cert_not_after, cert_error`.

- [ ] Step 1: Tests: `TestDomainValidation` (table: `Shop.Example.com.`→ok normalized; `1.2.3.4`, `*.x.com`, `x.com:443`, `<BASE_DOMAIN>`, `a.<BASE_DOMAIN>`, console host, runtime public host, 254-char → invalid; `bücher.de` → `xn--bcher-kva.de`), `TestDomainConflict` (two orgs add same host; first verify wins; second → `host_taken`), `TestVerifyActivatesViaRoot`, `TestPendingExpiresAfter24h`, `TestActiveDeactivatedWhenTXTGone`, `TestDomainReconcile`, `TestRoutesOnlyActive`, `TestCertStatusStored`, `TestDeveloperCannotManageDomains`.
- [ ] Step 2–4. Step 5: Commit `feat(domains): custom domains with dns verification`.

### Task 11a: HTTP server, errors, middleware, SPA, setup, auth routes `[haiku]`

**Files:** `internal/api/{server.go,registry.go,errors.go,spa.go,routes_auth.go,*_test.go}`, `cmd/rtweb/main.go`.

**Produces:**
- `api.Server`; `(*Server).route(method, pattern string, action authz.Action, h HandlerFunc)` registers into `api.Registry` (`[]RouteSpec{Method, Pattern string; Action authz.Action; Public bool}`); `routePublic(...)` for setup/login/healthz/oauth. Org-scoped handlers receive the resolved `authz.Subject` and call `authz.Can(sub, action, projectSlug)` via a shared helper.
- Middleware order: recover → slog → `CheckOrigin` (unsafe methods) → session (rejects `mfa_pending` sessions except on `/api/auth/mfa`) → `RequirePasswordChanged("/api/me", "/api/me/password", "/api/auth/logout")` → `RequireMFAEnrolled("/api/me", "/api/me/totp/", "/api/auth/logout")` → CSRF.
- Routes: `GET /api/setup` · `POST /api/setup` (body includes `setup_token`) · `POST /api/auth/login` (→ `{mfa_required}` or session) · `POST /api/auth/mfa` · `POST /api/auth/logout` · `GET /api/me` · `PUT /api/me/password` · `GET /healthz`. SPA: embed `web/dist`, fallback, `Cache-Control: immutable` for `/assets/*`, CSP `default-src 'self'; frame-src RUNTIME_PUBLIC_URL`.
- Error mapping (`errors.go`): `apperr.ErrNotFound`/runtime 404 → 404 `not_found`; `ErrForbidden` → 403 `forbidden`; `ErrInvalid` → 422 `invalid` (+ `details`); runtime 422 → 422 with runtime `code` + `details`; runtime busy → 503 `busy` + `Retry-After`; runtime 429 `rate_limited|build_quota|queue_full` → 429 same code + `Retry-After`; runtime 503 `control_disabled` and `ErrUnavailable` → 502 `runtime_unavailable`; `apperr.Conflict` → 409 with its code (runtime 412 → 409 `stale`); `ErrPreconditionRequired` → 428 `precondition_required`; `ErrRateLimited` → 429 `rate_limited`.

- [ ] Step 1: Tests (httptest + fake runtime + memory store): `TestSetupFlow` (GET → needed; POST with token → admin + session cookie; second POST → 409), `TestSetupWrongToken403`, `TestCSRFEnforced`, `TestOriginEnforced`, `TestRoutesRequireSession`, `TestErrorMappingTable` (every row above), `TestSPAFallback` (`/orgs/x/apps/y` → index.html; `/api/unknown` → JSON 404), `TestLoginMFAFlow` (login → `mfa_required`; pending cookie rejected on `/api/me`; `/api/auth/mfa` → full session).
- [ ] Step 2–4. Step 5: Commit `feat(api): server, errors, spa, setup and auth routes`.

### Task 11b: Admin and org routes `[haiku]`

**Files:** `internal/api/{routes_admin.go,routes_org.go,*_test.go}`.

Routes (contract in `docs/api-web.md`): `GET|POST /admin/users`, `PATCH|DELETE /admin/users/{id}`, `POST /admin/users/{id}/reset-password`, `DELETE /admin/users/{id}/totp` (reset 2FA, audited) · `GET|POST /admin/orgs`, `PATCH|DELETE /admin/orgs/{org}` · `GET /admin/node/{status,config,scheduler,cache,version}`, `PUT /admin/node/config`, `POST /admin/node/drain` · `GET /admin/domains` · `GET /admin/audit` · `GET|PUT /admin/settings` (incl. `require_2fa`, `password_login_disabled`) · `GET /admin/orgs/{org}/usage` · `GET /orgs` · `GET /orgs/{org}` · `GET|POST /orgs/{org}/members`, `PATCH|DELETE /orgs/{org}/members/{user}` · `PUT|DELETE /orgs/{org}/members/{user}/grants/{project}` · `GET|POST /orgs/{org}/tokens`, `DELETE /orgs/{org}/tokens/{id}` · `POST /orgs/{org}/default-key/rotate` · `GET /orgs/{org}/limits` · `GET /orgs/{org}/usage` (`org.usage.read`) · `GET /orgs/{org}/audit` (`org.audit.read`; `?actor=&action=&cursor=`) · `GET|POST /orgs/{org}/projects`, `GET|PATCH|DELETE /orgs/{org}/projects/{p}`, `GET /orgs/{org}/projects/{p}/environments`.

- [ ] Tests: `TestAdminRoutesRequireInstanceAdmin`, `TestInstanceAdminInOrgAudited`, `TestLimitsReadOnly`, `TestAuditVisibleOnlyToOrgAdmins`, `TestAuditCrossOrg404`, `TestSSOOnlyRequiresProvider` (PUT settings `password_login_disabled=true` with no provider → 422), `TestEveryRouteChecksAuthz` (walks `api.Registry`: every non-public route has an `Action`; calls each as a non-member → 401/403/404, never 2xx). Commit `feat(api): admin and org routes`.

### Task 11c: App routes `[haiku]`

**Files:** `internal/api/{routes_apps.go,*_test.go}`.

Routes: `GET|POST /orgs/{org}/apps`, `GET|PATCH|DELETE /orgs/{org}/apps/{app}` (GET sets `ETag`; PATCH requires `If-Match`), `GET|PUT /…/files` (PUT requires `If-Match`), `GET /…/versions`, `PUT /…/live` (`If-Match`), `GET /…/versions/{v}/build-logs`, `POST /…/versions/{v}/rebuild`, `GET /…/events`, `GET|PUT /…/env`, `GET /…/secrets`, `PUT|DELETE /…/secrets/{name}`, `GET|POST /…/schedules`, `PATCH|DELETE /…/schedules/{id}`, `GET|POST /…/queue`, `GET|DELETE /…/dlq` (DELETE = purge), `POST /…/dlq/redrive`, `GET /…/stats`, `GET|POST /…/domains`, `POST /…/domains/{id}/verify`, `DELETE /…/domains/{id}`.

- [ ] Tests: `TestSaveDiagnostics422` (details shown), `TestSlugTaken409`, `TestAppETagRoundTrip` (GET ETag → PATCH If-Match ok; stale → 409 `stale`; missing → 428), `TestDomainsIncludeCertStatus`, `TestEndToEndAppDeploy` (admin creates org+user → user login → create app → save → versions shows v2 live). Commit `feat(api): app routes`.

### Task 11d: SSE, export, router routes endpoint `[haiku]`

**Files:** `internal/api/{routes_stream.go,routes_router.go,*_test.go}`.

Routes: `GET /…/apps/{app}/logs` (SSE via `apps.LogHub`; honors `Last-Event-ID`; `http.ResponseController` clears the write deadline for this route only; heartbeat comment every 15 s), `GET /…/apps/{app}/export` (stream), `GET /api/internal/router/routes` (bearer `ROUTER_SHARED_SECRET`, ETag/If-None-Match), `POST /api/internal/router/cert-status` (same bearer).

- [ ] Tests: `TestLogsSSEResume`, `TestLogsNoWriteDeadline` (server `WriteTimeout` 1 s, stream stays open 3 s), `TestRouterRoutesAuthAndETag`, `TestCertStatusEndpointAuth`, `TestExportStreams`. Commit `feat(api): log streams, export and router routes`.

### Task 11e: OAuth login linking `[haiku]`

**Files:** `internal/auth/oauth.go`, `internal/auth/oauth_test.go`, `internal/api/routes_oauth.go`.
**Produces:** providers `github`, `google`, `oidc` configured from `settings` (sealed client secret); routes `GET /api/auth/oauth/{provider}/start|callback`. `start` sets a state+PKCE cookie (10 min). `callback` checks state, then links to an existing user by verified email: OIDC/Google require `email_verified=true`; GitHub uses the `primary && verified` address from `GET /user/emails`. With no matching user it shows an error page (`no_account`) and **never creates** one. Links on first match (inserts an `identities` row). Disabled users are rejected. Successful OAuth goes through 4b's MFA step and is recorded as a login event (`method=oauth`).
- [ ] Tests with an httptest fake OIDC provider and fake GitHub API: `TestOAuthStateMismatch`, `TestOAuthUnknownEmailNoUserCreated`, `TestOAuthUnverifiedEmailRejected`, `TestGitHubUsesPrimaryVerifiedEmail`, `TestOAuthLinksExisting`. Commit `feat(auth): oauth/oidc login linking`.

### Task 11f: Account security, invites and audit routes `[haiku]`

**Files:** `internal/api/{routes_me.go,routes_invites.go,routes_audit.go,*_test.go}`.

Routes: `GET /me/sessions`, `DELETE /me/sessions/{id}`, `POST /me/sessions/revoke-others`, `POST /me/totp/{enroll,confirm,disable}`, `POST /me/recovery-codes` (regenerate; password required), `GET /me/logins` · `GET|POST /invites` (instance admin: any; org owner/admin: `?org=` bound), `DELETE /invites/{id}`, `GET /invites/{token}` (public: email + org name only), `POST /invites/{token}/accept` (public; Origin-checked; no session needed, so CSRF is replaced by the single-use token). Audit list handlers for `/orgs/{org}/audit` and `/admin/audit` share `audit.List`.

- [ ] Tests: `TestSessionsRoutes` (list marks current; revoke other; revoke-others keeps current), `TestTOTPRoutes` (enroll → confirm returns codes once; second confirm → 409), `TestLoginHistoryOwnOnly`, `TestInviteRoutesScoped` (org admin cannot list other org's invites → 404), `TestInviteAcceptNoCSRFBypass` (foreign Origin → 403; accept does not set a session for an MFA-enforced instance without enrollment flow), `TestAuditPagination`. Commit `feat(api): account security, invites and audit routes`.

### Task 12a: rtrouter proxy and routing `[opus-low]`

**Files:** `cmd/rtrouter/main.go`, `internal/router/{router.go,table.go,router_test.go}`.

**Produces:** `router.Table` (atomic snapshot) and `router.Poller{URL, Secret, Interval: 5s}` (ETag; keeps the last good table on error). `router.Handler(table, Upstreams{Runtime, Console *url.URL})`: a `httputil.ReverseProxy` using `Rewrite` (not `Director`) with `SetXForwarded()` (incoming `X-Forwarded-*` dropped), preserving `Host`. Console host (`RTWEB_PUBLIC_URL` host) → rtweb; `{slug}.{BASE_DOMAIN}` and active custom hosts → runtime public; unknown host → `404` small HTML page. Streams (FlushInterval -1). `ROUTER_TLS=off` dev mode serves plain HTTP only.

- [ ] Step 1: Tests: `TestUnknownHost404`, `TestKnownHostProxiedWithHost`, `TestBaseDomainSubdomain`, `TestConsoleHostToRTWeb`, `TestIncomingXFFDropped` (client-sent `X-Forwarded-For: 6.6.6.6` not forwarded; real peer set), `TestPollerKeepsLastGoodOnError`, `TestStreamingNotBuffered`, `TestBusyPassthrough` (503 + Retry-After unchanged).
- [ ] Step 2–4. Step 5: Commit `feat(router): console and custom-domain request router`.

### Task 12b: rtrouter TLS (Dokploy parity) `[opus-low]`

**Files:** `internal/router/{tls.go,certstatus.go,tls_test.go}`.

**Decisions:** Let's Encrypt via certmagic (`ACME_EMAIL`; `ROUTER_ACME_CA` override for staging/Pebble in tests).
- Custom domains: on-demand TLS with HTTP-01 and TLS-ALPN-01; `DecisionFunc` allows only hosts active in the table (rejects `*.BASE_DOMAIN`, console, unknown).
- `BASE_DOMAIN` + `*.BASE_DOMAIN`, one of: (1) operator cert files `ROUTER_WILDCARD_CERT`/`ROUTER_WILDCARD_KEY` (reloaded on change); (2) DNS-01 via certmagic + `libdns/cloudflare` when `ROUTER_DNS_PROVIDER=cloudflare` and `CLOUDFLARE_API_TOKEN` are set (the only provider in v1); neither → startup error unless `ROUTER_TLS=off`.
- Console host: `ROUTER_CONSOLE_CERT/KEY` if set, else managed (HTTP-01/TLS-ALPN, pre-obtained at startup, not on-demand).
- `:80` serves ACME HTTP-01 challenges and 308-redirects everything else to https (preserving path+query).
- Cert status: `router.CertReporter` posts `{host: {status: pending|issued|error, not_after, error}}` for custom domains to `POST /api/internal/router/cert-status` (shared secret) on certmagic events and every 5 min.

- [ ] Step 1: Tests: `TestTLSDecisionOnlyActiveCustom` (`a.<BASE_DOMAIN>` → rejected by on-demand, served by wildcard cert), `TestWildcardFromFiles`, `TestDNS01ConfigCloudflareOnly` (other provider name → config error), `TestHTTPRedirectsToHTTPS` (path+query kept; `/.well-known/acme-challenge/*` not redirected), `TestOnDemandIssuesViaPebble` (Pebble test CA, skipped with `-short`), `TestCertStatusReported`.
- [ ] Step 2–4. Step 5: Commit `feat(router): acme tls, wildcard cert and cert status`.

### Task 13a: Web scaffold, tokens, UI kit `[haiku]`

**Files:** `web/` (`package.json`, `vite.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `src/main.tsx`, `src/index.css` with tokens migrated from `docs/ui-reference/src/index.css` plus a `.dark` set, `src/components/ui/{button,input,label,dialog,dropdown-menu,select,tabs,table,badge,toast,skeleton,empty-state,progress}.tsx`, `src/lib/utils.ts`).
- [ ] Tests: `ui kit renders in light and dark`, `button focus ring visible`. `npm run lint && npm test && npm run build` green. Commit `feat(web): scaffold and design system`.

### Task 13b: API client and auth pages `[haiku]`

**Files:** `src/lib/{api.ts,query.ts}`, `src/routes/{__root,login,login.mfa,setup,change-password,invite.$token}.tsx`, `src/components/runtime-status-banner.tsx`, `src/test/msw.ts` (handlers generated by hand from `docs/api-web.md`).

**Produces:** `api.get/post/put/patch/del<T>(path, body?, opts?{ifMatch})` throwing `ApiError{status, code, message, details?, retryAfter?}`; sends `X-CSRF-Token`. On 401 it redirects to `/login?next=`. `busy`, 429 and `runtime_unavailable` map to a toast and `<RuntimeStatusBanner/>`. Hooks `useXxx` in `src/hooks/`.
- [ ] Tests (Vitest + MSW): `login submits and redirects to next`, `setup page only when GET /api/setup says needed`, `setup asks for setup token`, `401 redirects to login`, `busy error shows "Busy — retry" toast`, `429 shows retry-after`, `change-password required redirects`, `invite link sets password`, `login asks for TOTP code when mfa_required` (recovery-code link too), `mfa enrollment required redirects to security page`, `password form hidden when SSO-only`, `412-stale 409 shows reload prompt`. Commit `feat(web): api client and auth pages`.

### Task 14a: Shell, navigation, org switcher, ⌘K, empty states `[haiku]`

**Files:** `src/components/layout/{sidebar,topbar,org-switcher,command-menu}.tsx` (cmdk), `src/components/features/empty/…`; `src/routes/$org/{index,projects.$p,apps.new}.tsx`.
Org switcher changes scope and clears the TanStack Query cache. ⌘K palette: apps, projects, settings pages and actions (new app, new project). Empty states: no projects → create-project CTA; empty project → create-app CTA with template cards. App create dialog has an environment selector (project's environments); project page lists environments. Org overview shows the read-only quota bar (`/limits`) and, for owner/admin, own usage (`/usage`).
- [ ] Tests: `sidebar lists projects then apps`, `cmd+k navigates to app`, `org switcher changes scope and clears query cache`, `empty project shows create-app CTA`, `app create offers project environments`, `quota bar renders limits read-only`, `usage card hidden for members`, `no "val" text in rendered routes` (walk the route tree; `/\bval\b/i` absent). Commit `feat(web): shell, navigation and empty states`.

### Task 14b: Editor, TS worker, std stubs `[opus-low]`

**Files:** `src/components/features/editor/…`, `src/lib/std-types/*.d.ts` (stubs for `std:kv std:sqlite std:sql std:queue std:blob std:services std:platform` matching `../runtime-copy/docs/handlers.md`), `src/routes/$org/apps.$app.code.tsx`.
CodeMirror 6, lazy-loaded, TS diagnostics via `@valtown/codemirror-ts` or an equivalent worker loading the stubs. ⌘S saves (sends `If-Match`; 409 `stale` → "changed elsewhere — reload/overwrite" dialog); save shows a building → live pill linking to the build log; 422/failed build diagnostics are rendered inline. Wasm versions show a read-only notice. The preview iframe points at `RUNTIME_PUBLIC_URL/s/{slug}/` and reloads after a successful save.
- [ ] Tests: `viewer sees read-only editor and no Save`, `cmd+s triggers save mutation`, `save shows building then live`, `stale save shows reload dialog`, `diagnostics from 422 shown inline`, `wasm version read-only`, `editor chunk not in first-route bundle`. Commit `feat(web): code editor`.

### Task 14c: Logs, versions, build logs, rebuild `[haiku]`

**Files:** `src/components/features/{logs,versions}/…`, `src/routes/$org/apps.$app.{logs,versions}.tsx`.
Logs use `EventSource` (auto `Last-Event-ID` resume) with pause/resume (buffers while paused), clear, level filter and a reconnect indicator. Versions list: live badge, build state, author, promote (rollback confirm names the target version), diff, build-log viewer, "Rebuild" on failed versions.
- [ ] Tests: `logs resume after reconnect`, `logs pause buffers new lines`, `promote calls PUT live`, `rollback dialog names target version`, `failed version cannot be promoted`, `rebuild failed version shows new build log`, `version author shown`. Commit `feat(web): logs and versions`.

### Task 14d: App settings: runtime blocks `[haiku]`

**Files:** `src/components/features/app-settings/{scaling,access,ingress,egress,callers,limits}.tsx`, `src/routes/$org/apps.$app.settings.tsx`.
Settings sections send `PATCH` with `If-Match`; each form notes "saving replaces this whole block". Scaling (min/max). Access (public/key/internal; `key` mode prompts to create an invoke token). Ingress (methods, path prefixes, `ip_allow` CIDRs validated client-side, rate_limit). Egress. `call.allowed_callers` picker listing the org's apps. Limits/profile showing requested vs effective with its source.
- [ ] Tests: `access key mode prompts invoke token`, `ip_allow rejects invalid CIDR client-side`, `allowed_callers picker lists org apps`, `effective limits show source`, `settings save sends If-Match`. Commit `feat(web): app runtime settings`.

### Task 14e: App overview, triggers, DLQ, events, export `[haiku]`

**Files:** `src/components/features/{app-header,overview,triggers,events}/…`, `src/routes/$org/apps.$app.{index,triggers}.tsx`.
Tabs: **Overview | Code | Logs | Versions | Triggers (HTTP, schedules, queue/DLQ) | Settings (env, secrets, domains, runtime blocks, danger zone)**. App header status pill (build_state, tier, last_error). Overview: stats + events panel. Triggers: schedules CRUD, enqueue, DLQ list with purge and redrive (both confirmed). Data export button only for owner/admin/project admin.
- [ ] Tests: `status pill shows last_error`, `events panel lists runtime events`, `dlq redrive requires confirmation`, `dlq purge requires confirmation`, `export hidden for developer`. Commit `feat(web): overview, triggers, dlq, events, export`.

### Task 14f: Env/secrets, domains, tokens, members, audit, security page `[haiku]`

**Files:** `src/components/features/{env,secrets,domains,tokens,members,invites,audit,security}/…`, `src/routes/$org/settings/{members,tokens,audit,general}.tsx`, `src/routes/me.security.tsx`.
Domains tab: DNS instructions with copy buttons, status badge, cert status (pending/issued/error + expiry) and the note "Keep the TXT record; removing it deactivates the domain." Tokens: create form with scopes, optional app restriction and expiry; shown once. Members: roles, grants, pending invites (create/revoke). Org audit page with actor/action filters. Security page: sessions (revoke one / others), 2FA enroll with QR then recovery codes once (download/print), disable 2FA, login history.
- [ ] Tests: `secrets show names only, value write-only`, `domain pending shows TXT record to copy`, `domain tab says TXT must stay`, `domain shows cert status`, `token created is shown once then hidden`, `token form limits scopes to role`, `pending invites can be revoked`, `audit page filters by actor`, `security page lists sessions and revokes`, `2fa enroll shows QR then recovery codes once`. Commit `feat(web): org settings, domains, tokens, audit and security`.

### Task 15a: Admin: users, invites, orgs, audit `[haiku]`

**Files:** `src/routes/admin/{index,users,orgs,audit}.tsx`.
Users: create → temp password shown once with copy, or "Create invite link" (optional org + role, 7-day expiry) shown once; disable, reset password, reset 2FA (confirmed). Org create picks the owner from users; org row shows usage. Admin audit page (instance-wide, filters).
- [ ] Tests: `non-admin is redirected from /admin`, `temp password shown once`, `invite link shown once`, `reset 2fa requires confirmation`, `admin audit filters by org and actor`. Commit `feat(web): admin users, orgs and audit`.

### Task 15b: Admin: node, cache, domains, instance settings `[haiku]`

**Files:** `src/routes/admin/{node,cache,domains,settings}.tsx`.
Node page: status/scheduler cards, a config form with only `degradation_mode`, `default_profile`, `rate_limit` (badge "applies after restart"), drain with typed confirmation. Cache view. Admin domains page lists all orgs' domains with status and cert status. Settings: OAuth providers (client secret write-only), public URL, "Require 2FA for all users", "Disable password login (SSO only)" (disabled until a provider is configured). There is no plan picker anywhere.
- [ ] Tests: `drain requires typed confirmation`, `node config form has only three fields`, `cache view renders`, `admin domain view lists all orgs`, `sso-only toggle disabled without provider`, `require 2fa toggle saves`, `no plan or billing UI` (assert `/\bplan\b/i`, "upgrade", "billing" absent). Commit `feat(web): admin node and instance settings`.

### Task 16: UI/UX best-practices review `[opus-low reviewer → haiku fixers]`

- [ ] Dispatch a reviewer (Opus low) with: the running app (`make dev`, browser pane), `docs/00-research-and-design.md` §1, the `web-design-guidelines` skill, and this brief: "Compare against val.town, Cloudflare Workers dashboard, windmill, Vercel and Railway dashboards. Review information architecture, empty/loading/error states, keyboard flows (⌘K, ⌘S), destructive-action safety, copy, accessibility (WCAG AA contrast, focus rings, labels), dark mode and mobile at 375 px. Output `docs/reviews/ui-ux-review.md`: findings tagged must/should/could, each with a screen, the problem, the fix and the file."
- [ ] Haiku fixers implement every **must** (with a test where behavior changes). The controller triages should/could with the owner.
- [ ] Commit `fix(web): ui/ux review musts`.

### Task 17: Security review `[opus-low]`

- [ ] Reviewer brief: session/CSRF/Origin/cookie flags, setup token, TOTP (replay, rate limit, pending-session scope, recovery codes), invite tokens, SSO-only enforcement, the authz matrix vs handlers (`TestEveryRouteChecksAuthz` from Task 11b must cover every registry entry), default-key handling, SSRF in domain verification/OAuth discovery, router TLS decision and XFF handling, header injection in the proxy, console/app same-site separation, the SPA's CSP, and argon2 params. Output `docs/reviews/security-review.md`. Fix every high and medium finding (Opus low implementer), with a regression test per fix.
- [ ] Commit `fix(security): review findings`.

### Task 18: Packaging, compose, e2e, budgets `[haiku]`

**Files:** `Dockerfile` (node build stage → go build → distroless), `Dockerfile.router`, `docker-compose.yml`, `deploy/runtime.toml`, `e2e/{playwright.config.ts,smoke.spec.ts}`, `scripts/budget.sh`.
- [ ] Compose: runtime built from `../runtime-copy` with `deploy/runtime.toml` setting `routing.base_domain = BASE_DOMAIN`, `ingress.trusted_proxies = [<rtrouter address>]`, and a `[plans.standard]` (cron + interval + queue triggers, ≥ 50 services, ≥ 50 schedules); rtweb with `RUNTIME_DEFAULT_PLAN=standard`, `RTWEB_SETUP_TOKEN`; rtrouter with `ROUTER_TLS=off`, routing the console host to rtweb; a `compose.tls.yml` override runs Pebble to exercise 12b's ACME path in CI.
- [ ] `smoke.spec.ts` covers spec §7.1 end to end (including the setup token, 2FA enroll + TOTP login with a generated code, invite accept), plus a custom-domain route via the router using `Host:` header injection, with the resolver stubbed through `RTWEB_DEV_DNS_OVERRIDE` (dev only).
- [ ] `scripts/budget.sh` asserts the binary size, idle RSS (`docker stats --no-stream` 30 s after start), first-route JS ≤ 250 KB gzip and the editor chunk ≤ 900 KB gzip (each checked separately) against the Global Constraints.
- [ ] `make ci` = fmt-check vet test web-test web-lint build e2e budget. Commit `chore: docker, compose, e2e and budgets`.

### Final: whole-branch review (Opus high) → fixes → owner handoff.
