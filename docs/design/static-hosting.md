# Design: static file hosting for Apps

Status: **final, revision 5.** Research only, not in the MkDocs nav.
Scope: `../runtime` (rt 0.1.1) and this repo (runtime-web).

The runtime-side work is specified separately in
[`runtime-task-static-hosting.md`](runtime-task-static-hosting.md), the hand-off for the rt team.
Section 13 lists what this repo changes once rt ships.

Revision history:
- r1: first design.
- r2: separate file/code deploys, S3, quotas, cache controls.
- r3: subdomains by default.
- r4: final origin, certificate, config and upload decisions.
- **r5** (supersedes anything below that conflicts with it):
  - `/s/` is off entirely, with no operator exception, no 410 window and no `routing.path_routes`.
    This applies to new installs only, so there is nothing to migrate.
  - The console lives at `console.<domain>`, mapped as a host to its service. Its internal loopback
    calls use that `Host` header instead of `/s/`.
  - Every plan limit can be `"unlimited"`. Each plan has an over-quota selector (`soft` / `hard`). The
    instance default is one unified `unlimited` plan.
  - The default Caddy build includes only the Cloudflare DNS module.
  - Skew pinning is dropped.
  - The PSL entry is an optional launch-checklist item.

r4 applied the user's earlier final decisions (section 11). Apps are served only on
`<app>.<apps-domain>` and verified custom domains, and `/s/` is removed for Apps. Certificates come
from Caddy on-demand TLS, with an optional wildcard. `static.toml` is parsed and enforced by rt.
Uploads go browser → rt directly with one-time tokens. The `<base href>` rewrite is removed.

Sources fetched on 2026-10-27:

- Let's Encrypt: rate limits (updated 2026-08-05).
- Cloudflare: Purge cache, Cache Rules settings, Pages "Serving Pages", R2 API tokens.
- Netlify: Deploy overview, API guide (file digest deploys, drafts).
- Vercel: Skew Protection.
- AWS: S3 presigned PUT, IAM prefix ("home directory") policy.
- MinIO: PBAC.
- Backblaze: B2 application keys.
- crates.io: versions.

Statements not backed by these pages are marked *(unverified)*.

## 0. Architecture in one page

```text
 browser ──TLS──> Caddy (TLS only: on-demand per-host certs, optional *.apps wildcard)
                    │  Host kept, X-Forwarded-For
                    ▼
                 rt public listener (invoke.rs)
                    1. route: mapped/verified host (incl. console.<domain>) → {slug}.<apps-domain> → 404  (no /s/)
                    2. access / plan / rate limits
                    3. rt-static: live file deploy's static.toml → static | redirect | rewrite | app
                    4. app → existing isolate/Wasm dispatch (live code version)
 console (own host, never under <apps-domain>) ── rtctl ──> rt control listener
 browser ──one-time token──> rt upload endpoint (blobs) ; S3: presigned PUT straight to the bucket
```

- **`rt-static`** is a new crate inside rt. It has no new process and no hop, and adds about 50-150 µs
  per hit.
- **Two release tracks per service**:
  - code versions (existing): `live`;
  - **file deploys** (new): `live_files`.

  Each track has its own history, rollback and redeploy. Both are swapped atomically in the route
  snapshot.
- **Storage**: a sha256 CAS. The backend is `fs` (volume) or `s3` (AWS, MinIO, R2, B2), set per
  instance with a root-only override per service. S3 gets a prefix or bucket per service with scoped,
  rotated credentials. Files are always served through rt's cache, never by redirect.
- **Quotas**: static bytes count toward `storage_mb`. New counters `static_requests` and
  `static_egress_mb`.
- **Caching**: content-hash ETags, br/gzip variants built at finalize, cache classes, a per-service
  toggle and purge, and a CDN hook.

## 1. Origins and routing

### 1.1 Apps only on `<app>.<apps-domain>` and custom domains

**rt change** (`rt-triggers/src/routes.rs`, `resolve`). Resolution order becomes:

1. A host mapped to a service: a verified custom host, or an operator-mapped host such as
   `console.<domain>`.
2. `{slug}.{routing.base_domain}`.
3. Nothing else. The `/s/{slug}/` branch in `RouteTable::resolve` (routes.rs, the
   `strip_prefix("/s/")` arm) is **deleted** for every service, including the operator's. `/s/…`
   on an unmapped host is a plain `404`.

Consequences:
- There is no `routing.path_routes` setting and no operator carve-out.
- `RouteMatch::PathPrefix` and `x-rt-base-path` are removed (`base_path` is always empty).
- `routing.base_domain` is **required** when `[static]` or tenant HTTP is enabled; rt fails config
  validation without it.
- Loopback callers (installer, supervisor, Caddy's ask) reach a service with
  `Host: <mapped host>` against `127.0.0.1:8080`, or with `Host: {slug}.<apps-domain>`.
- rt's own docs and samples (`curl …/s/hello/`, `sample/scripts/invoke.sh`) switch to `Host:`.
- **Slug rules**: DNS label, `[a-z0-9-]`, ≤ 63 characters, no leading or trailing `-`, and **no
  `--`**, which is reserved for preview hosts (section 2.3). runtime-web's slug validator and rt's
  service create both enforce this. Existing slugs with `--` (if any) must be renamed. Check with a
  migration query.
- **The console** lives at `console.<domain>` (`RTWEB_DOMAIN`) from the start. The installer maps
  that host to the console service (`PUT /v1/services/{s}/hosts/{host}` as root, which already exists
  in `install.mjs` step 7). It must not be `<apps-domain>` or under it, and `install.sh` and
  `rtweb-entry` refuse that config.

### 1.2 Migration

None. This applies to new installs only, so there is nothing to migrate and no redirect or 410
window.

### 1.3 Certificates

The wildcard DNS record `*.<apps-domain>` → node (A/AAAA, or a CNAME to the load balancer) is
**required**. TLS is handled by Caddy (the existing relay in `deploy/` and the Docker image). rt stays
TLS-agnostic.

**Default: Caddy on-demand TLS, one cert per App host, through HTTP-01 (or TLS-ALPN-01).**
- No DNS API token is needed.
- `on_demand_tls { ask http://127.0.0.1:8081/v1/internal/tls-ask }`. The ask endpoint answers `200`
  only when the host is one of these, and not `access = internal`:
  - `{slug}.<apps-domain>` for an existing service;
  - `{seq}--{slug}.<apps-domain>` for an existing preview;
  - a verified custom host;
  - an operator-mapped host.
- The ask endpoint lives on rt's control listener, loopback only, unauthenticated but rate-limited.
  Caddy caches its answers.
- It **replaces** runtime-web's `/s/rtweb/api/internal/tls-ask` (today `deploy/Caddyfile` line 21 and
  `docker/entry/edge.go`), because rt owns the route table, and that path stops working once `/s/` is
  removed.

