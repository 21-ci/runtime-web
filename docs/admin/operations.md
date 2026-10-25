---
title: Operations
description: Run the runtime node, custom domains and TLS, backups and keys, and upgrades for a Runtime Web instance.
---

# Operations

Routine tasks for the host and the node under a Runtime Web instance. Each section names the command or page to use.

## Runtime node

The console runs on one runtime node as the service `rtweb`, in the tenant `runtime-web`. The node runs the apps,
stores their data and enforces their limits. Check its state in the **Node** page of the instance console, or on the
host:

```bash
systemctl status rt caddy
journalctl -u rt -f
```

Plans (quotas, limits and allowed triggers per tenant) are defined in the node's `/etc/rt/rt.toml`. The console's own
tenant uses the `rtweb` plan from [`deploy/rt.rtweb.toml`](https://github.com/21-ci/runtime-web/blob/main/deploy/rt.rtweb.toml).
New org tenants get the plan named by `RTWEB_DEFAULT_PLAN` (default `free`). Every five minutes a `housekeeping`
schedule runs the console's background jobs, such as domain re-checks and pruning. It needs the `cron` trigger in the
`rtweb` plan.

To change a plan, edit `rt.toml` and reload the node. Reloading with `systemctl reload rt` sends `SIGHUP`, which
applies plans without a restart. Bindings are read at start, so restart the node after you change them.

## Custom domains and TLS

An org member adds a domain to an app and publishes a TXT record. The domain is pending until the record at
`_rtweb.<host>` contains the token shown in the console. Once verified, the console maps the domain to the app as a
runtime custom host.

Caddy obtains a certificate on demand. Before it issues one, Caddy asks the console's `tls-ask` endpoint, which answers
yes only for active domains. Ports 80 and 443 must be reachable from the internet for the ACME challenge.

To check one domain from the host:

```bash
curl -i 'http://127.0.0.1:8080/s/rtweb/api/internal/tls-ask?domain=api.example.com'
```

`200` means Caddy may issue the certificate. `404` means the domain is not active. The endpoint answers only on
loopback. See [Troubleshooting](../troubleshooting.md#tls-certificate-is-not-issued-for-a-custom-domain).

## Backups and keys

- The console's data lives in the `rtweb` service's SQL database on the node. Back up the node's data directory,
  `/var/lib/rt`, with the runtime's backup procedure.
- Back up the keys separately from the data, in a password manager or a secret store. The keys are the service secret
  `RTWEB_SEAL_KEY`, the rt environment file `/etc/default/rt` (root and master keys) and the directory `/etc/rtweb/`.
  A data backup without its keys cannot decrypt sealed secrets such as TOTP seeds and OAuth client secrets.
- Test a restore on a second machine before you need it.

## Upgrades

1. Read the [changelog](https://github.com/21-ci/runtime-web/blob/main/CHANGELOG.md) for the version you are moving to.
2. Back up the data and the keys.
3. Run the installer with the new version, using the same `--domain` and `--email`:

    ```bash
    sudo sh install.sh --version X.Y.Z --domain console.example.com --email you@your-company.com
    ```

The installer keeps the secrets, uploads and activates the new service version, and the new version migrates the
database the first time it opens it. See [Install: Upgrade](../getting-started/install.md#upgrade).

## Security checklist

- `RTWEB_INSECURE_COOKIES` is unset, and `RTWEB_ORIGIN` uses `https://`.
- `RTWEB_SETUP_TOKEN` is deleted after first-run setup.
- Two-factor auth is enabled for every instance admin, and is required by policy if your team can enforce it.
- Only Caddy's ports (80 and 443) are exposed. The node's invoke (8080), control (8081) and metrics (9090) listeners
  stay on loopback.
- The audit log is reviewed on a schedule.
- Backups and keys are stored apart from each other.

For the full model, read the [security model](../security-model.md).
