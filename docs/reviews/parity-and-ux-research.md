# Parity and UX research: Dokploy, Workers, val.town, Vercel/Railway vs Runtime Web v1

Date: 2026-10-22. Inputs: `docs/02-design-v1.md`, `docs/00-research-and-design.md`, `docs/superpowers/plans/2026-10-22-runtime-web-v1.md`, `../runtime-copy/openapi/openapi.json`, `../runtime-copy/docs/api.md`. Dokploy shallow clone (untrusted, not executed) at the session scratchpad `dokploy/`.

Note: section 2 is drawn from product knowledge of these dashboards (as of mid-2026), not from fresh web fetches in this pass.

## 1. Dokploy inventory (paths relative to the clone root)

| Area | What Dokploy has | Where |
|---|---|---|
| Auth library | better-auth with plugins `twoFactor()`, `passkey()`, `apiKey()`, `sso()`, `organization()`, `admin()` | `packages/server/src/lib/auth.ts:2-10,465-502` |
| Social login | GitHub, Google, plus DB-configured providers | `lib/auth.ts:102-113` |
| SSO enforcement | when SSO is enforced, password, social and passkey sign-in are disabled | `lib/auth.ts:138-148`; schema `db/schema/sso.ts`, `scim.ts` |
| 2FA UI | enable (QR + backup codes), configure, passkey management, delete account | `apps/dokploy/components/dashboard/settings/profile/{enable-2fa,configure-2fa,manage-passkeys,delete-account}.tsx`; CLI `apps/dokploy/reset-2fa.ts` |
| API keys | `x-api-key` header → user + org membership; metadata holds organizationId | `lib/auth.ts:536-611`; UI `settings/api/{add-api-key,show-api-keys}.tsx` |
| Sessions | list/revoke page | `pages/dashboard/settings/sessions.tsx`, `components/dashboard/settings/sessions/show-sessions.tsx`; `db/schema/session.ts` |
| Roles | org role owner/admin/member (+ custom `organization_role` table) | `db/schema/account.ts:76-91,196` |
| Fine permissions | per-member booleans `canCreateProjects/Services`, `canDelete*`, `canCreate/DeleteEnvironments`, `canAccessToAPI/Docker/SSHKeys/GitProviders/TraefikFiles`, plus `accessedProjects[]`, `accessedServices[]` | `db/schema/account.ts:131-170` |
| Invitations | invite by email with role, list/cancel pending | `settings/users/{add-invitation,show-invitations,add-permissions,change-role}.tsx` |
| Audit | `audit_log(action, resource_type, resource_id, resource_name, …)` + page | `db/schema/audit-log.ts`; `pages/dashboard/settings/audit-logs.tsx` |
| Logs/monitoring | per-service logs, deployments with build log, request logs page (Traefik access log), monitoring page, logs-and-metrics settings | `pages/dashboard/{requests,monitoring,deployments}.tsx`, `components/dashboard/application/{logs,deployments,rollbacks}` |
| Networking | Traefik; domain row has `https`, `certificateType` (none/letsencrypt/custom), `customCertResolver`, `stripPath`, `middlewares[]`; redirects table; DNS providers for DNS-01; custom certificates | `db/schema/domain.ts:32-57`, `redirects.ts`, `dns-provider.ts`, `certificate.ts`, `packages/server/src/utils/traefik/*` |
| Notifications | Slack/Telegram/Discord/email/etc. with event toggles appDeploy, appBuildError, backups, restart, dockerCleanup, serverThreshold | `db/schema/notification.ts:15-43` |
| Settings pages | profile, users, sessions, audit-logs, sso, certificates, dns, notifications, git-providers, registry, ssh-keys, servers, server, tags, secrets, whitelabeling, logs-and-metrics, ai, billing, license | `apps/dokploy/pages/dashboard/settings/*.tsx` |
| UI structure | sidebar (projects, monitoring, deployments, requests, schedules, traefik, docker, swarm, settings) → project → environment → service; service tabs general, environment, domains, deployments, rollbacks, logs, schedules, advanced, patches, preview-deployments, volume-backups | `pages/dashboard/*`, `components/dashboard/application/*` |