Let's Encrypt limits that matter (letsencrypt.org, updated 2026-08-05):

| Limit | Value | Effect here |
|---|---|---|
| New certificates per registered domain | 50 per 7 days, refill 1 per 202 min, override on request | **The binding one.** Without a PSL entry, all App hosts share `<registered domain>`, so only about 50 new Apps (plus previews) get certs per week |
| New orders per account | 300 per 3 h | Burst cap for Caddy's single account |
| Certificates per exact set of identifiers | 5 per 7 days, no override | Hit only by cert churn on one host (Caddy restarts without persistent storage). **Caddy's data dir must be on the persistent volume** |
| Authorization failures per identifier per account | 5 per hour | A misconfigured DNS record blocks one App for up to an hour. The ask endpoint keeps attackers from burning this on random hosts |
| ARI renewals | Exempt from all limits | Renewals are not a concern (Caddy supports ARI *(unverified)*) |

**Optional: a wildcard cert `*.<apps-domain>` through DNS-01**, with a Caddy DNS-provider module.
- It is one certificate for all Apps and previews, so the per-domain limit doesn't apply. It also
  avoids leaking App names into Certificate Transparency logs.
- It needs a DNS API token and a custom Caddy build. The default image includes **only
  `caddy-dns/cloudflare`**. Other providers mean a custom `xcaddy` build by the operator.
- Recommended for public instances with more than about 30 new Apps a week, or wherever preview
  hosts are heavily used.
- The installer (the in-progress Caddy work) offers `--apps-wildcard-dns <provider>` with the token
  from a file or env.
- Custom domains always use on-demand HTTP-01, since only their owner controls their DNS.

**Public Suffix List**: an optional launch-checklist item for public multi-org instances, where you
submit `<apps-domain>`. Two effects:
1. Browsers refuse `Domain=<apps-domain>` cookies, which isolates Apps' cookies.
2. Let's Encrypt computes the "registered domain" from the PSL *(unverified, widely documented
   behaviour)*, so each App counts as its own registered domain and the 50/week limit stops
   mattering.

PSL inclusion takes weeks. Until then, rt strips `Set-Cookie` with `Domain=<apps-domain>` (or a
parent of it) from every App response.

### 1.4 Custom domains

The existing verified-host flow is unchanged: a verified custom host wins over the subdomain.
- An optional `canonical_host` setting per App 308-redirects the other host (subdomain ↔ custom
  domain) for `GET`/`HEAD`.
- Static rules match the request path unchanged on every host, because there is no base path any
  more.

### 1.5 Default response headers (static)

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: SAMEORIGIN`
- `Cross-Origin-Resource-Policy: same-site`

Every App is its own origin, so there is no default CSP and no sandbox; users add a CSP through
`[[headers]]`. HSTS for `<apps-domain>` is set in Caddy (`max-age=31536000; includeSubDomains`) once
the operator confirms that all subdomains are HTTPS.

## 2. File deploys (separate from code)

### 2.1 Prior art (fetched)

| Platform | Assets vs code | Rollback / preview | Rules |
|---|---|---|---|
| Netlify | One atomic deploy holds both. Digest API: `POST /sites/{id}/deploys {files:{path:sha1}, functions:{…sha256}}` → `required[]`, then `PUT /deploys/{id}/files/{path}`. `draft: true` deploys don't change the published one | Publish an earlier deploy, deploy previews | `_redirects`/`_headers`/`netlify.toml` in the deploy |
| Vercel | One immutable deployment. Skew Protection pins clients to their deployment through `?dpl=`, `x-deployment-id` or a cookie | Promote an earlier deployment, a URL per deployment | `vercel.json` in the deployment |
| Cloudflare Pages | One deployment. Assets are served before Functions; `_routes.json` decides what reaches Functions. No `404.html` means SPA mode. Assets stay cached until the next deploy | Rollback, preview per branch | `_redirects`/`_headers`/`_routes.json` |
| Deno Deploy *(unverified)* | One revision; static files are read by code | Earlier revision, preview URL per revision | Code |

None of these split the tracks, because of **version skew**. This design splits them by user
decision, and makes skew visible (2.3).

### 2.2 Data model (rt, SQL)

```text
file_deploys
  id            text pk      -- "fd_<ulid>"
  service_id    fk
  seq           int          -- per service: "files #12"
  state         enum  draft | uploading | processing | ready | failed | expired
  manifest_sha  text         -- sha256 of the canonical manifest JSON
  rules         json         -- compiled static.toml (section 3)
  files int, bytes bigint, unique_bytes bigint
  requires_code text null    -- advisory, section 2.3
  label, created_by, created_at, source ("console"|"cli"|"api"), failure json
file_entries   (file_deploy_id, path) pk, sha256, size, content_type, br_sha null, gz_sha null
upload_grants  (section 4)
services       + live_files fk null, + preview_files fk null, + storage_backend json null,
                 + cache_enabled bool default true, + cache_epoch int default 0
```

- **Atomic swap**: a deploy reaches `ready` only when every blob and variant is stored and verified.
  Activation is one SQL update plus a route snapshot swap (`ArcSwap`), so a request sees either the
  old file set or the new one.
- **Retention**: the last `static.retained_deploys` per plan (10 on free, 50 on pro), plus the live
  and preview deploys. Blob GC uses the artifact store's grace period (`sweep_orphans`).
- **Drafts** expire after 24 h when they don't reach `ready` (`expired`), and their unreferenced
  blobs are swept.

### 2.3 Rules ownership, compatibility, preview

- **`static.toml` belongs to the file deploy.** A rules-only change creates a new file deploy with
  the same manifest, `POST …/file-deploys {from, rules}`, with no uploads. It can be versioned and
  rolled back.
- **Compatibility is advisory.**
  - `requires_code = ">=42"` gives a console ⚠ skew badge, and activation then asks for
    confirmation (API `?force=1`, otherwise `409 skew`).
  - Responses carry `x-rt-files: <seq>` and `x-rt-code: <v>` (operator can turn them off). Requests
    forwarded to the App carry the `x-rt-files` header.
  - There is no skew pinning (dropped by decision).
- **Preview**: `https://{seq}--{slug}.<apps-domain>/` serves a `ready` file deploy, with the **live**
  code behind its `app` routes. Responses carry `X-Robots-Tag: noindex` and
  `Cache-Control: no-store`. Under on-demand TLS each preview host needs its own cert, and counts
  toward the Let's Encrypt limit. On instances without the wildcard, previews are limited to the
  pinned `preview_files` deploy (one host per App), and other deploys can only be inspected in the
  console's file list.

