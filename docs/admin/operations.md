---
title: Operations
description: Run the runtime node, App and custom-domain certificates, backups and restores, metrics and alerting, and upgrades or downgrades of a Runtime Web instance.
---

# Operations

Routine tasks for the host and the node under a Runtime Web instance. Each section names the command or page to use.
Commands are for a bare install; the docker-mode equivalent follows where it differs (the compose project is
`runtime-web`, its files are in `/opt/runtime-web/docker`).

## Runtime node

The console runs on one runtime node as the service `rtweb`, in the tenant `runtime-web`. The node runs the Apps,
stores their data and enforces their limits. Check its state in the **Node** page of the instance console, or on the
host:

```bash
systemctl status rt caddy
journalctl -u rt -f
# docker mode:
docker compose -p runtime-web ps
docker compose -p runtime-web logs -f rtweb caddy
```

Plans (quotas, limits and allowed triggers per tenant) are defined in the node's `/etc/rt/rt.toml` (docker: the
generated `/data/rtweb/rt.toml` plus `RTWEB_RT_CONFIG_EXTRA`). The console's own tenant uses the `rtweb` plan from
[`deploy/rt.rtweb.toml`](https://github.com/21-ci/runtime-web/blob/main/deploy/rt.rtweb.toml). New org tenants get the
plan named by `RTWEB_DEFAULT_PLAN`; the installer and the container set `unlimited`, a plan without quotas of its own
(see [Install: Plans](../getting-started/install.md#plans)). Every five minutes a `housekeeping` schedule runs the
console's background jobs, such as domain re-checks, pruning and the App index backfill. It needs the `cron` trigger in
the `rtweb` plan.

To change a plan, edit `rt.toml` and reload the node. Reloading with `systemctl reload rt` sends `SIGHUP`, which
applies plans without a restart. Bindings are read at start, so restart the node after you change them. In docker mode,
restart the container (`docker compose -p runtime-web restart rtweb`).

## Certificates for Apps and custom domains

Every App is served at `https://<app>.<apps domain>/`. With a wildcard certificate (Cloudflare DNS-01), Caddy holds one
certificate for `*.<apps domain>` and renews it on its own. Without it, Caddy obtains a certificate per App on its
first visit, after the console's `tls-ask` endpoint confirms that the App exists.

Custom domains: an org member adds a domain to an App and publishes a TXT record. The domain is pending until the
record at `_rtweb.<host>` contains the token shown in the console. Once verified, the console maps the domain to the App
as a runtime custom host, and `tls-ask` says yes for it. Ports 80 and 443 must be reachable from the internet for the
HTTP-01 challenge.

To check one name from the host:

```bash
# bare: Caddy's own ask URL (loopback only)
curl -i 'http://127.0.0.1:8080/s/rtweb/api/internal/tls-ask?domain=api.example.com'
# the same through the console host mapping
curl -i -H 'Host: console.example.com' 'http://127.0.0.1:8080/api/internal/tls-ask?domain=shop.apps.example.com'
```

`200` means Caddy may issue the certificate. `404` means the name is neither an active domain nor an existing App. The
endpoint answers only on loopback (in docker mode, on the container's `RTWEB_TLS_ASK_LISTEN`, `:8079`, which only the
Caddy container reaches). The bare `ask` URL is the one place that still uses the runtime's `/s/rtweb/` path routing,
because Caddy cannot set a `Host` header there; it never leaves loopback. See
[Troubleshooting](../troubleshooting.md#tls-certificate-is-not-issued-for-a-custom-domain).

## Backups and keys

![The backups page with status and history](../assets/screenshots/backups-light.png#only-light)
![The backups page with status and history](../assets/screenshots/backups-dark.png#only-dark)

What to back up:

| What | Bare | Docker |
|---|---|---|
| Data: runtime databases, Apps, blobs, logs (the console's own database is the `rtweb` service's data) | `/var/lib/rt` | volume `runtime-web_rtweb-data` |
| Keys: root token, master key, relay secret | `/etc/default/rt`, `/etc/rt/credentials/`, `/etc/rtweb/` | `/opt/runtime-web/docker/secrets/` (or `/data/rtweb/secrets/` in the volume, for a volume made before the installer) |
| Caddy certificates and ACME account (optional: re-issued if lost) | `/var/lib/caddy` | volume `runtime-web_caddy-data` |

- Store the keys apart from the data, in a password manager or a secret store. The master key opens the sealed secrets,
  including the console's `RTWEB_SEAL_KEY`, which in turn opens TOTP seeds, OAuth client secrets and org keys. A data
  backup without its keys cannot decrypt them; a backup that holds both is a full copy of the instance, so encrypt it.
- Take consistent copies: stop the node first (`systemctl stop rt`, or `docker compose -p runtime-web stop rtweb`), or
  snapshot the filesystem. SQLite files copied while the node writes can be torn.

```bash
# bare
sudo systemctl stop rt
sudo tar -C / -czf /backup/rt-data-$(date +%F).tgz var/lib/rt
sudo systemctl start rt
# docker
docker compose -p runtime-web stop rtweb
docker run --rm -v runtime-web_rtweb-data:/data -v /backup:/backup alpine \
  tar -C / -czf /backup/rtweb-data-$(date +%F).tgz data
docker compose -p runtime-web start rtweb
```

## Restore

Restore onto the same version of Runtime Web and `rt` that made the backup, then upgrade if needed.

1. Install the same version on the new host with the same console host and apps domain (`--version X.Y.Z`), and stop
   the node: `systemctl stop rt` (docker: `docker compose -p runtime-web stop rtweb`).
2. Put the keys back: `/etc/default/rt`, `/etc/rt/credentials/` and `/etc/rtweb/` (docker:
   `/opt/runtime-web/docker/secrets/`, mode `0400`, owner `10001`). The master key must be the one that sealed the
   data.
3. Replace the data: empty `/var/lib/rt` and unpack the backup into it, owned by `rt:rt` (docker: unpack into the
   `runtime-web_rtweb-data` volume, owned by `10001`).
4. Start the node and run the installer once more with the same flags. It keeps the restored secrets, checks the
   bindings and maps the console host again.
5. Check `https://console.example.com/healthz`, sign in, and open an App.

Rehearse this on a second machine before you need it.

### Restore an `rt` backup to a new host

The **Backups** page of the instance admin area shows the node's scheduled backups and starts one. The console cannot
download or delete an archive: its binding lists only `/v1/node/backups` and `/v1/node/backups/status`. Copy archives
on the node, or with `21ci backup download <id>`, and delete them with `21ci backup delete <id>`.

On a new host (bare mode), first put `/etc/default/rt` and `/etc/rtweb/` back, then:

```sh
./install.sh --mode bare --domain console.example.com --apps-domain apps.example.com \
  --runtime-version X.Y.Z --restore rt-backup-<id>.tar --master-key /secure/master.key
```

The installer installs `rt`, runs `rt backup restore` into the empty `/var/lib/rt`, puts the master key in place and
continues as usual. It refuses a node that already has data. Use the `rt` version that made the backup, or a newer one.

A backup brings back keys that were revoked after it was taken. Pass `--revoke-keys-before <time>` to revoke keys older
than that time, or rotate tenant keys afterwards. Encrypted archives are not supported yet, because `rt` does not write
them yet.

Docker: run `rt backup restore <archive> --data-dir <empty dir>` in the image against the empty volume, then continue
with step 4 above.

## Metrics and alerting

The node serves Prometheus metrics on its loopback metrics listener: `http://127.0.0.1:9090/metrics`, with
`/healthz` and `/readyz` next to it (docker: inside the container; publish nothing, scrape it with an agent on the host
network or a sidecar). The console answers `GET /healthz` on its host with `{"ok":true,"db":true,...}`.

In the console, **Usage** shows what an org used against its plan, and **Alerts** sends a message to a webhook or
Telegram channel when a rule fires.

![Plan usage of an org](../assets/screenshots/usage-light.png#only-light)
![Plan usage of an org](../assets/screenshots/usage-dark.png#only-dark)

![Alert channels and rules](../assets/screenshots/alerts-light.png#only-light)
![Alert channels and rules](../assets/screenshots/alerts-dark.png#only-dark)

The console can send some of these itself: see **Alerts** in the instance admin area and in each org's settings (webhook or Telegram). Evaluation depends on the console's cron, so a node that is down cannot report itself; keep an external probe.

Suggested alerts:

| Alert | Signal |
|---|---|
| Console down | `https://console.example.com/healthz` not `200` for 2 minutes (an external probe) |
| Node not ready | `/readyz` not `200`, or the container `unhealthy` |
| Admission pressure | `rate(rt_admission_rejects_total[5m]) > 0`, rising `rt_admission_queue_wait_seconds` |
| Task errors | the error share of `rt_tasks_total` by outcome |
| Certificates | Caddy log lines with `"level":"error"` and `"logger":"tls.obtain"`; certificate expiry under 14 days from an external probe |
| Disk | free space of the data directory or volume under 15 % |
| Backups | the newest backup older than 26 hours |

## Upgrades

Every six hours the console reads the GitHub releases of `21-ci/runtime` and `21-ci/runtime-web`, without a token and
ignoring prereleases. When either is newer than what runs here, instance admins see **Update available** at the bottom
of the sidebar. It opens a dialog with the release notes and the commands for this upgrade. The console does not run
the upgrade: it is an App with no access to the host. To stop the checks, turn off **Check for new releases** under
Instance, Settings.

A normal run of the installer leaves an `rt` it finds alone. To upgrade the node on a bare install, run what the dialog
gives you:

```bash
sudo sh install.sh --upgrade-runtime --runtime-version X.Y.Z
```

This verifies the release against its checksums and Sigstore signature (it needs `cosign`, unless X.Y.Z is the version
`install.sh` pins), replaces `/usr/bin/rt` and restarts it. Config and data stay. The old binary stays at
`/usr/bin/rt.previous` and comes back if the new one does not stay up. A downgrade is refused. In Docker mode `rt` is
part of the image and moves with a Runtime Web release. Test a runtime newer than the one `install.sh` pins before you
use it in production.

## Telemetry

The runtime sends one anonymous report a day: request, project, service, organization and user counts, plus the version
and a random ID. No IP addresses are stored. The first report leaves 24 hours after the first start.

The console's only part is the user count. Once a day it gives the runtime a number through `PUT /v1/telemetry/console`,
and it never contacts the telemetry server. A failed call is ignored.

To opt out, set `telemetry.enabled = false` in `rt.toml`, or `DO_NOT_TRACK=1` in the node's environment, and restart
`rt`. The count then stays on the node. To see the exact report, run `rt telemetry show`.

To upgrade Runtime Web:

1. Read the [changelog](https://github.com/21-ci/runtime-web/blob/main/CHANGELOG.md) for every version between yours and
   the target, including **Breaking** entries.
2. Back up the data and the keys.
3. Run the installer with the new version and the same flags:

    ```bash
    sudo sh install.sh --yes --version X.Y.Z --base-domain example.com --email you@your-company.com
    # docker mode
    sudo sh install.sh --yes --mode docker --version X.Y.Z --base-domain example.com --email you@your-company.com
    ```

The installer keeps the secrets, uploads and activates the new service version only when the bundle changed, and the
new version migrates the database the first time it opens it. See [Install: Upgrade](../getting-started/install.md#upgrade).

## Downgrades

Database migrations only go forward: an older version refuses, or misreads, a database that a newer version migrated.

- **Before the new version served traffic:** run the installer with the previous `--version`. Nothing was migrated yet.
- **After:** restore the backup you took before the upgrade (see [Restore](#restore)), then run the installer with the
  previous version. Changes made since the upgrade are lost.
- The runtime node (`rt`) follows its own release notes; the installer pins the version it installs.

## Security checklist

- `RTWEB_INSECURE_COOKIES` is unset, `RTWEB_ORIGIN` uses `https://` and `RTWEB_APPS_URL` is set (the console refuses
  to start without it).
- Apps live on a separate registrable domain, or the console logs the same-site warning on purpose.
- `RTWEB_SETUP_TOKEN` is deleted after first-run setup.
- Two-factor auth is enabled for every instance admin, and is required by policy if your team can enforce it.
- Only Caddy's ports (80 and 443) are exposed. The node's invoke (8080), control (8081) and metrics (9090) listeners
  stay on loopback.
- The audit log is reviewed on a schedule.
- Backups are encrypted, and the keys are stored apart from them.

For the full model, read the [security model](../security-model.md).
