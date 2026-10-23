# Runtime Web — research & design

Status: draft for discussion · 2026-10-21

Runtime Web is a self-hosted web console in the style of val.town for **21 Cloud Runtime** (`../runtime`). It aims for the "one command, one box" feel of Dokploy, while running on hardware as minimal as the runtime itself. This document covers:

1. how three reference products solve the same problem;
2. the user flows, UI and UX we take from them;
3. the stack;
4. a review of the current UI sample in `./temp`;
5. the main topic: different ways to put a user/OAuth/organization layer in front of the runtime's API, which only knows about API keys.

---

## 1. Reference products

### 1.1 val.town

| Aspect | What they do |
|---|---|
| Unit | A **val**: a small TS module, now a "project" made of several files. Types are chosen per file: HTTP, Cron (interval/cron), Email, Script. |
| Runtime | Deno, one isolate per run. `npm:`/`jsr:`/`https:` imports. Std libs: `std/sqlite` (Turso/libSQL per user), `std/blob` (KV-ish), `std/email`, `std/openai`. |
| Editor | Browser editor (CodeMirror) with Deno type checking/LSP features, a **Run/Save = deploy** model with no build step for the user, and a live preview pane for HTTP vals. |
| Flows | Sign in with GitHub/Google/email. "New val" opens a template picker. You edit, save, and the val is live at `https://<user>-<val>.web.val.run`. Logs/traces are in a tab. Env vars live at account level. **Remix** forks a public val. |
| Social | Public profiles, public/unlisted/private vals, likes, comments, and a search/discovery feed. |
| Versioning | Every save is a version. You can browse, diff and restore. Branches exist for projects. |
| Orgs | Organizations with members. Roles are coarse: admin/member. |
| AI | Townie: a chat assistant that writes or edits a val, plus an MCP server. |
| UX takeaway | **Time from "idea" to "live URL" under 10 s.** No deploy button, no build, no infra vocabulary. |

### 1.2 windmill.dev

| Aspect | What they do |
|---|---|
| Unit | **Scripts** (TS/Bun/Deno, Python, Go, Bash, SQL…), **Flows** (DAGs of scripts), **Apps** (low-code UIs). |
| Runtime | Rust API server plus workers that pull jobs from a Postgres queue. Self-hosted via docker compose or Helm. |
| Editor | Monaco plus **real LSP proxied over WebSocket** (deno/pyright/gopls run server-side). The function signature is parsed into a JSON schema, which auto-generates the run form. |
| Triggers | Webhook (sync/async), schedules, email, Kafka/NATS/Postgres CDC/HTTP routes. |
| Tenancy | **Instance superadmin → workspaces → users/groups/folders**. Roles: admin / developer / operator (run-only). Folder and group ACLs (read/write/owner) on every object. SSO/OAuth (GitHub, Google, Microsoft, generic OIDC, SAML in EE). The first user is the superadmin. |
| Ops | Every run is a job row with input, output, logs and duration. You can re-run with the same args. Instance settings live in a superadmin UI (SMTP, OAuth, workers, license). |
| UX takeaway | **Permissions and audit are first-class**. Path-based ownership (`u/alice/…`, `f/folder/…`) makes ACLs visible in the name. Run history is a primary navigation item. |

### 1.3 Cloudflare Workers

| Aspect | What they do |
|---|---|
| Unit | **Worker** (script or module) with **bindings**: KV, D1 (SQLite), R2 (blob), Queues, Durable Objects, service bindings, secrets/vars. |
| Deploy | `wrangler deploy`, or Git integration builds. Every deploy is a **version**. **Deployments** route traffic to versions, including gradual % rollouts and rollback. |
| Triggers | fetch (routes, custom domains, `*.workers.dev`), cron triggers, queue consumers, email workers. |
| Dashboard | Account → Workers & Pages list. Per-worker tabs: Overview (metrics), Deployments, Settings (variables, bindings, triggers, domains), Logs (real-time tail). There is also a "Quick edit" playground with a preview. |
| Tenancy | Account with members and roles (Admin, Super Admin, Workers Admin, read-only…). API tokens use **resource × permission** scoping. |
| UX takeaway | **Bindings as a single, legible list**, a clear version-vs-deployment split, and tokens built from permission templates. |

### 1.4 What we take

