# Runtime Web HTTP API (v1 contract)

This is the contract between the `rtweb` service (`server/src/routes/`, a TypeScript backend that runs as an App
on 21 Cloud Runtime) and the React console (`web/`). Handlers and MSW mocks are both written from this file, and
`server/test/contract.test.ts` fails when a route listed here is not registered. When the code and this
file disagree, fix one of them in the same PR.

Names: `{org}` is the **org slug**, `{app}` is the **app slug**
(resolved to the runtime `svc_` id by the apps lookup), `{project}`/`{p}` is the **project slug**, and project
grants are keyed by project slug. The word "service" never appears in this API. "App" is the user-facing
name.

## 1. Conventions

### 1.1 Base, encoding, time

- Every route lives under `/api`, except `GET /healthz` and the SPA.
- Request and response bodies are `application/json; charset=utf-8` unless the route says otherwise.
- Timestamps are **unix milliseconds** (`number`). Runtime timestamps pass through unchanged, and the web's
  own rows (`created_at`, `at`, …) use the same unit.
- Ids are opaque strings with a prefix (`usr_`, `org_`, `inv_`, `tok_`, `dom_`, `aud_`, `lev_`).
- In the TS shapes below, `?` means the field may be absent, and `| null` means it is present and may be null.

### 1.2 Auth, cookies, CSRF, Origin

- **Session cookie:** `__Host-rtw_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`). With
  `RTWEB_INSECURE_COOKIES=1` (local development only) it is `rtw_session` without `Secure`. The idle TTL is 7 days (sliding) and the absolute TTL is
  30 days.
- **MFA-pending cookie:** the same cookie name holds a 5-minute `mfa_pending` session after a password login
  for a user with TOTP. Only `POST /api/auth/mfa` accepts it. Every other route answers `401 unauthenticated`.
- **CSRF:** every non-GET/HEAD request with a session must send `X-CSRF-Token: <csrf>`. The value comes from the
  login, MFA and setup responses and from `GET /api/me` (`csrf`). Missing or wrong → `403 csrf_invalid`.
  Public routes without a session (`/api/setup`, `/api/auth/login`, `/api/auth/mfa`,
  `/api/invites/accept/{token}`) skip CSRF.
- **Origin:** every unsafe method (POST, PUT, PATCH, DELETE), including the public ones, must carry an
  `Origin` header equal to `RTWEB_ORIGIN`. Missing or foreign → `403 origin_invalid`. A `Sec-Fetch-Site`
  header other than `same-origin` or `none` is also `403 origin_invalid`, even with a matching `Origin` (apps
  run on a sibling host, so they are same-site). The internal routes (§9) are not browser routes and are exempt.
- **Bearer tokens:** the app routes, `/api/orgs/{org}/apps` and everything below it (§8, including domains, env,
  secrets, versions, schedules, queue and logs), also accept `Authorization: Bearer <token>` with a custom token
  (§7). A bearer request:
  - is verified against the stored SHA-256 of the token secret. An unknown, revoked or expired token, or one
    minted before bearer support, gets `401 unauthenticated`.
  - acts only in the token's org (another org is `404 not_found`) with the actions its scopes allow (§1.3).
    An app or `project` outside the token's `projects`, or an `environment` outside its `environments`, is
    `403 forbidden`. A token restricted to environments must pass `?environment=` when listing apps.
  - skips CSRF, Origin and the user gates, because it carries no cookie. A request with both a bearer token and
    a session cookie gets `400 ambiguous_credentials`.
  - is limited to 600 requests per minute per token (`429 rate_limited` with `Retry-After`).
  - is audited with the token id (`tok_…`) as `actor.user_id` and the token name as `actor.name`.

  Every other route that needs a session answers a bearer token with `403 bearer_not_allowed`: auth, `/api/me`,
  users, orgs, members, invites, tokens, projects, admin, branding and settings.
- **Gates** (applied in this order after the session is loaded):
  1. `must_change_password` → `403 password_change_required` on every route except `GET /api/me`,
     `PUT /api/me/password` and `POST /api/auth/logout`.
  2. Policy *require 2FA* and the user has no confirmed TOTP → `403 mfa_enrollment_required` on every route
     except `GET /api/me`, `POST /api/me/totp/*` and `POST /api/auth/logout`.
- The client sends `credentials: "include"`. On `401` it redirects to `/login?next=<path>`.

### 1.3 Authorization column

Each route lists one of:

- `public`: no session.
- `session`: any logged-in user (after the gates).
- `instance.admin`: instance admins only, otherwise `403 forbidden`.
- an action (`app.read`, …): checked with `can(subject, action, projectSlug)` (`server/src/authz/policy.ts`). For app routes the
  project is the app's `project`, and for project routes it is `{p}`.
- `asset-token`: `X-Rtweb-Asset-Token: <RTWEB_ASSET_TOKEN>` (install-time asset upload, §9).
- `loopback`: reached only from the node itself; the Caddy console site answers `404` for `/api/internal/*`.

Instance admins act as owner of every org. Each such use is audited with `as_instance_admin=1`.

A bearer token has no org or project role. Each action needs one token scope, and the project must be in the
token's `projects` (empty = every project):

| Action | Token scope |
|---|---|
| `app.read`, `project.read` | `services:read` |
| `app.create`, `app.update`, `app.delete`, `app.schedules.write` | `services:write` |
| `app.deploy` | `deploy` |
| `app.env.read`, `app.env.write` | `env:write` |
| `app.secrets.write` | `secrets:write` |
| `app.queue.write` | `queue:write` |
| `app.logs.read` | `logs:read` |
| `app.data.export` | `data:admin` |

Every other action, `domains.manage` included, is never allowed to a token. `invoke` and `sockets:write` only
apply to calls to the runtime.

**Visibility rule:** if the caller is not a member of `{org}`, or the app or project is outside their grants,
the answer is `404 not_found` (this also applies to an app of another org). If they can see the resource but
their role is too low, the answer is `403 forbidden`.

### 1.4 Error envelope

```ts
type ErrorBody = {
  error: {
    code: string;              // snake_case, stable; see §1.5
    message: string;           // human readable, may change
    details?: Record<string, unknown>;
  };
};
```

`details` shapes:

