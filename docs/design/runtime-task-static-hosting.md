# Runtime task: static file hosting, subdomain-only routing, unlimited plans

You are working in `github.com/21-ci/runtime` (rt, v0.1.1, Rust). This file is self-contained. The
full design rationale lives in runtime-web at `docs/design/static-hosting.md` (revision 5), but you
should not need it.

## 1. Goal

Make rt able to host the static files of web interfaces (HTML, CSS, JS, images, fonts) **next to**
App code in the same service, with caching. A request to an App host follows a per-service rules
file (`static.toml`), which sends it to a file, a redirect, a rewrite, or the App's code.

Alongside that:

1. Serve Apps **only** on `<slug>.<routing.base_domain>` and verified or mapped hosts, and remove
   `/s/{slug}/` path routing.
2. Add an internal `tls-ask` endpoint for Caddy on-demand TLS.
3. Allow `"unlimited"` plan limits and a per-plan soft/hard over-quota mode, with a unified
   `unlimited` default plan.

This applies to new installs only, so there is nothing to migrate.

## 2. Context (read first)

| Path in `../runtime` | Why |
|---|---|
| `crates/rt-triggers/src/routes.rs` | `RouteTable` (`ArcSwap` snapshot), `resolve()`: custom host → `{slug}.{base_domain}` → the `/s/{slug}` arm (lines ~195-213) to be deleted; `RouteMatch::PathPrefix`, `base_path`/`x-rt-base-path` |
| `crates/rt-api/src/invoke.rs` | The ingress pipeline (route → plan `http` → limits → `allow_paths` → dispatch); `resolved_path()`/`dot_segment()` path normalization to reuse; `guest_headers()` sets `x-rt-base-path` |
| `crates/rt-api/src/hosts.rs` | Custom-host claims and verification (`PUT /v1/services/{s}/hosts/{host}`); `tls-ask` must consult the same table |
| `crates/rt-store/src/artifact.rs` | Content-addressed artifact store `$RT_DATA/artifacts/<sha256>`, `delete_unreferenced`, `sweep_orphans`, grace period. Reuse it for the fs backend and GC |
| `crates/rt-cache/` | Existing cache crate; check for overlap before adding `moka` |
| `crates/rt-types` | `RouteEntry`, `RouteSnapshot`; add the live file deploy here |
| `crates/rt-server/src/wiring.rs`, `control_plane.rs`, `specs.rs` | Where the route table and snapshots are built and swapped |
| `crates/rt-api/src/control.rs` | Control routes (`/v1/node/*`, versions, `live`); add the new routes the same way (utoipa) |
| `docs/api.md`, `docs/config.md`, `docs/handlers.md` | Update: versions/live API, `[routing]`, `[plans.<name>]` (built-in `free`/`system`), `std:blob` |
| `Cargo.toml` (workspace) | axum 0.8.9, hyper 1.9, tokio 1.52, tower-http 0.6.6 already present |

Deployment context:
- rt never terminates TLS. Caddy does, then proxies plain HTTP to the invoke listener
  `127.0.0.1:8080` and keeps `Host`.
- The control listener is `127.0.0.1:8081`.
- The console (runtime-web) is an rt service mapped to `console.<domain>`. Its loopback calls will use
  a `Host:` header, never `/s/`.

## 3. Scope

### 3.1 Routing: remove `/s/{slug}`

- Delete the `/s/` arm in `RouteTable::resolve`. The resolution order is:
  1. a mapped or verified host;
  2. `{slug}.{routing.base_domain}`;
  3. none → `404`.
- Remove `RouteMatch::PathPrefix`, `Route.base_path` and the `x-rt-base-path` header. Update
  `docs/handlers.md`.
- `routing.base_domain` is required whenever any service has the `http` trigger. Config validation
  fails with `routing.base_domain is required (Apps are served at <slug>.<base_domain>)`.
- Slugs: a DNS label `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` with **no `--`**, which is reserved for
  preview hosts `{seq}--{slug}`. Service create/rename returns `422 validation_failed` with
  `slug must be a DNS label without "--"`.
- Update docs and samples (`docs/api.md` example `curl …/s/hello/`, `sample/scripts/invoke.sh`) to
  use `Host:`.