| From | Take | Leave |
|---|---|---|
| val.town | Instant edit→live, file tree + preview, templates, remix, simple naming (`/s/{slug}`), friendly copy | Social feed, likes and comments (maybe later), hosted AI |
| windmill | Instance superadmin, first-user bootstrap, workspace roles, OAuth/OIDC settings UI, run history, LSP-over-WS | Flows/apps builder, multi-language workers, Postgres dependency |
| Cloudflare | Versions/rollback page, bindings/triggers/domains settings layout, scoped tokens UI, live log tail | Gradual rollouts (the runtime has no % routing), global edge |

---

## 2. Mapping the runtime onto the product

The runtime (`../runtime/openapi/openapi.json`) already provides:

| Runtime concept | UI name | Notes |
|---|---|---|
| Tenant | **Organization** | Has a plan (quotas). Every user gets a personal org on signup, like val.town's user namespace. |
| Project | **Project** | `default` exists. The sidebar's main grouping. |
| Environment | Environment tag | A label on a project (production/staging…). Shown as a switcher in the project header. |
| Service | **Val** (we keep the friendly word; "service" appears in the API/CLI) | Slug, route, triggers, env, secrets, data, hosts. |
| Version | Version / deploy | Immutable. `PUT /live` = promote/rollback. |
| Task | Run | Logs and stats per service. There is no per-task history endpoint yet (see gaps). |
| Operator (root token) | **Instance admin** | `/v1/node/*`, `/v1/tenants*`, `/v1/plans`. |
| Tenant key `rtk_…` | **Access token** (user-visible) *and* internal credential (section 5) | Scopes: `services:read/write`, `deploy`, `invoke`, `logs:read`, `env:write`, `secrets:write`, `queue:write`, `data:admin`, `keys:write`. Can be restricted to a list of service IDs. |

### Gaps in the runtime this product exposes

| Gap | Impact | Proposal |
|---|---|---|
| **No email trigger** (runtime NG-4) | One of the three val.town triggers is missing | Phase 2: the Go backend runs a tiny SMTP receiver (or a Postmark/SES inbound webhook) and forwards to the runtime's `internal` socket or enqueues via `POST /services/{s}/queue`. |
| No users/orgs/members in the runtime | Expected: this is the web layer's job | Section 5. |
| Keys restrict by **service IDs**, not **projects** | "User has access to project X" can't be expressed as a key directly | Enforce project scoping in the Go layer (option B/C below), or add `project_ids` to runtime keys (small runtime change, recommended long-term). |
| No per-run history (only logs/stats/events) | No windmill-style "runs" table | v1: logs filtered by task id. Later: runtime emits task records. |
| No LSP | Editor needs Deno types | Section 4.3. |
| Versions are uploaded archives | The editor needs "save → new version" | The backend packs the files into the upload format (`rt-build` docs, doc 07) and calls `POST /versions?activate=1`. |

---

## 3. Users, roles, permissions

### 3.1 Model (web-side, stored in Runtime Web's DB)

```
Instance
 ├─ users                      (identity: email, name, avatar, is_instance_admin)
 │   └─ identities             (provider=github|google|oidc|password, subject)
 ├─ organizations              1:1 with runtime tenant (tenant_id)
 │   ├─ members                (user, org_role: owner | admin | member)
 │   └─ project_grants         (user|team, project_id, role: admin | developer | viewer)
 └─ instance_settings          (OAuth providers, SMTP, signup policy, default plan, runtime URL)
```

### 3.2 Roles

| Role | Where | Can |
|---|---|---|
| **Instance admin** | Instance | Everything an operator can do: node status/config/drain/cache/scheduler, tenants (orgs) CRUD, plans, impersonate an org (`x-rt-tenant`), instance settings (OAuth, signup, SMTP). The **first user to sign up becomes the instance admin** (Dokploy/windmill bootstrap); after that, signup follows the policy (open / invite-only / domain allow-list). |
| **Org owner** | Organization | The whole tenant: all projects, members, tokens, billing/plan view, delete org. Is the only role that can transfer ownership. |
| **Org admin** | Organization | Same as owner except deleting the org or transferring ownership. |
| **Org member** | Organization | Sees only the projects granted to them. |
| **Project admin** | Project | Services CRUD, deploy, env, secrets, hosts, data export, grant others on this project. |
| **Project developer** | Project | Create/edit/deploy services, env, schedules, queue, logs. No secrets write (configurable), no data export, no grants. |
| **Project viewer** | Project | Read code, logs, stats. |

### 3.3 Role → runtime scope mapping

| Web role | Runtime scopes |
|---|---|
| viewer | `services:read`, `logs:read` |
| developer | + `services:write`, `deploy`, `env:write`, `queue:write`, `invoke` |
| admin / owner | + `secrets:write`, `data:admin`, `keys:write` |