- `422 invalid` (web validation): `{ fields: Record<string, string> }`, keyed by the request field path
  (for example `"ingress.ip_allow[1]": "not a CIDR prefix"`).
- `422 <runtime code>` (for example `validation_failed`) and `422 build_failed` (save, §6.2): the runtime
  `details` / build failure passed through unchanged:
  ```ts
  type BuildDetails = {
    reason: string;            // VersionFailure.reason
    message: string;
    diagnostics?: Diagnostic[]; // runtime shape, passed through
    version?: number;          // the failed version, when one was created
  };
  type Diagnostic = { file?: string; line?: number; column?: number; message: string; severity?: string };
  ```
- `429` and `503 busy` also set the `Retry-After` header (seconds) and `details.retry_after` (seconds).

### 1.4a Security headers

Every response (SPA, assets, API, errors) carries `Content-Security-Policy: default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self';
object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; frame-src <app origin>`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`,
`Cross-Origin-Opener-Policy: same-origin` and a deny-all `Permissions-Policy`; plus
`Strict-Transport-Security: max-age=31536000; includeSubDomains` when `RTWEB_ORIGIN` is https.
`'unsafe-inline'` applies to styles only (CodeMirror and sonner insert `<style>` at runtime); inline script is blocked.
`frame-src` is the origin of `RTWEB_APPS_URL`, so the App page can preview the app in an
iframe; it is `'none'` when that variable is unset or names the console's own origin.

### 1.5 Error codes (global mapping, `server/src/http/errors.ts`)

| Status | `code` | Source |
|---|---|---|
| 401 | `unauthenticated` | no, expired or MFA-pending session |
| 401 | `invalid_credentials` | wrong email/password (login), wrong password (password change, 2FA disable, recovery codes) |
| 401 | `invalid_code` | wrong TOTP or recovery code at `/api/auth/mfa` (`auth.ErrInvalidCode`) |
| 422 | `invalid_code` | wrong TOTP code on `/api/me/totp/confirm` and `/disable` |
| 403 | `forbidden` | `apperr.ErrForbidden` (known resource, role too low) |
| 403 | `csrf_invalid`, `origin_invalid`, `password_change_required`, `mfa_enrollment_required` | middleware |
| 403 | `<code>` | `apperr.Forbidden{Code}`: `setup_token_invalid`, `password_login_disabled`, `plan_limit` |
| 404 | `not_found` | `apperr.ErrNotFound`, runtime 404, unknown `/api/*` path |
| 404 | `invite_invalid` | expired, used or revoked invite |
| 409 | `<code>` | `apperr.Conflict{Code}`: `already_set_up`, `last_owner`, `last_admin`, `slug_taken`, `org_not_empty`, `host_taken`, `pending_limit`, `stale`, `version_not_ready`, `totp_already_enabled`, `totp_not_enabled` |
| 409 | `stale` | runtime `412` (ETag mismatch) |
| 422 | `invalid` | `apperr.ErrInvalid` (+ `details.fields`) |
| 422 | `<runtime code>` | runtime 422 with its `code` and `details` |
| 422 | `build_failed` | save produced a failed build (+ `BuildDetails`) |
| 428 | `precondition_required` | `If-Match` missing (`apperr.ErrPreconditionRequired`) |
| 429 | `rate_limited` | `apperr.ErrRateLimited` (login, MFA, log-stream cap) |
| 429 | `rate_limited`, `build_quota`, `queue_full` | runtime 429, same code + `Retry-After` |
| 502 | `runtime_unavailable` | runtime unreachable, or runtime `503 control_disabled` or any other runtime 5xx |
| 503 | `busy` | runtime `503 queue_timeout` or `overloaded` (+ `Retry-After`) |
| 504 | `runtime_timeout` | a control-API call did not answer within the deadline (10 s by default) |
| 500 | `default_plan_missing` | org create: the runtime has no plan named by `RTWEB_DEFAULT_PLAN` (`details: {plan, available}`) |
| 500 | `internal` | anything else (logged; message is generic) |

The UI shows `busy`, 429, `runtime_unavailable` and `runtime_timeout` as a toast plus `<RuntimeStatusBanner/>`, never as a code
error of the user's app. It shows `409 stale` as a "changed elsewhere, reload" prompt.

Every route below may also return the cross-cutting errors: `401`, the `403` middleware codes, `429`, `502`
and `503 busy` (for routes that call the runtime) and `500`. The per-route "Errors" column lists only the
other codes.

### 1.5.1 Additional error codes

| Status | `code` | Where |
|---|---|---|
| 401 | `invalid_credentials` | login; wrong current password on password change, 2FA disable, recovery codes |
| 401 | `invalid_code` | `/api/auth/mfa` wrong TOTP/recovery code |
| 422 | `invalid_code` | `/api/me/totp/confirm`, `/api/me/totp/disable` wrong code |
| 400 | `ambiguous_credentials` | a request with both `Authorization: Bearer` and a session cookie |
| 403 | `bearer_not_allowed` | a bearer token on a route outside `/api/orgs/{org}/apps` |

Why 401 vs 422 for `invalid_code`: at `/api/auth/mfa` the code is the second factor, so a wrong one is a failed authentication (401). On `/api/me/totp/*` the caller is already signed in, so a wrong code is an invalid input field (422), not a lost session.
| 409 | `email_taken` | `POST /api/admin/users` |
| 409 | `already_member` | `POST /api/orgs/{org}/members` |
| 409 | `project_not_empty` | `DELETE /api/orgs/{org}/projects/{p}` with apps |
| 404 | `invite_invalid` | invite accept (expired, used, revoked) |
| redirect | `oauth_state_invalid` | OAuth callback: state/PKCE mismatch or expired |
| redirect | `email_unverified` | OAuth callback: provider email not verified |
| redirect | `no_account` | OAuth callback: no user with that email (none created) |
| redirect | `account_disabled` | OAuth callback: user disabled |
| redirect | `oauth_failed` | OAuth callback: provider/token exchange error |

OAuth codes are sent as `/login?error=<code>`, not as a JSON body.

### 1.6 Pagination

Paged lists take `?cursor=<opaque>&limit=<n>` (default 50, max 200) and return:

```ts
type Page<T> = { items: T[]; next_cursor: string | null }; // null = last page
```

Paged routes: `/api/admin/audit`, `/api/orgs/{org}/audit`, `/api/orgs/{org}/apps/{app}/events`,
`/api/orgs/{org}/apps` and `/api/admin/users`. Every other list returns `{ items: T[] }` without paging.

### 1.7 Optimistic concurrency

- `GET /api/orgs/{org}/apps/{app}` returns the runtime service etag in the `ETag` header (quoted) and in the
  body as `etag`.
- `PATCH /api/orgs/{org}/apps/{app}`, `PUT …/files` and `PUT …/live` require `If-Match: <etag>`.
  - missing → `428 precondition_required`
  - stale (runtime 412) → `409 stale`
- Successful writes return the new `ETag` header and the new `etag` in the body.

## 2. Shared types

```ts
type User = {
  id: string;                    // usr_…
  email: string;
  name: string;
  instance_admin: boolean;
  must_change_password: boolean;
  disabled: boolean;
  totp_enabled: boolean;
  created_at: number;
};

type OrgRole = "owner" | "admin" | "member";
type ProjectRole = "admin" | "developer" | "viewer";

type Org = {
  id: string;                    // org_…
  slug: string;
  name: string;
  created_at: number;
  role: OrgRole | null;          // caller's role; null for an instance admin who is not a member
};

type Member = {
  user: Pick<User, "id" | "email" | "name">;
  role: OrgRole;
  grants: Record<string, ProjectRole>;   // project slug → role
};

type Project = {
  slug: string;
  name: string;
  environments: string[];
  created_at: number;
  updated_at: number;
  role: ProjectRole;             // caller's effective role (org owner/admin → "admin")
};

type AuditEntry = {
  id: string;                    // aud_…
  at: number;
  actor: { user_id: string | null; name: string | null; email: string | null }; // user_id "cli" for host CLI
  as_instance_admin: boolean;
  org: { id: string; slug: string } | null;
  action: string;                // e.g. "app.create", "member.role", "domain.verify"
  target: string;
  detail: unknown;               // free-form JSON
};
```

## 3. Setup, auth and profile

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/healthz` | public | | `200 {"ok":true}` | |
| GET | `/api/setup` | public | | `200 {needed: boolean}` | |
| POST | `/api/setup` | public (Origin) | `SetupReq` | `201 SessionResp` + session cookie | `403 setup_token_invalid`, `409 already_set_up`, `422 invalid` |
| GET | `/api/auth/providers` | public | | `200 AuthConfig` | |
| POST | `/api/auth/login` | public (Origin) | `LoginReq` | `200 LoginResp` + cookie (full or MFA-pending) | `401 invalid_credentials`, `403 password_login_disabled`, `429 rate_limited`, `503 busy` |
| POST | `/api/auth/mfa` | MFA-pending session cookie; no CSRF (there is no token yet); Origin enforced | `{code: string}` | `200 SessionResp` + full session cookie | `401 unauthenticated` (no/expired pending), `401 invalid_code`, `429 rate_limited` |
| POST | `/api/auth/logout` | session | | `204` + cookie cleared | |
| GET | `/api/me` | session (gate-exempt) | | `200 Me` | |
| PUT | `/api/me/password` | session (gate-exempt) | `{current_password: string; new_password: string}` | `204` (other sessions revoked) | `401 invalid_credentials` (wrong current), `422 invalid` (length < 12), `429 rate_limited` (10 wrong current passwords in 15 min) |

```ts
type SetupReq = { setup_token?: string; /* see note */ email: string; name: string; password: string };
type LoginReq = { email: string; password: string };
type LoginResp =
  | { mfa_required: true }                                   // pending cookie set; go to /login/mfa
  | ({ mfa_required: false } & SessionResp);