**Acceptance**:
- `GET /s/x/` on an unmapped host → 404, even when service `x` exists.
- `Host: x.<base>` resolves `x`, and `Host: 3--x.<base>` resolves the preview of `x` (3.5).
- Mapped and custom hosts win over the base domain.
- `access = internal` stays 404 on the public listener.
- No `x-rt-base-path` header reaches a guest.
- Route-table property tests cover the order.

### 3.2 `GET /v1/internal/tls-ask?domain=<host>`

- Control listener, **loopback peers only** (403 otherwise), no auth, rate-limited (e.g. 50/s).
- `200` (empty body) if `domain` (lowercased, without a trailing dot) is one of:
  - `{slug}.{base_domain}` for an existing service that is not `internal`;
  - `{seq}--{slug}.{base_domain}` where that file deploy exists and is `ready`;
  - an **active** verified custom host;
  - an operator-mapped host.
- `404` otherwise. Never answer for `base_domain` itself or for deeper subdomains (`a.b.<base>`).

**Acceptance**: a table-driven test covering each case, including an unknown slug, an internal
service, a pending custom host and a non-loopback peer.

### 3.3 Cookie strip

On every public response for a service reached through `base_domain`, drop any `Set-Cookie` whose
`Domain` attribute equals `base_domain` or a parent of it (a case-insensitive suffix match after
stripping a leading dot). Log at debug level.

**Acceptance**:
- `Domain=apps.example.com` and `Domain=.example.com` are dropped.
- Host-only cookies and `Domain=x.apps.example.com` are kept.

### 3.4 New crate `rt-static`

It is called from `invoke.rs` **after** access, plan and rate checks and before dispatch:
`rt_static::handle(&route, &req) -> Outcome::{Response(resp), App(rewritten_req), NotFound}`.

When the service has no live file deploy, the call returns `App` immediately at zero cost. When
there is also no live code version, the result is `404` (or the deploy's `not_found` file).

### 3.5 File deploy model (a separate track from code versions)

SQL (migrations in rt-store):

```text
file_deploys(id text pk "fd_<ulid>", service_id, seq int, state draft|uploading|processing|ready|failed|expired,
             manifest_sha, rules json, files int, bytes, unique_bytes, requires_code text null,
             label, created_by, created_at, source, failure json null)
file_entries(file_deploy_id, path, sha256, size, content_type, br_sha null, gz_sha null, pk(file_deploy_id,path))
upload_grants(id_hash pk, file_deploy_id, service_id, tenant_id, allowed json {sha:size}, max_bytes,
              max_count, used_bytes, used_count, expires_at, revoked)
services: + live_files null, + preview_files null, + storage_backend json null (root only),
          + cache_enabled bool default true, + cache_epoch int default 0
```

- `RouteEntry` gains `live_files: Option<Arc<StaticSite>>` and `preview: Option<(u32, Arc<StaticSite>)>`.
- Activating a file deploy, rolling back, changing the code version or changing the preview builds a
  new snapshot, swapped atomically like code flips. A request sees either the old or the new file
  set, never a mix.
- Code versions are unchanged and independent. Each track has its own history, rollback (activate an
  earlier `ready` id) and redeploy.
- Compatibility is advisory:
  - `requires_code` (`">=N"`, `"=N"` or a label) gives `409 skew` on activation unless `force=true`.
  - Responses carry `x-rt-files: <seq>` and `x-rt-code: <version>`, unless
    `static.expose_versions = false`. Requests forwarded to the App carry `x-rt-files`.
- Preview host `{seq}--{slug}.{base}`: serves that `ready` deploy, with the **live** code behind its
  `app` routes, `X-Robots-Tag: noindex` and `Cache-Control: no-store`.
- Drafts that are not `ready` within 24 h become `expired`.
- Retention: the plan's `static.retained_deploys`. With `"unlimited"`, keep 100 per service (node
  setting `static.unlimited_retain`), plus the live and preview deploys. Blob GC goes through the
  artifact store's sweep.

### 3.6 Control API (port 8081, tenant keys; scopes as for code versions)

`POST /v1/services/{s}/file-deploys` (scope `deploy`)

