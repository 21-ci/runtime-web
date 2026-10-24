# Security model

This page describes what Runtime Web protects, how, and what it does not protect. It describes the console and the
router. For the runtime node's own controls (isolates, limits, egress guard), read the
[21 Cloud Runtime security page](https://21-ci.github.io/runtime/concepts/security/).

## Actors and trust

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Instance admin | Instance-wide settings, users, orgs | Reading secrets or app code of other orgs without an audit entry |
| Org owner and admin | Their org's projects, members and tokens | Other orgs |
| Member, developer, viewer | Access granted to them by project grants | Anything their grants do not cover |
| App code | Nothing. It runs inside the runtime's sandbox | Access to the console, other apps or the database |
| Browser | Holding a session cookie and a CSRF token it received | Holding secrets. Secrets are write-only after they are set |
| Operator of the host | Running the stack | Being protected from. A compromised host defeats every control here |

## Sessions and login

- **Session cookie.** The cookie is `__Host-rtw_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and no
  `Domain`. In development mode it is named `rtw_session` and is not marked `Secure`.
- **Lifetime.** Idle timeout is 7 days, sliding. Absolute lifetime is 30 days.
- **Passwords.** Stored hashed. A password policy applies at setup and at change.
- **Rate limits.** Sign-in attempts are rate limited.
- **Two-factor auth.** TOTP. A password login for an account with TOTP first issues a short-lived MFA-pending session
  (5 minutes) that only the MFA endpoint accepts.
- **OAuth.** GitHub, Google and generic OIDC, with PKCE (S256) and a confidential client secret. Identity comes from the
  provider's userinfo endpoint over TLS. An unverified email is rejected, and a sign-in never creates a new account.

## Request checks

- **CSRF.** Every unsafe request with a session must send the `X-CSRF-Token` value that the server issued with the
  session. A missing or wrong token gets `403`.
- **Origin.** Every unsafe request, including public ones, must send an `Origin` header equal to `RTWEB_PUBLIC_URL`.
- **Gates.** A user who must change a password, or who must enrol in two-factor auth under policy, can reach only the
  routes needed to finish that step.
- **Authorization.** Each route states the action it requires. Org-scoped routes resolve the org and the caller's role,
  then check the action on the server. A non-member gets `404` for an org, so its existence is not revealed.

## Roles and grants

Org roles are `owner`, `admin` and `member`. Project roles are `admin`, `developer` and `viewer`. Token scopes are a separate
mechanism: a token carries explicit scopes such as `deploy`, `env:write`, `invoke` and `secrets:write`. A token can
never carry the scope that mints keys. Only owners and admins can create tokens.

## Secrets at rest

- The console seals values it stores (for example, app secrets and OAuth client secrets) with AES-256-GCM, keyed by
  `RTWEB_SECRET_KEY`.
- The runtime encrypts its own secrets with `RUNTIME_MASTER_KEY`.
- Secrets are write-only. The API lists their names and timestamps, and never their values.
- Tokens and keys are shown once, when they are created. The console keeps only what it needs to verify them.

Losing a key makes the matching sealed data unreadable. Back up keys apart from the database.

## Custom domains

A domain is attached to an app only after the org proves control of it with a DNS TXT record. Verification is repeated,
and a domain whose record disappears is unmapped. The router routes only verified hosts, and it reads its route table
from the console with `ROUTER_SHARED_SECRET`.

## Network boundaries

- Only the router is published by default. The console is reached through it.
- Client IP addresses come from `X-Forwarded-For` only when the request comes from an address in
  `RTWEB_TRUSTED_PROXIES`. Otherwise the connecting address is used.
- The router's internal route endpoint is exempt from session, CSRF and Origin checks. It is protected by the bearer
  secret, so keep that secret long and private.

## Audit

Changes to orgs, members, tokens, apps, domains and admin settings are recorded in the audit log with the actor and the
action. Instance admins acting in an org are marked as such.

## What is not protected

- **A malicious instance admin** can read and change everything on the instance.
- **A compromised host** can read the database, the keys and the environment.
- **Apps are not a boundary against the runtime operator.** The runtime's own isolation is documented in its security
  page.
- **Developer-supplied content** such as app code and HTML returned by an app is not reviewed by the console.
- **Availability.** The console is a single instance with a single SQLite database. Plan backups and restarts; it has
  no built-in high availability.

## Operator checklist

See [Configuration: before production](configuration.md#before-production) and the
[admin security checklist](admin-guide.md#security-checklist).

## Reporting a vulnerability

Report privately as described in [SECURITY.md](https://github.com/21-ci/runtime-web/blob/main/SECURITY.md). Do not open a
public issue.
