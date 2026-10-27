---
title: Data protection at rest
description: What a Runtime Web instance stores on disk, who can read it, why the container has a /tmp, and a phased plan to encrypt data without exposing keys.
---

# Data protection at rest

Status: research and plan. Phase 0 is implemented; phases 1 to 3 are follow-ups. Not part of the published site
navigation.

## What is stored today

| Data | Where (bare / docker) | Protection today |
|---|---|---|
| Runtime metadata: tenants, services, versions, hosts, API key hashes, sealed tenant secrets | `meta.db` (SQLite) in `/var/lib/rt` / `/data` | Secrets sealed with AES-256-GCM under the master key; API keys stored as `HMAC-SHA256(pepper)` with a pepper derived from the master key. The rest is plaintext |
| Per-App data: KV, SQL, blobs | `services/`, `blobs/` per service | Plaintext SQLite files and blob files |
| Console data (users, sessions, orgs, audit, TOTP secrets, OAuth client secrets, org default keys) | the `rtweb` service's own `data.db` | Password hashes are argon2id. TOTP secrets, OAuth client secrets and default org keys are sealed by the console with AES-256-GCM under `RTWEB_SEAL_KEY`, bound to their row (AAD). Everything else is plaintext |
| `RTWEB_SEAL_KEY`, `RTWEB_SETUP_TOKEN` | sealed tenant secrets of the `rtweb` service in `meta.db` | Sealed under the master key |
| App versions and compiled cache | `artifacts/`, `cache/` | Plaintext; the compiled cache has a MAC (`cache/v2/.mac-key`) against tampering, not confidentiality |
| Async queue, logs | `queue.db`, `logs/<svc>/*.seg` | Plaintext. Logs hold whatever Apps print |
| Root token, master key, relay secret | bare: `/etc/default/rt` (0600), `/etc/rt/credentials/` (new nodes), `/etc/rtweb/` (0600). docker: `/opt/runtime-web/docker/secrets` (0400, Docker secrets) or `/data/rtweb/secrets` (0600, generated) | File permissions only |
| Cloudflare token (`--wildcard-cert`) | `/etc/rtweb/dns-token` (0600) / Docker secret `dns_token` (0400) | File permissions only |
| Certificates and ACME account keys | Caddy's data dir / `caddy-data` volume | Plaintext private keys |
| SQLite temporary files | docker: `/data/tmp`; bare: the first writable of `SQLITE_TMPDIR`, `/var/tmp`, `/tmp` (systemd `PrivateTmp`) | Unlinked on open, plaintext while they exist |

The runtime has no at-rest encryption of its databases or blobs (no SQLCipher, no page-level encryption; it builds
`rusqlite` with `bundled`). The only cryptographic protection at rest is sealing of secrets under the master key, plus
the master-key rotation (`RT_MASTER_KEY_PREVIOUS` and `rt secrets reseal`). It reads `RT_ROOT_TOKEN_FILE` and
`RT_MASTER_KEY_FILE` (and `security.master_key_file`), but binding headers (`inject_headers = "env:..."`) come only from
its environment, so `RTWEB_OP_TOKEN` (which contains the root token) and `RTWEB_RELAY_SECRET` must be environment
variables of `rt`.

## Why the container has a `/tmp`

The image runs read-only, and `docker-compose.yml` mounted a 64 MB tmpfs at `/tmp`. Findings:

- **Empirical.** The image was run with `--read-only` and no `/tmp` mount at all. It booted, bootstrapped the console,
  became healthy, and `/tmp` stayed empty in a run that had one. Nothing in the boot path writes there.
- **rt source.** No production code path calls `std::env::temp_dir`, `tempfile` or writes `/tmp`; those uses are all in
  tests. Runtime caches (`cache/`, `deps/`, npm/JSR fetches) live under the data dir. V8 and wasmtime JIT memory is
  anonymous memory, not files.
- **SQLite.** Per-App `data.db` connections set `temp_store = FILE`, so a large sort or materialized subquery of a
  guest spills to a temporary file. SQLite picks the first writable of `SQLITE_TMPDIR`, `TMPDIR`, `/var/tmp`,
  `/usr/tmp`, `/tmp`, then the working directory. With the old tmpfs those spills went to a 64 MB RAM disk (a large
  statement failed with "database or disk is full" and the RAM counted against the container's memory); without it
  they went to `/data` (the working directory).
- **rtweb-entry (Go)** never creates temporary files. TLS is terminated by Caddy, not in the container.

Decision (implemented): `rtweb-entry` creates `/data/tmp` (0700, emptied on start) and sets `TMPDIR` and
`SQLITE_TMPDIR` for `rt` unless the operator set them. Spills now live on the data volume, in the same protection domain
as the databases they come from, and are bounded by the volume, not by RAM. The `/tmp` tmpfs is no longer required; the
compose files keep a 16 MB `noexec,nosuid,nodev` tmpfs only as a safety net for any library that insists on `/tmp`.

## Threat model

| Threat | Today | What helps |
|---|---|---|
| Stolen disk, snapshot or backup | Everything except sealed secrets and password hashes is readable. If the backup also holds the master key (`/data/rtweb/secrets/master-key` in the same volume, or `/var/lib/rt/master.key`), the sealed secrets fall too | Full-disk or volume encryption; keys kept apart from data; encrypted backups |
| Other local users on the host | Data dirs are `0750 rt:rt` / uid 10001 `0700`, secrets `0600`/`0400` root | File modes (in place), systemd credentials, `umask 077` (in place) |
| A compromised App (V8/wasmtime escape) | Same process as the master key and every tenant's data (the runtime's documented limitation) | Only the runtime's planned supervisor/executor split; encryption at rest does not help against a live process |
| Container escape / host root | Everything readable, including keys in memory | Out of scope for at-rest encryption; TPM-sealed keys only help while the host is off |
| Operator | Holds the root token and master key by design | Audit, separation of duties; not a technical control here |