Takeaways for us: Dokploy's security baseline is TOTP+backup codes, passkeys, session list/revoke, API keys, SSO enforcement, audit page and pending-invitation management. Its per-member boolean permissions are more granular than needed; our role × project-grant model (Task 5) is simpler and adequate.

## 2. UX best practices (Cloudflare Workers, val.town, Vercel, Railway)

- **Navigation**: left sidebar scoped to the current org, with an org switcher at the top (Vercel/Railway team switcher); breadcrumb org / project / app; app page with tabs; settings as a left sub-nav, not one long page.
- **⌘K palette**: jump to any app/project/setting, plus actions ("New app", "Rotate key"). Vercel, Railway, val.town all have it. Cheap with `cmdk` (~10 KB).
- **Empty states**: every list has a one-line explanation and a primary CTA (val.town "Create your first val" with templates; Workers "Create application" with Hello World). Templates on first-app creation.
- **Deploy feedback**: Save → inline status pill (building → live / failed) with the build log one click away; toast with "View version" and the live URL; Workers shows the URL plus a copy button right after deploy.
- **Logs**: live tail with pause/resume, level filter, search, "jump to now", timestamps in local time, auto-reconnect indicator (Workers real-time logs, Railway).
- **Rollback**: versions list with "Promote"/"Rollback to this" on each row, a diff/source view, a confirmation naming the version (Vercel Instant Rollback, Workers Deployments tab).
- **Tokens UI**: name, scope picker with a summary, optional expiry, shown once with a copy button and a warning, last-used column, revoke (Cloudflare API tokens, Vercel).
- **Domain wizard**: steps Add host → show DNS records (TXT + CNAME/A) with copy buttons → live "Checking…" status with retry → Active + certificate state (Vercel, Workers custom domains).
- **Danger zone**: red-bordered section at the bottom of settings; delete needs the slug typed in; transfer/rename separated from delete (GitHub, Vercel, Railway).
- **Optimistic concurrency**: Railway and Vercel show "changed elsewhere, reload" rather than silently overwriting.

## 3. Gap analysis

### (a) Simple yet exposes all runtime functionality

| Runtime endpoint / feature | Planned UI | Status |
|---|---|---|
| tenants, tenant keys (root) | org create (Task 6), default key (Task 7) | covered |
| `/v1/keys` | org tokens (Task 7/14) | covered; **scope/service/expiry picker not specified** |
| projects CRUD, `/projects/{p}/environments` | projects (Task 8) | projects covered; **environments not surfaced in UI** (app create takes `environment` but no selector/list described) |
| services CRUD, `live`, versions, source | Code/Versions tabs (Task 8/14) | covered |
| `versions/{v}/build/logs` | API route listed in Task 11 | **no UI test** for build-log viewer |
| `versions/{v}/rebuild` | none | **unmapped** |
| `env`, `secrets` | Settings tab | covered |
| `schedules` CRUD, `queue` list/enqueue, `dlq` list/delete/redrive | Triggers tab | covered by service; **no UI tests** for DLQ redrive/purge |
| `logs` (stream) | Logs tab | covered; tail UX unspecified |
| `stats` | Task 8 `Stats` | **no UI placement** (app overview metrics) |
| `events` | none | **unmapped** (service events/audit stream from runtime) |
| `hosts` | domains (Task 10) | covered |
| `data/export` | Task 8 `ExportData` | **no UI button/test**; developer must be denied (authz has it) |
| `scaling` (min/max_instances, max_queued) | Settings "scaling" | named only; no form/test |
| `access` public/key/internal | Settings "access" | named only; no test that `key` mode links to invoke-token creation |
| `call.allowed_callers` | Task 8 `Update` | **no UI** |
| `ingress` (allowed_methods, allow_paths, ip_allow CIDRs, rate_limit) | none | **unmapped** |
| `egress` | none | **unmapped** |
| `limits` per service (cpu_ms, memory, timeouts), `profile`, `effective` with sources | none | **unmapped** (show `effective` read-only + edit) |
| `status` {build_state, tier, inflight, last_error, admission} | none explicit | **unmapped**; app header status pill |
| `/v1/limits`, `/v1/me` | quota bar (D3) | covered read-only |
| `/tenants/{t}/usage` | admin `OrgUsage` | admin only; **org owners can't see usage** |
| `/v1/plans` | intentionally hidden (D3) | ok |
| node status/config/scheduler/cache/drain, version | admin (Task 9/15) | covered; cache has no UI test |

