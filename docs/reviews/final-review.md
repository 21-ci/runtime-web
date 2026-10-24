# Final branch review: Runtime Web v1

Branch `integration/web` @ `f2ce0e4` (base `main` @ `443ae71`, 86 commits). Reviewer: Opus 5.5 (high), read-only.
Inputs: `docs/02-design-v1.md`, plan `docs/superpowers/plans/2026-10-22-runtime-web-v1.md` (Global Constraints,
Review Focus), `docs/api-web.md`, `docs/reviews/security-review.md`, SDD ledger `progress.md`.

The diff is 2 MB, so I reviewed it in passes and read the worktree directly. Pass 1 covered the web console
(`web/src`, tasks 14b–15b had no per-task review), with all of it searched and the risky features read in full:
editor, security/2FA, tokens, secrets, domains, env, admin gate, API client, query client, logs, app shell. Pass 2
covered Go integration points: route registry, app-route authz delegation, CSP, server wiring, domains reconcile and
routes, app delete. Pass 3 covered the ledger triage and §7.

## Verification run (this worktree)

| Check | Result |
|---|---|
| `go test -race ./...` | pass (19 packages ok, exit 0) |
| `go vet ./...`, `gofmt -l cmd internal` | pass / clean |
| `npx vitest run` | pass: 25 files, 130 tests |
| `npm run lint`, `tsc --noEmit` | pass |
| `npm run build` | pass. First route 118 KB gz. `ts-worker` is 6.06 MB raw / **1.35 MB gz** |
| `scripts/budget.sh` (no docker) | **FAIL**: editor chunk **1,529,226 B gz > 921,600** (3 chunks). First route PASS (118,420 B). RSS skipped (no container). |
| `rtweb` size (built to scratchpad, `-s -w -trimpath`) | 12.9 MB with the placeholder dist + 7.3 MB `web/dist` ≈ **20 MB ≤ 30 MB** (estimate) |
| CSP in a real browser | Served `web/dist` with the exact CSP from `internal/api/server.go:153` and loaded `/login` in Chromium. Console shows 2 "Applying inline style violates … default-src" errors. Sonner's `<style>` has `sheet === null` (blocked), and a `data:` image is **blocked**. |
| Commit signatures | 7 commits have no `gpgsig`: `fe14e9f cbdbbaa 75fd296 ebf4317 b3fdc1c 3f69269 c9b3311` |
| Playwright e2e / live stack | not run (no stack) |

## Strengths

- **Server authz is consistent.** Each `appRoute` (`internal/api/approute.go:12`) delegates to `apps.Service` /
  `domains.Service`. Every service method checks the right action: Save/Promote/Rebuild check `AppDeploy`,
  secrets check `AppSecretsWrite`, export checks `AppDataExport`, domains check `DomainsManage`, and reads check
  `AppRead`/`AppLogsRead`. A grant on another project yields 404 (`TestProjectOnlyViewerScopedToProject`). The
  ledger's 11d concern (empty project → 403) does not hold.
- **The CSRF/Origin/session chain** (`internal/api/registry.go`) is ordered correctly. Gate exemptions match
  exact paths (`internal/auth/mustchange.go:15`), not prefixes.
- **The web API client** (`web/src/lib/api.ts`) sends CSRF on every unsafe method and `If-Match` on all three
  endpoints that need it (PATCH app ×2 hooks, PUT files, PUT live). Errors are normalized, `Retry-After` is
  honored, 502/503 set the runtime banner, and the CSRF token lives in memory only.
- **XSS:** there is no `dangerouslySetInnerHTML`, `innerHTML` or `eval` in app code. `?next=` is hardened
  (`lib/safe-next.ts`). `Referrer-Policy: same-origin` keeps invite tokens out of referrers. The preview iframe is
  cross-site by config (`frame-src` = runtime origin only), so `allow-scripts allow-same-origin` does not reach
  the console origin.
- **Secrets:** secret values are write-only in the UI. Token secrets and temporary passwords are shown once and
  dropped on close. Recovery codes are shown once, with download and print.