```json
// request
{"files": {"/index.html": {"sha256": "ab…", "size": 1234}, "/assets/app.3f9a.js": {"sha256": "cd…", "size": 52011}},
 "rules": "version = 1\nspa = \"index.html\"\n…",        // optional; static.toml text; overrides a /static.toml file
 "from": "fd_01J…",                                       // optional: reuse that deploy's manifest (rules-only deploy)
 "label": "release 1.4", "requires_code": ">=42"}
// 201
{"id": "fd_01J…", "seq": 13, "state": "draft", "required": ["ab…"], "diagnostics": []}
// 422 validation_failed  {"error":{"code":"validation_failed","details":{"diagnostics":[{code,path,line,col,message,severity}]}}}
// 403 plan_limit {"details":{"limit":"static.max_files","max":2000,"requested":2500}}
```

`POST /v1/file-deploys/{id}/upload-grants` (scope `deploy`) issues a new grant and revokes any older
one for this draft.

```json
// 201, fs backend
{"grant": "rtu_<base64url 32B>", "expires_at": "2026-…Z", "upload": {"mode": "direct", "url": "https://<public>/v1/uploads/{sha256}"}}
// 201, s3 backend
{"grant": "rtu_…", "expires_at": "…", "upload": {"mode": "presigned", "urls": {"ab…": "https://bucket…?X-Amz-…"}}}
```

`PUT /v1/uploads/{sha256}` (**public listener**, `Authorization: RtUpload <grant>`, raw body):

| Result | When |
|---|---|
| `201` | Body stored |
| `409 already_uploaded` | That sha was already uploaded under this grant (idempotent for retries) |
| `400 size_mismatch` | `Content-Length` differs from the declared size |
| `422 hash_mismatch` | The streamed sha256 differs |
| `403 not_in_grant` | The sha is not part of this grant |
| `401 grant_invalid` | Unknown or revoked grant |
| `401 grant_expired` | Grant past its expiry |
| `413 too_large` | The grant's byte or count budget is exceeded |

`POST /v1/file-deploys/{id}/finalize` (scope `deploy`), body `{"activate": true, "force": false}`:

1. Every manifest sha must be present: uploaded, or already in the service CAS (S3: HEAD for
   size and checksum). Otherwise `422 upload_incomplete {"missing": [...]}`.
2. Burn the grant and move to `processing`, answering `202`.
3. Build br (q11) and gzip (level 9) variants for compressible types over 1 KB, kept only if ≥ 10%
   smaller.
4. Check `storage_mb` and `static.*` limits (always hard at deploy).
5. Move to `ready`, and optionally activate (with the skew check).
6. On any error: `failed` with `failure {reason, message}`.