### 2.4 rt API (control listener; `docs/api.md`)

| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | `/v1/services/{s}/file-deploys` | `deploy` | `{files:{path:{sha256,size}}, rules?: string (static.toml text), from?, label?, requires_code?}` → `201 {id, seq, state:"draft", required:[sha256], diagnostics:[]}`. Validates the manifest, limits and `static.toml` (section 3). `422` on errors |
| POST | `/v1/file-deploys/{id}/upload-grants` | `deploy` | → `201 {grant, expires_at, upload:{mode:"direct", url} \| {mode:"presigned", urls:{sha:url}}}`. Section 4 |
| PUT | `/v1/uploads/{sha256}` | one-time grant (`Authorization: RtUpload <grant>`) | Public listener; section 4 |
| POST | `/v1/file-deploys/{id}/finalize` | `deploy` | `{activate?: bool, force?: bool}` → `202 {state:"processing"}`; section 4.4 |
| GET | `/v1/services/{s}/file-deploys`, `/v1/file-deploys/{id}`, `…/{id}/files?prefix&cursor` | `services:read` | |
| POST / DELETE | `/v1/services/{s}/files/live` | `deploy` | `{file_deploy, force?}` activates, rolls back or redeploys; DELETE turns static serving off |
| POST | `/v1/services/{s}/files/preview` | `deploy` | `{file_deploy \| null}` |
| GET | `/v1/services/{s}/static/match?path=&method=&host=` | `services:read` | Dry run: the matched rule, the final action and file, and the headers |
| POST | `/v1/static/validate` | `deploy` | `static.toml` text → `{ok, diagnostics}` (used by the console editor) |
| GET / PUT | `/v1/services/{s}/cache` | read / `deploy` | `{enabled}` |
| POST | `/v1/services/{s}/cache/purge` | `deploy` | `{paths?, prefixes?}`, or an empty body for everything → `202 {epoch, cdn}` |
| GET | `/v1/internal/tls-ask?domain=` | loopback only | Section 1.3 |

## 3. `static.toml` (parsed and enforced by rt, in `rt-static`)

The file is `static.toml` at the root of the uploaded file set (it is not served), or the `rules`
text in the create call (which wins over the file). It is parsed with `toml` (strict, with
`deny_unknown_fields`) and compiled into a `StaticSite` stored in `file_deploys.rules`. Validation
runs at deploy time and through `/v1/static/validate`; serving never parses TOML. Netlify
`_redirects`/`_headers` import is an optional later feature (phase 7), converted into this schema at
upload.

### 3.1 Schema

```toml
version = 1                        # required; only 1 is accepted

# --- serving -------------------------------------------------------------
index = ["index.html"]             # directory index candidates, ≤ 4
not_found = "404.html"             # file served with status 404; optional
spa = "index.html"                 # SPA fallback, optional; for HTML navigations, while not_found covers the rest
clean_urls = false                 # /a → a.html ; /a.html → 308 /a
trailing_slash = "auto"            # "auto" | "always" | "never"
hide = ["**/*.map"]                # globs never served (dotfiles are always hidden)
requires_code = ">=42"             # optional, advisory (section 2.3)

[cache]
html = "revalidate"                # "revalidate" | "no-store" | "<seconds>"
default = 300                      # seconds for non-HTML, non-immutable files
immutable = ["/assets/**"]         # also auto-detected for hashed names (section 5)

# --- rules, evaluated in this order: redirects → routes → default -----------
[[redirects]]                      # ≤ 500 total with routes
from = "/old/:slug"
to = "/blog/:slug"                 # path, or absolute https:// URL (no placeholders in host)
status = 308                       # 301 | 302 | 303 | 307 | 308; default 308
host = "www.example.com"           # optional exact host match
query = "keep"                     # "keep" | "drop"; default "keep"

[[routes]]                         # first match wins
path = "/api/**"
methods = ["*"]                    # default ["GET","HEAD"] for static/rewrite, ["*"] for app
to = "app"                         # "app" | "static" | "rewrite" | "redirect"

[[routes]]
path = "/docs/**"
to = "rewrite"
dest = "/docs/index.html"          # a file in the manifest (rewrites target files only)

[[routes]]
path = "/favicon.ico"
to = "static"
fallthrough = false                # missing file → 404 (default); true → continue to next rule

[[headers]]                        # all matching blocks apply in order; later wins per header
path = "/**"
set = { "X-Frame-Options" = "DENY" }
unset = ["X-Powered-By"]

[[headers]]
path = "/fonts/**"
set = { "Access-Control-Allow-Origin" = "*" }
```

**Path patterns**: they start with `/`.
- `*` matches one segment, `**` matches the rest (≥ 0 segments, last position only), and `:name`
  matches one segment as a placeholder.
- Matching is literal and case-sensitive on the decoded, normalized path.
- In `to`/`dest`, `:name` and `:splat` (the `**` capture) are substituted.

**Default when no route matches** (and for `static` routes):
1. For `GET`/`HEAD`, try the exact file, then `clean_urls`, then the `index` of a directory.
2. Otherwise go to `app` if a live code version exists.
3. Otherwise, for an HTML navigation (`Accept: text/html` and no extension in the last segment),
   serve the `spa` file with status 200.
4. Otherwise serve `not_found` with status 404, or a plain 404.

Non-GET/HEAD requests are never static: they go to `app`, or get a `405` with `Allow` when there is
no code.

### 3.2 Validation rules and error messages

Each diagnostic is `{code, path: "routes[2].dest", line, col, message}`. All of them are returned
together in a `422 validation_failed` (`details.diagnostics`), the same shape as code build
diagnostics.

