# Runtime changelog for Runtime Web

What changed in `../runtime` (branch `feat/runtime-v1`) that the web console needs to know, as of 2026-10-22.
The source of truth for shapes is `../runtime/openapi/openapi.json`.

## Landed

### API surface
- **Projects** — `GET/POST /v1/projects`, `GET/PATCH/DELETE /v1/projects/{p}`, `GET /v1/projects/{p}/environments`.
  Every tenant has a `default` project. A project owns its list of environments (`production` by default).
  Services carry `project` and `environment`; the environment must be one of the project's.
  *Why:* grouping for the sidebar and an environment switcher, with no web-side bookkeeping.
- **Self-service tokens** — `GET/POST /v1/keys`, `DELETE /v1/keys/{key}` (scope `keys:write`). A tenant mints
  its own `rtk_…` keys. A new key can never exceed its creator's scopes, services or expiry. Revoking a key
  revokes every key minted from it, and a key cannot revoke a stronger key (`403 insufficient_scope`).
  At most 200 live keys per tenant. *Why:* the per-session derived keys in option C work without the root token.
- **Introspection** — `GET /v1/me` returns the tenant and plan for any key, `GET /v1/limits` returns tier limits
  and what is left, and `GET /v1/version`. Operator-only: `GET /v1/plans`, `GET /v1/node/config` (with secrets
  masked) and `GET /v1/node/scheduler`. *Why:* the header/org page and a quota bar.
- **Scaling per service** — `scaling.min_instances` (0 up to the plan limit; that many instances stay warm) and
  `scaling.max_instances` (1 up to the plan limit). The service view and `/stats` include live autoscaler state:
  instances, target, rps, queued, queue wait, last change. *Why:* a scaling card with a live gauge.
- **Service-to-service access** — `config.call.allowed_callers` accepts slugs, `svc_…` ids or
  `env:<environment>`. Refused calls return `403 call_not_allowed`.
- **No 429 for capacity.** A request waits in its service's queue. It ends with `503 queue_timeout` and
  `Retry-After`, or with `503 overloaded` when the node is full. Show these as "busy", not as errors in user code.
- **MCP server** — Streamable HTTP at `/mcp` on the control listener, using a tenant bearer key. It has 20 tools:
  projects, services, push code, logs, stats and limits. *Why:* we can link "Connect your AI agent" straight to it.

- **Keys scoped by projects** (closes the "keys restrict by service IDs" gap in `00-research-and-design.md`).
  - Keys no longer take `service_ids`. `POST /v1/keys`, `POST /v1/tenants/{t}/keys` and `/v1/me` use:
    - `project_ids`: `prj_…` ids, `null` = all projects;
    - `environments`: `null` = all environments.
  - Both limits are enforced by the runtime, so the project → web role mapping can mint keys directly, with no
    Go-side enforcement.
  - A child key can only narrow its parent's scope. An explicit `[]` means nothing.
  - Services now return `project_id` as well as `project` (the slug).
  - An `env:<name>` caller rule matches only within the same project.
  - CLI: `21ci key create --project … --environment …`.
- **Schema reset:** the runtime database migrations were merged into a single new one, which will not migrate
  existing data. Delete any old dev `data/meta.db`.

### Guest code (what users write in the editor)
- **Built-in modules are now `std:*`** (renamed from `rt:*`): `std:kv`, `std:sql`, `std:sqlite`, `std:queue`,
  `std:blob`, `std:services`, `std:platform`. The WIT package is `std:host`. Importing an old `rt:*` name fails
  with "`rt:kv` was renamed to `std:kv`". **Update templates, snippets and editor type stubs.**
- `std:sqlite` is bun:sqlite-compatible and synchronous: `new Database()`, `query/prepare`, `all/get/run`, and
  `db.transaction(fn)`. It is about 7× faster per query than the async `std:sql`. Use it in the SQL templates.
- `kv.incr(key, delta, {ttlSeconds})` is an atomic counter. `kv.set(key, v, {ttlSeconds})` and
  `kv.list({prefix})` were already there.