Other routes:

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/services/{s}/file-deploys` | `services:read` | Array, newest first |
| GET | `/v1/file-deploys/{id}` | `services:read` | |
| GET | `/v1/file-deploys/{id}/files?prefix&cursor&limit` | `services:read` | `{items:[{path,size,content_type,sha256,encodings:["br","gzip"]}], next_cursor}` |
| PUT | `/v1/services/{s}/files/live` | `deploy` | `{"file_deploy": "fd_…", "force": false}` → `200 {live_files}`; `409 skew`; `422 not_ready` |
| DELETE | `/v1/services/{s}/files/live` | `deploy` | Static serving off |
| PUT | `/v1/services/{s}/files/preview` | `deploy` | `{"file_deploy": "fd_…" \| null}` |
| GET | `/v1/services/{s}/static/match?path=/x&method=GET&host=` | `services:read` | `{rule: "routes[2]" \| "default", action: "static" \| "app" \| "redirect" \| "rewrite" \| "not_found", file?, status, headers}` |
| POST | `/v1/static/validate` | `deploy` | Body: `static.toml` text → `{ok, diagnostics}` |
| GET | `/v1/services/{s}/cache` | `services:read` | `{enabled}` |
| PUT | `/v1/services/{s}/cache` | `deploy` | `{enabled}` |
| POST | `/v1/services/{s}/cache/purge` | `deploy` | `{paths?: [], prefixes?: []}` (empty = all) → `202 {epoch, cdn: "queued" \| "none"}`; 10 per minute per service → `429` |

Also update `openapi/` (utoipa), `docs/api.md` and the MCP tools (`deploy_files`, `list_files`).

### 3.7 One-time upload grants (security)

- Token: `rtu_` + base64url(32 random bytes). Only `sha256(token)` is stored, compared in constant
  time.
- Scope: one draft; an exact `{sha: size}` set; `max_bytes` = sum and `max_count` = n; TTL 15 min.
  The grant is single-use as a whole (burned at finalize or expiry). Each sha slot can be consumed
  once. At most one live grant per draft. 20 grants per hour per service; 3 concurrent drafts per
  service.
- CORS on `/v1/uploads/*` only:
  - origins: exactly the entries of `ingress.upload_cors_origins` (the console origin); never `*`;
  - `PUT, OPTIONS`; headers `Authorization, Content-Type, Content-Length`; `max-age 600`; no
    credentials.
- S3: rt signs one presigned PUT per sha with the service's scoped credentials. The URL expires at
  the grant's expiry, is bound to key `…/blobs/{sha}`, has `Content-Length` signed in, and
  `x-amz-checksum-sha256` signed in where the provider supports it. rt sets the bucket's CORS to the
  same origin and `PUT` only.
- Optional zip/tar bundle (CLI convenience): `POST /v1/file-deploys/{id}/bundle` with a grant.
  Streaming extraction with limits on total bytes, count, a 100:1 compression ratio, no nested
  archives, and no symlinks, hardlinks or devices.

**Acceptance**:
- A replayed grant after finalize → 401.
- A grant for deploy A used on B → 403.
- A wrong hash → 422, and nothing is stored.
- An expired grant → 401.
- CORS preflight from another origin → no ACAO header.
- Fuzz manifest paths: reject `..`, `\`, NUL, control characters, non-NFC, and paths over 1024
  bytes.

### 3.8 `static.toml` (parsed and enforced by rt)

It is a `/static.toml` at the root of the file set (never served), or the `rules` text in the
request (which wins). Parse with `toml` and `deny_unknown_fields`, compile into a `StaticSite`
(path map plus `globset`), and store the result in `file_deploys.rules`. The serving path never
parses TOML.

```toml
version = 1                        # required
index = ["index.html"]             # ≤ 4
not_found = "404.html"             # served with 404
spa = "index.html"                 # HTML-navigation fallback (Accept: text/html, no extension in last segment)
clean_urls = false                 # /a → a.html; /a.html → 308 /a
trailing_slash = "auto"            # auto | always | never
hide = ["**/*.map"]                # dotfiles are always hidden
requires_code = ">=42"

[cache]
html = "revalidate"                # revalidate | no-store | seconds
default = 300
immutable = ["/assets/**"]

[[redirects]]                      # evaluated first
from = "/old/:slug"
to = "/blog/:slug"                 # or an absolute https URL with a literal host
status = 308                       # 301|302|303|307|308
host = "www.example.com"           # optional exact host match
query = "keep"                     # keep | drop

[[routes]]                         # first match wins
path = "/api/**"
to = "app"                         # app | static | rewrite | redirect
methods = ["*"]                    # default ["GET","HEAD"] for static/rewrite, ["*"] for app
dest = "/x.html"                   # rewrite/redirect target
status = 308                       # redirect only
fallthrough = false                # static: missing file → next rule instead of 404