type SessionResp = { user: User; csrf: string };
// code: a 6-digit TOTP code or a recovery code (format xxxx-xxxx-xxxx-xxxx; dashes and spaces ignored)

type AuthConfig = {
  password_login_disabled: boolean;   // hide the password form (instance admins can still use it)
  providers: { id: "github" | "google" | "oidc"; name: string }[]; // start URL: /api/auth/oauth/{id}/start
};

type Me = {
  user: User;
  csrf: string;
  orgs: { slug: string; name: string; role: OrgRole }[];
  policy: { require_2fa: boolean; password_login_disabled: boolean };
  mfa_enrollment_required: boolean;   // require_2fa && !user.totp_enabled
};
```

Notes:
- Setup token: `RTWEB_SETUP_TOKEN` when set. When it is unset, `rtweb` generates a random one-time token at startup (48 hex chars) and logs it once at `WARN` (`setup_token` attribute). Either way a token is always required: the server compares it in constant time, and a missing, empty or wrong token is `403 setup_token_invalid`, with no user created. The field is optional in the type only so a missing token reaches that 403 instead of a 422.
- The login error never reveals whether the account exists: unknown user, wrong password and disabled user
  are all `401 invalid_credentials`.
- `password_login_disabled` applies to everyone except instance admins (break-glass).
- Login throttling. The client address is the runtime's `ctx.client.ip` (= `x-rt-client-ip`, which the
  runtime resolves behind `ingress.trusted_proxies` and clients cannot set); `X-Forwarded-For` is never read.
  Limits: 10 failures per (IP, email) and 30 failures per IP per 15 min give `429 rate_limited`. Failures on
  an account from one network (IPv4 /24, IPv6 /64) past 10, or from all networks past 50, give an IP that
  never signed into that account a growing delay (1 s doubling up to 60 s, `429` with `Retry-After`), never
  a lock; IPs with a correct password for the account in the last 30 days
  skip that delay and the instance-wide cap of 60 unauthenticated attempts per minute. At most 2 argon2
  runs happen at once for unauthenticated requests; beyond that `503 busy` with `Retry-After: 1`. New
  hashes use argon2id m=19 MiB, t=2, p=1; older hashes are replaced at the next successful login.
- Second-factor throttling. Wrong TOTP or recovery codes and wrong password re-checks count per user over
  24 h: after 5 the next attempt waits 30 s, doubling with each further failure up to 15 min (`429
  rate_limited` with `Retry-After`). A correct code resets the count.
- After a login with `must_change_password`, the UI goes to `/change-password`. With
  `mfa_enrollment_required`, it goes to `/me/security`.

## 4. OAuth login linking

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/auth/oauth/{provider}/start` | public | `?next=<path>` | `302` to the provider; sets the state+PKCE cookie (10 min) | `404 not_found` (provider not configured) |
| GET | `/api/auth/oauth/{provider}/callback` | public | `?code&state` | `302` to `next` (full session), or to `/login/mfa` (MFA-pending cookie) | redirects to `/login?error=<code>` |