### (b) Multi-user / multi-org / multi-project collaboration

- Invites: design D2 mentions "invite link" but no plan task implements it (`invite` count 0 in plan). Gap.
- Grants: covered (Task 7).
- Org switcher: not specified in Task 14. Gap.
- Audit: written (Task 6) but **no audit-log UI or API route** for org owners or admin. Gap.
- Concurrent edits: runtime PATCH supports `If-Match` / `etag`; plan uses ETag only for router routes. Two developers saving the same app or settings will silently overwrite. Gap.
- Presence ("X is editing") and version author attribution: versions don't record which web user saved them. Should.

### (c) Security parity with Dokploy

| Control | Dokploy | Plan | Gap |
|---|---|---|---|
| Password + rate limit + no enumeration | yes | Task 4 | none |
| TOTP 2FA + recovery codes | yes | none | **must** |
| Admin-enforced 2FA | partial | none | should |
| Passkeys | yes | none | could (v2) |
| OAuth/OIDC | yes | Task 11b (linking only) | ok |
| SSO enforcement (disable password) | yes | none | should (setting flag) |
| Session list / revoke / revoke-all | yes | none | **must** |
| Audit log UI | yes | none | **must** |
| Login history (success/fail, IP, UA) | via sessions | none | should |
| Invitations with expiry | yes | none | **must** (D2 promises it) |
| Personal API keys | yes | org tokens only | ok for v1 |
| 2FA reset CLI | `reset-2fa.ts` | none | should (`rtweb admin reset-2fa`) |

### (d) Lightweight

Budgets exist (binary ≤ 30 MB, RSS ≤ 40 MB, first-route JS ≤ 400 KB gzip; Task 18 `scripts/budget.sh`). Adding TOTP (`pquerna/otp` or ~80 lines stdlib HMAC), cmdk (~10 KB) and an audit table keeps us well inside. Suggest tightening first-route JS to ≤ 250 KB gzip and adding a per-lazy-chunk cap for the editor (≤ 900 KB gzip) so the TS worker doesn't grow unchecked. Dokploy (Next.js + Postgres + Redis + Traefik) is far heavier; our SQLite + single binary is the differentiator, so keep it.

## 4. Proposed plan changes

### Must