At-rest encryption protects data when the machine is off or the storage leaves the machine (disk, snapshot, backup). It
does not protect against a running, compromised host.

## Options

1. **Full-disk or volume encryption (LUKS / dm-crypt, cloud provider disk encryption).** Covers every file above,
   including logs, temporary files and Caddy's keys, with no application change. Unlock at boot with a TPM2
   (`systemd-cryptenroll --tpm2-device=auto`), a network key server (Clevis/Tang) or a passphrase. Cost: an ops step;
   protects against stolen disks and snapshots only.
2. **Per-volume encryption for the data dir only.** A LUKS file or partition mounted at `/var/lib/rt` (or the Docker
   volume's backing directory), unlocked by a systemd credential bound to the TPM. Narrower than full disk, same
   protection for the data.
3. **Database-level encryption (SQLCipher or a page-encryption VFS in rt).** Would protect individual files even in
   backups made by copying them. Needs a runtime change (another team's repository): `rusqlite` with
   `bundled-sqlcipher`, key derivation per database from the master key, a migration of existing files, and a
   performance cost of a few percent. Blobs and logs need their own encryption. Large effort; worth it only for
   multi-tenant hosting where tenants' backups are handled separately.
4. **Envelope encryption of the keys.** Keep the master key (the KEK for sealed secrets) out of plaintext files:
   `systemd-creds encrypt` (host key plus TPM2 when present) with `LoadCredentialEncrypted=`, Docker/Swarm or Kubernetes
   secrets, or a KMS (AWS KMS, GCP KMS, Vault transit) that decrypts the key at start. Cheap and effective against
   stolen disks that hold the key file. Caveat: a TPM-bound key dies with the machine, so an offline copy of the master
   key must exist, or sealed secrets are lost.
5. **Encrypted backups.** `restic`/`borg` or `age` on the backup stream, with the backup key apart from both the data
   and the master key. Without this, a backup that holds the volume and its `secrets/` directory is a full compromise.
6. **Secrets handling.** Secrets in files, not environment variables (`*_FILE`, credentials); `0600`/`0400` files;
   `umask 077`; tmpfs-backed credential directories (`/run/credentials`, `/run/secrets` are tmpfs).

## Plan

### Phase 0: cheap hardening (implemented in this change)

- Container: `RT_ROOT_TOKEN_FILE` / `RT_MASTER_KEY_FILE` are passed to `rt` as paths when the values come from files
  (Docker secrets or the generated files), so the master key is not in `rt`'s environment. `umask 077` for
  `rtweb-entry` and `rt`. SQLite temporary files on the data volume (`/data/tmp`, 0700).
- Installer, docker mode: the root token, master key and relay secret are Docker secrets in
  `/opt/runtime-web/docker/secrets` (0400, uid 10001), outside the data volume, so a copy of the volume alone does not
  hold the master key. The Cloudflare token is a Docker secret too. An existing volume keeps the secrets it generated.
- Installer, bare mode: a new node's master key is a systemd credential (`LoadCredential=` from a root-only file under
  `/etc/rt/credentials`, `RT_MASTER_KEY_FILE=%d/...`); where systemd cannot mount credentials, a `root:rt 0640` file.
  The Cloudflare token is a credential of `caddy.service`. Existing keys are never moved.
- Caddy for `--wildcard-cert` runs without `--environ`, so its environment is not logged.

### Phase 1: operator guidance and opt-in flags (follow-up)

- Document LUKS/TPM2 or cloud disk encryption as the recommended baseline for production hosts, and encrypted backups
  (`restic` with a separate key) in the operations guide; spell out "back up the master key apart from the data".
- Installer flag `--seal-master-key`: `systemd-creds encrypt` the master key (TPM2 when present) and switch to
  `LoadCredentialEncrypted=`, after printing how to keep an offline copy.
- Move `RT_ROOT_TOKEN` itself out of `/etc/default/rt` into a credential; only `RTWEB_OP_TOKEN` stays in the
  environment until the runtime can read binding secrets from files.

### Phase 2: runtime support (follow-ups for the runtime team)

- Binding header values from files or credentials (`inject_headers = { x = "file:/run/credentials/..." }`), so no
  secret has to be in `rt`'s environment.
- Disable `/s/<slug>/` path routing when `routing.base_domain` is set (today the edge blocks it).
- A KEK hook: decrypt the master key through a KMS or `systemd-creds` at start.

### Phase 3: database encryption (only if needed)

- SQLCipher (or an encrypting VFS) for `meta.db`, `queue.db` and per-service `data.db`, keys derived per database from
  the master key; encrypted blob and log segments. Re-evaluate after phase 1: full-disk encryption plus encrypted
  backups covers the realistic threats of a self-hosted single-operator instance at a fraction of the cost.