[[headers]]                        # every matching block applies in order; later wins
path = "/**"
set = { "X-Frame-Options" = "DENY" }
unset = ["X-Powered-By"]
```

- Patterns: `*` matches one segment, `**` the rest (last position only), `:name` is a placeholder.
  Matching is case-sensitive on the decoded, normalized path (reuse `resolved_path`). `:name` and
  `:splat` are substituted in targets.
- Default order: redirects → routes → (GET/HEAD: exact file, then clean URL, then directory index)
  → `app` if a live code version exists → `spa` for HTML navigations → `not_found` (404).
- Non-GET/HEAD requests are never static: they go to `app`, or `405` with `Allow`.

Validation (all errors returned together, `422 validation_failed`, each diagnostic
`{code, path:"routes[2].dest", line, col, message, severity}`):

| Code | Rule | Message |
|---|---|---|
| `toml_syntax` | Valid TOML | `static.toml:{line}:{col}: {parser message}` |
| `unknown_key` | No unknown keys | `Unknown key "{key}" in {table}. Allowed: {list}` |
| `version` | `version = 1` | `Unsupported static.toml version {v}; this runtime supports 1` |
| `pattern_invalid` | Starts with `/`; `**` only last; no `..` `//` `\` NUL `?` `#`; ≤ 512 B | `Invalid path pattern "{p}": {reason}` |
| `placeholder_unknown` | Placeholders in the target are captured by the source | `"{to}" uses :{name}, which "{from}" does not capture` |
| `redirect_host_placeholder` | Absolute targets: https only, literal host, no userinfo | `Redirect target host must be literal (open redirect): "{to}"` |
| `status_invalid` | Redirect status in the allowed set | `Redirect status must be one of 301, 302, 303, 307, 308` |
| `dest_missing` | `dest`/`spa`/`not_found`/`index` exist in the manifest | `"{dest}" is not in this file deploy` |
| `to_invalid` | `to` in the enum | `routes[{i}].to must be app, static, rewrite or redirect` |
| `dest_required` | `rewrite`/`redirect` have `dest` | `routes[{i}]: "to = {to}" requires "dest"` |
| `methods_invalid` | Tokens; static/rewrite only GET/HEAD | `routes[{i}]: static routes serve only GET and HEAD` |
| `header_forbidden` | Not `Set-Cookie`, `x-rt-*`, hop-by-hop, `Content-Length`, `Content-Encoding`, `Content-Range`, `ETag`, `Last-Modified`, `Date`, `Server` | `Header "{h}" cannot be set by static rules` |
| `header_invalid` | Token name; visible ASCII value ≤ 4 KiB | `Header "{h}" has an invalid name or value` |
| `too_many_rules` | redirects + routes ≤ 500; headers ≤ 100 | `Too many rules: {n} (max {max})` |
| `cache_invalid` | Enum or 0..=31536000 | `cache.{k} must be "revalidate", "no-store" or 0..31536000 seconds` |
| `requires_code_invalid` | `>=N`, `=N` or a label ≤ 64 | `requires_code must look like ">=42", "=42" or a label` |
| `unreachable_rule` (warning) | Fully shadowed by an earlier rule | `routes[{i}] can never match: shadowed by routes[{j}]` |

**Acceptance**: a golden test per code (input → exact diagnostics); a property test that compile is
deterministic; `match` dry-run tests covering the default order, SPA vs 404, clean URLs vs trailing
slash, rewrite placeholders, and redirect query handling.

### 3.9 Serving and caching

- Look up only through the manifest; never map a request path onto the filesystem.
- Headers on every static response:
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
    `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Resource-Policy: same-site`, then the user
    `[[headers]]`;
  - content type from the manifest (fixed at upload with `mime_guess`, `charset=utf-8` for text);
  - `Cache-Tag: rt-svc-<id>`.
- ETag `"<sha first 16 bytes hex>[-br|-gz]-e<cache_epoch>"`; `Last-Modified` = the deploy's
  `created_at`.
- `If-None-Match` → 304; `If-Modified-Since`; `If-Match`/`If-Unmodified-Since` → 412. A single
  `Range` → 206 (identity encoding only) with `If-Range`; multipart ranges → 200.
- Encoding picked from `Accept-Encoding` q-values among br, gzip and identity, with
  `Vary: Accept-Encoding`. No on-the-fly compression.
- Cache-Control:
  - HTML: per `cache.html` (default `public, max-age=0, must-revalidate`);
  - immutable (hashed names `[.-][A-Za-z0-9_-]{8,}\.(js|mjs|css|woff2?|png|jpe?g|webp|avif|svg|wasm)$`,
    or `cache.immutable`): `public, max-age=31536000, immutable`;
  - other files: `public, max-age={cache.default}, stale-while-revalidate=86400`;
  - services with `access = key`: `private`.
- **Caching toggle** (`cache_enabled = false`):
  - every static response gets `Cache-Control: no-store` (overriding rules), with no
    `ETag`/`Last-Modified`;
  - **rt's server caches stay on**, because their entries are immutable by content hash;
  - a CDN purge-all fires when the toggle turns off.
- **Purge all**: drop the service's memory and disk cache entries, `cache_epoch += 1` (so every ETag
  changes), and send a CDN purge by tag. Paths/prefixes are only forwarded to the CDN.
- **CDN hook** `[static.cdn]`:
  - `provider = "cloudflare"` (`zone_id`, `token` secret): purge by tag/URL/prefix. Cloudflare
    allows 5 requests/min (Free) to 50 requests/s (Enterprise) and 100 operations per request, so
    queue, debounce 1 s, batch, and back off;
  - or `"webhook"` (`url`, HMAC `secret`): a POST `{service, hosts, tags, paths, prefixes}`.