| Code | Rule | Message |
|---|---|---|
| `toml_syntax` | Valid TOML | `static.toml:{line}:{col}: {parser message}` |
| `unknown_key` | No unknown keys | `Unknown key "{key}" in {table}. Allowed: {list}` |
| `version` | `version = 1` | `Unsupported static.toml version {v}; this runtime supports 1` |
| `pattern_invalid` | Starts with `/`; `**` only last; no `..`, `//`, `\`, NUL, `?`, `#`; ≤ 512 bytes | `Invalid path pattern "{p}": {reason}` |
| `placeholder_unknown` | Every `:name` in `to`/`dest` appears in `from`/`path` | `"{to}" uses :{name}, which "{from}" does not capture` |
| `redirect_host_placeholder` | Absolute `to` URLs: https only, no placeholder in the host, no userinfo | `Redirect target host must be literal (open redirect): "{to}"` |
| `status_invalid` | Redirect status in the allowed set | `Redirect status must be one of 301, 302, 303, 307, 308` |
| `dest_missing` | `dest`, `spa`, `not_found` and `index` files exist in the manifest | `"{dest}" is not in this file deploy` |
| `to_invalid` / `dest_required` | `to` ∈ the enum; `rewrite` needs `dest`; `redirect` needs `dest` + `status` | `routes[{i}]: "to = rewrite" requires "dest"` |
| `methods_invalid` | Methods are tokens; `static`/`rewrite` only GET/HEAD | `routes[{i}]: static routes serve only GET and HEAD` |
| `header_forbidden` | Not `Set-Cookie`, `x-rt-*`, hop-by-hop (`Connection`, `Transfer-Encoding`, …), `Content-Length`, `Content-Encoding`, `Content-Range`, `ETag`, `Last-Modified`, `Date`, `Server` | `Header "{h}" cannot be set by static rules` |
| `header_invalid` | Header names are tokens; values are visible ASCII, ≤ 4 KiB | `Header "{h}" has an invalid name or value` |
| `too_many_rules` | redirects + routes ≤ 500, headers ≤ 100 | `Too many rules: {n} (max {max})` |
| `cache_invalid` | `html`/`default` are an enum or 0..=31536000 | `cache.{k} must be "revalidate", "no-store" or 0..31536000 seconds` |
| `unreachable_rule` (warning) | A route fully shadowed by an earlier `/**` | `routes[{i}] can never match: shadowed by routes[{j}]` |
| `requires_code_invalid` | `>=N`, `=N` or a label ≤ 64 characters | `requires_code must look like ">=42", "=42" or a label` |

Warnings don't block a deploy. Errors do.

## 4. Uploads: browser → rt with one-time grants

### 4.1 Flow

1. The **console** (runtime-web) checks `app.deploy` on the App, then calls rt's
   `POST /v1/services/{s}/file-deploys` with the manifest (hashed in a Web Worker). It gets back
   `{id, required}`.
2. runtime-web writes the audit event `app.files.upload_granted` and calls
   `POST /v1/file-deploys/{id}/upload-grants`. rt returns a **one-time grant** for exactly the
   `required` set, which runtime-web passes to the browser.
3. The browser PUTs each required blob:
   - **fs backend**: to `https://<rt-public>/v1/uploads/{sha256}`, with
     `Authorization: RtUpload <grant>`;
   - **S3 backend**: to the presigned URL rt issued for that sha under the same grant.
4. The console calls `POST …/finalize` (through runtime-web) with the `deploy` scope, and with
   `activate` if the user chose it.

### 4.2 Grant format and replay protection

- The grant is opaque: `rtu_` + base64url(32 random bytes). It is **not** a JWT, so there is nothing
  to forge or decode.
- rt stores `upload_grants(id_hash sha256 pk, file_deploy_id, service_id, tenant_id,
  allowed: set<sha256 → size>, max_bytes, max_count, used_bytes, used_count, expires_at,
  revoked bool)`.
- **Scope**: the grant covers one file deploy draft, exactly the listed shas, each with its declared
  size, and their sum (`max_bytes`, `max_count`). Every PUT must name a sha in the set that is not
  yet uploaded, and its `Content-Length` must equal the declared size. The body is hashed while
  streaming and rejected if the hash differs.
- **"One-time use"**: each `(grant, sha)` slot can be consumed once. A PUT for a sha already
  uploaded answers `409 already_uploaded`, which is idempotent for retries after a network drop: the
  client then moves on. The grant as a whole is **single-use**: it is burned at `finalize` or
  expiry, whichever comes first, and can never be reused for another draft.
  - Alternative considered: one token per file, which is strictly one-shot but means N tokens for
    20k files. Rejected as heavy.
  - Optional stricter mode: `grant_per_file = true` returns `{sha: token}`.
- **TTL**: 15 minutes, extendable by calling `upload-grants` again. That issues a new grant and
  revokes the old one. There is at most one live grant per draft.
- **Storage**: only `sha256(grant)` is stored, so a database leak doesn't leak usable grants.
  Comparisons are constant-time.
- **Rate limits**: 20 grants per hour per service; 3 concurrent drafts per service.
- **S3 backend**: rt signs one presigned PUT per sha with the service's scoped credentials
  (section 6.2). Each URL:
  - expires at the grant's `expires_at` (≤ 15 min);
  - is bound to the key `…/blobs/{sha}`;
  - has `Content-Length` signed in, and `x-amz-checksum-sha256` signed in where the provider supports
    it *(unverified for R2/B2)*.

  A replay can only rewrite the same bytes to the same content-addressed key, so it is harmless.
  `finalize` verifies each object: a HEAD for size and checksum, or a streamed hash where no
  checksum is available.

### 4.3 CORS on the rt upload endpoint

- Only `/v1/uploads/*` on the public listener has CORS.
- Allowed origin: exactly the configured console origin (`ingress.upload_cors_origins =
  ["https://console.example.com"]`, set by the installer from `RTWEB_PUBLIC_URL`). Never `*`, and
  never `<apps-domain>` hosts.
- Methods `PUT, OPTIONS`; headers `Authorization, Content-Type, Content-Length`; `max-age 600`; no
  credentials.
- For S3, the bucket's CORS rules are set by rt when it creates the bucket or prefix: the same single
  origin, `PUT` only. With prefix isolation on a shared bucket, these rules are bucket-wide.

### 4.4 Finalize

1. `finalize` checks every manifest sha is present: uploaded in this draft, or already in the
   service's CAS. A missing sha → `422 upload_incomplete {missing:[…]}`.
2. It burns the grant and moves the draft to `processing`.
3. On the blocking pool it builds br (q11) and gzip (level 9) variants for compressible types over
   1 KB, and keeps a variant only if it is ≥ 10% smaller. It also computes `unique_bytes` and checks
   quotas (`storage_mb`, `static.*`) → `403 plan_limit`.
4. → `ready`, then optionally activates (an atomic swap, with the skew check).
5. Failures → `failed` with `failure {reason, message}`.
6. The console polls `GET /v1/file-deploys/{id}`, or uses SSE later.

