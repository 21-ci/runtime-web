# Security review: Runtime Web v1 (Task 17)

Branch `feat/v1` @ `fc36359`. Scope: the Task 17 brief plus trusted-proxy IP, SQLite concurrency, audit, secrets in logs, dependency pinning, Dockerfile.

## Verification run

- `go test -race ./...`: all 18 packages ok, exit 0. The invites flake did not reproduce this run.
- `govulncheck ./...` (network ok): **17 reachable stdlib vulns** on local `go1.26.4` (net/http, crypto/tls, crypto/x509, net/url, mime/multipart, encoding/asn1). All are fixed by go1.26.10. Reachable via ReverseProxy (`internal/router/router.go:64`), certmagic ACME client, and `http.Server`. There are 3 package and 5 module vulns that the code does not call.

## Findings

| ID | Sev | File:line | Exploit scenario | Fix | Regression test |
|---|---|---|---|---|---|
| SR-01 | **High** | toolchain (`go.mod` `go 1.26.0`, built with 1.26.4) | The public router (`rtrouter`) runs a vulnerable net/http + crypto/tls. Example: a remote attacker sends crafted HTTP/2 or TLS traffic to the internet-facing listener to cause DoS or parser confusion (GO-2026-6603..6617, 6607, 6809). | Add `toolchain go1.26.10` (or later) to go.mod and pin the same version in CI and the Task 18 Dockerfile base image. Add `govulncheck ./...` to `make ci`. | CI step `govulncheck` (no Go test). |
| SR-02 | **Medium** | `internal/api/routes_auth.go:62-66`, `internal/auth/oauth.go:446-452` | rtweb sits behind rtrouter, so `RemoteAddr` is always the router's IP. The limiter key `(ip,email)` (`internal/auth/ratelimit.go:12`, 10 per 15 min) collapses to `(router,email)`. Anyone on the internet can lock any known email out of password login with 10 bad attempts, and keep it locked indefinitely. Login events and session IP records are also useless for forensics. This is the ledger's "carry to 17" item. | Add one `ClientIP(r, trusted []netip.Prefix)` in `internal/auth`. When `RemoteAddr` is inside `RTWEB_TRUSTED_PROXIES` (default: loopback/the compose network), take the right-most X-Forwarded-For entry that is not a trusted proxy. Otherwise use `RemoteAddr`. Delete the duplicate `clientIPOf`. rtrouter already uses `SetXForwarded`, which appends the real peer (router.go:52), so the right-most hop is trustworthy. | `TestClientIPTrustedProxyUsesRightmostXFF`, `TestClientIPUntrustedPeerIgnoresXFF`, `TestLoginLimiterKeysOnForwardedIP` |
| SR-03 | **Medium** | `internal/store/store.go:56-60`, `:88` | WAL + deferred `BEGIN`: a tx that reads and then writes gets SQLITE_BUSY when it tries to upgrade its lock, and `busy_timeout` does not retry that case. Under concurrent load, invite accept, last-owner guard, key rotation and the limiter return 500 or "database is locked" (the invites flake). An attacker can provoke this to make security-relevant writes (limiter `Fail`, audit rows, session revoke) fail. Where the error is swallowed, the code fails open; for example the limiter-write path in `service.go:258` needs checking. | Add `_txlock=immediate` to the DSN (modernc supports it) so write transactions take the RESERVED lock up front and wait out `busy_timeout`. Optionally `SetMaxOpenConns(1)` for the writer pool. Confirm that limiter/audit write errors fail closed. | `TestConcurrentAcceptOnlyOneSucceeds` run with `-count=50 -race` in CI; add `TestStoreConcurrentWriteTxNoBusy` |
| SR-04 | Low | `internal/auth/setup.go:30` | The generated first-run setup token is written to logs at WARN. If logs are shipped to a shared aggregator before setup completes, anyone with log access can claim the instance admin. | Keep the behaviour but print it to stderr only when it is a TTY, or write it to a 0600 file. Make sure the token is invalidated once setup completes (verify). Document it in Task 18. | `TestSetupTokenNotLoggedWhenEnvSet` (exists?) + `TestSetupTokenSingleUse` |
| SR-05 | Low | `internal/router/tls.go:243` (ledger 12b) | The HTTP→HTTPS redirect builds its Location from the client's `Host`. This is an open redirect to an arbitrary host via a crafted Host header on port 80. Low impact because the browser sent that Host itself. | Redirect only when `Resolve` knows the host. Otherwise return 404. | `TestRedirectUnknownHost404` |
| SR-06 | Low | `internal/api/server.go:153` | The CSP has no `object-src 'none'`, `base-uri 'none'` or `form-action 'self'`. `default-src 'self'` covers objects, but `base-uri` is not covered by default-src, so an injected `<base>` could redirect relative script loads. | Append `; base-uri 'none'; form-action 'self'; object-src 'none'`. | extend `TestSecurityHeaders` |
| SR-07 | Low | Task 11c parked | Domain rows whose app was deleted are never swept. The router keeps routing a stale custom domain to a reused app slug, so a new app can receive traffic intended for the old domain. | Add an orphan sweep to the domains checker, or delete domains inside the app-delete tx. | `TestDomainsSweepOrphans` |
| SR-08 | Low | `internal/auth/oauth.go` discovery cache (ledger 11e) | The discovery cache is global, unbounded and ignores Dev. An admin can only set one issuer, so the cache grows slowly. SSRF on issuer discovery is limited to instance admins. | Bound the cache and reject private/loopback issuer IPs when not in Dev. | `TestDiscoveryRejectsPrivateIssuer` |
| SR-09 | Low | — | There is no Dockerfile yet (Task 18), so the image's user, base and Go version are unverified. | In Task 18: distroless/nonroot base, pinned Go ≥1.26.10, `-trimpath`, read-only rootfs, data volume 0700. | n/a |
| SR-10 | Info | `web/package.json`, `go.mod` | Dependencies are pinned. npm uses exact versions with `package-lock.json` present, and Go is pinned via go.sum. The ledger notes `npm ci` has no lockfile guard. | Use `npm ci` (which fails when the lock is missing) in the Makefile/Dockerfile. Run `npm audit --omit=dev` in CI. | CI step |