| POST | `/api/me/oauth/{provider}/link` | session | `{next?: string}` (default `/me/security`) | `200 {location: string}` (navigate there) + state cookie; the callback attaches the identity to the signed-in user and redirects to `next` without a new session | `404 not_found` (provider not configured); callback redirects to `next?error=identity_taken` when the identity belongs to another user |

`{provider}` is `github`, `google` or `oidc`. Callback error codes (shown on the login page):
`oauth_state_invalid`, `email_unverified`, `no_account` (no user has that verified email; **no user is
created**), `link_required` (a user has that email but this identity is not linked to it),
`account_disabled`, `oauth_failed`.

OAuth sign-in never links an identity to an account by email. An invite link can be redeemed by
whoever holds it, so an account's email is not proof that its owner controls that mailbox; auto-linking
would let an inviter pre-create `ceo@corp.com` and later receive the real owner's SSO sign-in. Linking
happens only from a signed-in session via `POST /api/me/oauth/{provider}/link`.

Security notes: `id_token` and `nonce` are intentionally not used. Identity comes from the userinfo endpoint
(or GitHub's `/user` and `/user/emails`) over TLS, with a confidential client (`client_secret`) and PKCE (S256).
OIDC issuers must be `https` (`http` only in dev); discovery must report the configured issuer and all
endpoints must be `https`. Discovery is cached per issuer for 10 minutes.

## 5. Account security, invites

### 5.1 `/api/me/*`

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/me/sessions` | session | | `200 {items: SessionInfo[]}` | |
| DELETE | `/api/me/sessions/{id}` | session | | `204` | `404 not_found` (not the caller's session) |
| POST | `/api/me/sessions/revoke-others` | session | | `200 {revoked: number}` | |
| POST | `/api/me/totp/enroll` | session (2FA gate-exempt) | `{password: string}` | `200 {otpauth_url: string}` | `401 invalid_credentials` (wrong current password; counts toward the per-user lockout), `409 totp_already_enabled`, `429 rate_limited` |
| POST | `/api/me/totp/confirm` | session (2FA gate-exempt) | `{code: string}` | `200 {recovery_codes: string[]}` (10, shown once) | `409 totp_already_enabled`, `422 invalid_code`, `429 rate_limited` |
| POST | `/api/me/totp/disable` | session | `{password: string; code: string}` | `204` | `401 invalid_credentials`, `422 invalid_code`, `409 totp_not_enabled` |
| POST | `/api/me/recovery-codes` | session | `{password: string}` | `200 {recovery_codes: string[]}` (old ones invalidated) | `401 invalid_credentials`, `409 totp_not_enabled` |
| GET | `/api/me/logins` | session | `?limit` (default 50, max 200) | `200 {items: LoginEvent[]}` (own only, newest first) | |

```ts
type SessionInfo = {
  id: string;            // public id (first 12 hex of the stored hash)
  ip: string; ua: string;
  created_at: number; last_seen_at: number;
  current: boolean;
};
type LoginEvent = {
  id: string; at: number; ip: string; ua: string;
  method: "password" | "oauth" | "invite";
  result: "ok" | "bad_password" | "bad_totp" | "rate_limited" | "disabled" | "sso_only" | "mfa_pending";
};
```

The UI renders `otpauth_url` as a QR code and as copyable text.

### 5.2 Invites

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/orgs/{org}/invites` | `invites.manage` | | `200 {items: Invite[]}` (pending only, this org) | `403`, `404` |
| POST | `/api/orgs/{org}/invites` | `invites.manage` (role `owner` also needs `members.owners`) | `InviteReq` (`org` ignored; bound to `{org}`) | `201 {invite: Invite; link: string}` (link shown once) | `403`, `404`, `422 invalid` |
| DELETE | `/api/orgs/{org}/invites/{id}` | `invites.manage` | | `204` | `404` (unknown, or invite of another org) |
| GET | `/api/admin/invites` | `instance.admin` | `?org=<slug>` (optional filter) | `200 {items: Invite[]}` (pending only, all orgs) | |
| POST | `/api/admin/invites` | `instance.admin` | `InviteReq` (`org` optional; unbound = no membership) | `201 {invite: Invite; link: string}` | `404` (org), `422 invalid` |
| DELETE | `/api/admin/invites/{id}` | `instance.admin` | | `204` | `404` |
| GET | `/api/invites/accept/{token}` | public | | `200 {email: string; org_name: string \| null}` | `404 invite_invalid` |
| POST | `/api/invites/accept/{token}` | public (Origin; the single-use token replaces CSRF) | `{name: string; password: string}` for a new email; ignored for an existing account | New account: `200 {email, mfa_required, csrf?}` and sets the session cookie (`csrf` is absent while `mfa_required` is true; the 2FA policy applies). Existing account: `200 {email, mfa_required: false}`, no cookie, password unchanged, membership added. The caller must be signed in as that account. | `403 invite_login_required` (existing account, caller not that user), `403 account_disabled`, `404 invite_invalid`, `422 invalid` |

```ts
type InviteReq = { email: string; org?: string /* org slug */; role?: OrgRole };
type Invite = {
  id: string; email: string;
  org: { slug: string; name: string } | null; role: OrgRole | null;
  created_by: Pick<User, "id" | "name">;
  created_at: number; expires_at: number;   // 7 days
};
// link: `${RTWEB_ORIGIN}/invite/<token>` (page calls /api/invites/accept/<token>)
```

Management uses the invite id (`inv_…`); the public accept page uses the token under `/api/invites/accept/`.
`GET /api/invites/accept/{token}` only previews (no side effects) and returns the same `404 invite_invalid` for expired, used, revoked and unknown tokens.

## 6. Instance admin

All routes require `instance.admin`. Every mutation is audited.

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/api/admin/users` | `?cursor&limit&q` | `200 Page<User>` | |
| POST | `/api/admin/users` | `{email; name; instance_admin?: boolean}` | `201 {user: User; temp_password: string}` (shown once) | `409 email_taken`, `422 invalid` |
| PATCH | `/api/admin/users/{id}` | `{name?; disabled?: boolean; instance_admin?: boolean}` | `200 User` (disable revokes sessions) | `404`, `409 last_admin` |
| DELETE | `/api/admin/users/{id}` | | `204` | `404`, `409 last_admin`, `409 last_owner` |
| POST | `/api/admin/users/{id}/reset-password` | | `200 {temp_password: string}` (sessions revoked) | `404` |
| DELETE | `/api/admin/users/{id}/totp` | | `204` (2FA reset, sessions revoked) | `404` |
| GET | `/api/admin/orgs` | | `200 {items: Org[]}` | |
| POST | `/api/admin/orgs` | `{slug; name; owner_user_id}` | `201 Org` | `409 slug_taken`, `422 invalid` |
| PATCH | `/api/admin/orgs/{org}` | `{name}` | `200 Org` | `404` |
| DELETE | `/api/admin/orgs/{org}` | | `204` | `404`, `409 org_not_empty` |
| GET | `/api/admin/orgs/{org}/usage` | `?from&to` (YYYY-MM-DD) | `200 {items: Usage[]}` | `404` |
| GET | `/api/admin/node/status` | | `200 NodeStatus` (runtime passthrough) | |
| GET | `/api/admin/node/config` | | `200 object` (runtime passthrough) | |
| PUT | `/api/admin/node/config` | `NodeConfigPatch` | `200 {applied: string[]; pending_restart: string[]}` | `422 invalid` (any other field) |
| GET | `/api/admin/node/scheduler` | | `200 object` (runtime passthrough) | |
| GET | `/api/admin/node/cache` | | `200 object` (runtime passthrough) | |
| GET | `/api/admin/node/version` | | `200 {version: string; web_version: string}` | |
| POST | `/api/admin/node/drain` | `{confirm: "drain"}` | `202 object` (runtime passthrough) | `422 invalid` (bad confirm) |
| GET | `/api/admin/domains` | | `200 {items: (Domain & {org: {slug; name}})[]}` | |
| GET | `/api/admin/audit` | `?org&actor&action&exclude_action&cursor&limit` | `200 Page<AuditEntry>` (instance-wide) | |
| GET | `/api/admin/settings` | | `200 InstanceSettings` | |
| PUT | `/api/admin/settings` | `Partial<InstanceSettingsWrite>` | `200 InstanceSettings` | `422 invalid` (`details.fields.password_login_disabled` when SSO-only is enabled with no OAuth/OIDC provider configured; `auth.SetPolicy` returns `Conflict{sso_not_configured}`, and the handler maps it to this 422) |

```ts
type Usage = { app: string | null /* slug, null if deleted */; day: string; invocations: number;
               cpu_ms: number; egress_bytes: number; storage_bytes: number };
type NodeConfigPatch = {
  degradation_mode?: string;
  default_profile?: string;
  rate_limit?: Record<string, unknown>;   // reported in pending_restart
};
type OAuthProvider = {
  id: "github" | "google" | "oidc";
  enabled: boolean;
  client_id: string;
  client_secret_set: boolean;             // the secret is write-only
  issuer?: string;                         // oidc only
  name?: string;                           // display name (oidc)
};
type InstanceSettings = {
  public_url: string;
  require_2fa: boolean;
  password_login_disabled: boolean;
  providers: OAuthProvider[];
};
type InstanceSettingsWrite = {
  require_2fa: boolean;
  password_login_disabled: boolean;
  providers: (Omit<OAuthProvider, "client_secret_set"> & { client_secret?: string })[];
};
```

There is no plan field anywhere: every org uses `RTWEB_DEFAULT_PLAN`.

### 6.1 Branding

White-label settings for the instance. The read routes are **public** (the login page renders the
brand before sign-in) and return display fields only. Writes require `instance.admin`, CSRF and
Origin like every unsafe route, need `If-Match: <etag>` (`428 precondition_required` when missing,
`409 stale` when another admin changed the brand) and are audited (`branding.update`,
`branding.reset`, `branding.asset_update`, `branding.asset_delete`).

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/api/branding` | | `200 Branding` + `ETag` | |
| GET | `/api/branding/theme.css` | | `200 text/css` token overrides (`no-cache` + `ETag`, `304`) | |
| GET | `/api/branding/assets/{kind}` | `?v=<hash>` | `200` image; `immutable` when `v` matches, else `no-cache`; `ETag`, `304` | `404` |
| PUT | `/api/admin/branding` | `Partial<BrandingWrite>` | `200 Branding` | `422 invalid`, `428`, `409 stale` |
| DELETE | `/api/admin/branding` | | `200 Branding` (defaults; images removed) | `428`, `409 stale` |
| PUT | `/api/admin/branding/assets/{kind}` | `{data: string /* base64 */}` | `200 Branding` | `404` (kind), `413 too_large` (> 512 KB), `422 invalid` (`must_be_base64`, `unsupported_image`, `svg_active_content`), `428`, `409 stale` |
| DELETE | `/api/admin/branding/assets/{kind}` | | `200 Branding` | `404`, `428`, `409 stale` |

`{kind}` is `logo-light`, `logo-dark` or `icon`. The image type comes from the file's magic bytes
(PNG, JPEG, WebP, ICO, SVG); the client's type and name are ignored. SVG is refused when it holds
script, event handlers, `foreignObject`, entities, `javascript:` or non-local references, and is
served with `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`.
Every asset response sets `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`.

```ts
type AccentPalette = { accent: string; hover: string; on_accent: string; soft: string; pale: string };
type Branding = {
  product_name: string;             // "" = default product name
  accent: string;                   // "#rrggbb" as entered, "" = default blue
  accent_adjusted: boolean;         // the light accent was darkened to reach WCAG AA
  palette: { light: AccentPalette; dark: AccentPalette } | null;
  logo_light_url: string | null;    // same-origin, cache-busted
  logo_dark_url: string | null;     // null = use the light logo
  icon_url: string | null;          // favicon and square mark
  login_headline: string;
  login_subtitle: string;
  support_url: string;
  support_email: string;
  hide_powered_by: boolean;
  radius: "sharp" | "default" | "round";
  tint: "neutral" | "warm" | "cool";
  etag: string;
};
type BrandingWrite = Omit<Branding, "accent_adjusted" | "palette" | "logo_light_url" | "logo_dark_url" | "icon_url" | "etag">;
// limits: product_name 40, login_headline 80, login_subtitle 160, support_url 300 (http/https),
// support_email 254; field codes too_long, must_be_hex, must_be_http_url, must_be_email,
// invalid_choice, invalid_characters, unknown_field.
```

## 7. Orgs, members, tokens, projects

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/orgs` | session | | `200 {items: Org[]}` (member orgs; all orgs for an instance admin). If setup's first org failed (runtime not ready) and no org was ever created (no `org.create` audit row), an instance admin's call retries creating `default` first, best effort | |
| GET | `/api/orgs/{org}` | `org.read` | | `200 Org` | `404` |
| GET | `/api/orgs/{org}/members` | `org.read` (any member; mutations need `members.manage`) | | `200 {items: Member[]}` | `404` |
| POST | `/api/orgs/{org}/members` | `members.manage` (+ `members.owners` for role `owner`) | `{user_id: string; role: OrgRole}` | `201 Member` | `403`, `404`, `409 already_member` |
| PATCH | `/api/orgs/{org}/members/{user}` | `members.manage` (+ `members.owners` when the old or new role is `owner`) | `{role: OrgRole}` | `200 Member` | `403`, `404`, `409 last_owner` |
| DELETE | `/api/orgs/{org}/members/{user}` | `members.manage` (+ `members.owners` for an owner) | | `204` (grants removed) | `403`, `404`, `409 last_owner` |
| PUT | `/api/orgs/{org}/members/{user}/grants/{project}` | `grants.manage` on `{project}` | `{role: ProjectRole}` | `200 Member` | `403`, `404` |
| DELETE | `/api/orgs/{org}/members/{user}/grants/{project}` | `grants.manage` on `{project}` | | `204` | `403`, `404` |
| GET | `/api/orgs/{org}/tokens` | `tokens.manage` | | `200 {items: Token[]}` (never secrets, never the default key) | `403`, `404` |
| POST | `/api/orgs/{org}/tokens` | `tokens.manage` | `TokenReq` | `201 {token: Token; secret: string}` (secret shown once) | `403`, `404` (unknown app), `422 invalid` (unknown scope, past expiry) |
| DELETE | `/api/orgs/{org}/tokens/{id}` | `tokens.manage` | | `204` | `404` |
| POST | `/api/orgs/{org}/default-key/rotate` | `defaultkey.rotate` | | `204` (custom tokens keep working) | `403`, `404` |
| GET | `/api/orgs/{org}/limits` | `org.read` | | `200 Limits` (read-only quota bar) | `404` |
| GET | `/api/orgs/{org}/usage` | `org.usage.read` | `?from&to` | `200 {items: Usage[]}` | `403`, `404` |
| GET | `/api/orgs/{org}/audit` | `org.audit.read` | `?actor=<user id>&action=&exclude_action=a,b&cursor&limit` | `200 Page<AuditEntry>` (this org only) | `403`, `404` |
| GET | `/api/orgs/{org}/projects` | `org.read` | | `200 {items: Project[]}` (members see granted projects only) | `404` |
| POST | `/api/orgs/{org}/projects` | `project.create` | `{slug: string; name?: string; environments?: string[]}` | `201 Project` | `403`, `409 slug_taken`, `422` |
| GET | `/api/orgs/{org}/projects/{p}` | `project.read` | | `200 Project` | `404` |
| PATCH | `/api/orgs/{org}/projects/{p}` | `project.update` | `{name?: string; environments?: string[] /* complete new list */}` | `200 Project` | `403`, `404`, `422` |
| DELETE | `/api/orgs/{org}/projects/{p}` | `project.delete` | | `204` | `403`, `404`, `409 project_not_empty` |
| GET | `/api/orgs/{org}/projects/{p}/environments` | `project.read` | | `200 {items: string[]}` | `404` |

```ts
type TokenReq = {
  name: string;
  scopes: string[];          // ⊆ runtime tenant scopes (minus keys:write)
  projects?: string[];       // project slugs → runtime project_ids restriction (optional; 404 if unknown)
  environments?: string[];   // runtime environments restriction (optional)
  expires_at?: number | null;
};
type Token = {
  id: string;                // tok_…
  name: string;
  scopes: string[];
  projects: string[];        // empty = all projects
  environments: string[];    // empty = all environments
  created_by: Pick<User, "id" | "name">;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
};
type Limits = {              // runtime LimitsView passthrough (the plan name is not shown in the UI)
  day: string; resets_at: number;
  invocations: Quota; egress_bytes: Quota; storage_bytes: Quota; services: Quota; schedules: Quota;
  allowed_triggers: string[] | null; // the plan's `allowed_triggers` (runtime GET /v1/me plan.settings); null = unknown
};
type Quota = { limit: number | null; used: number; remaining: number | null; period: string };
```

Tokens are org-level only in v1: only org owners/admins (`tokens.manage`) create, list and revoke them. Project-scoped tokens (created by project admins): later.

## 8. Apps

`/api/orgs/{org}/apps/{app}` is abbreviated `…/{app}` below. Every app route resolves `{app}` in the org with
`apps.Resolve` (unknown, or the slug belongs to another tenant → `404 not_found`) and then checks the action
on the app's project.

### 8.1 App CRUD and settings

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/orgs/{org}/apps` | `org.read` (filtered by `app.read`) | `?project&environment&cursor&limit` | `200 Page<AppSummary>` | `404` |
| POST | `/api/orgs/{org}/apps` | `app.create` on `project` | `AppCreate` | `201 AppView` + `ETag` | `403`, `404` (project), `409 slug_taken` ("This app name is taken on this runtime"), `422 invalid` (unknown environment or template), `403 plan_limit` |
| GET | `…/{app}` | `app.read` | | `200 AppView` + `ETag` | `404` |
| PATCH | `…/{app}` | `app.update` | `AppPatch`, header `If-Match` | `200 AppView` + `ETag` | `403`, `409 stale`, `422 invalid` (+ `details.fields`), `428` |
| DELETE | `…/{app}` | `app.delete` | | `204` (its domains are removed) | `403`, `404` |

```ts
type AppCreate = { project: string; environment: string; slug: string;
                   template: "http" | "cron" | "queue" | "sqlite-crud"; name?: string };

type AppSummary = {
  slug: string; name: string | null; project: string; environment: string;
  live_version: number | null;
  status: { build_state: string; tier: string; last_error: string | null };
};

type AppView = AppSummary & {
  etag: string;
  runtime: string;                     // "deno" | "wasm"
  profile: string | null;
  access: "public" | "key" | "internal";
  url: string;                         // `https://{slug}.{apps host}/` (RTWEB_APPS_URL)
  scaling: object | null; ingress: object | null; egress: object | null;
  call: object | null; triggers: object | null;           // runtime blocks, passed through
  status: AppSummary["status"] & { inflight: number; admission: object | null };
  limits: { requested: object | null; effective: object; source: "plan" | "profile" | "service" };
};