- Server caches:
  - `moka` weighted LRU for objects ≤ 256 KB (`static.cache.memory_mb`; profile defaults
    edge-1gb 32, balanced 128, min_latency 512), with each tenant capped at 25%;
  - S3 only: a disk read-through LRU (`static.cache.disk_mb`, default 2048).

**Acceptance**:
- A conditional-request matrix test, and range tests.
- br is served when accepted and identity otherwise.
- Toggle off → `no-store` and no ETag; purge changes ETags.
- A bench: a warm 10 KB hit has p50 < 200 µs on a laptop, vs Caddy `file_server` as reference.

### 3.10 Storage backends and per-service credentials

```toml
[static]
enabled = true
expose_versions = true
unlimited_retain = 100
[static.storage]
backend = "fs"                     # fs | s3
fs_dir = "/data/static"
[static.storage.s3]
provider = "aws"                   # aws | minio | r2 | b2 | generic
endpoint = "…"; bucket = "rt-static"; region = "…"; path_style = false
admin_credentials = "secret:rt_static_admin"
isolation = "prefix"               # prefix | bucket (r2 → bucket)
key_rotation_days = 30
[static.cache]
memory_mb = 128
disk_mb = 2048
[ingress]
upload_cors_origins = ["https://console.example.com"]
```

- Layout: `t/{tenant}/s/{service}/blobs/{sha[0..2]}/{sha}` (+ `.br`, `.gz`). Deduplication is per
  service. The fs backend may reuse the artifact store's write-temp-then-rename and GC.
- Per-service override `services.storage_backend`: **root only**.
- `CredentialMinter` trait, one implementation per provider:

| Provider | Mechanism |
|---|---|
| AWS | STS AssumeRole with an inline session policy limited to `arn:aws:s3:::bucket/t/{t}/s/{s}/*`, plus `s3:ListBucket` with `StringLike s3:prefix`, ≤ 1 h |
| MinIO | A service account per service with the same prefix policy (AWS IAM schema) |
| R2 | Tokens can't be scoped to a prefix → **one bucket per service** plus a bucket-scoped token (`Workers R2 Storage Bucket Item Write`) through the Cloudflare API |
| B2 | `b2_create_key` with `bucketId`, `namePrefix`, `readFiles,writeFiles,listFiles,deleteFiles`, `validDurationInSeconds` |
| generic | Shared credentials, plus a warning in `rt doctor` |

- Rotation: two active credentials, a daily job, 24 h overlap. Stored encrypted like service
  secrets.
- Serving is always proxied through rt. Never redirect to a presigned GET.
- Crates (crates.io, 2026-10-27):
  - `object_store` 0.14.2 (fs + S3; fallback `rusty-s3` 0.10.2 for presigning);
  - `moka` 0.12.16, `globset` 0.4.20, `mime_guess` 2.0.5, `flate2` 1.1.10, `tar` 0.4.46,
    `http-range-header` 0.4.2;
  - `brotli` 9.x and `zip` 9.x: pin a release ≥ 2 weeks old (9.1.1 and 9.1.2 came out
    2026-10-26/27);
  - `aws-sdk-sts` only for AWS minting; `reqwest` for the others;
  - run `cargo deny`.

**Acceptance**: integration tests against MinIO (docker) for prefix isolation (service A's
credentials can't read B's prefix), presigned PUT with checksum, rotation without failed reads, and
GC. Unit tests for the R2 and B2 minters with recorded HTTP.

### 3.11 Plans: unlimited, over-quota mode, default plan, metering

- Every numeric plan key accepts a number or `"unlimited"`, in TOML and in JSON. Unlimited means no
  plan constraint; node caps still apply.
- New plan key `over_quota = "soft" | "hard"`, default `soft`:
  - `soft`: serve, record and warn (`x-rt-quota: exceeded` on the tenant's control API responses,
    plus usage flags);
  - `hard`: `429 quota_exceeded` with `Retry-After` at the window end, for runtime counters
    (invocations, static requests, egress).

  Deploy-time storage and size limits are always hard (`403 plan_limit`).
