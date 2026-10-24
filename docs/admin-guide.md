# Admin guide

This guide is for the person who runs an instance: the first run, the instance admin console, the runtime node and
routine tasks. For the settings themselves, see [Configuration](configuration.md).

## First run

1. Install as described in [Install](getting-started/install.md).
2. Open `https://<domain>/setup`. On a clean database it asks for the setup token.
3. Enter the token that `install.sh` (through `install.mjs`) printed once. It is the service secret
   `RTWEB_SETUP_TOKEN`; to issue a new one, delete that secret and re-run the installer.
4. Create the first account. It becomes the instance admin.
5. Sign in again. Enable two-factor authentication for your account at once (see [Two-factor auth and OAuth](user-guide/two-factor-and-oauth.md)).

Setup can run only once per database. Afterwards delete the secret (`DELETE /v1/services/<id>/secrets/RTWEB_SETUP_TOKEN`
on the control API with the root token; install prints the exact path).

## Instance admin console

Instance admins see the **Admin** area in the console. It has these pages:

| Page | Use it to |
|---|---|
| Users | Find users, disable or enable accounts, and manage their access |
| Orgs | Find orgs and see their members, plans and usage |
| Invites | Invite people to the instance, and see pending invites |
| Node | See the runtime node's status and its scheduler |
| Cache | See the runtime's artifact cache |
| Domains | See every custom domain on the instance and its verification state |
| Settings | Instance policy, for example whether two-factor auth is required and which sign-in providers are enabled |
| Audit | Search the instance-wide audit log |

Admin actions that change state are written to the audit log.

## Account recovery

When someone loses their authenticator and their recovery codes, an instance admin removes their second factor from
**Admin → Users** (`DELETE /api/admin/users/{id}/totp`), or resets their password, which forces a change at the next
sign-in. Both are audited.

## Runtime node

The console runs on one runtime node as the service `rtweb` in the tenant `runtime-web`. The node runs the apps,
stores their data and enforces their limits. Check its health from the **Node** page, and on the host:

```bash
systemctl status rt caddy
journalctl -u rt -f
```

Plans (quotas, limits and `allowed_triggers` per tenant) are defined in the node's `rt.toml`. The console's own
tenant uses the `rtweb` plan from `deploy/rt.rtweb.toml`; new org tenants get the plan named by
`RTWEB_DEFAULT_PLAN` (default `free`). Every five minutes a `housekeeping` schedule runs the console's background
jobs (domain re-checks, pruning); it needs the `cron` trigger in the `rtweb` plan.

## Custom domains and TLS

A domain is shown as pending until its TXT record matches the verification value. Once verified, the console maps it
to the app as a runtime custom host, and Caddy obtains a certificate on demand: its `ask` hook calls the console's
`/api/internal/tls-ask`, which says yes only for active domains. Ports 80 and 443 must be reachable from the
internet.

## Backups and keys

- The console's data lives in the `rtweb` service's `std:sql` database on the node: back up the node's data
  directory (`/var/lib/rt`) with the runtime's backup procedure.
- Back up the keys separately, in a password manager or a secret store: the service secret `RTWEB_SEAL_KEY`, the rt
  environment file (`/etc/default/rt`: root and master keys) and `/etc/rtweb/`. A data backup without its keys cannot
  decrypt sealed secrets.
- Test a restore on a second machine before you need it.

## Upgrades

Read the [changelog](https://github.com/21-ci/runtime-web/blob/main/CHANGELOG.md) for the version you are moving to. Back
up first, then run the installer again with the new version (`sudo sh install.sh --version X.Y.Z --domain ... --email
...`). It keeps the secrets, uploads and activates the new service version, and the schema migrations run on the
first request.

## Security checklist

- `RTWEB_INSECURE_COOKIES` is unset, and `RTWEB_ORIGIN` uses `https://`.
- `RTWEB_SETUP_TOKEN` is deleted after first-run setup.
- Two-factor auth is enabled for every instance admin, and is required by policy if your team can enforce it.
- Only Caddy's ports (80, 443) are exposed. The node's invoke (8080), control (8081) and metrics (9090) listeners stay on loopback.
- The audit log is reviewed on a schedule.

For the full model, read the [security model](security-model.md).