This mapping is what lets option C (section 5) mint real runtime keys.

### 3.4 Authentication ("OAuth service")

Two separate meanings. We need both, in phases:

1. **OAuth/OIDC client (log in with…)**: GitHub, Google, GitLab, generic OIDC (Authentik, Keycloak, Zitadel), plus email+password (argon2id) and magic link if SMTP is set. Providers are configured by the instance admin in the UI and stored encrypted.
2. **OAuth 2.1 authorization server (our own)**: lets the CLI (`rt login`, device code flow), the runtime's MCP server and third-party tools get org/project-scoped tokens on a user's behalf. This is phase 2. Use `ory/fosite`, or a small hand-rolled server covering PKCE plus device code only.

Sessions: an opaque session ID in an `HttpOnly; Secure; SameSite=Lax` cookie, with the session row in SQLite. No JWT in the browser. CSRF is handled by SameSite plus a double-submit header on mutations.

---

## 4. Technical stack

### 4.1 Repo layout (monorepo)

```
runtime-web/
├─ cmd/rtweb/              main.go — one binary
├─ internal/
│  ├─ auth/                sessions, password, oauth clients, (later) oauth server
│  ├─ authz/               role → permission checks, project scoping
│  ├─ runtime/             typed client for ../runtime (generated from openapi.json)
│  ├─ api/                 HTTP handlers for the frontend (/api/*)
│  ├─ proxy/               SSE log stream / LSP websocket passthrough
│  ├─ store/               SQLite + migrations + sqlc queries
│  └─ settings/            instance settings, secret sealing
├─ web/                    Vite + React app (built into web/dist, go:embed-ed)
├─ docs/
├─ .env.example            RUNTIME_URL, RUNTIME_ROOT_TOKEN, RTWEB_SECRET_KEY, PUBLIC_URL…
├─ Dockerfile              multi-stage: node build → go build → distroless/static
└─ Makefile
```

The runtime is **not** embedded. It is reached via `RUNTIME_URL` (control API, e.g. `http://127.0.0.1:8081`), `RUNTIME_PUBLIC_URL` (for invoke links/preview) and `RUNTIME_ROOT_TOKEN`.

### 4.2 Backend: Go

| Concern | Choice | Why |
|---|---|---|
| HTTP | `net/http` (Go 1.22+ pattern routing) + `chi` middleware is optional | Zero deps, fast |
| DB | **SQLite** via `modernc.org/sqlite` (pure Go, CGO-free) or `ncruces/go-sqlite3` (wasm) | One file, matches the runtime's "one volume" philosophy |
| Queries | `sqlc` | Typed, no ORM |
| Migrations | `goose` (embedded) | |
| Runtime client | `oapi-codegen` from `../runtime/openapi/openapi.json` | Stays in sync with the runtime |
| OAuth client | `golang.org/x/oauth2` + `coreos/go-oidc` | |
| Password | `x/crypto/argon2` | |
| Static UI | `embed.FS`, SPA fallback, immutable caching for hashed assets | Single binary |
| Logs | `log/slog` | |

Target footprint: **binary of about 20 MB, RSS of about 20–40 MB idle**, starting in under 100 ms. It can share the runtime's 2 GiB box.

### 4.3 Frontend