### 4.5 Limits

There are no per-plan numbers for now. Every plan key accepts a number or **`"unlimited"`**:
unlimited means no plan constraint, and only the node's own hard caps apply. Each plan also has
**`over_quota = "soft" | "hard"`**:

- `soft`: serve, record the overage and warn (console banner, `x-rt-quota: exceeded` on control API
  responses);
- `hard`: refuse, with `429 quota_exceeded` on requests or `403 plan_limit` on deploys.

Storage limits are always hard at deploy, since there is nothing to serve yet. `over_quota` governs
the runtime counters (requests, egress, invocations).

**The instance default is one unified plan, `unlimited`**, where every key is `"unlimited"` and
`over_quota = "soft"`. The installer sets it as `RTWEB_DEFAULT_PLAN` / rt's default plan. Operators
can add limited plans later in the admin plan settings (section 13).

| Key (new or affected) | Meaning | Default plan | Node hard cap |
|---|---|---|---|
| `static.max_file_mb` | Largest single file | unlimited | `static.node_max_file_mb` 512 |
| `static.max_files` | Files per deploy | unlimited | 100,000 |
| `static.max_deploy_mb` | Bytes per deploy | unlimited | 5,000 |
| `static.retained_deploys` | File deploys kept | unlimited (GC keeps 100 when unlimited) | 1,000 |
| `storage_mb` (existing) | Now includes unique static bytes, variants included | unlimited | disk |
| `static_requests_per_month` (new) | Static hits | unlimited | — |
| `static_egress_mb_per_month` (new) | Static response bytes | unlimited | — |
| `over_quota` (new) | `soft` / `hard` | `soft` | — |