- **Accessibility:** icon buttons have `aria-label`, inputs are labelled, destructive actions sit behind dialogs,
  app delete needs the slug typed, and there are skeletons, `QueryError` and empty states. A route-walk test
  checks that the word "val" never appears. No plan or billing copy (the quota bar is read-only).
- **Admin gating:** every `/admin/*` route has `requireInstanceAdmin` in `beforeLoad`. The ⌘K admin filter (15a
  carry) is done.

## Issues

### Critical (code)

None found.

### Merge blockers (process)

**B1. Seven unsigned commits.** `fe14e9f cbdbbaa 75fd296 ebf4317 b3fdc1c 3f69269 c9b3311` were made with
`-c commit.gpgsign=false`, which you had rejected (ledger "PROBLEM" line). Re-sign them (rebase/re-merge with
signing) before merging to `main`.

### Important (should fix before merge)

**I1. The production CSP breaks the 2FA QR code and every toast.**
- **Where:** `internal/api/server.go:153` sets `default-src 'self'` with no `img-src` and no `style-src`.
- **QR code:** `web/src/components/features/security/enroll-2fa.tsx:71,133` renders the QR as a `data:` URL
  `<img>`, which is blocked. Users see a broken image and must type the key by hand (§7.6 UX).
- **Toasts:** Sonner (`components/ui/toast.tsx`, mounted at `routes/__root.tsx:38`) injects its CSS in a
  `<style>` tag, which is blocked (verified in Chromium: `sheet === null`). Every success and error toast renders
  unpositioned and unstyled at the end of the document. That includes the global error toasts in
  `lib/query.ts`, the stale/Reload toast and "Saved version N".
- **Also blocked:** Radix's injected styles (scroll lock, select scrollbar). This is cosmetic.
- **Why tests missed it:** jsdom and vitest do not enforce CSP.
- **Fix:** add `img-src 'self' data:; style-src 'self' 'unsafe-inline'` (script-src stays strict, so inline
  styles carry low risk). Alternatively, render the QR as inline SVG (`qrcode.toString({type:'svg'})`) and use
  Sonner's `nonce`. Extend `api.TestSPAHasCSP`. Add a Playwright assertion with no CSP console errors on
  `/me/security`.

**I2. Keystrokes typed while a save is in flight are lost.**
- **Where:** `web/src/components/features/editor/code-page.tsx:53-56`.
- **Scenario:** `doSave` captures `current` when ⌘S is pressed and awaits `PUT …/files`, which builds eagerly and
  waits for `ready` (seconds). The editor stays editable, because `readOnly` (line 44) ignores
  `save.isPending`. When the save resolves, `setDraft({ base: data, files: current })` puts back the old
  snapshot. The value-sync effect (`cm-editor.tsx:134-139`) then replaces the document, so text typed during the
  build disappears and the cursor jumps.
- **Fix:** when the save resolves, keep the newer draft. Use `setDraft(d => d && d.files !== current ? d : { base:
  data, files: current })`, or track a "saved snapshot" separately from the draft. Add a test that types during a
  pending save.

**I3. Mutation errors are silently dropped, and write controls are shown to roles that cannot use them.**
- **Where:** `web/src/lib/query.ts:40-41`. The global handler toasts only `busy`, `rate_limited`,
  `runtime_unavailable`, `stale` and `network`. `forbidden`, `not_found`, `internal`, `payload_too_large`,
  `version_not_ready`, `plan_limit`, `conflict` and the like fall through to `default: break`.
- **Call sites with no local `onError`:**
  - `secrets-panel.tsx:51-57` (ApiError other than `invalid` ignored) and `:65`
  - `env/env-editor.tsx:74`
  - `versions-view.tsx:127`, `:172` (promote `409 version_not_ready`)
  - `domains-panel.tsx:158`, `:169`
  - `triggers/schedules-card.tsx:84`, `triggers/http-route-card.tsx:35`
  - `tokens-page.tsx:52`, `invites-panel.tsx:37`, `security-page.tsx:220`
- **Write controls without role gating:** only the code page (`useCanDeploy`) and the export button check the
  role. Viewers and developers still see Save on env, secrets, domains, triggers, settings and promote.
- **Scenario:** a developer saves a secret, or a viewer promotes a version. The server correctly returns 403 and
  the UI does nothing: no message, and a dialog may stay open.