1. **Task 2**: add tables `user_totp(user_id, secret_sealed, enabled_at)`, `recovery_codes(user_id, hash, used_at)`, `invites(id, email, org_id?, role, token_hash, expires_at, used_at, created_by)`, `login_events(id, at, user_id?, email, ip, ua, result)`; `sessions` gains `ip, ua, last_seen_at`. Tests: `TestRecoveryCodeSingleUse`, `TestInviteTokenStoredHashed`.
2. **Task 4**: TOTP 2FA. Login becomes two-step (password → `mfa_required` pending session → code or recovery code). Tests: `TestTOTPEnrollRequiresValidCode`, `TestLoginRequiresTOTPWhenEnabled`, `TestTOTPReplayRejected` (same code within window), `TestRecoveryCodesShownOnceAndConsumed`, `TestTOTPRateLimited`, `TestDisableTOTPRequiresPasswordAndCode`. Plus session management: `TestListOwnSessions`, `TestRevokeOtherSession`, `TestRevokeAllExceptCurrent`, `TestPasswordChangeRevokesOtherSessions`, `TestLoginEventsRecorded` (success, bad password, bad TOTP).
3. **Task 6/7**: invites. Admin creates invite link (optionally pre-bound to org + role); 7-day expiry; single use; accept page sets password. Tests: `TestInviteAcceptCreatesUserAndMembership`, `TestInviteExpired`, `TestInviteReuseRejected`, `TestInviteRevoke`.
4. **Task 11**: routes `GET /me/sessions`, `DELETE /me/sessions/{id}`, `POST /me/sessions/revoke-others`, `POST /me/totp/{enroll,confirm,disable}`, `POST /me/recovery-codes`, `GET /me/logins`, `POST|GET|DELETE /invites`, `POST /invites/{token}/accept`, `GET /orgs/{org}/audit` (owner/admin, paginated, filter by actor/action), `GET /admin/audit`. Tests: `TestAuditVisibleOnlyToOrgAdmins`, `TestAuditCrossOrg404`, `TestInviteAcceptNoCSRFBypass`.
5. **Task 8/11 (concurrency)**: pass the runtime service `etag` through as `ETag` on `GET /…/apps/{app}` and require `If-Match` on `PATCH` and `PUT /files`; map runtime 412 to `409 conflict`. Tests: `TestPatchAppStaleEtag409`, `TestSaveFilesStaleEtag409`, `TestPatchWithoutIfMatch428`.
6. **Task 8 + 14 (runtime coverage)**: Settings tab adds forms for `scaling`, `access`, `ingress` (methods, path prefixes, ip_allow CIDRs, rate_limit), `egress`, `call.allowed_callers`, per-service `limits`/`profile` with `effective` shown and its source. App header shows `status` (build_state, tier, last_error). Web tests: `access key mode prompts invoke token`, `ip_allow rejects invalid CIDR client-side`, `allowed_callers picker lists org apps`, `effective limits show source`, `status pill shows last_error`. Go tests: `TestUpdateIngressValidatesCIDR`, `TestUpdateBlockReplacesNotMerges` (documents runtime semantics in UI).
7. **Task 14/15 (UI)**: audit log page (org settings + admin), sessions & security page (2FA enroll with QR, recovery codes download/print, session list), invites list. Tests: `security page lists sessions and revokes`, `2fa enroll shows QR then recovery codes once`, `login asks for TOTP code when mfa_required`, `audit page filters by actor`, `pending invites can be revoked`.

### Should

8. **Task 8/14**: Versions tab adds "Rebuild" (`versions/{v}/rebuild`) and build-log viewer; DLQ purge/redrive UI; Data export button (owner/admin/project admin only); app Overview with `stats`; Events panel from `/services/{s}/events`. Tests: `rebuild failed version shows new build log`, `dlq redrive requires confirmation`, `export hidden for developer`, `TestEventsPassthroughScoped`.
9. **Task 14**: org switcher, ⌘K palette (apps, projects, settings, actions), empty states with templates, environment selector on app create and a project environments list. Tests: `cmd+k navigates to app`, `org switcher changes scope and clears query cache`, `empty project shows create-app CTA`.
10. **Task 14 (logs/deploy)**: log tail pause/resume, level filter, reconnect indicator; Save shows build → live pill with link to build log; rollback confirm names the version. Tests: `logs pause buffers new lines`, `save shows building then live`, `rollback dialog names target version`.
11. **Task 7/14 (tokens)**: token create form with scopes, service restriction and optional expiry; list shows last-used if runtime exposes it. Test `TestTokenScopesSubsetOfCreator` (a project admin cannot mint broader scopes than their grant).
12. **Task 9/15**: org owners see their own usage (`/tenants/{t}/usage` via root cred, scoped); admin cache view test. Test `TestOrgOwnerSeesOwnUsageOnly`.
13. **Task 4/15**: instance setting "require 2FA for all users" and "disable password login when OIDC configured"; CLI `rtweb admin reset-2fa --email`. Tests: `TestRequire2FAForcesEnrollmentAfterLogin`, `TestPasswordLoginDisabledWhenSSOEnforced`.
14. **Task 8**: record `web_user_id` per saved version (local table `version_authors`) and show author in Versions. Test `TestVersionAuthorRecorded`.
15. **Task 18**: tighten budgets to first-route JS ≤ 250 KB gzip, editor chunk ≤ 900 KB gzip; budget script checks each.

### Could (defer to v2)

Passkeys (WebAuthn), notifications (webhook/Slack on build failure, DLQ growth), redirect rules per domain, request-log view, presence indicators.