## Checked, no finding (at this depth)

- **Cookies:** `HttpOnly`, `Secure` (except Dev) and `SameSite=Lax` (`session.go:338-340`). The `__Host-` prefix is used outside Dev, and the OAuth state cookie is the same (`oauth.go:370`).
- **CSRF:** a per-session token is compared in constant time (`csrf.go:21`) and applied to every session route before authz (`registry.go:64-73`). Origin is checked on unsafe public routes.
- **TOTP:** last-step replay is rejected atomically (`totp.go:182,219`). There is a per-user limiter (`totp.go:312,332`) and a constant-time compare.
- **Constant-time compares:** setup token, internal router secret (`routes_internal.go:50`) and OAuth state.
- **Argon2id:** used in `password.go:45`. Verify reads the params from the stored hash.
- **Header handling:** the router uses `ReverseProxy.Rewrite`, which strips inbound `Forwarded`/`X-Forwarded-*` and then appends. Host is preserved, and there is no header injection path.
- **Console vs runtime same-site:** enforced at config load (`config.go:113`).
- **Secrets in logs:** apart from SR-04, the slog calls log IDs and errors only, with no tokens, keys or passwords.
- **Audit:** admin, orgs and keys paths write audit rows, including failure outcomes. Ledger Task 9 still applies: the outcome audit uses the request ctx, so a client disconnect can leave a dangling pending row (Low, already known).

Not re-derived here: a full authz-matrix diff against `TestEveryRouteChecksAuthz` (the test passes under -race), and invite-token entropy and expiry.

## Fixes

All in commit `b5260cb` (fix(security): review findings).

| ID | Fix | Regression test |
|---|---|---|
| SR-01 | `toolchain go1.26.10` in go.mod; `make vuln` (govulncheck v1.1.4) added to `make ci`: 0 reachable vulns | CI `vuln` step |
| SR-02 | `internal/netx.ClientIP`: right-most untrusted X-Forwarded-For hop, only when the peer is in `RTWEB_TRUSTED_PROXIES` (default empty); replaces `clientIP`/`clientIPOf` | `netx.TestClientIPTrustedProxyUsesRightmostXFF`, `TestClientIPUntrustedPeerIgnoresXFF`, `api.TestLoginLimiterKeysOnForwardedIP` |
| SR-03 | `_txlock=immediate` in the DSN; limiter/login-event/session-revoke errors propagate (fail closed) | `store.TestStoreConcurrentWriteTxNoBusy` (red before: "database is locked"), `auth.TestLoginFailsClosedOnStoreError`; `invites.TestConcurrentAcceptOnlyOneSucceeds -count=50 -race` ok |
| SR-04 | Ruling: logging the generated one-time token is intended; documented in `.env.example` | — |
| SR-05 | `RedirectHandler` redirects only hosts `Resolve` knows; else 421 | `router.TestRedirectUnknownHost421` |
| SR-06 | CSP adds `base-uri 'none'; form-action 'self'; object-src 'none'` | `api.TestSPAHasCSP` |
| SR-07 | Parked | — |
| SR-08 | Non-Dev discovery rejects issuers resolving to loopback/private/link-local; cache bounded to 64 | `auth.TestDiscoveryRejectsPrivateIssuer`, `TestDiscoveryCacheBounded` |
| SR-09/10 | Task 18 | — |