- **Fix:**
  - Make the `default` branch toast `err.message` (or "You don't have permission…" for `forbidden`), and opt out
    with `meta.skipGlobalError` where errors are shown inline.
  - Add a `useProjectRole(org, project)` hook. Hide or disable write controls that `authz` would deny.

**I4. Logout keeps the previous user's data in the query cache.**
- **Where:** `web/src/hooks/auth.ts:61-66`, `components/layout/account-menu.tsx:21`.
- **Scenario:** logout only clears the CSRF token. User A logs out, then user B signs in in the same tab (SPA
  navigation, no reload). B's first render shows A's cached `["me"]`, `["orgs"]`, `["apps",…]`, members, tokens
  and audit, until each query refetches. `useIsInstanceAdmin` reads the cached `["me"]`, so admin ⌘K entries
  show for B. This exposes data across users on shared machines. It also matches 13b parked "logout clearing
  untested".
- **Fix:**
  - Call `queryClient.clear()` in `useLogout`'s `onSettled`, and on any 401 → login redirect (or do
    `window.location.assign('/login')`).
  - Also clear on login/MFA success.
  - Add the parked test.

**I5. The runtime HTTP client has no timeouts.**
- **Where:** `cmd/rtweb/serve.go:43` creates `runtime.New(cfg.RuntimeURL, &http.Client{})` with no dial,
  TLS-handshake or response-header timeout.