Manifest paths must be relative, NFC, ≤ 1024 bytes, with no `..`, no control characters and no `\`.
Zip/tar uploads (for CLI convenience) are extracted by rt with streaming limits: total bytes, count,
a 100:1 compression ratio, no nested archives, and no symlinks, hardlinks or devices.

## 5. Caching

### 5.1 Response headers

- ETag `"<sha16>[-br|-gz]-e<epoch>"`.
- `Last-Modified` = the deploy's `created_at`.
- 304/412 handling, a single range per request, `If-Range`, `Vary: Accept-Encoding`, no
  on-the-fly compression.
- Cache-Control classes:
  - HTML: `public, max-age=0, must-revalidate`, per `cache.html`;
  - immutable (hashed names matching `[.-][A-Za-z0-9_-]{8,}\.(js|mjs|css|woff2?|png|jpe?g|webp|avif|svg|wasm)$`,
    or `cache.immutable`): `public, max-age=31536000, immutable`;
  - other files: `public, max-age={cache.default}, stale-while-revalidate=86400`;
  - services with `access = key`: `private`.

### 5.2 Per-service caching toggle and purge

| Control | rt server caches (memory LRU, disk read-through for S3) | Headers to browsers and CDNs | CDN hook |
|---|---|---|---|
| **Caching on** (default) | Read-through, keyed `(service, sha, enc)` | Classes from 5.1 plus `[[headers]]` | — |
| **Caching off** | **Still used**: entries are immutable by content hash, so a stale hit is impossible. Turning them off would only add S3 cost | `Cache-Control: no-store` on every static response (overrides rules); no `ETag`/`Last-Modified`, so no 304s | Purge-everything fires when the toggle turns off |
| **Purge all** | Drop the service's entries (cold start) | `cache_epoch += 1`, which changes every ETag, so browsers revalidate and get a 200. `immutable` copies already in browsers cannot be purged by anyone; the console says so | Purge by tag `rt-svc-<id>` |
| **Purge paths/prefixes** | Nothing (content-addressed) | Nothing | Purge by URL/prefix |

- **Deploy/rollback** needs no purge: paths map to new shas, and HTML is `must-revalidate`. The CDN
  hook still fires a tag purge for edge-cached HTML.
- **CDN hook** (instance config `[static.cdn] provider = "cloudflare" | "webhook"`):
  - Cloudflare supports URL, hostname, tag, prefix and purge-everything on every plan.
  - Per-account limits run from **5 requests/min (Free) to 50 requests/s (Enterprise)**, with
    **100 operations per request**. rt therefore queues purges, debounces for 1 s, batches and
    retries with backoff.
  - Responses carry `Cache-Tag: rt-svc-<id>`.
- **API**: `GET/PUT …/cache {enabled}` and `POST …/cache/purge {paths?, prefixes?}` (10 per minute
  per service).
- **Audit**: `app.cache.update`, `app.cache.purge`.

### 5.3 Server cache sizing

`moka` weighted LRU for objects ≤ 256 KB:
- 32 MB on `edge-1gb`, 128 MB on `balanced`, 512 MB on `min_latency`;
- each tenant may hold at most 25% of it.

S3 backend: a disk read-through LRU (`disk_mb`, default 2 GB). The compiled `StaticSite` of the live
and preview deploys hangs off `RouteEntry`: exact-path lookups are O(1), and rules use a compiled
`globset`.

## 6. Storage backends

### 6.1 Config

```toml
[static.storage]
backend = "fs"                     # "fs" | "s3"
fs_dir = "/data/static"            # persistent volume
[static.storage.s3]
provider = "aws"                   # aws | minio | r2 | b2 | generic
endpoint = "https://s3.eu-central-1.amazonaws.com"
bucket = "rt-static"               # shared bucket for isolation = "prefix"
region = "eu-central-1"
path_style = false                 # true for MinIO
admin_credentials = "secret:rt_static_admin"   # mints/rotates per-service creds only
isolation = "prefix"               # prefix | bucket (r2 forces bucket)
key_rotation_days = 30
[static.cache]
memory_mb = 128
disk_mb = 2048
```

- Set per instance. A per-service override (`storage_backend`) is **root-only**, never chosen by
  tenants, to avoid SSRF and egress through tenant-supplied endpoints.
- Layout: `{prefix}/t/{tenant}/s/{service}/blobs/{sha[0..2]}/{sha}` (+ `.br`, `.gz`).
- Deduplication is per service.

### 6.2 Per-service scoped credentials (fetched docs)

| Provider | Scoping | rt strategy |
|---|---|---|
| AWS S3 | IAM policy: `s3:ListBucket` with `StringLike s3:prefix`, and Get/Put on `bucket/prefix/*`. (The AWS example notes `aws:username` doesn't work with roles) | STS AssumeRole with an inline session policy for the service prefix, ≤ 1 h, minted on demand. No long-lived per-service secrets *(STS details unverified)* |
| MinIO | AWS-compatible policies with `s3:prefix` conditions, ≤ 20 KiB per policy | One service account per service with a prefix policy; rotate by creating the new one, switching, then deleting the old one |
| Cloudflare R2 | Tokens scope to the account or to a **bucket** (`Bucket Item Read/Write`); no prefix scoping | One bucket per service plus a bucket-scoped token. Watch the account bucket limit *(unverified)* |
| Backblaze B2 | Application keys limited to a bucket plus a **file name prefix**, with expiry | One key per service with `namePrefix`, expiring at the rotation period |
| Generic S3 | Unknown | Shared credentials, isolation in rt only; `rt doctor` warns |

- **Rotation**: two active credentials per service, overlapping by 24 h, run as a daily job. They are
  stored encrypted like service secrets.
- **Serving**: always proxied through rt (rules, headers, auth, cache, one origin). Redirects to
  presigned GETs are rejected, because they skip rules, `access = key` and caching.

## 7. Security summary

- Requests are resolved only through the manifest, never by filesystem path. Paths are normalized
  like `resolved_path` (invoke.rs).
- Uploads reject symlinks, devices and bombs.
- MIME types are fixed at upload, plus `nosniff`.
- Header allowlist (3.2); no open redirects (3.2).
- One origin per App (section 1); the console is on its own host, never under `<apps-domain>`.
- `Set-Cookie` `Domain=<apps-domain>` is stripped until the PSL entry lands.
- The TLS ask endpoint keeps certificate issuance to real App hosts.
- Uploads use one-time, scoped, hashed grants, with CORS only for the console origin (4.2, 4.3).
- Per-service S3 prefix or bucket and credentials (6.2).
- Access, plan and rate limits apply before rt-static, so static hosting never bypasses
  `access = key`, and `internal` services stay 404 on the public listener.

## 8. Rust crates (crates.io, 2026-10-27)

| Crate | Latest | Pin / note |
|---|---|---|
| `moka` | 0.12.16 | `0.12.16` (LRU) |
| `globset` | 0.4.20 | `0.4.20` (rules) |
| `toml` / `serde` | workspace | strict parse, `deny_unknown_fields` |
| `mime_guess` | 2.0.5 | `2.0.5` |
| `brotli` | 9.1.1, **released 2026-10-27** | Pin the newest 9.x that is ≥ 2 weeks old; `cargo deny` |
| `flate2` | 1.1.10 | `1.1.10` |
| `tar` | 0.4.46 | `0.4.46` |
| `zip` | 9.1.2, **released 2026-10-26** | Pin an earlier 9.x that is ≥ 2 weeks old |
| `http-range-header` | 0.4.2 | `0.4.2` |
| `object_store` | 0.14.2 | `0.14.2`: fs + S3 (AWS, MinIO, R2, B2-S3) and presigned URLs *(presign API unverified; fallback `rusty-s3` 0.10.2)* |
| `aws-sdk-sts` | — | only for AWS credential minting; otherwise plain `reqwest` calls (MinIO admin, Cloudflare API, `b2_create_key`) behind a `CredentialMinter` trait |
| `tower-http` | 0.7.1 (workspace 0.6.6) | stay on 0.6.6; upgrade separately |

## 9. runtime-web changes

### 9.1 API (`docs/reference/api.md`, new §8.x "Files, caching and domains")

`…` = `/api/orgs/{org}/apps/{app}`.

| Method | Path | Action | Maps to rt |
|---|---|---|---|
| GET | `…/file-deploys` | `app.read` | list |
| POST | `…/file-deploys` | `app.deploy` | create the draft. Answers `{id, seq, required, diagnostics, grant, upload}`: runtime-web creates the draft and immediately requests the grant, auditing `app.files.upload_granted` |
| POST | `…/file-deploys/{id}/grant` | `app.deploy` | a fresh grant (the old one is revoked) |
| POST | `…/file-deploys/{id}/finalize` | `app.deploy` | finalize (`activate?`, `force?`) |
| GET | `…/file-deploys/{id}` and `…/files` | `app.read` | |
| POST / DELETE | `…/files/live` | `app.deploy` | activate, rollback, redeploy / turn off |
| POST | `…/files/preview` | `app.deploy` | |
| GET | `…/static/match` | `app.read` | |
| POST | `/api/static/validate` | signed-in | |
| GET / PUT | `…/cache` | `app.read` / `app.update` | |
| POST | `…/cache/purge` | `app.deploy` | |
| PATCH | `…/{app}` | `app.update` | adds `canonical_host` |

- `AppView`: `url` = `https://{slug}.<apps-domain>/`. New fields:
  `urls: {subdomain, custom[]}`, `live_files: {id, seq, files, bytes} | null`, `files_skew: boolean`,
  `preview_url | null` and `cache: {enabled}`. **`/s/` URLs are removed.**
- Config: a new `RTWEB_APPS_DOMAIN` (required, validated fail-closed in `config.ts`). It must not
  equal the host of `RTWEB_PUBLIC_URL`, and that host must not be under it.
- Audit events: `app.files.upload_granted`, `app.files.deploy`, `app.files.activate`,
  `app.files.rollback`, `app.files.preview`, `app.cache.update`, `app.cache.purge`,
  `app.domain.canonical`.
- Errors mapped in `runtime/errors.ts`: `413 too_large`, `422 validation_failed` (with
  `details.diagnostics`), `422 upload_incomplete`, `403 plan_limit`, `409 skew`,
  `409 already_uploaded` (client-side only), `429 rate_limited`.
- The contract test covers the new rows.
- The slug validator (`apps/service.ts`) rejects `--`.

### 9.2 Console UX

- **Deployments** shows two tracks, Code and Files, with the live pair in the header:
  `code v42 · files #12`, plus ⚠ on skew.
- **Files tab**:
  - Drop zone for a folder or zip. Files are hashed in a Web Worker (SubtleCrypto), and only the
    `required` blobs are uploaded straight to rt or S3, with parallel PUTs (6 at a time), progress,
    and retry on `409 already_uploaded` / network errors (re-grant on `401 grant_expired`).
  - Then finalize, with the choices Deploy, Deploy & activate, and Deploy as preview.
  - History: seq, label, files, size, author, state; Preview, Activate / Roll back, Redeploy.
  - Live file tree with cache class and encodings.
- **Routing panel**: a `static.toml` editor with inline diagnostics from `validate`, a read-only rule
  list, and a "Test a path" box (`static/match`). Saving creates a rules-only file deploy.
- **Settings → Caching**: the toggle plus "Purge cache" (all / paths / prefixes), with the help text
  from 5.2.
- **Settings → Domains**: the subdomain URL, custom domains and a canonical host selector.
- **i18n**: `apps.files.*`, `apps.routing.*`, `apps.cache.*`, `apps.domains.*`, `apps.skew.*` in
  every locale.
- **Tests**: MSW handlers and tests per the `ui-design` skill; e2e smoke for upload → activate →
  fetch from the subdomain.
- `server/src/spa.ts` and `gen-assets.mjs` (the console's own SPA): the console is served on its own
  host `console.<domain>`, so `x-rt-base-path` is always empty. The `<base href>` and
  root-relative rewrite branch in `spa.ts` becomes dead code and is removed (section 13). The SPA
  can move to file deploys later (phase 7).
- **Admin → Plans** (new, operator only): see section 13.

### 9.3 Install and Docker

The Caddy work is in progress in the installer, so these items integrate with it:

- **Required**: `--apps-domain`, which sets rt's `routing.base_domain` and runtime-web's
  `RTWEB_APPS_DOMAIN`. Preflight check: `*.<apps-domain>` resolves to this host.
- Caddyfile: `*.<apps-domain>` and custom hosts get `tls { on_demand }` with
  `on_demand_tls { ask http://127.0.0.1:<rt-control>/v1/internal/tls-ask }`.
- **Optional**: `--apps-wildcard-dns cloudflare` with a token file, which switches to a DNS-01
  wildcard. Cloudflare is the only module in the default build.
- Caddy's data directory goes on the persistent volume (because of the exact-set limit).
- `rtweb-entry` (Go) mirrors these rules. Change them together.
- rt.toml fragment in `deploy/`: `[static]`, `[static.storage]` (fs, `/data/static`),
  `[static.cache]`, `routing.base_domain`, `ingress.upload_cors_origins`, and the `unlimited`
  default plan.

## 10. Phased plan

| # | Phase | Weeks | Main risks |
|---|---|---|---|
| 0 | Hand `runtime-task-static-hosting.md` to the rt team; agree on the contracts | 0.4 | — |
| 1 | **rt routing and certs**: delete `/s/` routing, slug rules (`--` reserved), `tls-ask`, `Set-Cookie` Domain strip. **runtime-web**: drop every `/s/` dependency (section 13.1): Host-based loopback calls, Caddyfile/edge ask URL, console at `console.<domain>` | 1.5 (rt 0.8 + rtweb 0.7) | Let's Encrypt 50/week per registered domain without PSL |
| 1b | **Plans**: `"unlimited"` values, `over_quota` soft/hard, the unified `unlimited` default plan, operator plan write API in rt; runtime-web Admin → Plans | 1.5 (rt 0.8 + rtweb 0.7) | Plans are TOML today (SIGHUP reload); a DB-backed overlay is needed for UI edits |
| 2 | **rt-static core (fs)**: `file_deploys` schema, manifest create, one-time grants plus the upload endpoint with CORS, finalize with br/gz, atomic `live_files` swap, serving GET/HEAD with ETag/304/range, index/404/SPA | 3 | Hook placement in invoke.rs; snapshot rebuilds for two tracks |
| 3 | **`static.toml`**: parser, compiler, all validation codes, `validate` and `match` endpoints, rules-only deploys, preview hosts, skew check | 1.5 | Rule semantics and edge cases (clean URLs vs trailing slash) |
| 4 | **Caching and quotas**: moka LRU, cache classes, toggle, epoch purge, CDN hook (Cloudflare queue, webhook), `static_requests`/`egress` counters, `storage_mb` accounting, retention and GC | 2 | Cloudflare purge rate limits; hot-path counters |
| 5 | **runtime-web**: api.md, routes, rtctl SDK, audit, two-track Deployments, Files tab (worker hashing, direct upload), Routing editor, Caching and Domains settings, i18n, MSW, e2e | 3 | Upload UX for 20k files; CORS in practice |
| 6 | **S3 backend**: `object_store`, presigned PUTs under grants, disk read-through cache, per-service prefix/bucket, `CredentialMinter` (AWS STS, MinIO, R2, B2), rotation, bucket CORS, S3 GC | 3 | Provider differences (R2 needs a bucket per service); operator AWS role setup |
| 7 | **Hardening and extras**: path fuzzing, bench vs Caddy file_server, `_redirects`/`_headers` import, console SPA onto file deploys | 1.2 | — |

**Total ≈ 17 engineer-weeks** (rt ≈ 12, runtime-web ≈ 5).
- **v1 (fs only), phases 0-5 ≈ 13 weeks.** Phases 1 and 1b can ship first, on their own.
- Phase 6 (S3) can run in parallel with 4-5 once phase 2 has landed.

## 11. Decisions (final)

| # | Decision |
|---|---|
| Origins | Apps only on `<app>.<apps-domain>` plus verified custom domains. `/s/` is deleted entirely (no operator exception, no window; new installs only). The console is at `console.<domain>` |
| Certificates | Wildcard DNS `*.<apps-domain>` required. Default: Caddy on-demand TLS (HTTP-01) gated by rt's `tls-ask`. Optional: DNS-01 wildcard, with only the Cloudflare module in the default build |
| PSL | Optional launch-checklist item for public multi-org instances; rt strips `Domain=` cookies meanwhile |
| Plans | Every limit can be `"unlimited"`; `over_quota` is `soft`/`hard` per plan; the default is one unified `unlimited` plan; the admin edits plans in the console |
| Skew pinning | Dropped |
| Config | `static.toml`, parsed and enforced by rt (`rt-static`). `_redirects`/`_headers` import later |
| Uploads | Direct browser → rt (fs) or → S3 presigned PUT, under a one-time grant issued after runtime-web authz and audit |
| `<base href>` | Removed |
| Deploy tracks | Files and code separate, each with history, rollback and redeploy; rules belong to files; skew is advisory; preview hosts |
| Quotas | `storage_mb` includes static bytes; new `static_requests_per_month` and `static_egress_mb_per_month` |
| Storage | fs or S3-compatible per instance, root-only override per service, per-service prefix/bucket with scoped, rotated credentials, proxied serving |
| Caching | Toggle (client headers only) plus purge (epoch, server caches, CDN hook) |
| Out of scope | Image transforms and on-the-fly compression |

## 12. Open questions (only the genuinely open ones)

All earlier questions are resolved (section 11). Remaining:

1. **Where plan edits live in rt.** Recommendation: a DB-backed overlay over `[plans.*]` in rt.toml,
   written through an operator API (`PUT /v1/plans/{name}`). TOML stays the seed, and the overlay
   wins. The alternative, editing rt.toml and sending SIGHUP, can't be done safely from a service.
2. **Monthly counter reset.** Calendar month UTC or a rolling 30 days? Recommendation: calendar
   month UTC, matching `invocations_per_day`'s fixed windows.
3. **Retention under `unlimited`.** Keep every file deploy forever, or a soft GC cap?
   Recommendation: keep 100 per service by default, adjustable per plan.

## 13. runtime-web changes (this repo, once rt ships)

### 13.1 Remove every `/s/` dependency (with rt phase 1)

Found by grep on 2026-10-27:

| File | Today | Change |
|---|---|---|
| `server/scripts/install.mjs:57` | `consoleUrl()` falls back to `${INVOKE}/s/${SLUG}` | Require `RTWEB_HOST` (`console.<domain>`); there is no `/s/` fallback |
| `server/scripts/install.mjs:256` | Asset upload PUT `${INVOKE}/s/${SLUG}/api/internal/assets/…` | `${INVOKE}/api/internal/assets/…` with `Host: ${HOST}` (Node `fetch` can't override `Host`, so use `undici.request` or `http.request` with a `headers.host`) |
| `server/scripts/install.mjs:276` | `base = ${INVOKE}/s/${SLUG}` (setup/health) | Same Host-header approach. Host mapping (step 7, `PUT /v1/services/{id}/hosts/{HOST}`) moves **before** the first call and becomes mandatory |
| `install.sh:1018` | Health wait `curl http://127.0.0.1:8080/s/$SLUG/api/healthz` | `curl -H "Host: $DOMAIN" http://127.0.0.1:8080/api/healthz` |
| `install.sh` (wildcard work) | — | Require `--apps-domain`; preflight `*.apps` DNS; write `routing.base_domain`; optional `--apps-wildcard-dns cloudflare`; default plan `unlimited`; `ingress.upload_cors_origins = ["https://$DOMAIN"]` |
| `deploy/Caddyfile:21` | `ask http://127.0.0.1:8080/s/{$RTWEB_SLUG}/api/internal/tls-ask` | `ask http://127.0.0.1:8081/v1/internal/tls-ask` (rt's own endpoint) |
| `deploy/Caddyfile:27` | `@internal path /api/internal/* /s/*/api/internal/*` | `@internal path /api/internal/* /v1/internal/*` |
| `deploy/Caddyfile:68-78` | Apps host block with `/s/` path-routing comments and the `@console` 404 | A `*.{$RTWEB_APPS_DOMAIN}` block with `tls { on_demand }` (or the wildcard `dns cloudflare`), `import rtweb_upstream`; delete the `/s/` comments and the matcher |
| `docker/entry/bootstrap.go:342,542,564,581` | Setup, asset upload and smoke via `http://rtInvoke/s/<slug>/…` | Same Host-header requests (`req.Host = c.domain`); mapping the host first is mandatory |
| `docker/entry/edge.go:19` | `internalRe` matches `(/s/[^/]+)?/api/internal` | `^/(api\|v1)/internal(/\|$)` |
| `docker/entry/edge.go:120-122` | Blocks `/s/` on App hosts | Delete (rt no longer routes `/s/`) |
| `docker/entry/edge.go:183` | Rewrites ask to `/s/<slug>/api/internal/tls-ask` | Proxy to rt control `127.0.0.1:8081/v1/internal/tls-ask` |
| `docker/entry/config.go:193` | Comment on `/s/` fallback | Update; require apps domain and console domain; refuse the console under apps |
| `server/src/config.ts:25` | Doc: relative App URLs `/s/<slug>/` | `RTWEB_APPS_DOMAIN` required; `AppView.url = https://{slug}.{apps}/` |
| `server/src/spa.ts` | `x-rt-base-path` `<base href>` and root-relative rewrite | Delete the branch and its tests (header always empty) |
| runtime-web `tls-ask` route (`/api/internal/tls-ask`, T8) | Answers for active custom domains | Retire it once rt's `tls-ask` covers custom and operator hosts. Keep it one release if the Caddyfile and rt versions can drift |
| `e2e/`, docs (`docs/admin/*`, `docs/contributing/architecture.md` D11), `AGENTS.md` | `/s/` examples | Host-based examples; D11 rewritten |
| Tests | `edge_test.go`, `spa` tests, install tests that use `/s/` | Update |

### 13.2 Static hosting features (with rt phases 2-6)

- `server/src/runtime/`: rtctl methods for file deploys, grants, finalize, live/preview, match,
  validate, cache and purge. Map the new codes in `errors.ts`.
- `server/src/routes/` and `server/src/apps/`: the endpoints in 9.1, with audit events (9.1), authz
  reusing `app.read`/`app.deploy`/`app.update`, and the slug validator rejecting `--`.
- `docs/reference/api.md` §8.x plus the contract test.
- `web/`: two-track Deployments, Files tab, Routing editor, Caching, Domains (9.2), and i18n keys.

### 13.3 Admin → Plans (with rt phase 1b)

**API** (operator role only, `instance.admin`):

| Method | Path | Body |
|---|---|---|
| GET | `/api/admin/plans` | `Plan[]` |
| GET | `/api/admin/plans/{name}` | |
| PUT | `/api/admin/plans/{name}` | `{settings, over_quota}`, `If-Match` |
| POST | `/api/admin/plans` | create |
| DELETE | `/api/admin/plans/{name}` | refused for `unlimited` or a plan in use (`409 plan_in_use`) |
| PUT | `/api/admin/default-plan` | `{name}` |

`type Limit = number | "unlimited"`. Audit events: `plan.create`, `plan.update`, `plan.delete`,
`plan.default`.

**UI**: Admin → Plans:
- A plan list, with a "Default" badge.
- Per plan, a form grouped by area (Compute, Requests, Storage, Static, Events). Each limit has a
  number input with an **"Unlimited" toggle**; on means the input is disabled and the value is sent
  as `"unlimited"`.
- An **"When a limit is exceeded"** selector: Soft (serve and warn) / Hard (refuse with 429).
- A "Used by N orgs" count.
- i18n keys `admin.plans.*`.

`RTWEB_DEFAULT_PLAN` defaults to `unlimited`. The org-level "Limits" view shows "Unlimited" for
those keys.