- **New connectors (landed 2026-10-23):**
  - `std:kv` adds `cas`, `expire`, `ttl` and `list({reverse})`.
  - `std:log`: `log.info(msg, fields)` and `log.with(fields)`. Log records now carry `fields`; render them as
    expandable JSON in the logs view. `console.*` output is still captured as before.
  - `std:secrets`: `secrets.get` and `secrets.require("A","B")`. A missing secret raises an error that names the
    `21ci secret set` command. Link that error to the secrets page.
  - `std:lock`: `lock("key", fn, {waitMs, leaseMs})`.
  - `std:schedule`: `schedule.after` / `at` / `cancel` / `list` run one-off tasks from code. They are listed at
    `GET /v1/services/{s}/schedules/once`; show them next to the cron schedules.
  - `std:services` typed RPC (Deno for now):
    - call with `services.call(slug, method, arg)` or `services.bind(slug).method(arg)`;
    - the callee exports `rpc = {...}` and reads the caller from `ctx.caller`;
    - errors arrive as `ServiceError`;
    - payloads are capped at 256 KiB.
  - WASM guests must be rebuilt, because the `list-options` ABI changed.
  - `std:services` typed RPC also works from WASM. `GET /v1/services/{s}/types` (`21ci types <svc>`) returns a
    `.d.ts` for a service's RPC methods. Use it for editor autocompletion.
- **Operator SDK as a runtime service (landed 2026-10-23).** It is built against the contract and bound at
  runtime.
  - **Where it runs:** the SDK runs in a hidden system tenant, `sys`.
  - **How services call it:** services import `std:sdk` or `sdk:<name>`. The build generates a shim from the
    contract, so publishing, promoting or rolling back an SDK never redeploys tenant services.
  - **Operator API:** `POST/GET /v1/sdks`, `GET /v1/sdks/{name}/releases`,
    `PUT /v1/sdks/{name}/channels/{ch}`, `DELETE /v1/sdks/{name}` and `GET/PUT /v1/sdk-grants`.
  - **Grants:** access is granted at node, plan, tenant, project or environment level, never per service.
  - **Tenant API:** `GET /v1/sdks/effective` lists the SDKs this org, project or environment can use.
    `GET /v1/sdks/{name}/contract` returns the `.d.ts`. MCP has `list_sdks` and `get_sdk_contract`.
  - **For the web console:**
    - an "SDKs" admin page: publish, channels, rollback and a grant editor;
    - an "Available SDKs" panel per project;
    - load the SDK contracts into the editor's TypeScript stubs.
  - The old bundled `[[sdk]]` config section was removed, and the runtime refuses to start if a config still
    has it.
- `ctx.client.ip` gives the real client IP. `rtk_` bearer tokens are removed before a request reaches guest code.

### Other things worth surfacing
- `SECURITY.md` in the runtime repo explains the sandbox, keys, egress and the threat model. Link it from the
  docs and about pages.
- Five real-world sample apps live in `../runtime/sample/apps`: a Telegram bot, an events backend, a live queue,
  CBU currency rates and an edge gateway. They are good template sources.

## In progress — not merged yet, do not build against these

- A security review and hardening pass is under way. Expect small API fixes, but no shape changes are planned.

## WebSockets and durable objects (landed 2026-10-23)
Durable objects work like Cloudflare Durable Objects. The runtime holds each socket while the app sleeps, and
wakes the app for each event.
- **Guest code:**
  - `std:sockets`: accept, list, send, broadcast, close, tags, attachments and auto-response;
  - `std:durable`: one durable class per service, `durable.get(name)`, per-object storage and alarms;
  - an outbound `new WebSocket(url)` client.
- **Measured cost:** about 5 KiB per idle socket. Waking a sleeping object takes about 2 ms.
- **API:**
  - `GET /v1/services/{s}/objects`;
  - `GET` and `DELETE /v1/services/{s}/objects/{name}/sockets[/{ws}]`;
  - `DELETE /v1/services/{s}/objects/{name}`;
  - a new scope, `sockets:write`.
- **Services:** have a `durable` flag and a `ws` block. Plans have socket caps. Socket counts appear in stats.
- **Deploys:** sockets survive deploys by default. Deploy and rollback accept `close_sockets: true` to close every
  socket (code 1012). Add a checkbox for it in the deploy dialog.
- **CLI and MCP:**
  - CLI: `21ci sockets ls|close`, `21ci objects ls|rm`, `--close-sockets`;
  - MCP: `list_objects`, `list_sockets`, `close_socket`.
- **Template source:** `sample/apps/chat-room` (rooms, presence, history).