- **Scenario:** a runtime that accepts TCP but stalls (GC pause, overloaded node, half-open connection) causes
  three problems:
  - Browser requests hang instead of returning `502 runtime_unavailable` (Review Focus #3).
  - `domains.RunChecker` (`internal/domains/verify.go:190`) and `keys.RunRetrier` (`internal/keys/keys.go:319`)
    run under the process ctx and block forever. TXT-missing deactivation, reconcile and pending key revokes
    stop with no error.
- **Fix:**
  - Use a `Transport` with `DialContext` timeout 5 s, `TLSHandshakeTimeout` 5 s and `ResponseHeaderTimeout` of
    about 30 s. Keep the overall `Timeout` off for SSE and build waits.
  - Wrap each `CheckOnce` / `RetryPendingRevokes` pass in `context.WithTimeout`.

**I6. The editor budget (§7.5) is not met: 1.53 MB gz against a limit of 900 KB.**
- **Where:** `web/src/components/features/editor/ts-worker.ts:7-18`. It bundles the full `typescript` compiler
  plus `lib.dom*` and every `lib.es20*`. The worker alone is 1.35 MB gz (1.03 MB brotli), so the 900 KB target
  is not reachable with an in-browser `typescript` compiler at all.
- **Effect on CI:** `make ci` runs `budget`, so CI is red.
- **Needs your ruling:**
  - (a) Raise the editor budget in the spec. §5 asks for in-browser TS, which conflicts with §7.5.
  - (b) Load the TS worker only on explicit request or idle, and exclude it from the budget.
  - (c) Drop in-browser type checking and rely on the server's build diagnostics.
- **Independent of the ruling:** remove `lib.dom*` (guest code has no DOM; it also hides wrong `document` usage)
  and trim the ES libs to the target.

**I7. Spec features are missing from the console.**
- **Default-key rotation (D5; §2 owner/admin):** the API exists (`internal/api/routes_org.go:262`,
  `POST /api/orgs/{org}/default-key/rotate`), but there is no UI anywhere in `web/src`.
  - **Fix:** add a "Rotate default key" action with a confirm dialog to `$org.settings.tokens` (owner/admin).
- **Instance-admin "impersonating an org (acts as org owner, audited)" (§2):** this is in neither the plan, nor
  `api-web.md`, nor the code. The plan dropped it silently, so it needs an explicit ruling (defer to v1.1, or
  build it).

**I8. The full-suite gate (§7.7/§7.8) is incomplete.**
- **Task 16 (UI/UX review) has not run.** There is no `docs/reviews/ui-ux-review.md`, and 375 px was never
  browser-checked (ledger 14a). So the half of §7.7 that says "UI/UX review findings triaged with every must
  fixed" is not met.
- **`make ci` cannot pass as written:**
  - `Makefile:33` chains `e2e` (docker) and `budget`, which fails on I6.
  - The e2e smoke test (`e2e/smoke.spec.ts`) has never run against a live stack.
  - The e2e test does not do the "saves" step of §7.1.
  - The e2e test does not cover the verified-domain positive path of §7.4 (TODO at the end of the file).

### Minor

1. **Apps beyond the first 200 show "App not found".** `web/src/routes/$org.apps.$app.tsx` finds the app in
   `useApps` (`hooks/orgs.ts:72`, `limit=200`; ledger 14a). Use `GET …/apps/{app}` (`useAppView`) for the
   layout.
2. **A failed audit write skips domain cleanup.** In `internal/api/routes_apps.go:303-306`, a failed
   `app.delete` audit write returns 500 before `Domains.RemoveApp` runs. The app is gone but its domains are
   orphaned (feeds SR-07). Run `RemoveApp` before returning the audit error.
3. **Stale grants survive project deletion.** Ledger 8a parked: `apps.Service.CreateProject` does not purge
   grants for the slug, so grants left by a failed `DeleteProject` cleanup re-activate on slug reuse. The fix is
   cheap (delete grants for `(org, slug)` on create), and recommended since it is authz-relevant.
4. **Token Copy gives no feedback.** `tokens-page.tsx:223`: `navigator.clipboard.writeText` has no
   success/failure feedback and no `catch` (it rejects on insecure origins). The same applies to the admin
   temporary-password copy, if it uses the same pattern.
5. **The log viewer grows without bound.** In `logs/use-log-stream.ts`, the pause buffer and the `seenRef` set
   are unbounded on long sessions. Cap them at `MAX_LINES`. A 401 on the EventSource shows "closed" with no
   redirect to login.
6. **Unmatched `Last-Event-ID` loses logs silently.** Ledger 8d: the server sends no `gap` event, so the UI's
   gap banner (`use-log-stream.ts`) never fires for that case. Emit `event: gap` when the id is unknown.
7. **Env editing has no concurrency guard.** `env-editor.tsx` PUTs the full env map with no `If-Match` or
   version, so concurrent edits lose updates silently. The spec does not require it; note it or add a
   GET-time hash.
8. **Wrong comment.** `components/features/tokens/scopes.ts:2-3` says "the default key holds" `keys:write`. The
   spec (D4) says the default key holds every scope *except* `keys:write`.
9. **D9 not reflected.** There is no reserved "SDKs" area in the UI. Add a placeholder nav entry or record the
   deviation.
10. **Version mismatch.** `@tanstack/router-plugin` 1.168.42 vs `@tanstack/react-router` 1.170.41 (ledger 13b).
11. **Stale comment.** `components/ui/toast.tsx:3` says the Toaster is mounted in `main.tsx`; it is in
    `routes/__root.tsx`.
12. **Thin HTTP authz test.** `TestEveryRouteChecksAuthz` (`internal/api/routes_org_test.go:28`) accepts any of
    401/403/404 for a stranger. It proves a gate exists, not the right status. §7.2's HTTP-level matrix is
    covered only for reads (see §7 below).

## Ledger triage: every "minor (deferred)" / "parked" / open carry

Legend: **Fix before merge** · **Post-merge** (acceptable for v1, track) · **Resolved** (verified in code).

| Ledger line | Ruling | Note |
|---|---|---|
| T1: dev-local skips BASE_DOMAIN validation; LOG_LEVEL in main | Post-merge | Dev only |
| T2: down-migration order; goose globals; DSN path unescaped; Tx ignores rollback err | Post-merge | |
| T3a: ctx-cancel untested; Retry-After HTTP-date; usage from/to + limit params; body-etag fallback untested | Post-merge | from/to carried to 11b/T9 |
| T3b: secrets empty value, env key validation, queue_full/1MB/delay, FailNext/host TTL untested | Post-merge | |
| T4a: limiter check+record not atomic; trailing-slash allow-list; rate-limited path does user lookup | Post-merge | Allow-list is exact match (`mustchange.go:15`). The lookup is a minor timing oracle. |
| T4b: enroll race ugly error; limiter keyed by user only | Post-merge | Lockout needs the password |
| T4b: CompleteMFA pending-delete + create not in one Tx | Post-merge | SR-03 immediate tx reduces the window |
| T4b: Disable route must pass currentSessionID | Resolved | `routes_account.go:167` passes `p.SessionID` |
| T5b carry: sso_not_configured → 422 fields | Resolved | `internal/api/errors.go:101` |
| T6: hookInsert seam; weak email validation; self-reset kills own session (UI should warn) | Post-merge | No self-reset warning in `users-page.tsx`. Low impact. |
| T6: ResetPassword rollback untested; slug-unique by driver text; owner check outside tx; orphan tenant | Post-merge | |
| T6b: disabled-account signal; ValidatePassword wrap | Post-merge | |
| T7 carry: token LastUsedAt not tracked | Post-merge | |
| T7: lastOwnerGuard assumes BUSY on deferred tx; beforeSwap deadlock (test-only) | Post-merge | Re-check the assumption now that `_txlock=immediate` (SR-03). Tests pass. |
| **T8a parked: DeleteProject grant cleanup can leave stale grants** | **Fix before merge (recommended, cheap)** | Minor 3: purge grants on CreateProject |
| T8a: invites concurrent-accept flake | Resolved | SR-03, `-count=50 -race` ok; passed here |
| T8b: zip lying-header; full unmarshal; mutable test vars; duplicate JSON keys | Post-merge | |
| T8c: schedule patch TOCTOU; payload cannot be cleared; secret-echo test weak | Post-merge | |
| T8d: idle-timer race; **unmatched Last-Event-ID silent loss**; idle upstreams count to cap; close indistinguishable; no red run | Post-merge | Fix the gap event soon (Minor 6). The UI already handles `gap`. |
| T9: outcome audit uses request ctx | Post-merge | Known (security review) |
| T10: isUnique by error string; checkPending miss count | Post-merge | |
| T11a: runtime 422 passed raw | Post-merge (by spec) | |
| T11a: uploads > 60 s ReadTimeout fail; extra Lookup; timeouts untested | Post-merge | 10 MiB on a slow link. Document it. |
| T11a carry: RTWEB_TRUSTED_PROXIES / Makefile dist copy / MFA cookie MaxAge | Resolved | SR-02; `make web-embed` |
| T11b: usage N+1; admin users paged in memory; settings validation outside Tx | Post-merge | |
| **T11c parked: domains orphan sweep (SR-07)** | Post-merge | Runtime hosts are keyed by `svc_` id, so a reused slug does not get the runtime route. The router still holds a route for a stale host (`domains.go:405`, slug-keyed) and may request ACME certs for it. Fix Minor 2 now, add the sweep after merge. |
| T11d concern: app routes via orgRoute with empty project may 403 | Resolved | `appRoute` delegates to the services |
| T11d: invites flake under load | Resolved | SR-03 |
| T11e: discovery cache global/unbounded | Resolved | SR-08 |
| T11e: SetProvider rejects empty issuer when disabled; id_token not verified | Post-merge | Ruled acceptable (userinfo over TLS) |
| T11f: revoke-others count race; **enroll w/o password**; optionalCallerID swallows DB errors | Post-merge | Enroll without re-auth lets a session thief turn on 2FA and lock the owner out. Admin reset recovers. Require the password in v1.1. |
| T12a: first retry 10 s; untested backoff; env docs | Post-merge / Resolved | `.env.example` documents ROUTER_* |
| T12b: redirect via client Host | Resolved | SR-05 |
| T12b: ROUTER_TLS off docs; raw ACME error forwarded; StorageDir fallback; comment | Post-merge / Resolved (docs) | |
| T13a: focus-ring test asserts classes; eslint legacy; npm ci lockfile guard | Post-merge / Resolved (npm ci) | |
| **T13b parked: no tests for stale Reload, focus-key, put/patch default body, logout clearing** | **Fix before merge (logout part)** | Logout does not clear the cache: I4 |
| T13b: /api/me refetched per signed-out navigation; router-plugin version | Post-merge | Minor 10 |
| T14a: useApps cap 200; slug flash; template cards only on new-app page | Post-merge | Minor 1 is the cheap fix |
| T14b: TS worker exempt from first-route budget | **Fix before merge (needs ruling)** | I6: the spec counts the worker in the editor budget |
| T15a carry: ⌘K admin filter | Resolved | `settings-registry.ts:24` |
| T15b carry: apply admin gate to 15b routes | Resolved | `fe14e9f` (unsigned, B1) |
| T17: OAuth DNS-rebinding; ci needs network for govulncheck | Post-merge | |
| SR-04 setup token in logs (ruled intended) | Post-merge | |
| T18 gaps: no healthchecks (distroless); verified-domain e2e missing; e2e inside `make ci`; live smoke not run | **Fix before merge: run the live smoke.** Split `ci` (no docker) from `ci-full`. | §7.1, §7.4 |
| Known: app-shell/auth-pages flaky under load | Resolved here | 130/130 |
| **PROBLEM: 7 unsigned commits** | **Fix before merge** | B1 |

## §7 success criteria

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| 1 | compose → /setup → admin, org, user → app from HTTP template, save → 200 within 15 s (Playwright) | **Unverified** | `e2e/smoke.spec.ts` exists but has not run on a live stack. It creates the app but never saves code. CSP issue I1 would not fail it (2FA is enrolled via API). |
| 2 | Viewer on A: 403 on every mutation of A, 404 on B (full action × role table tests) | **Partially met** | `authz.TestCanMatrix` covers the action × role table at the authz layer. Handler→action wiring was verified by reading. The HTTP test (`TestProjectOnlyViewerScopedToProject`) checks only GET 200 on A and 404 on B. No HTTP test asserts 403 for each mutation route as a viewer. |
| 3 | Custom token created, shown once, revoked → runtime 401; rotate default key keeps custom tokens | **Met (fake runtime) / UI partial** | `keys.TestRevokedTokenRejectedByRuntime`, `TestRotateDefaultKeepsCustomTokens`. The UI shows the secret once and revokes. There is no rotate UI (I7). Not checked against the real runtime. |
| 4 | Verified custom domain served via rtrouter; unverified gets no cert, no route | **Not met (positive) / unverified (negative)** | The e2e negative path is written but has not run. The positive path is a TODO in `smoke.spec.ts`. The router unit tests cover the `ask` hook. |
| 5 | rtweb ≤ 30 MB, RSS ≤ 40 MB, first route ≤ 250 KB gz, editor+worker ≤ 900 KB gz | **Not met** | Binary about 20 MB (met, estimate). First route 118 KB (met). Editor 1.53 MB gz (**fail**, I6). RSS unverified. |
| 6 | Enroll TOTP → login requires code; used code rejected; revoke session logs out; expired/used invite fails | **Met (server tests) / UI degraded** | `TestLoginRequiresTOTPWhenEnabled`, `TestTOTPReplayRejected`, `TestRevokeOtherSession`, `TestInviteExpired`, single-use accept. In production the QR image is blocked by CSP (I1). |
| 7 | Security review: no open high; UI/UX review triaged, every must fixed | **Not met** | Security: SR-01 (High) fixed in `b5260cb`, none open. The web tasks landed after that review, which is why this review covers them. UI/UX review (Task 16): **not done** (I8). |
| 8 | `go test -race`, gofmt + vet, npm test, lint, build, Playwright all pass in `make ci` | **Not met** | All local steps pass. `make ci` fails at `budget` (I6), and Playwright has not run. |

## Declined to judge

- **Runtime-side behavior** (whether `/s/{slug}/` sets `X-Frame-Options` and so blocks the preview iframe;
  real 401 for a revoked key): outside this repo. Verify in the live smoke run.
- **Go packages that passed per-task reviews** (store/sqlc, runtime client typing, router TLS/certmagic, OAuth
  flows) were re-read only where they touch integration, because each had a clean per-task review. I did not
  re-derive argon2 params or invite-token entropy.
- **Visual design, IA and copy against competitors:** that belongs to Task 16, which has not run.
- **Mobile layout at 375 px:** not browser-checked here (Task 16).
- **Performance of the in-browser TS linter** (500 ms debounce, whole program per keystroke): not measured.

## Assessment

**Ready to merge: with fixes.**

The server side is solid. Authz delegation is consistent, CSRF, Origin and If-Match are correct, and the tests
are green under `-race`. The web console is careful about XSS and about showing secrets. Before merge:

- **Production defects:** fix the CSP (I1), lost keystrokes (I2), silent mutation errors (I3) and cross-user
  cache on logout (I4).
- **Runtime client:** add timeouts so a stalled runtime cannot hang requests and background loops (I5).
- **Spec decisions for you:** the editor budget (I6), plus the missing rotate UI and impersonation (I7).
- **Release gates:** re-sign the unsigned commits (B1), run Task 16, and run the live e2e smoke (I8).

## Fixes

Signing was blocked (1Password: "failed to fill whole buffer"), so nothing is committed. Each group is staged
in the worktree and also saved as a patch in `.fixes/NN-name.patch`, with its commit message in `NN-name.msg`.
Apply the patches in numeric order (they stack). Check it with `git apply --index` on a clean `HEAD`, which
reproduces the staged tree.

| Item | Patch | Regression test |
|---|---|---|
| I1 CSP (`img-src 'self' data:; style-src 'self' 'unsafe-inline'`) | `01-csp` | `internal/api` `TestSPAHasCSP` |
| I5 runtime HTTP timeouts (control: 30 s overall; streams: no overall timeout, 15 s response header; dial/TLS 5 s) | `02-runtime-timeouts` | `internal/runtime` `TestDefaultHTTPClientsHaveTimeouts`, `TestControlCallTimesOutButStreamDoesNot` |
| T8a (minor 3): purge stale grants on `CreateProject` | `03-stale-grants` | `internal/apps` `TestCreateProjectPurgesStaleGrants` |
| T18 / I8: `make ci` without docker, `ci-full` = ci + e2e; smoke saves code (PUT files) and runs the verified-domain positive path via the dev-only `PUT /api/admin/dev/dns-override` (RTWEB_DEV=1, instance admin, resolver read on every lookup) | `04-ci-e2e-dev-dns` | `internal/api` `TestDevDNSOverrideRoute`, `TestDevDNSOverrideRouteAbsentOutsideDev`; `internal/domains` `TestDevResolverSetIsReadOnEachLookup`; `e2e/smoke.spec.ts` (not run, no stack) |
| I6 (ruling): the editor chunk (≤ 900 KB gz) excludes the lazy TS worker; the worker has its own budget (≤ 1.5 MB gz); spec §7.5 updated | `05-budget` | `scripts/budget-measure.test.js` (run by `make budget`) |
| I2 editor: a save moves only the dirty baseline and keeps edits typed while it runs | `06-editor-save` | `code-editor.test.tsx` "keeps text typed while a save is in flight" |
| I4 query cache cleared on logout, login/MFA/setup and 401 redirect | `07-logout-cache` | `app-shell.test.tsx` "logout clears the query cache…", "a 401 redirect to login clears the query cache" |
| I3 global mutation toasts (forbidden, conflict, internal, invalid without fields; opt out via `meta.skipGlobalError`); role gating via `hooks/authz.ts` (`useCan`) on app settings, env, secrets, domains, triggers and versions (members and tokens were already gated); env, secrets and domains panels mounted on app Settings (they were not routed anywhere) | `08-mutation-errors-role-gating` | `lib/query.test.ts` "global mutation errors"; `test/role-gating.test.tsx` (viewer sees no Save/Delete; developer sees env only; triggers disabled for viewer; a 403 shows a toast) |
| I7 (ruling): "Rotate default key" in org settings → General (owner/admin, slug typed to confirm, success toast); spec §2 now says "acts as owner in any org (audited)" | `09-rotate-default-key` | `test/rotate-default-key.test.tsx` |

Verification (worktree, all patches applied): `go test -race ./...` ok, `go vet` ok, gofmt clean, `npm run lint`
ok, vitest 145/145 on both runs, `npm run build` ok. `scripts/budget.sh`: binary 12.9 MB, first route 118.6 KB
gz, editor 170.9 KB gz, TS worker 1.36 MB gz, all pass. RSS skipped (no container).