// Every present block REPLACES the whole runtime block (no merge). Absent = unchanged.
type AppPatch = {
  name?: string | null;
  profile?: string | null;
  access?: "public" | "key" | "internal";
  scaling?: object;
  ingress?: { methods?: string[]; path_prefixes?: string[]; ip_allow?: string[] /* CIDR */; rate_limit?: object };
  egress?: object;
  call?: { allowed_callers: string[] /* app slugs */ };
  limits?: object;
};
```

### 8.2 Code and versions

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `…/{app}/files` | `app.read` | `?version=<n>` or `?version=latest` (default: live) | `200 Files` | `404`, `422` |
| PUT | `…/{app}/files` | `app.deploy` | `{entry: string; files: Record<string,string>}`, `If-Match` | `200 {version: Version; etag: string}` + `ETag` (built eagerly; the live version is unchanged, promote with `PUT …/live`) | `403`, `409 stale`, `422 build_failed` / runtime `422 validation_failed` (+ `BuildDetails`), `428`, `429 build_quota` |
| GET | `…/{app}/versions` | `app.read` | | `200 {items: Version[]}` (newest first) | `404` |
| PUT | `…/{app}/live` | `app.deploy` | `{version: number}`, `If-Match` | `200 {live_version: number; etag: string}` + `ETag` | `403`, `409 stale`, `409 version_not_ready`, `428` |
| GET | `…/{app}/versions/{v}/build-logs` | `app.read` | | `200 {items: LogLine[]}` | `404` |
| POST | `…/{app}/versions/{v}/rebuild` | `app.deploy` | | `202 Version` (state `building`) | `403`, `404`, `409 version_not_ready`, `429 build_quota` |

```ts
type Files = {
  version: number;
  entry: string;
  files: Record<string, string>;   // path → UTF-8 source
  read_only: boolean;              // true for wasm
  kind: "ts" | "js" | "bundle" | "wasm";
};
type Version = {
  version: number;
  build_state: "pending" | "building" | "ready" | "failed";
  live: boolean;
  source_digest: string;
  failure: BuildDetails | null;
  author: { user_id: string; name: string } | null;   // null = made outside the web
  created_at: number;
};
```

A save never changes the live version: `PUT …/files` stores and builds a new version, and `PUT …/live` (Deploy)
makes it live. `If-Match` on a save is the app's current ETag, so a save after someone changed the app elsewhere gets
`409 stale`. On `422 build_failed` `details.version` names the failed version.

### 8.3 Config: env, secrets, schedules, queue

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `…/{app}/env` | `app.env.read` (project `developer` and up) | | `200 {env: Record<string,string>}` | `403` (viewer), `404` |
| PUT | `…/{app}/env` | `app.env.write` | `{env: Record<string,string>}` (complete map, replaces) | `200 {env: Record<string,string>}` | `403`, `422` |
| GET | `…/{app}/secrets` | `app.read` | | `200 {items: {name: string; updated_at: number}[]}` (names only) | `404` |
| PUT | `…/{app}/secrets/{name}` | `app.secrets.write` | `{value: string}` (write-only) | `204` | `403`, `422` |
| DELETE | `…/{app}/secrets/{name}` | `app.secrets.write` | | `204` | `403`, `404` |
| GET | `…/{app}/schedules` | `app.read` | | `200 {items: Schedule[]}` | `404` |
| GET | `…/{app}/schedules/once` | `app.read` | | `200 {items: OnceSchedule[]}` (pending `std:schedule` tasks, read-only) | `404` |
| POST | `…/{app}/schedules` | `app.schedules.write` | `ScheduleBody` | `201 Schedule` | `403`, `403 plan_limit`, `422` |
| PATCH | `…/{app}/schedules/{id}` | `app.schedules.write` | `Partial<ScheduleBody>` | `200 Schedule` | `403`, `404`, `422` |
| DELETE | `…/{app}/schedules/{id}` | `app.schedules.write` | | `204` | `403`, `404` |
| GET | `…/{app}/queue` | `app.read` | | `200 {depth; in_flight; oldest_age_ms; dlq: number}` | `404` |
| POST | `…/{app}/queue` | `app.queue.write` | `{body: unknown; delay_seconds?: number; dedup_id?: string}` | `201 {id: string}` | `403`, `429 queue_full` |
| GET | `…/{app}/dlq` | `app.read` | | `200 {items: {id; body: unknown; attempts: number; failed_at: number}[]}` | `404` |
| DELETE | `…/{app}/dlq` | `app.queue.write` | | `204` (purge) | `403` |
| POST | `…/{app}/dlq/redrive` | `app.queue.write` | | `200 {redriven: number}` | `403` |

```ts
type ScheduleBody = {
  kind: "interval" | "cron";
  every_seconds?: number;        // interval
  cron?: string; timezone?: string;  // cron
  payload?: unknown;
  enabled?: boolean;
};
type Schedule = Required<Pick<ScheduleBody, "kind">> & {
  id: string; cron: string | null; every_seconds: number | null; timezone: string | null;
  payload: unknown; enabled: boolean; next_due: number | null;
};
type OnceSchedule = { id: string; kind: "once"; run_at: number /* unix ms */ };
```

`403 plan_limit` means the configured plan does not allow the trigger (runtime `trigger_not_allowed`) or the
schedule count.

### 8.4 Observability

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `…/{app}/stats` | `app.logs.read` | `?window=5m\|1h\|24h` (default `5m`) | `200 object`: runtime stats passthrough (`count`, `errors`, `error_rate`, `outcomes`, `queue`/`init`/`exec`/`total` percentiles, `admission`) plus `window` and flat `requests` (= `count`), `p50_ms`/`p95_ms`/`p99_ms` (= `total.*`) | `404` |
| GET | `…/{app}/events` | `app.logs.read` | `?cursor&limit` | `200 Page<{id: string; ts: number; kind: string; data: unknown}>` | `404` |
| GET | `…/{app}/logs` | `app.logs.read` | SSE, see §8.6 | `text/event-stream` | `404`, `429 rate_limited` (org upstream cap) |
| GET | `…/{app}/export` | `app.data.export` | | `200 application/vnd.sqlite3`, `Content-Disposition: attachment; filename="<app>.sqlite"` (streamed) | `403`, `404` |

### 8.5 Domains

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `…/{app}/domains` | `app.read` | | `200 {items: Domain[]}` | `404` |
| POST | `…/{app}/domains` | `domains.manage` | `{host: string}` | `201 Domain` (`pending`) | `403`, `409 host_taken` (held by any non-failed claim in any org; one generic message that does not reveal the holder; failed claims are purged on re-claim), `409 pending_limit` (org already has 20 unverified domains), `422 invalid` (IP, wildcard, port, single label, numeric TLD, the console host, > 253 chars) |
| POST | `…/{app}/domains/{id}/verify` | `domains.manage` | | `200 Domain` (`active`, or still `pending` when the TXT does not match yet) | `403`, `404`, `409 host_taken` (generic message; the row becomes `failed`) |
| DELETE | `…/{app}/domains/{id}` | `domains.manage` | | `204` | `403`, `404` |

```ts
type Domain = {
  id: string;                     // dom_…
  host: string;                   // normalized: lowercase, punycode, no trailing dot
  app: string;                    // app slug
  status: "pending" | "active" | "failed";
  txt_name: string;               // `_rtweb.${host}`
  txt_value: string;              // verification token (32 hex)
  cname_target: string;           // the router host to point a CNAME/A record at
  last_checked_at: number | null;
  verified_at: number | null;
  cert_status: "none" | "pending" | "issued" | "error";
  cert_not_after: number | null;
  cert_error: string | null;
  created_at: number;
};
```

The TXT record must stay. An active domain whose TXT is missing for 3 checks (6 h apart) becomes `failed`.

### 8.6 Log stream (SSE)

`GET /api/orgs/{org}/apps/{app}/logs`

- Request: `Accept: text/event-stream`. Optional `Last-Event-ID: <seq>` header (the browser's `EventSource`
  sends it on reconnect), or `?last_event_id=<seq>` for the first connect. Optional `?level=debug|info|warn|error`
  is a minimum severity: `warn` passes `warn` and `error` lines. It filters `log` events only; `gap` and `error`
  events always pass. An unknown level is `422 invalid`.
- Errors before the stream starts use the JSON envelope (`404`, `429 rate_limited`).
- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. The
  server write deadline is cleared for this route only.
- Events:

```
id: 1234
event: log
data: {"seq":1234,"ts":1761200000000,"level":"info","version":3,"task_id":"…","trigger":"http","kind":"runtime","msg":"hello","truncated":false}