| Concern | Choice |
|---|---|
| Build | Vite + React 19 + TypeScript (already in `./temp`) |
| Styling | Tailwind 4 + the CSS tokens already in `temp/src/index.css` |
| Routing | TanStack Router (typed, file routes) |
| Data | TanStack Query against `/api/*` |
| Editor | **CodeMirror 6** (lighter than Monaco: about 300 KB vs about 3 MB) with `@codemirror/lsp-client`. Monaco is the alternative if we want the VS Code feel. |
| Types/LSP | **Phase 1**: in-browser TS worker with bundled Deno + `rt:*` SDK `.d.ts`. No server cost, but no `npm:` type resolution. **Phase 2**: `deno lsp` processes spawned by the Go backend, proxied over WebSocket (windmill's approach), with a pool of 1–N and idle-kill. That costs about 80–150 MB per live LSP, so it stays optional and off on `edge-1gb`. |
| Live logs | `EventSource` → Go → runtime SSE `/services/{s}/logs` |

---

## 5. Applying the backend to the runtime (the core question)

The runtime only understands **root token** and **tenant keys**. The web layer has **users, orgs, project grants**. How do we bridge them?

### Option A — "Operator proxy" (BFF holds the root token)

```
Browser ─cookie─▶ Go BFF ──Bearer RT_ROOT_TOKEN + x-rt-tenant: ten_X──▶ runtime
                  └ authz: user→org→project→role checked in Go
```

* **Pros**: simplest. No key lifecycle. Works for every endpoint, including operator ones for the instance admin.
* **Cons**: the web app is fully trusted. A bug in Go authz means cross-tenant access, and the runtime's scope enforcement is bypassed. Audit in the runtime shows "operator" for everything, so the web layer must keep its own audit log.
* Project scoping: Go filters `GET /services` by `project_id` and checks the target service's project before every call.

### Option B — "Per-org service key" (BFF holds one key per tenant)

Each org gets a full-scope tenant key minted at org creation and stored sealed. Users act through it; Go narrows down to roles and projects.

* **Pros**: a Go bug can no longer cross tenants (the runtime enforces the tenant boundary). The root token is only used for instance-admin pages and org provisioning.
* **Cons**: inside a tenant the runtime still trusts Go fully. One extra secret per org.

### Option C — "Per-session derived keys" (least privilege, recommended target)

On login, or on the first request to an org, Go mints a **short-lived runtime key** (`POST /v1/tenants/{t}/keys`, `expires_at = session TTL`). Its scopes come from the user's role (section 3.3) and its `service_ids` from the user's projects. Go caches it per (session, org) and revokes it on logout or role change.

* **Pros**: the runtime enforces both tenant and scope. A Go authz bug is bounded by the key. Runtime audit shows a per-user key (`key.name = "web:alice@…"`).
* **Cons**: key churn (the 200 live key limit per tenant matters, so keys must be shared per (user, org) rather than per session). The `service_ids` list goes stale when services are created, so it needs re-minting or a runtime `project_ids` restriction. Instance-admin pages still use the root token.
* **Small runtime change that makes C clean**: add `project_ids` (and `environment`) to key restrictions, alongside `service_ids`.

### Option D — "Runtime trusts web-issued JWT"

The runtime verifies JWTs signed by Runtime Web (JWKS) with `tenant`, `scopes`, `projects` claims. No key minting.

* **Pros**: the cleanest long-term design, and it is also how CLI/MCP tokens from our OAuth server would work. The runtime stays the enforcement point.
* **Cons**: needs a new auth path in `rt-sec` and couples the runtime to the web's key rotation. That is out of scope for "don't touch the runtime now".

### Recommendation

| Phase | Approach |
|---|---|
| **v1** | **B** for tenant traffic plus **A** (root) for instance-admin pages and org provisioning. Authz is fully in Go, with its own audit table. Ships fastest and keeps the runtime unchanged. |
| **v1.1** | Move to **C** once the runtime gets `project_ids` on keys. User-created "Access tokens" in the UI are already C-style real `rtk_` keys (via `POST /v1/keys`), so the same code path is reused. |
| **v2** | **D**, when our OAuth 2.1 server ships for CLI/MCP. |

### Request flow example (v1): "Save & deploy" in the editor

1. `PUT /api/orgs/{org}/services/{svc}/files`: Go checks the session, then the membership, then that the user's project role is ≥ developer.
2. Go packs the files into the version archive and calls `POST /v1/services/{svc}/versions?activate=1` with the org key.
3. On `201`, Go records an audit row, and the UI polls `GET …/versions/{v}` or streams build logs (`/versions/{v}/build/logs`).
4. The preview iframe loads `RUNTIME_PUBLIC_URL/s/{slug}/`. The first request compiles the code (lazy build), so the UI shows "warming up".

### Instance admin flows (root token)

| Page | Runtime calls |
|---|---|
| Node overview | `GET /v1/node/status`, `/node/scheduler`, `/node/cache`, `/v1/version` |
| Node config / profile | `GET/PUT /v1/node/config` |
| Drain | `POST /v1/node/drain` |
| Organizations | `GET/POST/PATCH/DELETE /v1/tenants`, `GET /tenants/{t}/usage` |
| Plans | `GET /v1/plans` (read-only in the runtime today) |
| Instance settings | Web-local (OAuth providers, signup policy, SMTP, default plan) |

---

## 6. User flows

1. **Bootstrap**: the operator runs `docker compose up` (runtime + rtweb), then opens the URL and sees "Create admin account". That account becomes the instance admin and a personal org is created (tenant + `default` project). Next comes an optional "Configure GitHub login" step.
2. **Sign up / sign in**: GitHub, Google, OIDC or password, depending on the signup policy. The user gets a personal org (tenant on the default plan).
3. **Create a val**: the user clicks "New" and picks a template (HTTP handler, Cron, Queue consumer, SQLite CRUD API, Email in phase 2), then a project and a name (the slug is suggested). The editor opens with a live preview, and on save the val is live at `/s/{slug}`.
4. **Edit & iterate**: edit, ⌘S saves (new version + activate), preview reloads, logs tail. The version dropdown offers diff and rollback (`PUT /live`).
5. **Triggers**: in the Triggers tab, HTTP route/access (public/key), custom hosts, schedules (interval/cron with a human preview "every day at 09:00"), and queue (enqueue test message, DLQ, redrive).
6. **Config**: Environment variables and Secrets (write-only; names shown) per val. Shared org-level env is a phase-2 web feature that fans out to services.
7. **Data**: KV/SQL browser (read-only SQL console is phase 2; export now via `data/export`).
8. **Team**: an org owner invites by email or link, then picks the org role and project grants.
9. **Tokens**: Settings → Access tokens offers scope templates ("Deploy from CI", "Read logs"). The token is shown once.
10. **Instance admin**: Admin area (a separate sidebar section, visible only to admins) covers node, orgs, plans, users and settings.

---

## 7. UI — review of `./temp` and revisions

`./temp` is a Figma-Make React 19 + Tailwind 4 single-file app (`src/App.tsx`, about 1100 lines) that clones val.town's look. Its components: `Sidebar`, `Topbar`, `AccountMenu`, `HomePage` (val cards), `ProjectHeader`, `ValPage` (file list + preview), `EditorPage`, `EnvPage`, `SettingsPage` (profile, handle, avatar, social links), `Assistant` (chat side panel), `NewValPage`, `MobileNav`. The design tokens are in `index.css` (`--blue #0ea5e9`, `--navy`, `--panel`, 8px radius).

### Keep

* Layout: left sidebar, top bar, content, optional right panel (preview/assistant).
* Editor page shape: file tree | code | preview/logs.
* The new-val template picker. CSS tokens and button/field styles.

### Change

| Area in `temp` | Revision |
|---|---|
| Account menu (personal only) | **Org switcher** at the top of the sidebar (personal org + teams), as in Cloudflare/windmill. |
| Sidebar: vals list | **Projects → vals** tree with an environment badge. Add nav items: Home, Runs/Logs, Data, Tokens, Members, Settings. A separate **Admin** section for instance admins. |
| "Public profile", social links, avatar upload, "Remix", "Share", "Upgrade to Pro", "Book a call" | Remove for v1 (no social layer, no billing). Keep "Remix" later as "Duplicate". |
| "Connect your AI agent" | Keep, pointing to the runtime's MCP server and a token-creation flow. |
| Trigger badge "HTTP" only | Badges per trigger: HTTP / Cron / Queue / Email(soon). |
| Logs: LOGS / RAW LOGS / TRACES tabs | LOGS (structured, SSE tail), BUILD (build logs per version), STATS (`/stats`). There is no traces endpoint in the runtime, so drop that tab. |
| Env page | Split into **Variables** and **Secrets** (write-only), plus **Hosts**, **Schedules**, **Queue/DLQ** tabs under Val settings. |
| Single-file `App.tsx` with `setPage` state | TanStack Router routes, components split by feature, API layer. |
| No auth screens | Login, signup, first-run admin bootstrap, invite accept. |
| No version UI | Versions panel: list, status (building/ready/failed), live marker, diff, promote/rollback. |
| Light only | Add dark tokens (`prefers-color-scheme` + toggle). |

### Route map

```
/login  /signup  /setup (first run)  /invite/:token
/:org                          home: recent vals, projects
/:org/p/:project               project: vals, environments, members
/:org/v/:slug                  val: code (editor) | preview | logs | versions | settings
/:org/v/:slug/settings/{general,triggers,env,secrets,hosts,schedules,queue,data}
/:org/settings/{general,members,tokens,usage}
/admin/{node,orgs,users,plans,settings}
/account                        profile, linked identities, sessions
```

---

## 8. Open questions

1. Naming: "val" (friendly, val.town-like) vs "service" (matches runtime/API)? This doc assumes "val" in UI and "service" in API.
2. Should a personal org be auto-created per user, or should orgs be explicit only (Dokploy-like)?
3. Email trigger: build it in the Go layer (phase 2) or as a runtime feature?
4. Runtime changes we can request: `project_ids` on keys (enables option C), task history, plans CRUD.
5. LSP: is in-browser types (phase 1) good enough, or is server-side `deno lsp` a must at launch?
6. DB for Runtime Web: SQLite only, or optional Postgres for larger installs?