- New plan keys:
  - `static.max_file_mb`, `static.max_files`, `static.max_deploy_mb`, `static.retained_deploys`;
  - `static_requests_per_month`, `static_egress_mb_per_month` (calendar month UTC);
  - `storage_mb` now includes unique static bytes, variants included.
- New built-in plan **`unlimited`** (every key `"unlimited"`, all triggers allowed,
  `over_quota = "soft"`). A new node key `tenancy.default_plan = "unlimited"` applies to new tenants.
  `free` and `system` stay.
- Static hits are counted in `static_requests`, **not** in invocations. A 304 counts as a request
  with zero egress. Counters are per-node atomics, flushed every 10 s.
- Operator plan write API (needed by runtime-web Admin → Plans), with a DB overlay over `[plans.*]`
  (TOML is the seed; the overlay wins and is reloaded live):
  - `PUT /v1/plans/{name}` `{settings, over_quota}`;
  - `POST /v1/plans`;
  - `DELETE /v1/plans/{name}` → `409 plan_in_use`, refused for built-ins;
  - `PUT /v1/node/default-plan` `{name}`;
  - `GET /v1/plans` returns the merged view with `source: "toml" | "api" | "builtin"`.
- `GET /v1/tenants/{id}/usage` adds `static_requests`, `static_egress_mb` and `static_storage_mb`.

**Acceptance**:
- `"unlimited"` parses in TOML and JSON and round-trips.
- A hard plan returns 429 past the limit; a soft plan serves and sets the flag.
- A new tenant gets `unlimited`.
- Plan edits through the API apply without a restart.

## 4. Non-goals

- Image transforms and on-the-fly compression (variants are built at finalize only).
- `/s/` compatibility, redirects or migration (new installs only).
- Skew pinning (cookie or query-based asset pinning).
- TLS or ACME inside rt (Caddy does TLS; rt only answers `tls-ask`).
- Tenant-supplied storage endpoints or credentials.
- Netlify `_redirects`/`_headers` import (possible later, converted into `static.toml`).
- Multi-node replication beyond what the S3 backend gives.

## 5. Suggested PR breakdown (≈ 12 rt engineer-weeks)

| # | PR | Weeks |
|---|---|---|
| 1 | Routing: delete `/s/`, require `base_domain`, slug rule (no `--`), docs and samples | 0.4 |
| 2 | `tls-ask` endpoint + `Set-Cookie` Domain strip | 0.4 |
| 3 | Plans: `"unlimited"`, `over_quota`, `unlimited` built-in and `tenancy.default_plan`, DB overlay and plan write API | 1.5 |
| 4 | `rt-static` skeleton + schema migrations + `StaticSite` in `RouteEntry` + snapshot swap; invoke.rs hook (no-op without files) | 1 |
| 5 | File deploy create/list/get/files, upload grants, `PUT /v1/uploads/{sha}` with CORS, finalize (no variants), live/preview, fs backend | 2 |
| 6 | Serving: lookup, default order, headers, ETag/304/412, ranges, preview hosts, skew check | 1.2 |
| 7 | `static.toml` parser, compiler, validation codes, `validate` + `match` endpoints, rules-only deploys | 1.5 |
| 8 | Precompression at finalize, cache classes, moka LRU, cache toggle, epoch purge, CDN hook | 1.2 |
| 9 | Metering: `static_requests`/egress counters, `storage_mb` accounting, hard/soft enforcement, usage API, retention and GC | 0.8 |
| 10 | S3 backend (`object_store`), disk cache, presigned PUTs, `CredentialMinter` (AWS, MinIO, R2, B2), rotation, bucket CORS | 2.5 |
| 11 | Optional zip/tar bundle upload; MCP tools; path fuzzing (cargo-fuzz); bench | 0.8 |

PRs 1-3 ship first and unblock runtime-web.

## 6. Open questions (with recommendations)

1. **Plan storage**: a DB overlay plus an API (recommended), or keep TOML-only with SIGHUP?
2. **Monthly windows**: calendar month UTC (recommended) or a rolling 30 days?
3. **Retention when `unlimited`**: keep 100 per service (recommended) or everything?
4. **Does `cache_epoch` belong in the ETag of an `immutable` asset too?** Recommendation: yes,
   because it is harmless (URLs change on every build anyway) and keeps purge semantics uniform.