: ping
```

```ts
type LogLine = {
  seq: number; ts: number;
  level: "debug" | "info" | "warn" | "error";
  version: number | null; task_id: string | null; trigger: string | null;
  kind: "runtime" | "build" | "system";
  msg: string; truncated: boolean;
  fields?: Record<string, unknown>; // structured std:log fields; absent on plain records
};
```

- `id` is the runtime `seq`. `data` is one `LogLine` per event on one line (the runtime `service_id` is
  dropped).
- A comment line `: ping` is sent every 15 s as a heartbeat.
- On resume the server replays events after `Last-Event-ID` from its 500-event ring buffer. If the id is older
  than the buffer, it first sends `event: gap` with `data: {"from": <oldest seq kept>}`, then the buffer.
- `event: error` with `data: ErrorBody["error"]` is sent once before the server closes the stream for a
  terminal reason (for example the app was deleted). The client should not reconnect after it.
- Build logs (`…/versions/{v}/build-logs`) use the same `LogLine` shape as JSON.

## 9. Internal routes

Used by the edge and the installer, never by the console. They skip session, CSRF and Origin checks.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/internal/tls-ask` | loopback (runtime-resolved client IP; others get `404`) | `?domain=<host>` | `200 ok` for an `active` custom domain, else `404` (Caddy on-demand TLS `ask`) |
| PUT | `/api/internal/assets/{id}/{part}` | loopback + asset-token; header `x-rtweb-part-sha256: <hex sha256 of body>` | raw bytes (≤ 900 kB part) | `204`; `403` wrong token, `404` unknown asset or part or non-loopback client, `413 too_large`, `422 checksum_mismatch` (header missing, wrong, or not the manifest's part hash) |

`install.mjs` rotates `RTWEB_ASSET_TOKEN` on every run and uploads the console files too large for the bundle
(over 1 MB) to `std:blob` through the second route; the SPA handler streams them back.

## 10. SPA

Every non-`/api` path that is not a file in `web/dist` returns `index.html` (`Cache-Control: no-cache`).
`index.html` is rendered with the brand (§6.1): `<title>` is the HTML-escaped product name (default
"Runtime Console"), and the favicon link is the uploaded icon's `icon_url` when set, else the bundled
`/favicon.svg`. Its `ETag` includes the branding etag, so a brand change never revalidates as `304`.
`/assets/*` is served with `Cache-Control: public, max-age=31536000, immutable`. Every response has
`Content-Security-Policy: default-src 'self'; frame-src <RTWEB_APPS_URL>`. Unknown `/api/*` paths return
`404 not_found` as JSON.
