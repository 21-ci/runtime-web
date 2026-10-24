# Admin guide

This guide is for the person who runs an instance: the first run, the instance admin console, the runtime node and
routine tasks. For the settings themselves, see [Configuration](configuration.md).

## First run

1. Start the stack as described in [Install](getting-started/install.md).
2. Open the console. On a clean database it shows the setup page and asks for the setup token.
3. Enter the token. If you did not set `RTWEB_SETUP_TOKEN`, find the generated one in the console log (it is logged once, at `WARN`, on start):

    ```bash
    docker compose logs rtweb | grep -i setup
    ```

4. Create the first account. It becomes the instance admin.
5. Sign in again. Enable two-factor authentication for your account at once (see [Two-factor auth and OAuth](user-guide/two-factor-and-oauth.md)).

The setup token is useless once setup is complete. Setup can run only once per database.

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

## Command line

The console binary has an `admin` subcommand for recovery tasks that do not need the browser:

```bash
rtweb admin reset-2fa --email person@example.com
```

Use it when someone loses their authenticator and their recovery codes.

## Runtime node

The console talks to one runtime node. The node runs the apps, stores their data and enforces their limits. Check its
health from the **Node** page, and from the compose service:

```bash
docker compose ps
docker compose logs -f runtime
```

Plans (quotas and limits per tenant) are defined in the runtime's configuration. The console assigns new tenants the
plan named by `RUNTIME_DEFAULT_PLAN`.

## Custom domains and the router

Custom domains need the router and a DNS record. A domain is shown as pending until its TXT record matches the
verification value. The router serves the console host, every `{app}.BASE_DOMAIN` host and every verified custom domain.
With `ROUTER_TLS=on` it obtains certificates through ACME. Plan for port 443 and port 80 to be reachable from the
internet.

## Backups and keys

- Back up the database file (`RTWEB_DB`) while the console is stopped, or with SQLite's online backup.
- Back up `RTWEB_SECRET_KEY` and `RUNTIME_MASTER_KEY` separately, in a password manager or a secret store.
  A database backup without its keys cannot decrypt sealed secrets.
- Test a restore on a second machine before you need it.

## Upgrades

Read the [changelog](https://github.com/21-ci/runtime-web/blob/main/CHANGELOG.md) for the version you are moving to. Back
up first, then pull the new version and run `docker compose up -d --build --wait`. Schema migrations run when the console
starts.

## Security checklist

- Every `dev-insecure-*` value is replaced, and `RTWEB_DEV` is unset.
- HTTPS is on, and the public URLs use `https://`.
- `RTWEB_TRUSTED_PROXIES` lists only proxies you run.
- Two-factor auth is enabled for every instance admin, and is required by policy if your team can enforce it.
- Only the router's ports are exposed. The runtime's control port and the metrics port stay on the internal network.
- The audit log is reviewed on a schedule.

For the full model, read the [security model](security-model.md).
